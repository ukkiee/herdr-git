// The operation in progress (merge, rebase, cherry-pick, revert): reading it, and running
// a request on it (Continue, Abort, Skip) with one result whatever git said. Every function
// takes `git` from makeGit (git.js) and the repository root, and returns a result instead
// of throwing. A sentence the mod words itself comes in English in `err` with its key in
// `msg` ({ key, args }, i18n.js); git's own words come without `msg`.
//
// Nothing here is decided from git's words: they come in the person's language. Whether
// an operation is in progress comes from its state files (found with `rev-parse
// --git-path`, so a linked worktree reads its own), conflicts from `status --porcelain=v2`,
// and how a request ended from the state and HEAD read again after it ran.

import { readStatus } from "./git-status.js";
import { blockedBy } from "./git-smart.js";

// Continue and Skip may run hooks (pre-commit, commit-msg, post-checkout) for minutes;
// this is exec's cap.
const TIMEOUT = 600000;
// An editor would wait forever for a person who can't see it (exec has no terminal), and
// `merge --continue` and `rebase --continue` start one even when nothing is interactive.
const NO_EDITOR = { GIT_EDITOR: "true" };
const LITERAL = "--literal-pathspecs";

// The state files, by their name under the git folder. ORIG_HEAD and AUTO_MERGE are left
// out: a finished operation leaves them behind.
// HEAD is read with them for the branch the operation happens on (`branch`).
const NAMES = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "MERGE_MSG", "rebase-merge", "rebase-apply", "sequencer", "HEAD"];
// What is read inside the folders: rebase-merge is the default backend, rebase-apply the
// --apply one (`git am` uses it too, without `onto`).
const INSIDE = {
  "rebase-merge": ["head-name", "onto", "msgnum", "end"],
  "rebase-apply": ["head-name", "onto", "next", "last"],
  sequencer: ["todo"],
};
// A conflict's letter for one side (porcelain v2 XY: X ours, Y theirs).
const SIDE = { U: "modified", A: "added", D: "deleted" };

const failed = (r, extra = {}) => ({ ok: false, code: r.code ?? -1, out: r.out ?? "", err: r.err ?? "", ...(r.msg ? { msg: r.msg } : {}), ...extra });
const refuse = (err, msg, extra = {}) => ({ ok: false, code: -1, out: "", err, msg, ...extra });

const NONE = { kind: null, branch: null, target: null, rebasing: null, current: null, step: null, sequence: false, message: "", conflicts: [], staged: [], canContinue: false, canSkip: false };

