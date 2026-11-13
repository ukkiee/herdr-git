// Comparing: two branches' own commits, the working tree against a branch or a commit,
// two commits, and taking files from a revision (Get from Revision, Get from Branch).
// Also a file's parent version (Compare Before with Local, Show Changes to Parents) and a
// file as a commit has it (Open Repository Version).
// Every function takes `git` from makeGit (git.js) and the repository root, and returns
// a result instead of throwing. No `herdr` import: node tests it (git-compare.test.mjs).

import { chunks } from "./git.js";
import { parseDiff } from "./git-diff.js";
import { record } from "./git-snapshot.js";

// A path is a path, not a pattern: `app/[id]/page.tsx` must not be read as a glob.
const LITERAL = "--literal-pathspecs";
// The person's git config must not change what comes back (as git-diff.js reads a diff).
const PLAIN = ["--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
const short = (hash) => String(hash ?? "").slice(0, 7);

// ---- Compare with '<branch>': the commits each side has and the other hasn't

// Fields split on 0x1f, commits on NUL (-z): a subject holds neither.
const FIELDS = ["%H", "%P", "%aN", "%aE", "%at", "%s"].join("%x1f");

function parseCommits(out) {
  return out.split("\0").filter((entry) => entry.trim()).map((entry) => {
    const [hash, parents, author, email, time, subject] = entry.replace(/^\n/, "").split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], author, email, time: Number(time), subject: subject ?? "" };
  });
}

// filterArgs as git-log-filter.js makes them: options, then "--" and paths.
function splitFilter(filterArgs) {
  const at = filterArgs.indexOf("--");
  return at < 0 ? { options: filterArgs, paths: [] } : { options: filterArgs.slice(0, at), paths: filterArgs.slice(at + 1) };
}

async function only(git, root, keep, drop, filterArgs) {
  const { options, paths } = splitFilter(filterArgs);
  // --end-of-options: a branch name is read as a revision, never a flag.
  return git.read(root, ["log", "-z", `--format=${FIELDS}`, ...options, "--end-of-options", keep, `^${drop}`, "--", ...paths]);
}

// branchCommits(git, root, { a, b, filterArgs? }) → { ok, code, out, err, onlyA, onlyB }
//   onlyA: the commits reachable from a and not from b, newest first; onlyB the other
//   way. Each: { hash, parents, author, email, time (unix seconds), subject }.
//   filterArgs: extra `git log` arguments (git-log-filter.js filterArgs), the same for both.
export async function branchCommits(git, root, { a, b, filterArgs = [] } = {}) {
  const [ra, rb] = await Promise.all([only(git, root, a, b, filterArgs), only(git, root, b, a, filterArgs)]);
  const failed = !ra.ok ? ra : !rb.ok ? rb : null;
  if (failed) return { ...failed, onlyA: [], onlyB: [] };
  return { ok: true, code: 0, out: "", err: "", onlyA: parseCommits(ra.out), onlyB: parseCommits(rb.out) };
}

// ---- Show Diff with Working Tree, Compare with Local: the working tree against a revision

// workingTreeFiles(git, root, ref) → { ok, code, out, err, files }
//   The tracked files whose working-tree content differs from `ref` (a branch or a
//   commit), uncommitted changes included. files: [{ path, state }], state:
//     "changed"    in both, different (blue)
//     "only-ref"   only `ref` has it (gray)
//     "only-local" only the working tree has it (green)
export async function workingTreeFiles(git, root, ref) {
  const r = await git.read(root, ["diff", "--no-renames", "--name-status", "-z", "--end-of-options", String(ref), "--"]);
  if (!r.ok) return { ...r, files: [] };
  const parts = r.out.split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const letter = parts[i][0], path = parts[i + 1];
    if (!path) break;
    files.push({ path, state: letter === "A" ? "only-local" : letter === "D" ? "only-ref" : "changed" });
  }
  return { ...r, files };
}

// Swap branches: what was only on one side is only on the other.
export const swapState = (state) => (state === "only-ref" ? "only-local" : state === "only-local" ? "only-ref" : state);

// ---- Compare Versions: two commits

const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", C: "added" };

// versionFiles(git, root, from, to) → { ok, code, out, err, files }
//   The files changed from commit `from` to commit `to`: [{ path, status, from }], status
//   "modified" | "added" | "deleted" | "renamed" (from: the old path of a renamed file).
export async function versionFiles(git, root, from, to) {
  const r = await git.read(root, ["diff-tree", "-r", "-M", "--name-status", "-z", "--end-of-options", String(from), String(to), "--"]);
  if (!r.ok) return { ...r, files: [] };
  const parts = r.out.split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length;) {
    const letter = parts[i++][0], pair = letter === "R" || letter === "C";
    const old = pair ? parts[i++] : null, path = parts[i++];
    if (!path) break;
    files.push({ path, status: STATUS[letter] ?? "modified", from: letter === "R" ? old : null });
  }
  return { ...r, files };
}

// ---- Get from Revision, Get from Branch

