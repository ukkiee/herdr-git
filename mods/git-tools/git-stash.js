// The stash: putting local changes away (create), the list and each stash's files,
// putting one back (apply, pop, onto a new branch, with or without its staging), drop and
// clear. No `herdr` import: node tests it against real repositories (git-stash.test.mjs).
//
// A stash is named by its hash everywhere outside this module. git numbers stashes
// (stash@{0} is the newest) and the numbers move whenever any copy, worktree or terminal
// adds or drops one; `git stash drop <hash>` is refused, so the writes that need a number
// look the hash up right before they run (refOf) and do nothing when it is gone.
//
// The list is shared by every worktree of a repository (git keeps it in the common
// folder): a linked worktree reads and writes the same list.

import { readCommit } from "./git-show.js";
import { readOperation } from "./git-operation.js";

// A stash can hold a large tree; creating and applying it rewrite the working tree.
const TIMEOUT = 5 * 60 * 1000;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// The reflog subject git writes for a stash, in English whatever the locale:
// "On <branch>: <message>" (a message was given), "WIP on <branch>: <short> <subject>"
// (none was). A detached HEAD is "(no branch)". Branch names can't hold ": ".
const SUBJECT = /^(?:WIP on|On) (.+?): ([\s\S]*)$/;
const DETACHED = "(no branch)";

const refuse = (err, msg, extra = {}) => ({ ok: false, code: -1, out: "", err, msg, ...extra });

// listStashes(git, root) → { ok, code, out, err, msg?, stashes }
//   stashes: newest first, [{ ref, hash, time, branch, message, subject, untracked }]
//   ref: "stash@{n}" as of this read. time: unix seconds the stash was made.
//   branch: the branch HEAD was on, null on a detached HEAD. message: the message given,
//   or git's own "<short> <subject>" of the commit it was made on. subject: git's whole
//   line ("On main: …"). untracked: it holds untracked files (made with -u).
export async function listStashes(git, root) {
  const r = await git.read(root, ["stash", "list", "--format=%gd%x00%H%x00%ct%x00%P%x00%gs%x00"]);
  if (!r.ok) return { ...r, stashes: [] };
  const parts = r.out.split("\0"), stashes = [];
  for (let i = 0; i + 4 < parts.length; i += 5) {
    const [ref, hash, time, parents, subject] = parts.slice(i, i + 5).map((s, n) => (n === 0 ? s.trim() : s));
    if (!ref) continue;
    const m = SUBJECT.exec(subject);
    const branch = m && m[1] !== DETACHED ? m[1] : null;
    stashes.push({ ref, hash, time: Number(time) || 0, branch, message: m ? m[2] : subject, subject, untracked: parents.trim().split(/\s+/).length >= 3 });
  }
  return { ok: true, code: 0, out: "", err: "", stashes };
}

// stashFiles(git, root, hash) → { ok, code, out, err, msg?, files }
//   files: by path, [{ path, status, from, commit }]. The tracked changes are the stash
//   commit against the commit it was made on ("modified" | "added" | "deleted" |
//   "renamed", from: a renamed file's old path). Untracked files (a stash made with -u)
//   are "unversioned"; git keeps them in a commit of their own with no parent.
//   commit: the commit whose Diff tab shows the file against its parent (view-diff.js).
export async function stashFiles(git, root, hash) {
  if (!HASH.test(String(hash ?? ""))) return refuse("No such stash.", { key: "stash.gone" }, { files: [] });
  const tracked = await readCommit(git, root, hash);
  if (!tracked.ok) return { ...tracked, files: [] };
  const files = tracked.files.map((f) => ({ ...f, commit: hash }));
  const third = tracked.parents[2];
  if (third) {
    const extra = await readCommit(git, root, third);
    if (!extra.ok) return { ...extra, files: [] };
    for (const f of extra.files) files.push({ path: f.path, status: "unversioned", from: null, commit: third });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, code: 0, out: "", err: "", files };
}

// refOf(git, root, hash) → { ok, ref } | a refusal: the stash's number now ("stash@{n}"),
// read right before a write that needs one. Gone: stash.gone, nothing done.
async function refOf(git, root, hash) {
  if (!HASH.test(String(hash ?? ""))) return refuse("The request names no stash.", { key: "stash.badRequest" });
  const list = await listStashes(git, root);
  if (!list.ok) return list;
  const found = list.stashes.find((s) => s.hash === hash);
  return found ? { ok: true, ref: found.ref } : refuse("The stash is no longer in the list.", { key: "stash.gone" });
}