// readOperation(git, root, { status }?) → { ok, err, msg?, kind, head, branch, target, rebasing,
//   current, step, sequence, message, conflicts, staged, canContinue, canSkip }
//   kind: "merge" | "rebase" | "cherry-pick" | "revert", or null when nothing is in progress.
//     A stash pop or apply that conflicted leaves no operation: kind null with conflicts.
//   head: the commit HEAD is on (null without commits).
//   branch: the branch HEAD is on, null on a detached HEAD (a rebase always runs on one).
//   target: what a merge merges in, or what a rebase goes onto. A merge's is the name it
//     was asked for ("feature", "origin/feature"); else a branch, remote branch or tag
//     pointing at that commit, in that order, else its short hash.
//   rebasing: the branch a rebase rewrites (null when it started on a detached HEAD).
//   current: { hash, subject, author } of the commit being merged, picked, reverted or
//     replayed, or null (a sequence stopped between commits).
//   step: { n, total } of a rebase, else null.
//   sequence: several cherry-picks or reverts, with more to come after this one.
//   message: the message the operation would commit, without git's comment lines.
//   conflicts: [{ path, xy, ours, theirs }], each side "modified" | "added" | "deleted".
//   staged: paths of the other changes in the index (what the operation brought in or the
//     person resolved): Continue commits them all.
//   canContinue: in progress and no conflict left. canSkip: a rebase, or a sequence.
//   status: a readStatus result read just before, so the panel asks git once for both.
//   Reads only (git.read): nothing under .git is written.
export async function readOperation(git, root, { status } = {}) {
  const st = status ?? await readStatus(git, root);
  if (!st.ok) return { ...failed(st), ...NONE, head: null };
  const conflicts = [], staged = [];
  for (const change of st.changes) {
    if (change.status === "conflict") conflicts.push({ path: change.path, xy: change.xy, ours: SIDE[change.xy[0]] ?? "modified", theirs: SIDE[change.xy[1]] ?? "modified" });
    else if (change.xy && change.xy[0] !== ".") staged.push(change.path);
  }
  const files = await readStateFiles(git, root);
  if (!files.ok) return { ...failed(files), ...NONE, head: st.head };
  const has = (name) => files.read.has(name);
  const first = (name) => files.read.get(name)?.[0]?.trim() ?? "";
  const rebase = has("rebase-merge/head-name") ? "rebase-merge" : has("rebase-apply/onto") ? "rebase-apply" : null;
  const todo = (files.read.get("sequencer/todo") ?? []).find((line) => line.trim() && !line.startsWith("#")) ?? "";
  const kind = rebase ? "rebase"
    : has("REVERT_HEAD") ? "revert"
    : has("CHERRY_PICK_HEAD") ? "cherry-pick"
    : has("MERGE_HEAD") ? "merge"
    // A sequence stopped between two commits (its own commit made by hand) is still on.
    : /^(p|pick)\s/.test(todo) ? "cherry-pick"
    : /^revert\s/.test(todo) ? "revert"
    : null;
  const ref = /^ref: refs\/heads\/(.+)$/.exec(first("HEAD"));
  const base = { ok: true, err: "", ...NONE, head: st.head, branch: ref ? ref[1] : null, conflicts };
  if (!kind) return base;
  const currentHash = first({ rebase: "REBASE_HEAD", revert: "REVERT_HEAD", "cherry-pick": "CHERRY_PICK_HEAD", merge: "MERGE_HEAD" }[kind]) || null;
  const targetHash = kind === "merge" ? currentHash : rebase ? first(`${rebase}/onto`) || null : null;
  const known = await describe(git, root, [currentHash, targetHash].filter(Boolean));
  const current = currentHash && known.get(currentHash) ? { hash: currentHash, ...known.get(currentHash).who } : null;
  const named = kind === "merge" ? mergedName(files.read.get("MERGE_MSG")) : null;
  const target = named ?? (targetHash ? known.get(targetHash)?.name ?? targetHash.slice(0, 7) : null);
  const headName = rebase ? first(`${rebase}/head-name`) : "";
  const step = !rebase ? null
    : rebase === "rebase-merge" ? { n: Number(first("rebase-merge/msgnum")) || 0, total: Number(first("rebase-merge/end")) || 0 }
    : { n: Number(first("rebase-apply/next")) || 0, total: Number(first("rebase-apply/last")) || 0 };
  const sequence = files.read.has("sequencer/todo") && kind !== "rebase";
  // MERGE_MSG is what git would commit; the --apply rebase has none and keeps the
  // replayed commit's own message.
  const message = has("MERGE_MSG") ? withoutComments(files.read.get("MERGE_MSG"))
    : currentHash ? known.get(currentHash)?.message ?? "" : "";
  return {
    ...base, kind, target, current, step, sequence, message, staged,
    rebasing: headName.startsWith("refs/heads/") ? headName.slice(11) : null,
    canContinue: conflicts.length === 0,
    canSkip: kind === "rebase" || sequence,
  };
}

