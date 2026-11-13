// Editing the current branch's history: Undo Commit, Edit Commit Message, Drop Commits,
// Squash Commits, and the one way they all replay commits (runPlan). No `herdr` import:
// node tests it against real repositories (git-rewrite.test.mjs).
//
// Every function takes `git` from makeGit (git.js) and the repository root and returns a
// result instead of throwing: { ok, code, out, err, msg?, outcome, operation, changed }.
//   outcome: "done", "stopped" (a rebase is in progress afterwards: a conflict, or a stop
//     the plan asked for), "refused" (checked before anything ran: nothing changed, msg
//     says why), or "failed" (git's words in err).
//   operation: git-operation.js readOperation afterwards, so the screen can open the
//     Conflicts dialog (view-conflicts.js openConflictsIfStopped) or show the rebase.
//   changed: the repository may have changed.
//
// The replay is `git rebase -i` with the to-do list rebase-plan.js makes, handed in as
// the sequence editor; a message goes in from an exec line (see docs/adr/0004). Each
// write reads the edit facts again first and refuses what rebase-plan.js editCheck turns
// off, whatever the menu showed when it opened.

import { readOperation, settle } from "./git-operation.js";
import { PROTECTED } from "./git-push.js";
import { editCheck, todoList } from "./rebase-plan.js";
import { commit as commitFiles } from "./git-commit.js";
import { translator } from "./i18n.js";

// The English of a refusal's reason, for err (the screen words msg in its own language).
const english = translator("en");

// Hooks (pre-commit, commit-msg on every reworded commit) may run for minutes.
const TIMEOUT = 600000;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// The sequence editor: writes the list from a variable into the file git hands it (exec
// has no stdin, and a file can't be written on another machine). Given as the variable,
// which beats both sequence.editor and an exported GIT_SEQUENCE_EDITOR of the person's.
const SEQUENCE_EDITOR = `sh -c 'printf "%s\\n" "$GITTOOLS_TODO" > "$1"' -`;

const result = (r, extra = {}) => ({ ok: Boolean(r.ok), code: r.code ?? (r.ok ? 0 : -1), out: r.out ?? "", err: r.err ?? "", ...(r.msg ? { msg: r.msg } : {}), ...extra });
const refused = (err, msg, operation = null) => ({ ok: false, code: -1, out: "", err, msg, outcome: "refused", operation, changed: false });
const lines = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// ---- reading

