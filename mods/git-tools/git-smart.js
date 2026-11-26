// Smart operation: what to do when local changes stand in the way of a checkout, merge,
// pull, rebase, cherry-pick or revert. Here: the forced checkout, and the request Smart
// runs for each type (SMART_RUNS). Which files are in the way is git-blocked.js, and the
// stash the changes wait in, with the mark a stopped request leaves so the next read
// brings them back, is git-smart-stash.js; this module exports both again, so screens
// take Smart from one place.
// The imports go one way: SMART_RUNS runs git-remote.js and git-operation.js requests,
// so those two use the two modules below, never this one.
// No `herdr` import: node tests it against real repositories (git-smart.test.mjs).

import { readStatus } from "./git-status.js";
import { runOperation } from "./git-operation.js";
import { checkoutTarget } from "./git-blocked.js";
import { smartRunWith } from "./git-smart-stash.js";
import { checkout, checkoutRevision } from "./git-branch.js";
import { record } from "./git-snapshot.js";
import { pull } from "./git-remote.js";
import { editMessage, dropCommits, squashCommits, interactiveRebase, extractChanges, dropChanges } from "./git-rewrite.js";

export { blockedBy, checkoutBranch, checkoutRevisionOf } from "./git-blocked.js";
export { SMART_MARK, smartMessage, readSmartMark, settleSmartStash } from "./git-smart-stash.js";

const str = (value) => (typeof value === "string" ? value : "");
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const zList = (out) => out.split("\0").map((p) => p.replace(/^\n+/, "")).filter(Boolean);

// The paths named in a refusal's sentence; more are left out with "…".
const NAMED = 20;

// The untracked files (readStatus's unversioned) a forced checkout of `ref` would write
// over: where the target has a file the index doesn't, a folder over an untracked file, or
// a file over an untracked folder. → [path] in git's order, or null when git can't say.
// Ignored files aren't counted: git writes over those on any checkout.
async function untrackedInWay(git, root, ref, unversioned) {
  if (!unversioned.length) return [];
  // From the target's tree to the index: "D" is a path the target has and the index doesn't.
  const r = await git.read(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=D", "--end-of-options", ref, "--"]);
  if (!r.ok) return null;
  const files = new Set(zList(r.out)), folders = new Set();
  for (const p of files) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) folders.add(p.slice(0, i));
  const under = (p) => { for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) if (files.has(p.slice(0, i))) return true; return false; };
  return unversioned.map((u) => u.path).filter((p) => files.has(p) || folders.has(p) || under(p));
}

// forceCheckout(git, root, { name, remote?, revision?, copy }) → { ok, code, out, err, msg?, snapshot, changed, untracked? }
//   Checks out over the local changes. `checkout --force` throws away every tracked change,
//   not only the ones in the way, so all of them are recorded first as a snapshot named
//   "Checkout" (git-snapshot.js record; copy: the calling copy's id). When that record
//   fails, nothing is checked out. It would also write over an untracked file where the
//   target has one, which a snapshot can't hold: then nothing is recorded or checked out
//   and `untracked` lists those paths (msg smart.untrackedInWay). Other untracked files
//   stay as they are. revision: a commit to detach HEAD at instead of a branch.
export async function forceCheckout(git, root, { name, remote = false, revision = "", copy } = {}) {
  const none = { snapshot: null, changed: false };
  const target = str(revision) ? { revision: str(revision) } : await checkoutTarget(git, root, { name: str(name), remote: remote === true });
  if (!target) {
    const msg = remote ? { key: "log.notRemoteBranch", args: { name: str(name) } } : { key: "log.notLocalBranch", args: { name: str(name) } };
    return { ok: false, code: -1, out: "", err: `'${str(name)}' is not a branch.`, msg, ...none };
  }
  const st = await readStatus(git, root);
  if (!st.ok) return { ok: false, code: -1, out: "", err: st.err, ...(st.msg ? { msg: st.msg } : {}), ...none };
  const untracked = await untrackedInWay(git, root, target.revision ?? target.ref, st.unversioned);
  if (untracked === null) return { ok: false, code: -1, out: "", err: "Couldn't tell which untracked files the checkout would overwrite.", msg: { key: "smart.untrackedUnknown" }, ...none };
  if (untracked.length) {
    const named = untracked.slice(0, NAMED).join("\n") + (untracked.length > NAMED ? "\n…" : "");
    return { ok: false, code: -1, out: "", err: `Force Checkout would overwrite untracked files:\n${named}`, msg: { key: "smart.untrackedInWay", args: { n: untracked.length, paths: named } }, untracked, ...none };
  }
  const made = await record(git, root, st.changes.map((c) => c.path), copy, "Checkout");
  if (!made.ok) return { ...made, ...none };
  // --end-of-options: a branch may be called "-f". A new local branch takes the full
  // remote ref, as git-branch.js checkout does.
  const args = target.revision ? ["checkout", "--force", "--detach", "--end-of-options", target.revision, "--"]
    : target.exists ? ["checkout", "--force", "--end-of-options", target.local, "--"]
    : ["checkout", "--force", "-b", target.local, "--track", target.ref, "--"];
  const r = await git(root, args);
  return { ...r, snapshot: made.snapshot, changed: true };
}

// ---- Smart: the request with the local changes put away

// The requests Smart runs itself, by type: (git, root, request) → a result. Any other
// type is a git-operation.js runOperation request ({ type, ...args }).
export const SMART_RUNS = {
  checkout: (git, root, request) => (str(request.revision) ? checkoutRevision(git, root, str(request.revision))
    : checkout(git, root, str(request.name), { remote: request.remote === true })),
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

// smartRun(git, root, { request, run?, now? }) → git-smart-stash.js smartRunWith's result.
//   request: { type, ...args } (SMART_RUNS, else runOperation). run(git, root): runs the
//   request instead, for a request with no type here yet. now: the time in the message.
export const smartRun = (git, root, { request = {}, run, now = new Date() } = {}) =>
  smartRunWith(git, root, { request, run: run ?? ((g, r) => runRequest(g, r, request)), now });
