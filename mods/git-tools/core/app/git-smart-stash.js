// The stash Smart puts local changes in while a request runs (Smart operation): made
// before the request, brought back with its staging and dropped after, and the mark a
// stopped request leaves in the repository settings so the next read brings the changes
// back. The request itself comes in as `run`: git-smart.js picks it by type, and
// git-remote.js passes Update Project's step. This module imports neither of them, so
// both can import it.
// No `herdr` import: node tests it against real repositories (git-smart.test.mjs).

import { readOperation, settle } from "./git-operation.js";
import { createStash, applyStash, dropStash, listStashes } from "./git-stash.js";

// The repository setting that marks a stash Smart left behind for a request that
// stopped: one value per stopped request, "<stash hash> <absolute git folder>". The
// settings are shared by every worktree of a repository, and each worktree only brings
// back its own.
export const SMART_MARK = "gittools.smart-stash";

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

// smartRunWith(git, root, { request, run, now? })
//   → { ok, code, out, err, msg?, skipped?, outcome, operation, stash, kept, changed }
//   Smart for a request local changes stood in the way of: the tracked changes and their
//   staging go into a stash ("Uncommitted changes before <request> at <time>"), the
//   request runs, and the stash comes back with its staging and is dropped.
//   request: { type, ...args }, its type names it in the stash message. run(git, root):
//   runs the request; nothing is stashed without one, as there is no default here.
//   now: the time in the message.
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
export async function smartRunWith(git, root, { request = {}, run, now = new Date() } = {}) {
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
  try { r = await run(git, root); } catch (error) { r = { ok: false, code: -1, out: "", err: String(error?.message ?? error) }; }
  const after = await readOperation(git, root);
  const word = settle(before, after, r ?? { ok: false });
  // fetchFailed: a pull's fetch failed, which its words tell with the credential hint
  // (git-remote.js failureText).
  const said = { code: r?.code ?? -1, out: r?.out ?? "", err: r?.err ?? "", ...(r?.msg ? { msg: r.msg } : {}), ...(r?.skipped?.length ? { skipped: r.skipped } : {}), ...(r?.fetchFailed ? { fetchFailed: true } : {}) };
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
