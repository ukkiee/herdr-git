// New Worktree and Checkout Tag or Revision: the git side. No herdr import; every
// function returns { ok, code, out, err, msg?, … } and never throws.
//
//   worktreeSources(git, root)                      the New Worktree dialog's source list
//   worktreePath(root, branch)                      the location it suggests
//   createWorktree(git, root, { source, newBranch?, path })
//   checkoutRef(git, root, text)                    a detached HEAD at a tag, branch or hash
//
// The new worktree's git folder is under this repository's, outside the folder the
// panels watch: its own writes show here on the next read, not at once.

import { checkBranchName, checkoutRevision } from "./git-branch.js";

const HEADS = "refs/heads/", REMOTES = "refs/remotes/";
const refused = (err, msg) => ({ ok: false, code: -1, out: "", err, msg });
// Checking out a big tree can take a while: as long as a commit may.
const ADD_TIMEOUT = 600000;

// A path the dialog may hand to git as is: from the root on Unix, a drive or a share on
// Windows. "~" isn't one: nothing expands it on the way to git.
const fullPath = (path) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);

// worktreeSources(git, root) → { ok, branches: [{ name, scope: "local" | "remote",
// checkedOut: path | null }], current: branch | null } or { ok: false, err }. Local
// branches first, then remote ones, each by name; a remote's HEAD is left out.
// checkedOut: the worktree that has that local branch checked out, this one included
// (%(worktreepath), git 2.23).
export async function worktreeSources(git, root) {
  const [refs, head] = await Promise.all([
    git.read(root, ["for-each-ref", "--format=%(refname)%00%(symref)%00%(worktreepath)", HEADS, REMOTES]),
    git.read(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  if (!refs.ok) return { ok: false, code: refs.code, out: "", err: refs.err || "git for-each-ref failed." };
  const local = [], remote = [];
  for (const line of refs.out.split("\n")) {
    const [ref, symref, path] = line.split("\0");
    if (!ref || symref) continue;
    if (ref.startsWith(HEADS)) local.push({ name: ref.slice(HEADS.length), scope: "local", checkedOut: path || null });
    else if (ref.startsWith(REMOTES)) remote.push({ name: ref.slice(REMOTES.length), scope: "remote", checkedOut: null });
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { ok: true, code: 0, out: "", err: "", branches: [...local.sort(byName), ...remote.sort(byName)], current: head.ok ? head.out.trim() || null : null };
}

// worktreePath(root, branch) → the folder beside the repository named after it and the
// branch: "/work/app" and "feature/login" → "/work/app-feature-login".
export function worktreePath(root, branch) {
  const trimmed = String(root ?? "").replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = trimmed.slice(0, cut + 1), name = trimmed.slice(cut + 1);
  const part = String(branch ?? "").replace(/[\\/]+/g, "-");
  return `${parent}${name}${part ? `-${part}` : ""}`;
}

// createWorktree(git, root, { source: { name, scope }, newBranch?, path }) → git's result
// with path. With newBranch, that branch is made at the source and checked out there.
// Without one, a local source is checked out there: git refuses one another worktree
// has, and its words come back. A remote source without one gives a detached HEAD at its
// commit, as git does for any ref that isn't a local branch.
export async function createWorktree(git, root, { source, newBranch, path } = {}) {
  if (!source || typeof source.name !== "string" || !source.name) return refused("Choose a branch to start from.", { key: "worktree.needSource", args: {} });
  const where = String(path ?? "").trim();
  if (!where) return refused("Enter a location.", { key: "worktree.needPath", args: {} });
  if (!fullPath(where)) return refused(`'${where}' is not a full path.`, { key: "worktree.pathNotFull", args: { path: where } });
  const from = source.scope === "remote" ? REMOTES + source.name : source.name;
  const args = ["worktree", "add"];
  const wanted = typeof newBranch === "string" ? newBranch.trim() : "";
  if (wanted) {
    const check = await checkBranchName(git, root, wanted);
    if (!check.ok) return refused(check.reason, check.msg);
    // The full ref: a local branch and a tag may share a name.
    args.push("-b", wanted, "--end-of-options", where, source.scope === "remote" ? from : HEADS + source.name);
  } else {
    // A local branch by its short name: the full ref would detach HEAD instead.
    args.push("--end-of-options", where, from);
  }
  return { ...(await git(root, args, { timeout: ADD_TIMEOUT })), path: where };
}

// checkoutRef(git, root, text) → git's result: HEAD detached at the commit a tag, branch
// or hash names; a name nothing has is refused and HEAD stays.
export async function checkoutRef(git, root, text) {
  const ref = String(text ?? "").trim();
  if (!ref) return refused("Enter a reference name or a commit hash.", { key: "worktree.enterRef", args: {} });
  const found = ref.startsWith("-") ? { ok: false } : await git.read(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (!found.ok || !found.out.trim()) return refused(`Nothing is called '${ref}'.`, { key: "worktree.unknownRef", args: { ref } });
  return checkoutRevision(git, root, found.out.trim());
}