// The state files that exist, read in two git calls: { ok, read: Map(name → [line]) },
// names relative to the git folder ("MERGE_MSG", "rebase-merge/onto").
// Read with `grep --no-index` run inside the git folder: git can't hand a file's bytes
// any other way without a shell, and exec may run on another machine. Paths outside the
// folder git runs in are refused, so it runs there and gets names relative to it.
async function readStateFiles(git, root) {
  const where = await git.read(root, ["rev-parse", "--absolute-git-dir", ...NAMES.flatMap((name) => ["--git-path", name])]);
  if (!where.ok) return where;
  const [dir, ...paths] = where.out.split("\n").map((line) => line.trim());
  const wanted = [];
  NAMES.forEach((name, i) => {
    const path = paths[i] ?? "";
    // Relative to root unless absolute ("/…", or "C:/…" from git for Windows).
    const full = /^(\/|[A-Za-z]:[\\/])/.test(path) ? path : `${root}/${path}`;
    // Every state file is the worktree's own; one found elsewhere is not looked at.
    if (!full.startsWith(`${dir}/`)) return;
    const rel = full.slice(dir.length + 1);
    if (INSIDE[name]) for (const file of INSIDE[name]) wanted.push(`${rel}/${file}`);
    else wanted.push(rel);
  });
  const read = new Map();
  if (!wanted.length) return { ok: true, read };
  // The person's grep settings would add line numbers or columns to every line.
  const r = await git.read(dir, ["-c", "grep.lineNumber=false", "-c", "grep.column=false", "-c", "grep.fullName=false",
    "grep", "--no-index", "-z", "-a", "--no-color", "-e", "", "--", ...wanted]);
  // 1: no file matched, so none of them exists (an empty one would match nothing too, and
  // none of these is ever empty).
  if (r.code === 1) return { ok: true, read };
  if (!r.ok) return r;
  for (const line of r.out.split("\n")) {
    const at = line.indexOf("\0");
    if (at < 0) continue;
    const name = line.slice(0, at);
    if (!read.has(name)) read.set(name, []);
    read.get(name).push(line.slice(at + 1));
  }
  // A file that ends without a newline comes back the same as one that has it.
  return { ok: true, read };
}

// The commits by hash: Map(hash → { who: { subject, author }, name, message }). name: a
// branch, remote branch or tag on it, in that order, or undefined. git lists a commit's
// refs in no such order (tags and remote branches may come first), so the full names
// are read and sorted here.
const REF_ORDER = [["refs/heads/", 0], ["refs/remotes/", 1], ["refs/tags/", 2]];
async function describe(git, root, hashes) {
  const out = new Map();
  if (!hashes.length) return out;
  const r = await git.read(root, ["log", "--no-walk=unsorted", "-z", "--decorate=full", "--decorate-refs=refs/heads/", "--decorate-refs=refs/remotes/", "--decorate-refs=refs/tags/",
    "--format=%H%x1f%s%x1f%an%x1f%D%x1f%B", ...new Set(hashes), "--"]);
  if (!r.ok) return out;
  for (const record of r.out.split("\0")) {
    const [hash, subject, author, refs, body] = record.split("\x1f");
    if (!hash) continue;
    const names = (refs ?? "").split(", ")
      .map((ref) => ref.replace(/^HEAD -> /, "").replace(/^tag: /, ""))
      .map((ref) => { const kind = REF_ORDER.find(([prefix]) => ref.startsWith(prefix)); return kind ? { rank: kind[1], name: ref.slice(kind[0].length) } : null; })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank);
    out.set(hash.trim(), { who: { subject: subject ?? "", author: author ?? "" }, name: names[0]?.name, message: (body ?? "").replace(/\s+$/, "") });
  }
  return out;
}

// What a merge merges in, as the person named it: git's message starts "Merge branch
// 'feature'", "Merge remote-tracking branch 'origin/feature'" or "Merge tag 'v1'" (in
// English whatever the language: it is the commit message), followed by " into side"
// off the main branch. A commit merged by its hash, several branches at once or a
// message given with -m say no name: null.
function mergedName(lines = []) {
  const m = /^Merge (?:branch|remote-tracking branch|tag) '([^']+)'/.exec(lines[0] ?? "");
  return m ? m[1] : null;
}

