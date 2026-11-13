// Resetting the current branch to a commit: soft, mixed, hard or keep. A hard reset first
// records every local change (working tree and staging, and the untracked files the reset
// writes over) as a snapshot named "Reset"
// (git-snapshot.js), so Restore can bring them back; when it can't be recorded, nothing
// is reset. No `herdr` import: node tests it against real repositories (git-reset.test.mjs).

import { record } from "./git-snapshot.js";

export const RESET_MODES = ["soft", "mixed", "hard", "keep"];
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const invalid = { ok: false, code: -1, out: "", err: "The specified commit expression did not pass validation.", msg: { key: "reset.invalidCommit" }, hash: null };

// checkCommit(git, root, expr) → { ok, code, out, err, msg?, hash }
//   The commit `expr` names (a hash, a branch, a tag, "HEAD~1"), as its full hash. Any
//   expression that isn't one commit is refused with reset.invalidCommit and hash null.
export async function checkCommit(git, root, expr) {
  const wanted = String(expr ?? "").trim();
  // Never an option: rev-parse would take "-q" or "--all" as one.
  if (!wanted || wanted.startsWith("-")) return invalid;
  const r = await git.read(root, ["rev-parse", "-q", "--verify", "--end-of-options", `${wanted}^{commit}`]);
  if (!r.ok) return invalid;
  return { ok: true, code: 0, out: "", err: "", hash: r.out.trim() };
}

// currentBranch(git, root) → { ok, code, out, err, branch }: the branch HEAD is on, by its
// short name, or null on a detached HEAD.
export async function currentBranch(git, root) {
  const r = await git.read(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (r.ok) return { ok: true, code: 0, out: "", err: "", branch: r.out.trim() };
  if (r.code === 1) return { ok: true, code: 0, out: "", err: "", branch: null };
  return { ...r, branch: null };
}

// Every path the working tree or the index has otherwise than HEAD (untracked files
// aside): { ok, paths }. A rename is its two paths.
async function localChanges(git, root) {
  const found = new Set();
  for (const cached of [false, true]) {
    const r = await git.read(root, ["diff",...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD", "--"]);
    if (!r.ok) return r;
    for (const path of r.out.split("\0")) if (path) found.add(path);
  }
  return { ok: true, paths: [...found].sort() };
}

// The untracked files (ignored ones aside) a hard reset to `commit` writes over: the commit
// tracks that path, a file where one of its folders goes, or a path under one of its
// files. { ok, paths }. The other untracked files the reset leaves alone.
async function untrackedInTheWay(git, root, commit) {
  const loose = await git.read(root, ["ls-files", "-z", "-o", "--exclude-standard"]);
  if (!loose.ok) return loose;
  const paths = loose.out.split("\0").filter(Boolean);
  if (!paths.length) return { ok: true, paths };
  const tree = await git.read(root, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit]);
  if (!tree.ok) return tree;
  const files = new Set(), folders = new Set();
  for (const path of tree.out.split("\0")) {
    if (!path) continue;
    files.add(path);
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) folders.add(path.slice(0, i));
  }
  const under = (path) => {
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) if (files.has(path.slice(0, i))) return true;
    return false;
  };
  return { ok: true, paths: paths.filter((path) => files.has(path) || folders.has(path) || under(path)) };
}

// resetTo(git, root, { commit, mode, copy }) → { ok, code, out, err, msg?, snapshot, changed }
//   Moves the current branch (or a detached HEAD) to `commit`, a full hash (checkCommit),
//   with `mode`, one of RESET_MODES:
//   - soft: the index and the files stay; what the commits held is staged.
//   - mixed: the index follows, the files stay.
//   - hard: the index and the files follow. Before it, every local change, and each
//     untracked file at a path `commit` tracks (untrackedInTheWay), is recorded as a
//     snapshot named "Reset" (`copy`: the calling copy's id, as for git-snapshot.js record);
//     snapshot is its hash, or null when nothing local changed. Not recorded: not reset
//     (reset.notRecorded, with the cause's words).
//   - keep: the files the two commits differ in follow; local changes stay. git refuses
//     when a local change is in such a file, and then nothing changes (its words in err).
//   changed: the repository may have changed (a failed reset may still have moved things).
export async function resetTo(git, root, { commit, mode, copy } = {}) {
  const none = { snapshot: null, changed: false };
  if (!RESET_MODES.includes(mode)) return { ok: false, code: -1, out: "", err: `Unknown reset mode: ${mode}`, msg: { key: "reset.unknownMode", args: { mode: String(mode) } }, ...none };
  if (!HASH.test(String(commit ?? ""))) return { ...invalid, ...none };
  const known = await git.read(root, ["cat-file", "-e", `${commit}^{commit}`]);
  if (!known.ok) return { ...invalid, ...none };
  let snapshot = null;
  if (mode === "hard") {
    const local = await localChanges(git, root);
    const loose = local.ok ? await untrackedInTheWay(git, root, commit) : local;
    const paths = loose.ok ? [...new Set([...local.paths, ...loose.paths])].sort() : [];
    const made = loose.ok ? await record(git, root, paths, copy, "Reset") : loose;
    if (!made.ok) {
      const cause = made.msg ? { cause: made.msg } : {};
      return { ok: false, code: made.code, out: "", err: `Nothing was reset: the local changes couldn't be recorded first.\n${made.err}`, msg: { key: "reset.notRecorded", args: { err: made.err }, ...cause }, ...none };
    }
    snapshot = made.snapshot;
  }
  const r = await git(root, ["reset", "-q", `--${mode}`, commit, "--"]);
  if (!r.ok) {
    // keep refuses before it writes anything; any other failure may have moved something.
    return { ok: false, code: r.code, out: r.out, err: r.err, snapshot, changed: mode !== "keep" };
  }
  return { ok: true, code: 0, out: r.out, err: "", snapshot, changed: true };
}