// applyStash(git, root, { hash, pop?, index?, branch? })
//   → { ok, code, out, err, msg?, outcome, operation, changed }
//   Puts the stash `hash` back into the working tree.
//   index: its staging comes back staged too (without it, everything comes back unstaged).
//   pop: it leaves the list once it came back cleanly; a conflict keeps it.
//   branch: a new branch made at the commit the stash was made on, checked out, with the
//     stash and its staging on it; the stash then leaves the list (pop and index are
//     implied).
//   outcome: "done"; "stopped" when files are left in conflict (no operation is in
//     progress afterwards: the Conflicts dialog resolves them, the stash stays in the
//     list); "failed" (git refused, nothing changed: its words in err).
//   operation: git-operation.js readOperation afterwards, for the Conflicts dialog
//     (conflicts-model.js stoppedOnConflicts), or null when it couldn't be read.
//   changed: the repository may have changed.
export async function applyStash(git, root, { hash, pop = false, index = false, branch = "" } = {}) {
  const none = { outcome: "failed", operation: null, changed: false };
  const name = String(branch ?? "").trim();
  // Pop and a new branch drop the stash by its number; apply needs no number.
  let target = hash;
  if (pop || name) {
    const found = await refOf(git, root, hash);
    if (!found.ok) return { ...found, ...none };
    target = found.ref;
  } else if (!HASH.test(String(hash ?? ""))) return { ...refuse("The request names no stash.", { key: "stash.badRequest" }), ...none };
  if (name) {
    // Never an option: a name starting with "-" would be read as one.
    const valid = await git.read(root, ["check-ref-format", "--branch", name]);
    if (!valid.ok || name.startsWith("-")) return { ...valid, ok: false, err: valid.err || `'${name}' is not a valid branch name.`, ...none };
  }
  const before = await readOperation(git, root);
  const args = name ? ["stash", "branch", name, target] : ["stash", pop ? "pop" : "apply", ...(index ? ["--index"] : []), target];
  const r = await git(root, args, { timeout: TIMEOUT });
  const after = await readOperation(git, root);
  const operation = after.ok ? after : null;
  const stopped = Boolean(operation?.conflicts.length) && !(before.ok && before.conflicts.length);
  if (stopped) return { ...r, ok: false, outcome: "stopped", operation, changed: true };
  if (!r.ok) return { ...r, outcome: "failed", operation, changed: true };
  return { ok: true, code: 0, out: r.out, err: "", outcome: "done", operation, changed: true };
}

// dropStash(git, root, { hash }) → { ok, code, out, err, msg?, changed }
//   Removes the stash `hash` from the list. Gone already: stash.gone, nothing dropped.
export async function dropStash(git, root, { hash } = {}) {
  const found = await refOf(git, root, hash);
  if (!found.ok) return { ...found, changed: false };
  const r = await git(root, ["stash", "drop", "-q", found.ref]);
  return { ...r, changed: r.ok };
}

// clearStashes(git, root) → { ok, code, out, err, changed }: every stash goes.
export async function clearStashes(git, root) {
  const r = await git(root, ["stash", "clear"]);
  return { ...r, changed: r.ok };
}

// The stash's newest hash, or null when the list is empty.
async function newest(git, root) {
  const r = await git.read(root, ["rev-parse", "-q", "--verify", "refs/stash"]);
  return r.ok ? r.out.trim() : null;
}

// createStash(git, root, { message?, keepIndex?, untracked? }) → { ok, code, out, err, msg?, hash, changed }
//   Puts the local changes away and cleans the working tree. message: "" lets git name it.
//   keepIndex: what is staged stays staged (it is in the stash too). untracked: untracked
//   files go in as well (they stay otherwise).
//   hash: the new stash. Nothing to put away: git says yes and makes nothing, so the list
//   is compared before and after; then ok false with stash.nothing and hash null.
export async function createStash(git, root, { message = "", keepIndex = false, untracked = false } = {}) {
  const before = await newest(git, root);
  const args = ["stash", "push", "-q"];
  if (keepIndex) args.push("--keep-index");
  if (untracked) args.push("--include-untracked");
  const text = String(message ?? "").trim();
  if (text) args.push("-m", text);
  const r = await git(root, args, { timeout: TIMEOUT });
  const after = await newest(git, root);
  const made = after !== null && after !== before;
  if (!r.ok) return { ...r, hash: made ? after : null, changed: true };
  if (!made) return refuse("No local changes to save.", { key: "stash.nothing" }, { code: 0, hash: null, changed: false });
  return { ok: true, code: 0, out: r.out, err: "", hash: after, changed: true };
}
