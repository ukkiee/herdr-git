// Smart operation: what to do when local changes stand in the way of a checkout, merge,
// pull, rebase, cherry-pick or revert. Which files are in the way (worked out here from
// the request and the repository, never from git's words), the request run with the
// local changes put away in a stash and brought back after, the forced checkout, and the
// mark a stopped request leaves so the next read brings the changes back.
// No `herdr` import: node tests it against real repositories (git-smart.test.mjs).

import { readStatus } from "./git-status.js";
import { readOperation, runOperation, settle } from "./git-operation.js";
import { createStash, applyStash, dropStash, listStashes } from "./git-stash.js";
import { checkout } from "./git-branch.js";
import { record } from "./git-snapshot.js";
import { pull } from "./git-remote.js";
import { editMessage, dropCommits, squashCommits, interactiveRebase, extractChanges, dropChanges } from "./git-rewrite.js";

// The repository setting that marks a stash Smart left behind for a request that
// stopped: one value per stopped request, "<stash hash> <absolute git folder>". The
// settings are shared by every worktree of a repository, and each worktree only brings
// back its own.
export const SMART_MARK = "gittools.smart-stash";
// A checkout rewrites the working tree; hooks may run.
const TIMEOUT = 5 * 60 * 1000;

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
async function checkoutTarget(git, root, { name, remote }) {
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
//   merge: { target }                files the target changed since the common commit
//   pull: { rebase?, target? }       as merge (target: the upstream, "@{upstream}" when
//                                    not given), or as rebase
//   cherry-pick, revert: { commits } files those commits change
//   rebase, checkout-rebase          any tracked change: git refuses on one
// merge, pull (merge), cherry-pick and revert are also stopped by any staged change.
const TOUCHES = {
  checkout: async (git, root, args) => {
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

// forceCheckout(git, root, { name, remote?, copy }) → { ok, code, out, err, msg?, snapshot, changed }
//   Checks out over the local changes. `checkout --force` throws away every tracked change,
//   not only the ones in the way, so all of them are recorded first as a snapshot named
//   "Checkout" (git-snapshot.js record; copy: the calling copy's id). When that record
//   fails, nothing is checked out. Untracked files stay as they are.
export async function forceCheckout(git, root, { name, remote = false, copy } = {}) {
  const none = { snapshot: null, changed: false };
  const target = await checkoutTarget(git, root, { name: str(name), remote: remote === true });
  if (!target) {
    const msg = remote ? { key: "log.notRemoteBranch", args: { name: str(name) } } : { key: "log.notLocalBranch", args: { name: str(name) } };
    return { ok: false, code: -1, out: "", err: `'${str(name)}' is not a branch.`, msg, ...none };
  }
  const st = await readStatus(git, root);
  if (!st.ok) return { ok: false, code: -1, out: "", err: st.err, ...(st.msg ? { msg: st.msg } : {}), ...none };
  const made = await record(git, root, st.changes.map((c) => c.path), copy, "Checkout");
  if (!made.ok) return { ...made, ...none };
  // --end-of-options: a branch may be called "-f". A new local branch takes the full
  // remote ref, as git-branch.js checkout does.
  const args = target.exists ? ["checkout", "--force", "--end-of-options", target.local, "--"]
    : ["checkout", "--force", "-b", target.local, "--track", target.ref, "--"];
  const r = await git(root, args, { timeout: TIMEOUT });
  return { ...r, snapshot: made.snapshot, changed: true };
}

// ---- Smart: the request with the local changes put away

// The requests Smart runs itself, by type: (git, root, request) → a result. Any other
// type is a git-operation.js runOperation request ({ type, ...args }).
export const SMART_RUNS = {
  checkout: (git, root, request) => checkout(git, root, str(request.name), { remote: request.remote === true }),
  pull: (git, root, request) => pull(git, root, request),
  // The history edits (git-rewrite.js), each a replay of the current branch that any
  // change to a tracked file stops. Fixup… and Squash Into… aren't here: they commit the
  // changes the person checked, which Smart would put aside with the rest.
  reword: (git, root, r) => editMessage(git, root, { commit: str(r.commit), message: str(r.message) }),
  drop: (git, root, r) => dropCommits(git, root, { commits: strings(r.commits) }),
  squash: (git, root, r) => squashCommits(git, root, { commits: strings(r.commits), message: str(r.message) }),
  "interactive-rebase": (git, root, r) => interactiveRebase(git, root, { commit: str(r.commit), steps: Array.isArray(r.steps) ? r.steps : [] }),
  "extract-changes": (git, root, r) => extractChanges(git, root, { commit: str(r.commit), paths: strings(r.paths), message: str(r.message) }),
  "drop-changes": (git, root, r) => dropChanges(git, root, { commit: str(r.commit), paths: strings(r.paths) }),
};
const runRequest = (git, root, request) => (Object.prototype.hasOwnProperty.call(SMART_RUNS, request.type)
  ? SMART_RUNS[request.type](git, root, request)
  : runOperation(git, root, request));

// The request's name in the stash message, in English as git's own messages are. The
// history edits are rebases to git.
const NAMES = {
  checkout: "Checkout", merge: "Merge", rebase: "Rebase", pull: "Pull", "cherry-pick": "Cherry-Pick", revert: "Revert", "checkout-rebase": "Checkout and Rebase",
  reword: "Rebase", drop: "Rebase", squash: "Rebase", "interactive-rebase": "Rebase", "extract-changes": "Rebase", "drop-changes": "Rebase",
};
const two = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

// smartMessage(type, now) → the stash's message: "Uncommitted changes before Checkout at
// 2026-11-13 10:30" (local time).
export const smartMessage = (type, now = new Date()) => `Uncommitted changes before ${NAMES[type] ?? type} at ${stamp(now)}`;

// The stash's number now, for the Conflicts dialog's heading ("stash@{0}"), or null.
async function refOf(git, root, hash) {
  const list = await listStashes(git, root);
  return list.ok ? list.stashes.find((s) => s.hash === hash)?.ref ?? null : null;
}

// Puts stash `hash` back with its staging, then drops it.
//   → { ok, err, msg?, outcome: "done" | "stopped" | "failed", operation, stash }
//   stopped: the changes came back in conflict; the stash stays in the list for the
//     Conflicts dialog (stash: { hash, ref }). failed: nothing came back; the stash stays.
// When its staging can't come back (the request changed what was staged), the changes
// come back unstaged rather than not at all, and `unstaged: true` says so.
async function bringBack(git, root, hash) {
  let r = await applyStash(git, root, { hash, index: true }), unstaged = false;
  if (r.outcome === "failed" && !r.operation?.conflicts.length) {
    r = await applyStash(git, root, { hash });
    unstaged = r.outcome !== "failed";
  }
  const flag = unstaged ? { unstaged: true } : {};
  if (r.outcome === "done") {
    const dropped = await dropStash(git, root, { hash });
    return { ok: true, err: "", outcome: "done", operation: r.operation, stash: null, ...flag, ...(dropped.ok ? {} : { dropErr: dropped.err }) };
  }
  const stash = { hash, ref: await refOf(git, root, hash) };
  if (r.outcome === "stopped") return { ok: true, err: r.err ?? "", outcome: "stopped", operation: r.operation, stash, ...flag };
  return { ok: false, code: r.code, out: r.out ?? "", err: r.err ?? "", ...(r.msg ? { msg: r.msg } : {}), outcome: "failed", operation: r.operation, stash };
}

// smartRun(git, root, { request, run?, now? })
//   → { ok, code, out, err, msg?, skipped?, outcome, operation, stash, kept, changed }
//   Smart for a request local changes stood in the way of: the tracked changes and their
//   staging go into a stash ("Uncommitted changes before <request> at <time>"), the
//   request runs, and the stash comes back with its staging and is dropped.
//   request: { type, ...args } (SMART_RUNS, else runOperation). run(git, root): runs the
//   request instead, for a request with no type here yet. now: the time in the message.
//   outcome:
//     done: the request finished and the changes are back.
//     stopped: the request stopped (a conflict, an edit): the stash stays and the mark
//       (SMART_MARK) says so; the read after the request ends brings it back
//       (settleSmartStash). Or the request finished and the changes came back in
//       conflict: the stash stays for the Conflicts dialog, and there is no mark.
//     failed: the stash couldn't be made (nothing ran), or the request failed and the
//       changes are back (git's words in err), or they couldn't come back.
//   operation: readOperation afterwards. stash: { hash, ref } while it stays, else null.
//   kept: the stash stays in the list. changed: the repository may have changed.
//   skipped: as runOperation's, the commits a Cherry-Pick or Revert found already in.
export async function smartRun(git, root, { request = {}, run, now = new Date() } = {}) {
  const go = run ?? ((g, r) => runRequest(g, r, request));
  const before = await readOperation(git, root);
  if (!before.ok) return { ok: false, code: -1, out: "", err: before.err, ...(before.msg ? { msg: before.msg } : {}), outcome: "failed", operation: null, stash: null, kept: false, changed: false };
  const put = await createStash(git, root, { message: smartMessage(request.type, now) });
  const hash = put.ok ? put.hash : null;
  if (!put.ok && put.msg?.key !== "stash.nothing") {
    // A stash that was made all the same would hold the changes: it is put back.
    if (put.hash) await bringBack(git, root, put.hash);
    return { ...put, ok: false, outcome: "failed", operation: before, stash: null, kept: false, changed: Boolean(put.hash) };
  }
  let r;
  try { r = await go(git, root); } catch (error) { r = { ok: false, code: -1, out: "", err: String(error?.message ?? error) }; }
  const after = await readOperation(git, root);
  const word = settle(before, after, r ?? { ok: false });
  const said = { code: r?.code ?? -1, out: r?.out ?? "", err: r?.err ?? "", ...(r?.msg ? { msg: r.msg } : {}), ...(r?.skipped?.length ? { skipped: r.skipped } : {}) };
  if (!hash) return { ...said, ok: word !== "failed", outcome: word === "failed" ? "failed" : word === "stopped" ? "stopped" : "done", operation: after.ok ? after : null, stash: null, kept: false, changed: true };
  if (after.ok && after.kind) {
    const marked = await setMark(git, root, hash);
    return { ...said, ok: true, outcome: "stopped", operation: after, stash: { hash, ref: await refOf(git, root, hash) }, kept: true, changed: true, ...(marked.ok ? {} : { markErr: marked.err }) };
  }
  const back = await bringBack(git, root, hash);
  const kept = Boolean(back.stash);
  const flag = back.unstaged ? { unstaged: true } : {};
  if (word === "failed") return { ...said, ok: false, outcome: "failed", operation: back.operation ?? after, stash: back.stash, kept, changed: true, ...flag };
  if (!back.ok) return { ...back, outcome: "failed", kept, changed: true };
  return { ...said, ok: true, err: back.err || said.err, outcome: back.outcome, operation: back.operation, stash: back.stash, kept, changed: true, ...flag };
}

// ---- the mark

const gitDir = async (git, root) => {
  const r = await git.read(root, ["rev-parse", "--absolute-git-dir"]);
  return r.ok ? r.out.trim() : null;
};

async function setMark(git, root, hash) {
  const dir = await gitDir(git, root);
  if (!dir) return { ok: false, err: "The git folder could not be read." };
  return git(root, ["config", "--local", "--add", SMART_MARK, `${hash} ${dir}`]);
}

// readSmartMark(git, root) → { ok, err, hash, value }: the stash Smart left for this
//   worktree (hash null when there is none). One read when no mark is set anywhere.
export async function readSmartMark(git, root) {
  const r = await git.read(root, ["config", "--local", "--get-all", SMART_MARK]);
  // 1: the setting isn't there.
  if (r.code === 1) return { ok: true, err: "", hash: null, value: null };
  if (!r.ok) return { ok: false, err: r.err, hash: null, value: null };
  const dir = await gitDir(git, root);
  for (const value of r.out.split("\n")) {
    const at = value.indexOf(" ");
    if (at > 0 && value.slice(at + 1) === dir) return { ok: true, err: "", hash: value.slice(0, at), value };
  }
  return { ok: true, err: "", hash: null, value: null };
}

// settleSmartStash(git, root) → { ok, err, msg?, outcome, operation, stash, changed }
//   What a read does when it finds the mark: once nothing is in progress (the request
//   went on and ended, or was aborted, here or in a terminal), the stash comes back with
//   its staging and is dropped, and the mark goes. outcome:
//     none: no mark for this worktree. waiting: the request is still in progress, or files
//       are still in conflict: nothing done, the mark stays.
//     gone: the stash is no longer in the list: only the mark goes.
//     done, stopped, failed: as bringBack; the mark is gone in each (stopped: the
//       changes came back in conflict, the stash stays for the Conflicts dialog).
//   The mark is taken off before the stash comes back, and only the copy whose removal
//   succeeded brings it back: two screens reading at once don't apply it twice.
export async function settleSmartStash(git, root) {
  const quiet = { operation: null, stash: null, changed: false };
  const mark = await readSmartMark(git, root);
  if (!mark.ok) return { ok: false, err: mark.err, outcome: "failed", ...quiet };
  if (!mark.hash) return { ok: true, err: "", outcome: "none", ...quiet };
  const op = await readOperation(git, root);
  if (!op.ok) return { ok: false, err: op.err, ...(op.msg ? { msg: op.msg } : {}), outcome: "failed", ...quiet };
  if (op.kind || op.conflicts.length) return { ok: true, err: "", outcome: "waiting", ...quiet, operation: op };
  const taken = await git(root, ["config", "--local", "--fixed-value", "--unset", SMART_MARK, mark.value]);
  if (!taken.ok) return { ok: true, err: "", outcome: "none", ...quiet };
  const list = await listStashes(git, root);
  if (list.ok && !list.stashes.some((s) => s.hash === mark.hash)) return { ok: true, err: "", outcome: "gone", ...quiet, operation: op, changed: true };
  return { ...await bringBack(git, root, mark.hash), changed: true };
}
