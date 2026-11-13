// Smart operation: what to do when local changes stand in the way of a checkout, merge,
// pull, rebase, cherry-pick or revert. Which files are in the way (worked out here from
// the request and the repository, never from git's words), the request run with the
// local changes put away in a stash and brought back after, the forced checkout, and the
// mark a stopped request leaves so the next read brings the changes back.
// No `herdr` import: node tests it against real repositories (git-smart.test.mjs).

import { readStatus } from "./git-status.js";

const LITERAL = "--literal-pathspecs";
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

// The commit a checkout goes to: a local branch, else the remote branch it would track.
async function checkoutTarget(git, root, { name, remote }) {
  const at = async (ref) => (await git.read(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
  if (!remote) return (await at(`refs/heads/${name}`)) ? `refs/heads/${name}` : null;
  const remotes = await git.read(root, ["remote"]);
  let best = null;
  for (const r of remotes.ok ? remotes.out.split("\n") : []) {
    if (r && name.startsWith(`${r}/`) && name.length > r.length + 1 && (!best || r.length > best.length)) best = r;
  }
  if (!best) return null;
  const local = `refs/heads/${name.slice(best.length + 1)}`;
  if (await at(local)) return local;
  return (await at(`refs/remotes/${name}`)) ? `refs/remotes/${name}` : null;
}

// What each request touches, by type: (git, root, args) → [path] the request would write,
// "all" when any tracked change stops it, or null when it has none in its way.
//   checkout: { name, remote? }      files that differ between HEAD and the branch
//   merge: { target }                files the target changed since the common commit
//   pull: { rebase?, target? }       as merge (target: the upstream, "@{upstream}" when
//                                    not given), or as rebase
//   cherry-pick, revert: { commits } files those commits change
//   rebase, checkout-rebase          any tracked change: git refuses on one
// merge, pull (merge), cherry-pick and revert are also stopped by any staged change.
const TOUCHES = {
  checkout: async (git, root, args) => {
    const target = await checkoutTarget(git, root, { name: str(args.name), remote: args.remote === true });
    return target ? changedBetween(git, root, ["HEAD", target]) : [];
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
