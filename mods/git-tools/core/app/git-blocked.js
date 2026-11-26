// The local changes in the way of a request (Smart operation): which tracked files a
// checkout, merge, pull, rebase, cherry-pick or revert would write, worked out from the
// request and the repository, never from git's words. And the plain checkout that names
// the files that refused it.
// git-operation.js and git-remote.js use it to tell a refusal apart, and git-smart.js
// exports it again. It imports none of them, so those imports stay one-way.
// No `herdr` import: node tests it against real repositories (git-smart.test.mjs).

import { readStatus } from "./git-status.js";
import { checkout, checkoutRevision } from "./git-branch.js";

const str = (value) => (typeof value === "string" ? value : "");
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const zList = (out) => out.split("\0").map((p) => p.replace(/^\n+/, "")).filter(Boolean);

// The files a revision range changes: [path], or null when git can't say (a branch that
// is gone, no common commit).
async function changedBetween(git, root, args) {
  const r = await git.read(root, ["diff", "--name-only", "-z", "--no-renames", ...args, "--"]);
  return r.ok ? zList(r.out) : null;
}

// The files the commits change against their first parent, a first commit against
// nothing. A merge commit changes none here (cherry-pick and revert don't take one).
async function changedBy(git, root, commits) {
  if (!commits.length) return [];
  const r = await git.read(root, ["log", "--no-walk=unsorted", "--format=", "--name-only", "-z", "--no-renames", "--end-of-options", ...commits, "--"]);
  return r.ok ? zList(r.out) : null;
}

// Where a checkout goes, as git-branch.js checkout goes there: { local, ref, exists }, or
// null when there is no such branch. local: the local branch it ends on; ref: the commit
// it checks out (the local branch, else the remote branch a new local one will track).
export async function checkoutTarget(git, root, { name, remote }) {
  const at = async (ref) => (await git.read(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
  if (!name) return null;
  if (!remote) return (await at(`refs/heads/${name}`)) ? { local: name, ref: `refs/heads/${name}`, exists: true } : null;
  // A remote's own name may hold slashes: the longest remote that fits wins.
  const remotes = await git.read(root, ["remote"]);
  let best = null;
  for (const r of remotes.ok ? remotes.out.split("\n") : []) {
    if (r && name.startsWith(`${r}/`) && name.length > r.length + 1 && (!best || r.length > best.length)) best = r;
  }
  if (!best) return null;
  const local = name.slice(best.length + 1);
  if (await at(`refs/heads/${local}`)) return { local, ref: `refs/heads/${local}`, exists: true };
  return (await at(`refs/remotes/${name}`)) ? { local, ref: `refs/remotes/${name}`, exists: false } : null;
}

// What each request touches, by type: (git, root, args) → [path] the request would write,
// "all" when any tracked change stops it, or null when it has none in its way.
//   checkout: { name, remote? }      files that differ between HEAD and the branch
//             { revision }           or the commit a detached HEAD goes to (full hash)
//   merge: { target }                files the target changed since the common commit
//   pull: { rebase?, target? }       as merge (target: the upstream, "@{upstream}" when
//                                    not given), or as rebase
//   cherry-pick, revert: { commits } files those commits change
//   rebase, checkout-rebase          any tracked change: git refuses on one
// merge, pull (merge), cherry-pick and revert are also stopped by any staged change.
const TOUCHES = {
  checkout: async (git, root, args) => {
    if (str(args.revision)) return changedBetween(git, root, ["HEAD", str(args.revision)]);
    const target = await checkoutTarget(git, root, { name: str(args.name), remote: args.remote === true });
    return target ? changedBetween(git, root, ["HEAD", target.ref]) : [];
  },
  merge: (git, root, args) => changedBetween(git, root, [`HEAD...${str(args.target)}`]),
  pull: (git, root, args) => (args.rebase === true ? "all" : changedBetween(git, root, [`HEAD...${str(args.target) || "@{upstream}"}`])),
  "cherry-pick": (git, root, args) => changedBy(git, root, strings(args.commits)),
  revert: (git, root, args) => changedBy(git, root, strings(args.commits)),
  rebase: () => "all",
  "checkout-rebase": () => "all",
};
const STAGED_STOPS = new Set(["merge", "pull", "cherry-pick", "revert"]);

// blockedBy(git, root, request, { status }?) → { ok, err, paths }
//   The local changes in the way of `request` ({ type, ...args }, TOUCHES above): paths
//   relative to root, in git's order. Untracked files are never counted: a stash doesn't
//   put them away, so Smart can't help with them and git's own words say what happened.
//   A request with no rule (Continue, Abort, Skip) has none. status: a readStatus result
//   read just before, if there is one.
export async function blockedBy(git, root, request = {}, { status } = {}) {
  const rule = Object.prototype.hasOwnProperty.call(TOUCHES, request.type) ? TOUCHES[request.type] : null;
  if (!rule) return { ok: true, err: "", paths: [] };
  const st = status ?? await readStatus(git, root);
  if (!st.ok) return { ok: false, err: st.err, ...(st.msg ? { msg: st.msg } : {}), paths: [] };
  const local = st.changes.filter((c) => c.status !== "conflict");
  if (!local.length) return { ok: true, err: "", paths: [] };
  const touched = await rule(git, root, request);
  const staged = STAGED_STOPS.has(request.type) && request.rebase !== true ? local.filter((c) => c.xy && c.xy[0] !== ".") : [];
  const wanted = touched === "all" ? null : new Set(touched ?? []);
  const paths = local.filter((c) => !wanted || wanted.has(c.path) || staged.includes(c)).map((c) => c.path);
  return { ok: true, err: "", paths };
}

// ---- checkout

// checkoutBranch(git, root, { name, remote? }) → git-branch.js checkout's result with
//   outcome: "done"; "refused" when local changes stand in the way (blocked: their paths,
//   nothing changed); "failed" otherwise (git's words in err).
export async function checkoutBranch(git, root, { name, remote = false } = {}) {
  const r = await checkout(git, root, str(name), { remote: remote === true });
  if (r.ok) return { ...r, outcome: "done", blocked: [] };
  const found = await blockedBy(git, root, { type: "checkout", name: str(name), remote: remote === true });
  const blocked = found.ok ? found.paths : [];
  return { ...r, outcome: blocked.length ? "refused" : "failed", blocked };
}

// checkoutRevisionOf(git, root, { revision }) → as checkoutBranch, for a detached HEAD at
// a commit (git-branch.js checkoutRevision; revision: its full hash).
export async function checkoutRevisionOf(git, root, { revision } = {}) {
  const r = await checkoutRevision(git, root, str(revision));
  if (r.ok) return { ...r, outcome: "done", blocked: [] };
  const found = await blockedBy(git, root, { type: "checkout", revision: str(revision) });
  const blocked = found.ok ? found.paths : [];
  return { ...r, outcome: blocked.length ? "refused" : "failed", blocked };
}