// operationName(op, { step }?) → { key, args } for t(), or null when nothing is in
// progress: "Merging main", "Rebasing feature", "Cherry-picking in main", "Reverting in
// main". The VCS widget and the Commit panel name an operation by it, so both say the
// same. The name is the branch the operation happens on: a rebase's is the branch it
// rewrites, the others' the branch HEAD is on; the commit HEAD is on, short, when there
// is no branch. step: a rebase also says how far it got ("Rebasing feature (1/2)").
export function operationName(op, { step = false } = {}) {
  if (!op?.kind) return null;
  const here = op.branch ?? (op.head ? op.head.slice(0, 7) : "HEAD");
  if (op.kind === "rebase") {
    const name = op.rebasing ?? here;
    return step && op.step?.total ? { key: "ops.rebasingStep", args: { name, n: op.step.n, total: op.step.total } } : { key: "ops.rebasing", args: { name } };
  }
  const key = { merge: "ops.merging", "cherry-pick": "ops.cherryPicking", revert: "ops.reverting" }[op.kind];
  return { key, args: { name: here } };
}

// A message as git keeps it in MERGE_MSG, without the lines git comments out ("#
// Conflicts:" and the paths under it) and the blank lines left at the end.
function withoutComments(lines = []) {
  return lines.filter((line) => !line.startsWith("#")).join("\n").replace(/\s+$/, "");
}

// ---- running

// settle(before, after, run, { blocked }) → "done" | "stopped" | "empty" | "refused" | "failed"
//   before, after: readOperation results around the request; run: git's result for it.
//   done: nothing is in progress and nothing is in conflict afterwards, and git said yes
//     or HEAD moved (a hook that failed after the commit was made).
//   stopped: an operation is in progress afterwards, or files are in conflict (a stash
//     that came back with conflicts after the operation ended). The person goes on from
//     there; git's words say why.
//   empty: a cherry-pick or revert in progress whose commit would change nothing (it is
//     already in); the request that met it skips it.
//   refused: git said no, nothing changed, and `blocked` names the local changes that
//     stood in the way.
//   failed: anything else.
export function settle(before, after, run, { blocked = [] } = {}) {
  if (!after.ok) return "failed";
  if (after.kind && (after.kind === "cherry-pick" || after.kind === "revert") && !run.ok && !after.conflicts.length && !after.staged.length && after.current) return "empty";
  if (after.kind || after.conflicts.length) {
    // The same operation, the same HEAD, still in the same place: git refused the request.
    const unchanged = after.kind === before.kind && after.head === before.head && after.current?.hash === before.current?.hash;
    return !run.ok && unchanged ? "failed" : "stopped";
  }
  if (run.ok || after.head !== before.head) return "done";
  return blocked.length ? "refused" : "failed";
}

// Which local changes stood in the way of a request git refused: [path], worked out by
// git-smart.js from the request and the repository as it is now (git refused, so nothing
// moved). Continue, Abort and Skip have none. Only a refusal that left nothing in
// progress and HEAD where it was can be one; anything else needs no files.
async function blockingFiles(git, root, request, before, after) {
  if (!after.ok || after.kind || after.conflicts.length || after.head !== before.head) return [];
  const r = await blockedBy(git, root, request);
  return r.ok ? r.paths : [];
}

