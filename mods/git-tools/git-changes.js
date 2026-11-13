// Some files of a commit applied on their own: Revert Selected Changes (those files'
// changes undone, as a new commit) and Cherry-Pick Selected Changes (those files' changes
// brought into the working tree, not committed). Commit details' file menu and toolbar
// call these. Every function takes `git` from makeGit (git.js) and the repository root,
// and returns a result instead of throwing; a sentence the mod words itself comes in
// English in `err` with its key in `msg` ({ key, args }, i18n.js).
//
// How: a commit is made that changes only those files the way the request needs (the
// commit's own change for a cherry-pick, its reverse for a revert), built in a scratch
// index so the real one is not touched, and `cherry-pick --no-commit` applies it 3-way.
// `--no-commit` leaves no operation in progress when it meets a conflict (it writes no
// CHERRY_PICK_HEAD), only the files in conflict: Conflicts dialog resolves them, as after
// a stash that came back in conflict. `revert --no-commit` would leave REVERT_HEAD, so the
// revert goes through the same cherry-pick of a reversed commit. MERGE_MSG keeps the
// built commit's message, which a later `git commit` starts from.

import { readOperation } from "./git-operation.js";

// Applying may run for a while on a big tree; committing may run hooks.
const TIMEOUT = 600000;
const NO_EDITOR = { GIT_EDITOR: "true" };
// Paths are names, not patterns: "*.ts" is that file only.
const LITERAL = "--literal-pathspecs";
const COMMIT = /^[0-9a-f]{7,64}$/;

const result = (r, extra = {}) => ({ ok: Boolean(r.ok), code: r.code ?? (r.ok ? 0 : -1), out: r.out ?? "", err: r.err ?? "", ...(r.msg ? { msg: r.msg } : {}), ...extra });
const said = (err, msg, extra = {}) => ({ ok: false, code: -1, out: "", err, msg, ...extra });
const NOTHING = { outcome: "failed", operation: null, conflicts: [] };
const z = (out) => out.split("\0").filter(Boolean);

// The scratch index, one per repository: the write lock lets one git-tools write run on a
// repository at a time. It is emptied after use; the file stays.
const scratchIndex = (dir) => `${dir}/git-tools-changes-index`;

// The commit and the paths asked for, checked: { commit, paths } or a refusal.
function request(args) {
  const commit = typeof args?.commit === "string" && COMMIT.test(args.commit) ? args.commit : null;
  const paths = Array.isArray(args?.paths) ? [...new Set(args.paths.filter((p) => typeof p === "string" && p))] : [];
  if (!commit) return { no: said("No commit to take the changes from.", { key: "pick.noCommits" }, NOTHING) };
  if (!paths.length) return { no: said("No files selected.", { key: "pick.noFiles" }, NOTHING) };
  return { commit, paths };
}

// The commit's hash, first parent (null for the first commit), subject, author and message.
async function readCommit(git, root, commit) {
  const r = await git.read(root, ["log", "-1", "-z", "--format=%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%B", "--end-of-options", commit, "--"]);
  if (!r.ok) return r;
  const [hash, parents, subject, name, email, date, body] = r.out.replace(/\0$/, "").split("\x1f");
  return { ok: true, hash, parent: (parents ?? "").split(" ").filter(Boolean)[0] ?? null, subject: subject ?? "", author: { name, email, date }, message: (body ?? "").replace(/\s+$/, "") };
}

// A commit on `from` (a commit, or null for nothing) whose tree is `from`'s with `paths`
// as `to` (a commit, or null) has them: { ok, hash } or { ok, same: true } when that
// changes nothing. env: author variables for the commit.
async function built(git, root, { from, to, paths, message, env = {} }) {
  const dir = await git.read(root, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return dir;
  const index = { GIT_INDEX_FILE: scratchIndex(dir.out.trim()) };
  const made = await build(git, root, { from, to, paths, message, env, index });
  await git(root, ["read-tree", "--empty"], { env: index });
  return made;
}

async function build(git, root, { from, to, paths, message, env, index }) {
  const start = await git(root, from ? ["read-tree", from] : ["read-tree", "--empty"], { env: index });
  if (!start.ok) return start;
  const listed = to ? await git.read(root, [LITERAL, "ls-tree", "-z", "--full-tree", to, "--", ...paths]) : { ok: true, out: "" };
  if (!listed.ok) return listed;
  const entries = z(listed.out).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, , object] = line.slice(0, tab).split(" ");
    return { mode, object, path: line.slice(tab + 1) };
  });
  const there = new Set(entries.map((e) => e.path));
  const gone = paths.filter((p) => !there.has(p));
  if (gone.length) {
    const r = await git(root, ["update-index", "--force-remove", "--", ...gone], { env: index });
    if (!r.ok) return r;
  }
  if (entries.length) {
    const r = await git(root, ["update-index", "--add", ...entries.flatMap((e) => ["--cacheinfo", `${e.mode},${e.object},${e.path}`])], { env: index });
    if (!r.ok) return r;
  }
  const tree = await git(root, ["write-tree"], { env: index });
  if (!tree.ok) return tree;
  // Without `from` the tree started empty: it changed only if something went in.
  const before = from ? await git.read(root, ["rev-parse", `${from}^{tree}`]) : { ok: true, out: entries.length ? "" : tree.out };
  if (!before.ok) return before;
  if (before.out.trim() === tree.out.trim()) return { ok: true, same: true };
  const commit = await git(root, ["commit-tree", tree.out.trim(), ...(from ? ["-p", from] : []), "-m", message], { env: { ...index, ...env } });
  if (!commit.ok) return commit;
  return { ok: true, hash: commit.out.trim() };
}