// The paths among `paths` with a local change (staged, unstaged or untracked).
async function changedPaths(git, root, paths) {
  const wanted = new Set(paths), out = new Set();
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, [LITERAL, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...chunk]);
    if (!r.ok) return r;
    const parts = r.out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const path = entry.slice(3);
      if (wanted.has(path)) out.add(path);
      // A rename or copy names its source next.
      if (entry[0] === "R" || entry[0] === "C") { const from = parts[++i]; if (wanted.has(from)) out.add(from); }
    }
  }
  return { ok: true, paths: [...out] };
}

// The paths among `paths` that commit `rev` has.
async function inRevision(git, root, rev, paths) {
  const out = new Set();
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, [LITERAL, "ls-tree", "-r", "-z", "--name-only", rev, "--", ...chunk]);
    if (!r.ok) return r;
    for (const path of r.out.split("\0")) if (path) out.add(path);
  }
  return { ok: true, paths: out };
}

// getFromRevision(git, root, { rev, paths, copy }) → { ok, code, out, err, msg?, snapshot }
//   Sets each of `paths` to its version in `rev` (a commit or a branch), in the working
//   tree and the index; a path `rev` doesn't have is removed from both. Paths with a local
//   change are first recorded as a Rollback snapshot (git-snapshot.js record; copy: the
//   calling copy's id). When the snapshot can't be made nothing is changed and msg says
//   so. snapshot: its hash, or null when no path had a local change.
export async function getFromRevision(git, root, { rev, paths = [], copy } = {}) {
  if (!paths.length) return { ok: false, code: -1, out: "", err: "No files to get.", msg: { key: "compare.noFiles", args: {} }, snapshot: null };
  const at = await git.read(root, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]);
  if (!at.ok) return { ...at, snapshot: null };
  const hash = at.out.trim();
  const has = await inRevision(git, root, hash, paths);
  if (!has.ok) return { ...has, snapshot: null };
  const changed = await changedPaths(git, root, paths);
  if (!changed.ok) return { ...changed, snapshot: null };
  const kept = await record(git, root, changed.paths, copy);
  if (!kept.ok) {
    const err = `The local changes couldn't be kept as a Rollback snapshot, so nothing was replaced: ${kept.err}`;
    return { ok: false, code: kept.code, out: "", err, msg: { key: "compare.notRecorded", args: { err: kept.err } }, snapshot: null };
  }
  const { snapshot } = kept;
  for (const chunk of chunks(paths.filter((path) => has.paths.has(path)))) {
    const r = await git(root, [LITERAL, "checkout", "-q", hash, "--", ...chunk]);
    if (!r.ok) return { ...r, snapshot };
  }
  // git deletes the file itself, and only what its index has.
  for (const chunk of chunks(paths.filter((path) => !has.paths.has(path)))) {
    const r = await git(root, [LITERAL, "rm", "-q", "-f", "--ignore-unmatch", "--", ...chunk]);
    if (!r.ok) return { ...r, snapshot };
  }
  return { ok: true, code: 0, out: "", err: "", snapshot };
}

// ---- a file's parent version and a commit's file

// fileParent(git, root, { commit, path, from? }) → { ok, code, out, err, parent, path }
//   parent: the commit's first parent (full hash), null for a commit without one.
//   path: where the file was in the parent: `from` for a file the commit renamed.
export async function fileParent(git, root, { commit, path, from = null } = {}) {
  const r = await git.read(root, ["rev-list", "--parents", "-n", "1", "--end-of-options", String(commit), "--"]);
  if (!r.ok) return { ...r, parent: null, path: from ?? path };
  const [, parent] = r.out.trim().split(/\s+/);
  return { ...r, parent: parent ?? null, path: from ?? path };
}

// readLocalDiff(git, root, { rev, path, oldPath? }) → { ok, err, binary, truncated, from, to, rows }
//   The file as `rev` has it against the working file, as readDiff (git-diff.js) reads
//   one: rows to draw. oldPath: the file's name in `rev` when it has been renamed since.
//   from: the short hash; to: "" (the working tree).
export async function readLocalDiff(git, root, { rev, path, oldPath = null } = {}) {
  const renamed = Boolean(oldPath && oldPath !== path);
  const args = renamed
    ? [LITERAL, "diff", ...PLAIN, "-M", "--end-of-options", String(rev), "--", oldPath, path]
    : [LITERAL, "diff", ...PLAIN, "--no-renames", "--end-of-options", String(rev), "--", path];
  const r = await git.read(root, args);
  if (!r.ok) return { ok: false, err: r.err, binary: false, truncated: false, from: short(rev), to: "", rows: [] };
  return { ok: true, err: "", ...parseDiff(r.out), from: short(rev), to: "" };
}

// readRevisionFile(git, root, { rev, path }) → { ok, code, out, err, text, binary }
//   The file's content in commit `rev`. binary: it holds a NUL byte (text is then "").
export async function readRevisionFile(git, root, { rev, path } = {}) {
  const r = await git.read(root, ["cat-file", "blob", `${rev}:${path}`]);
  if (!r.ok) return { ...r, text: "", binary: false };
  const binary = r.out.includes("\0");
  return { ...r, text: binary ? "" : r.out, binary };
}