// Each request: check(before, args) → a refusal before anything runs, or null;
// run(git, root, args, before) → git's result. Starting an operation adds its line here.
const REQUESTS = {
  continue: {
    check: (before) => !before.kind ? refuse("Nothing is in progress to continue.", { key: "ops.nothingInProgress" })
      : before.conflicts.length ? conflictsLeft(before.conflicts.length)
      : null,
    run: continueRun,
  },
  abort: {
    check: (before) => before.kind ? null : refuse("Nothing is in progress to abort.", { key: "ops.nothingToAbort" }),
    run: (git, root, _args, before) => git(root, [before.kind, "--abort"], { timeout: TIMEOUT, env: NO_EDITOR }),
  },
  skip: {
    check: (before) => before.canSkip ? null : refuse("There is no commit to skip.", { key: "ops.nothingToSkip" }),
    run: (git, root, _args, before) => git(root, [before.kind, "--skip"], { timeout: TIMEOUT, env: NO_EDITOR }),
  },
  "cherry-pick": { check: startCheck, run: (git, root, args, before) => pickRun(git, root, "cherry-pick", args, before) },
  revert: { check: startCheck, run: (git, root, args, before) => pickRun(git, root, "revert", args, before) },
};

// ---- Cherry-Pick and Revert Commit

const COMMIT = /^[0-9a-f]{7,64}$/;
const commitsOf = (args) => (Array.isArray(args?.commits) ? args.commits.filter((c) => typeof c === "string" && COMMIT.test(c)) : []);

// A cherry-pick or revert starts only with nothing in progress: git would refuse anyway,
// and a refusal met while a cherry-pick is stopped would read as that one's empty commit.
function startCheck(before, args) {
  if (before.kind) return refuse("Another operation is in progress: finish or abort it first.", { key: "pick.busy" });
  if (!commitsOf(args).length || commitsOf(args).length !== (args.commits?.length ?? 0)) return refuse("No commits to apply.", { key: "pick.noCommits" });
  return null;
}