// Whether `a` is an ancestor of (or the same as) `b`: true, false, or null when git failed.
async function isAncestor(git, root, a, b) {
  const r = await git.read(root, ["merge-base", "--is-ancestor", a, b]);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

// The remote branch the current one tracks: { ref, name } ("refs/remotes/origin/main",
// "origin/main") with whether it is a protected branch, or null.
async function tracked(git, root, branch) {
  if (!branch) return null;
  const r = await git.read(root, ["for-each-ref", "--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)", `refs/heads/${branch}`]);
  if (!r.ok) return null;
  const [ref, name, remote] = (r.out.split("\n")[0] ?? "").split("\0");
  if (!ref?.startsWith("refs/remotes/") || !remote) return null;
  const target = ref.slice(`refs/remotes/${remote}/`.length);
  return { ref, name, protected: PROTECTED.includes(target) };
}

// readEditFacts(git, root, hashes) → { ok, err, msg?, head, branch, operation, protected,
//   mergeAbove, pushed, oldest, commits }
//   What the edit check (rebase-plan.js editCheck) needs for the commits picked:
//   head: HEAD's hash. branch: the current branch, or null on a detached HEAD.
//   operation: the kind in progress (git-operation.js), or null.
//   protected: the remote branch the current one tracks ("origin/main") when it is a
//     protected one, else null.
//   commits: [{ hash, parents (a count), onBranch (reachable from HEAD), pushedProtected
//     (reachable from that protected branch) }], in the order given.
//   oldest: the commit picked that the others descend from (where a replay starts), or
//     null when they aren't all on one line from HEAD.
//   mergeAbove: a merge commit between `oldest` and HEAD.
//   pushed: `oldest` is on some remote branch: rewriting it needs a force push next.
//   localChanges: the working tree or the index has anything to commit, untracked files
//     included (the Commit panel commits those too); null when git couldn't say.
export async function readEditFacts(git, root, hashes) {
  const wanted = [...new Set((hashes ?? []).filter((h) => typeof h === "string"))];
  const bad = wanted.find((h) => !HASH.test(h));
  if (!wanted.length || bad) return unknown(bad ?? "");
  const [headR, branchR, op, changes] = await Promise.all([
    git.read(root, ["rev-parse", "--verify", "-q", "HEAD"]),
    git.read(root, ["symbolic-ref", "-q", "--short", "HEAD"]),
    readOperation(git, root),
    git.read(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
  ]);
  if (!headR.ok) return result(headR);
  const head = headR.out.trim(), branch = branchR.ok ? branchR.out.trim() : null;
  const parentsR = await git.read(root, ["rev-list", "--no-walk=unsorted", "--parents", ...wanted, "--"]);
  if (!parentsR.ok) {
    for (const h of wanted) if (!(await git.read(root, ["cat-file", "-e", `${h}^{commit}`])).ok) return unknown(h);
    return result(parentsR);
  }
  const parents = new Map(lines(parentsR.out).map((l) => { const [h, ...ps] = l.split(" "); return [h, ps.length]; }));
  const upstream = await tracked(git, root, branch);
  const commits = await Promise.all(wanted.map(async (hash) => ({
    hash,
    parents: parents.get(hash) ?? 0,
    onBranch: (await isAncestor(git, root, hash, head)) === true,
    pushedProtected: upstream?.protected ? (await isAncestor(git, root, hash, upstream.ref)) === true : false,
  })));
  let oldest = null, mergeAbove = false, pushed = false;
  if (commits.every((c) => c.onBranch)) {
    const mb = wanted.length === 1 ? { ok: true, out: wanted[0] } : await git.read(root, ["merge-base", "--octopus", ...wanted]);
    oldest = mb.ok && wanted.includes(mb.out.trim()) ? mb.out.trim() : null;
    if (oldest) {
      const [merges, remote] = await Promise.all([
        git.read(root, ["rev-list", "--min-parents=2", "--count", `${oldest}..${head}`]),
        git.read(root, ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", oldest, "refs/remotes/"]),
      ]);
      mergeAbove = merges.ok && Number(merges.out.trim()) > 0;
      pushed = remote.ok && remote.out.trim() !== "";
    }
  }
  return {
    ok: true, code: 0, out: "", err: "", head, branch, operation: op.ok ? op.kind : null,
    protected: upstream?.protected ? upstream.name : null, mergeAbove, pushed, oldest, commits,
    localChanges: changes.ok ? changes.out !== "" : null,
  };
}

// readMessages(git, root, hashes) → { ok, err, msg?, messages, joined }
//   messages: { [hash]: the whole message, without the newlines git ends it with }.
//   joined: the messages of `hashes` given newest first (as the Commit list picks them),
//   oldest first with a blank line between: where Squashed Commit Message starts.
export async function readMessages(git, root, hashes) {
  const wanted = (hashes ?? []).filter((h) => typeof h === "string" && HASH.test(h));
  if (!wanted.length) return { ...unknown(hashes?.[0] ?? ""), messages: {}, joined: "" };
  const r = await git.read(root, ["log", "--no-walk=unsorted", "-z", "--format=%H%x1f%B", ...wanted, "--"]);
  if (!r.ok) {
    for (const h of wanted) if (!(await git.read(root, ["cat-file", "-e", `${h}^{commit}`])).ok) return { ...unknown(h), messages: {}, joined: "" };
    return { ...result(r), messages: {}, joined: "" };
  }
  const messages = {};
  for (const record of r.out.split("\0")) {
    const at = record.indexOf("\x1f");
    if (at > 0) messages[record.slice(0, at).trim()] = record.slice(at + 1).replace(/\n+$/, "");
  }
  return { ok: true, code: 0, out: "", err: "", messages, joined: [...wanted].reverse().map((h) => messages[h] ?? "").join("\n\n") };
}

function unknown(hash) {
  const short = String(hash).slice(0, 8);
  return { ok: false, code: -1, out: "", err: `Commit ${short} is not in this repository.`, msg: { key: "rewrite.unknownCommit", args: { hash: short } } };
}

// Reads the facts and checks `action` on them: { facts } to go on, or { no } (a result).
// files: rebase-plan.js editCheck's, for the file actions.
async function checked(git, root, hashes, action, files = null) {
  const facts = await readEditFacts(git, root, hashes);
  if (!facts.ok) return { no: { ...result(facts), outcome: "failed", operation: null, changed: false } };
  const { why } = editCheck(action, facts, hashes.length, files);
  if (why) return { no: refused(english(why.key, why.args), why) };
  return { facts };
}

// ---- the replay

// How many paths a local-changes refusal names in its sentence (`blocked` has them all).
const FILES_SHOWN = 10;

// Every tracked path the working tree or the index has otherwise than HEAD: { ok, paths },
// sorted. A rename is its two paths.
async function trackedChanges(git, root) {
  const found = new Set();
  for (const cached of [false, true]) {
    const r = await git.read(root, ["diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD", "--"]);
    if (!r.ok) return r;
    for (const path of r.out.split("\0")) if (path) found.add(path);
  }
  return { ok: true, paths: [...found].sort() };
}

// The refusal for changes to tracked files that would stop the replay, naming them.
function localRefusal(paths) {
  const files = paths.length > FILES_SHOWN ? `${paths.slice(0, FILES_SHOWN).join(", ")}, …` : paths.join(", ");
  return { ...refused(english("rewrite.localChanges", { files }), { key: "rewrite.localChanges", args: { files } }), blocked: paths };
}

// The commits from `oldest` to HEAD, oldest first.
async function range(git, root, oldest, root0) {
  const r = await git.read(root, ["rev-list", "--reverse", "--topo-order", root0 ? "HEAD" : `${oldest}^..HEAD`, "--"]);
  return r.ok ? { ok: true, hashes: lines(r.out) } : result(r);
}

// The branches that move with the replayed commits, as git would move them with the
// person's rebase.updateRefs: local branches on a commit of the range, except any checked
// out (the current one included). { [hash]: [full ref] }; {} when the setting is off.
async function movingRefs(git, root, hashes) {
  const on = await git.read(root, ["config", "--type=bool", "--get", "rebase.updateRefs"]);
  if (!on.ok || on.out.trim() !== "true") return {};
  const r = await git.read(root, ["for-each-ref", "--format=%(objectname)%00%(refname)%00%(worktreepath)", "refs/heads/"]);
  if (!r.ok) return {};
  const inRange = new Set(hashes), refs = {};
  for (const line of r.out.split("\n")) {
    const [hash, ref, worktree] = line.split("\0");
    if (!ref || worktree || !inRange.has(hash)) continue;
    (refs[hash] ??= []).push(ref);
  }
  return refs;
}

// runPlan(git, root, { oldest, steps }) → a result (top of the file)
//   Replays the current branch from `oldest` (a full hash on it) with steps
//   (rebase-plan.js todoList), one for every commit from `oldest` to HEAD, in the order to
//   replay. `steps` is the list, or a function of the commits from `oldest` to HEAD
//   (oldest first) that makes it. The edit check is the caller's.
//   Changes to tracked files (working tree or index) stop it before it starts, as they
//   stop git's rebase: outcome "refused" with `blocked`, every such path. They aren't put
//   aside with --autostash: a stash that doesn't apply cleanly afterwards stays behind
//   while git still says the rebase ended well. Untracked files don't stop it.
export async function runPlan(git, root, { oldest, steps } = {}) {
  const local = await trackedChanges(git, root);
  if (!local.ok) return { ...result(local), outcome: "failed", operation: null, changed: false };
  if (local.paths.length) return localRefusal(local.paths);
  const parents = HASH.test(String(oldest ?? "")) ? await git.read(root, ["rev-list", "--no-walk", "--parents", oldest, "--"]) : { ok: false };
  if (!parents.ok) return { ...unknown(oldest ?? ""), outcome: "failed", operation: null, changed: false };
  const isRoot = lines(parents.out)[0]?.split(" ").length === 1;
  const span = await range(git, root, oldest, isRoot);
  if (!span.ok) return { ...span, outcome: "failed", operation: null, changed: false };
  const plan = todoList(typeof steps === "function" ? steps(span.hashes) : steps, { refs: await movingRefs(git, root, span.hashes) });
  if (!plan.ok) return refused(plan.err, plan.msg);
  const before = await readOperation(git, root);
  // --no-autostash: the person's rebase.autoStash would put the changes aside too.
  const run = await git(root, ["rebase", "-i", "--no-autostash", "--no-autosquash", isRoot ? "--root" : `${oldest}^`], {
    timeout: TIMEOUT,
    env: { GIT_SEQUENCE_EDITOR: SEQUENCE_EDITOR, GIT_EDITOR: "true", GITTOOLS_TODO: plan.lines.join("\n"), ...plan.env },
  });
  const after = await readOperation(git, root);
  const outcome = settle(before, after, run);
  return result({ ...run, ok: outcome === "done" || outcome === "stopped" }, { outcome, operation: after.ok ? after : null, changed: true });
}

// Every commit from `facts.oldest` to HEAD as a step: `pick` unless `change` says else.
async function replay(git, root, facts, change) {
  if (!facts.oldest) return refused("The selected commits are not in one line of history from the current commit.", { key: "rewrite.notOneLine", args: {} });
  return runPlan(git, root, { oldest: facts.oldest, steps: change });
}

// ---- the edits

// undoCommit(git, root, { commit }) → a result
//   Undo Commit: the current branch goes back one commit (`reset --soft`); what the
//   commit held stays staged, a new file as added. Only on the last commit (`commit`
//   must be HEAD) and not on the first one.
export async function undoCommit(git, root, { commit } = {}) {
  const { facts, no } = await checked(git, root, [commit], "undo");
  if (no) return no;
  const r = await git(root, ["reset", "-q", "--soft", `${facts.head}~1`, "--"]);
  return result(r, { outcome: r.ok ? "done" : "failed", operation: null, changed: true });
}

// editMessage(git, root, { commit, message }) → a result
//   Edit Commit Message: HEAD gets the message by amending only the message (nothing
//   staged goes in); an older commit is replayed with it (reword).
export async function editMessage(git, root, { commit, message } = {}) {
  if (typeof message !== "string" || !message.trim()) return refused("Specify a commit message.", { key: "commit.noMessage", args: {} });
  const { facts, no } = await checked(git, root, [commit], "editMessage");
  if (no) return no;
  if (commit === facts.head) {
    const r = await git(root, ["commit", "--amend", "--only", "--allow-empty", "-q", "--cleanup=whitespace", "-m", message],{ timeout: TIMEOUT, env: { GIT_EDITOR: "true" } });
    return result(r, { outcome: r.ok ? "done" : "failed", operation: null, changed: r.ok });
  }
  return replay(git, root, facts, (hashes) => hashes.map((hash) => (hash === commit ? { hash, action: "reword", message } : { hash, action: "pick" })));
}

// dropCommits(git, root, { commits }) → a result
//   Drop Commits: the commits leave the current branch; the ones after them are replayed.
export async function dropCommits(git, root, { commits } = {}) {
  const list = Array.isArray(commits) ? commits : [];
  const { facts, no } = await checked(git, root, list, "drop");
  if (no) return no;
  const gone = new Set(list);
  return replay(git, root, facts, (hashes) => hashes.map((hash) => ({ hash, action: gone.has(hash) ? "drop" : "pick" })));
}

// ---- Interactively Rebase from Here

// readRebaseCommits(git, root, commit) → { ok, err, msg?, commits }
//   What the Rebasing Commits dialog lists: `commit` (a full hash) and every commit after
//   it up to HEAD, oldest first: [{ hash, subject, message (whole), author, time (unix
//   seconds, authored) }]. Not checked against the edit check: interactiveRebase is.
export async function readRebaseCommits(git, root, commit) {
  if (!HASH.test(String(commit ?? ""))) return { ...unknown(commit ?? ""), commits: [] };
  const parents = await git.read(root, ["rev-list", "--no-walk", "--parents", commit, "--"]);
  if (!parents.ok) return { ...unknown(commit), commits: [] };
  const isRoot = lines(parents.out)[0]?.split(" ").length === 1;
  const r = await git.read(root, ["log", "--reverse", "--topo-order", "-z", "--format=%H%x1f%an%x1f%at%x1f%B", isRoot ? "HEAD" : `${commit}^..HEAD`, "--"]);
  if (!r.ok) return { ...result(r), commits: [] };
  const commits = r.out.split("\0").filter((rec) => rec.includes("\x1f")).map((rec) => {
    const [hash, author, time, ...rest] = rec.split("\x1f");
    const message = rest.join("\x1f").replace(/\n+$/, "");
    return { hash: hash.trim(), subject: message.split("\n")[0], message, author, time: Number(time) };
  });
  return { ok: true, code: 0, out: "", err: "", commits };
}

// interactiveRebase(git, root, { commit, steps }) → a result
//   Start Rebasing: replays the current branch from `commit` with steps (rebase-plan.js
//   todoList), one for each commit readRebaseCommits listed, in the order to replay. A
//   list that isn't those commits any more (the branch moved since the dialog read it)
//   is refused. Every step a drop: the branch goes back to the commit before `commit`.
//   A step `edit` stops the rebase there (outcome "stopped", a rebase in progress).
export async function interactiveRebase(git, root, { commit, steps } = {}) {
  const { no } = await checked(git, root, [commit], "interactiveRebase");
  if (no) return no;
  const list = Array.isArray(steps) ? steps : [];
  const now = await readRebaseCommits(git, root, commit);
  if (!now.ok) return { ...now, outcome: "failed", operation: null, changed: false };
  const given = list.map((s) => s?.hash), there = now.commits.map((c) => c.hash);
  const same = given.length === there.length && new Set(given).size === given.length && given.every((h) => there.includes(h));
  if (!same) return refused("The branch has changed since its commits were listed. Open the dialog again.", { key: "interactive.moved", args: {} });
  return runPlan(git, root, { oldest: commit, steps: list });
}

// squashCommits(git, root, { commits, message }) → a result
//   Squash Commits: two or more commits become one with `message`, where the oldest of
//   them was (its author); the other commits keep their order after it.
export async function squashCommits(git, root, { commits, message } = {}) {
  const list = Array.isArray(commits) ? commits : [];
  const { facts, no } = await checked(git, root, list, "squash");
  if (no) return no;
  if (typeof message !== "string" || !message.trim()) return refused("Specify a commit message.", { key: "commit.noMessage", args: {} });
  const picked = new Set(list);
  return replay(git, root, facts, (hashes) => {
    const steps = [];
    for (const hash of hashes) {
      if (hash === facts.oldest) {
        steps.push({ hash, action: "pick" });
        hashes.filter((h) => picked.has(h) && h !== hash).forEach((h, i) => steps.push({ hash: h, action: "fixup", ...(i === 0 ? { message } : {}) }));
      } else if (!picked.has(hash)) steps.push({ hash, action: "pick" });
    }
    return steps;
  });
}

// fixupInto(git, root, { commit, files, squash, message }) → a result
//   Fixup… and Squash Into…: the checked files (`files`, [{ path, status }] as the Commit
//   panel's Included, git-commit.js commit) go into `commit`, an older commit of the
//   current branch: committed first as a `fixup! <subject>` (`squash!`) commit, then
//   melded into it by a replay. Fixup keeps the commit's message; Squash Into gives it
//   `message`. The commit keeps its author.
//   Changes to tracked files left unchecked would stop the replay: refused before the
//   commit is made, naming them (`blocked`). Untracked files left unchecked stay as
//   they are.
export async function fixupInto(git, root, { commit, files, squash = false, message } = {}) {
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f?.path === "string" && f.path);
  if (squash && (typeof message !== "string" || !message.trim())) return refused("Specify a commit message.", { key: "commit.noMessage", args: {} });
  const { facts, no } = await checked(git, root, [commit], squash ? "squashInto" : "fixup");
  if (no) return no;
  if (!list.length) return refused(english("rewrite.nothingToCommit"), { key: "rewrite.nothingToCommit", args: {} });
  const local = await trackedChanges(git, root);
  if (!local.ok) return { ...result(local), outcome: "failed", operation: null, changed: false };
  const picked = new Set(list.map((f) => f.path));
  const left = local.paths.filter((path) => !picked.has(path));
  if (left.length) return localRefusal(left);
  const said = await readMessages(git, root, [commit]);
  if (!said.ok) return { ...result(said), outcome: "failed", operation: null, changed: false };
  const subject = (said.messages[commit] ?? "").split("\n")[0].trim() || commit.slice(0, 8);
  const made = await commitFiles(git, root, { files: list, message: `${squash ? "squash" : "fixup"}! ${subject}` });
  // A refused commit (a hook) may still have touched the index.
  if (!made.ok) return { ...result(made), outcome: "failed", operation: null, changed: true };
  const added = await git.read(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!added.ok) return { ...result(added), outcome: "failed", operation: null, changed: true };
  const mine = added.out.trim();
  const r = await runPlan(git, root, {
    oldest: facts.oldest,
    steps: (hashes) => hashes.filter((h) => h !== mine).flatMap((hash) => (hash === commit
      ? [{ hash, action: "pick" }, { hash: mine, action: squash ? "squash" : "fixup", ...(squash ? { message } : {}) }]
      : [{ hash, action: "pick" }])),
  });
  // The fixup commit is in either way: the screens read the repository again.
  return { ...r, changed: true };
}

// The paths `commit` changes from its first parent (all of them for the first commit),
// a rename as its two paths: { ok, paths }.
async function changedPaths(git, root, commit) {
  const r = await git.read(root, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "--name-only", "-z", commit, "--"]);
  return r.ok ? { ok: true, paths: new Set(r.out.split("\0").filter(Boolean)) } : r;
}

// Extract and Drop Selected Changes: `action` on `paths` of `commit`.
async function fileEdit(git, root, { commit, paths, message }, action) {
  const wanted = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p))];
  if (action === "extractChanges" && (typeof message !== "string" || !message.trim())) return refused("Specify a commit message.", { key: "commit.noMessage", args: {} });
  const changed = HASH.test(String(commit ?? "")) ? await changedPaths(git, root, commit) : { ok: false };
  const picked = changed.ok ? wanted.filter((p) => changed.paths.has(p)) : [];
  const { facts, no } = await checked(git, root, [commit], action, changed.ok ? { picked: picked.length, total: changed.paths.size } : null);
  if (no) return no;
  if (!changed.ok) return { ...result(changed), outcome: "failed", operation: null, changed: false };
  const first = facts.commits[0]?.parents === 0;
  return replay(git, root, facts, (hashes) => hashes.map((hash) => (hash === commit
    ? { hash, action, paths: picked, ...(first ? { root: true } : {}), ...(action === "extractChanges" ? { message } : {}) }
    : { hash, action: "pick" })));
}

// extractChanges(git, root, { commit, paths, message }) → a result
//   Extract Selected Changes to Separate Commit…: `commit` splits in two, first without
//   the changes to `paths` (its message), then a new commit of them with `message`; both
//   keep its author. The tree at the end is the same. Off when `paths` are all of the
//   commit's files, or none of them.
export const extractChanges = (git, root, args = {}) => fileEdit(git, root, args, "extractChanges");

// dropChanges(git, root, { commit, paths }) → a result
//   Drop Selected Changes: the changes to `paths` leave `commit` (those files as its
//   parent had them); the commits after it are replayed with their own changes. Off when
//   `paths` are all of the commit's files, or none of them.
export const dropChanges = (git, root, args = {}) => fileEdit(git, root, args, "dropChanges");