// The paths whose content in the index differs from HEAD's, among `paths`.
async function stagedAmong(git, root, paths) {
  const r = await git.read(root, [LITERAL, "diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--", ...paths]);
  return r.ok ? { ok: true, paths: z(r.out) } : r;
}

// Applies `pick` (a built commit) to the index and the working tree, and says how it went:
//   done: applied. stopped: files left in conflict (operation: readOperation after, its
//   conflicts). refused: local changes to the files stood in the way (blocked: those of
//   `paths`), nothing changed. failed: anything else, with git's words.
async function apply(git, root, pick, paths) {
  const before = await git.read(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const r = await git(root, ["cherry-pick", "--no-commit", pick], { timeout: TIMEOUT, env: NO_EDITOR });
  if (r.ok) return { ...result(r), outcome: "done", operation: null, conflicts: [] };
  const after = await readOperation(git, root);
  if (after.ok && after.conflicts.length) return { ...result(r), ok: true, outcome: "stopped", operation: after, conflicts: after.conflicts.map((c) => c.path) };
  // Nothing in conflict: git refused before it touched anything. The local changes to the
  // files are what stood in the way.
  const local = await git.read(root, [LITERAL, "diff", "--name-only", "--no-renames", "-z", "HEAD", "--", ...paths]);
  const blocked = local.ok ? z(local.out) : [];
  const head = await git.read(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (blocked.length && head.out === before.out) return { ...result(r), outcome: "refused", blocked, operation: after.ok ? after : null, conflicts: [] };
  return { ...result(r), outcome: "failed", operation: after.ok ? after : null, conflicts: [] };
}

// The words of a revert's commit: git's own form, naming the files when there are few.
const FILES_NAMED = 3;
export function revertMessage(commit, paths) {
  const which = paths.length <= FILES_NAMED ? paths.join(", ") : `${paths.length} files`;
  return `Revert "${commit.subject}"\n\nThis reverts the changes to ${which} in commit ${commit.hash}.`;
}

// revertChanges(git, root, { commit, paths }) → { ok, code, out, err, msg?, outcome,
//   operation, conflicts, blocked?, commit? }
//   Undoes what `commit` did to `paths` (a rename is its two paths) against its first
//   parent, as a new commit on HEAD by the person (revertMessage). Other changes the person
//   has, staged or not, stay out of it.
//   outcome: "done" (commit: the new commit's hash), "stopped" (conflicts: the files left
//   in conflict, nothing committed: the person resolves them and commits), "empty" (those
//   files are already as before the commit: nothing to do), "refused" (blocked: local
//   changes to the files), "failed". ok: done, stopped or empty.
export async function revertChanges(git, root, args) {
  const asked = request(args);
  if (asked.no) return asked.no;
  const c = await readCommit(git, root, asked.commit);
  if (!c.ok) return { ...result(c), ...NOTHING };
  // A commit on the commit itself whose tree has the files as its parent had them: its
  // change is the reverse of theirs.
  const pick = await built(git, root, { from: c.hash, to: c.parent, paths: asked.paths, message: revertMessage(c, asked.paths) });
  if (!pick.ok) return { ...result(pick), ...NOTHING };
  if (pick.same) return empty();
  const applied = await apply(git, root, pick.hash, asked.paths);
  if (applied.outcome !== "done") return applied;
  const changed = await stagedAmong(git, root, asked.paths);
  if (!changed.ok) return { ...result(changed), ...NOTHING };
  if (!changed.paths.length) return empty();
  // --only: just the reverted files go in, whatever else is staged. Their working files
  // are what was just applied: git refuses to apply over local changes to them.
  const made = await git(root, [LITERAL, "commit", "--only", "-m", revertMessage(c, asked.paths), "--", ...changed.paths], { timeout: TIMEOUT, env: NO_EDITOR });
  if (!made.ok) return { ...result(made), outcome: "failed", operation: null, conflicts: [] };
  const now = await git.read(root, ["rev-parse", "HEAD"]);
  return { ...result(made), outcome: "done", operation: null, conflicts: [], commit: now.ok ? now.out.trim() : null };
}

// cherryPickChanges(git, root, { commit, paths }) → { ok, code, out, err, msg?, outcome,
//   operation, conflicts, blocked? }
//   Brings what `commit` did to `paths` (against its first parent) into the working tree
//   and the index, 3-way, without committing: they become local changes.
//   outcome: as revertChanges, without a commit.
export async function cherryPickChanges(git, root, args) {
  const asked = request(args);
  if (asked.no) return asked.no;
  const c = await readCommit(git, root, asked.commit);
  if (!c.ok) return { ...result(c), ...NOTHING };
  const env = { GIT_AUTHOR_NAME: c.author.name, GIT_AUTHOR_EMAIL: c.author.email, GIT_AUTHOR_DATE: c.author.date };
  const pick = await built(git, root, { from: c.parent, to: c.hash, paths: asked.paths, message: c.message || c.subject, env });
  if (!pick.ok) return { ...result(pick), ...NOTHING };
  if (pick.same) return empty();
  const applied = await apply(git, root, pick.hash, asked.paths);
  if (applied.outcome !== "done") return applied;
  const changed = await stagedAmong(git, root, asked.paths);
  if (changed.ok && !changed.paths.length) return empty();
  return applied;
}

function empty() {
  return { ok: true, code: 0, out: "", err: "", outcome: "empty", operation: null, conflicts: [] };
}