// Cherry-Pick: the commits oldest first, each committed with its own message and author
// (no "cherry picked from" line). Revert Commit: newest first, a commit for each with
// git's own message. `commits` come newest first, as the Commit list picks them; git
// applies them in the order given.
// A commit that comes out empty (its changes are already in) is skipped, as many times as
// the sequence meets one, so nothing is left in progress for it: skipped names them.
// empty: every commit was skipped (HEAD didn't move).
async function pickRun(git, root, type, args, before) {
  const commits = commitsOf(args);
  const order = type === "cherry-pick" ? [...commits].reverse() : commits;
  let r = await git(root, [type, ...(type === "revert" ? ["--no-edit"] : []), ...order], { timeout: TIMEOUT, env: NO_EDITOR });
  const skipped = [];
  for (let n = 0; !r.ok && n < commits.length; n++) {
    const now = await readOperation(git, root);
    if (!now.ok || now.kind !== type || now.conflicts.length || now.staged.length || !now.current) break;
    skipped.push(now.current.hash);
    r = await git(root, [type, "--skip"], { timeout: TIMEOUT, env: NO_EDITOR });
  }
  if (!skipped.length) return r;
  const moved = await git.read(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return { ...r, skipped, empty: moved.ok && moved.out.trim() === before.head };
}

// conflictsLeft(n) → the refusal of a commit or a Continue while n files are in conflict.
export const conflictsLeft = (n) => refuse(`Resolve the conflicts first: ${n} file(s) still in conflict.`, { key: "ops.conflictsLeft", args: { n } });

// Continue: the other changes the person checked are added first, then the operation is
// committed and goes on. A merge is committed (with the message, no paths), a cherry-pick
// or revert likewise and then the rest of its sequence, a rebase goes on with --continue.
async function continueRun(git, root, { message = "", files = [] }, before) {
  const paths = files.map((file) => (typeof file === "string" ? file : file?.path)).filter((path) => typeof path === "string" && path);
  if (paths.length) {
    // -A: a checked deletion is staged as one, an untracked file is added.
    const added = await git(root, [LITERAL, "add", "-A", "--", ...paths]);
    if (!added.ok) return added;
  }
  const text = String(message ?? "").trim() ? String(message) : before.message;
  if (before.kind === "rebase") {
    if (!String(message ?? "").trim() || String(message).trim() === before.message.trim()) {
      return git(root, ["rebase", "--continue"], { timeout: TIMEOUT, env: NO_EDITOR });
    }
    // A changed message goes in through the editor git asks for, which writes it from a
    // variable: exec has no stdin and a file can't be written on another machine. Lines
    // starting with "#" are the person's (an issue number), so git keeps them.
    return git(root, ["-c", "commit.cleanup=whitespace", "rebase", "--continue"], {
      timeout: TIMEOUT,
      env: { GITTOOLS_MESSAGE: text, GIT_EDITOR: `sh -c 'printf "%s\\n" "$GITTOOLS_MESSAGE" > "$1"' -` },
    });
  }
  let r = { ok: true, code: 0, out: "", err: "" };
  // A sequence stopped between commits has nothing of its own to commit.
  if (before.kind === "merge" || before.current) {
    if (!text.trim()) return refuse("Specify a commit message.", { key: "commit.noMessage" });
    r = await git(root, ["commit", "-m", text], { timeout: TIMEOUT, env: NO_EDITOR });
    if (!r.ok) {
      // The resolution left nothing to commit: the commit is already in. It is skipped,
      // as an empty cherry-pick is, and the sequence (if any) goes on.
      const now = await readOperation(git, root);
      if (before.kind !== "merge" && now.ok && now.kind === before.kind && !now.conflicts.length && !now.staged.length) {
        return { ...await git(root, [before.kind, "--skip"], { timeout: TIMEOUT, env: NO_EDITOR }), empty: true };
      }
      return r;
    }
  }
  if (before.sequence) r = await git(root, [before.kind, "--continue"], { timeout: TIMEOUT, env: NO_EDITOR });
  return r;
}

// runOperation(git, root, { type, ...args }) → { ok, code, out, err, msg?, outcome, operation }
//   type: "continue" | "abort" | "skip" | "cherry-pick" | "revert". args: Continue's
//   { message, files }; Cherry-Pick's and Revert's { commits } (full or short hashes,
//   newest first). skipped: the commits a Cherry-Pick or Revert found already in.
//   outcome: settle's word (above); "empty" also when Continue found the resolved commit
//   already in and skipped it. ok: the outcome is done, stopped or empty.
//   operation: readOperation afterwards, so the screen shows where things are now.
//   A refusal before anything ran (nothing in progress, conflicts left) has outcome
//   "refused" and changed nothing.
export async function runOperation(git, root, { type, ...args } = {}) {
  const request = Object.prototype.hasOwnProperty.call(REQUESTS, type) ? REQUESTS[type] : null;
  if (!request) return refuse(`Unknown request: ${type}`, { key: "ops.unknownRequest", args: { type: String(type) } }, { outcome: "failed", operation: null });
  const before = await readOperation(git, root);
  if (!before.ok) return { ...failed(before), outcome: "failed", operation: null };
  const no = request.check(before, args);
  if (no) return { ...no, outcome: "refused", operation: before };
  const run = await request.run(git, root, args, before);
  const after = await readOperation(git, root);
  const blocked = run.ok ? [] : await blockingFiles(git, root, { type, ...args }, before, after);
  const settled = settle(before, after, run, { blocked });
  // A Continue whose commit came out empty skipped it: said so, unless it stopped again.
  const outcome = run.empty && settled === "done" ? "empty" : settled;
  return { ok: outcome === "done" || outcome === "stopped" || outcome === "empty", code: run.code, out: run.out ?? "", err: run.err ?? "", ...(run.msg ? { msg: run.msg } : {}), outcome, operation: after.ok ? after : null, ...(blocked.length ? { blocked } : {}), ...(run.skipped?.length ? { skipped: run.skipped } : {}) };
}

export const continueOperation = (git, root, args = {}) => runOperation(git, root, { ...args, type: "continue" });
export const abortOperation = (git, root) => runOperation(git, root, { type: "abort" });
export const skipOperation = (git, root) => runOperation(git, root, { type: "skip" });
