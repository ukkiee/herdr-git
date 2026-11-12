// Rolling files back to HEAD. The only caller is the Rollback dialog (view-rollback.js);
// what is rolled back is recorded first, so Restore (git-snapshot.js) can bring it back.

import { record } from "./git-snapshot.js";
import { sentence } from "./i18n.js";

// Paths go on the command line (herdr's exec has no stdin), so a long list is split to
// stay far below the smallest limit an OS or an ssh hop puts on one command.
const CHUNK_BYTES = 60000, CHUNK_PATHS = 1000;

// cost: the bytes one path takes on the command line, worst case UTF-8.
function chunks(paths, cost = (path) => path.length * 3 + 1) {
  const out = [];
  let chunk = [], bytes = 0;
  for (const path of paths) {
    const size = cost(path);
    if (chunk.length && (bytes + size > CHUNK_BYTES || chunk.length >= CHUNK_PATHS)) { out.push(chunk); chunk = []; bytes = 0; }
    chunk.push(path); bytes += size;
  }
  if (chunk.length) out.push(chunk);
  return out;
}

// Why a path was skipped: the English reason, and its msg (i18n.js) for a screen to word
// it in its language. notPutBack: the msg for the reason with NOT_PUT_BACK after it.
// What a deleted file's place holds when git refused to write the file there. Only the
// disk knows what it is (another spelling of the name, an empty folder, a link above).
const ON_DISK = {
  reason: "something else is there on disk", msg: { key: "dialogs.rollback.skipOnDisk", args: {} },
  notPutBack: { key: "dialogs.rollback.skipOnDiskNotPutBack", args: {} },
};
// A deleted file git failed before it could write it back or confirm it did.
const UNCHECKED = {
  reason: "git failed before it could check it", msg: { key: "dialogs.rollback.skipUnchecked", args: {} },
  notPutBack: { key: "dialogs.rollback.skipUncheckedNotPutBack", args: {} },
};
// Added to a skipped path's reason when its index stayed as HEAD's.
const NOT_PUT_BACK = "its index could not be put back as it was";
// A file with assume-unchanged or skip-worktree on its index entry. git doesn't look at
// its disk, so what is there can't be checked: it is left alone, index and flag included.
const FLAGGED = {
  reason: "git is told not to watch this file (assume-unchanged or skip-worktree); clear that flag to roll it back",
  msg: { key: "dialogs.rollback.skipFlagged", args: {} },
};

// rollback(git, root, { files, deleteAdded, copy })
//   git: from makeGit (git.js). root: the repository root. copy: the calling copy's id
//   (lower-case hex), which names its scratch index (git-snapshot.js record); without one
//   nothing is recorded, so nothing is rolled back.
//   files: [{ path, status }] as git-status.js reports them. Modified and deleted files go
//   back to HEAD (index and working tree); added files are only untracked, and deleted
//   from disk only when deleteAdded is true; "unversioned" entries are never touched.
//   → { ok, code, out, err, msg?, skipped: [{ path, reason, msg }], snapshot }
//   reason and err are English; each msg (i18n.js) words the same in a screen's language.
//   msg comes with an err this module wrote, also around git's words; its English args
//   are worded again by wordRollback.
//   Before the first write, the paths about to be rolled back (those not skipped up front)
//   are recorded as a Rollback snapshot (git-snapshot.js); snapshot is its commit hash, or
//   null when nothing was recorded. When it can't be recorded, nothing is written and the
//   failure comes back with msg. A deleted file the disk turns away later (another
//   spelling in its place) is in the snapshot but skipped here.
//   A file git sees on disk is overwritten with HEAD's. A deleted one is written back only
//   where nothing is in its way: at its path or at any folder above it, under any spelling
//   the disk takes as the same name, a file, link or folder (even an empty one) is left as
//   it is and the path is skipped with its index as it was. The other paths are still
//   rolled back; ok is then false and err names each skipped path and why. A deleted file
//   git can't confirm was written as HEAD has it is skipped the same way. A file flagged
//   assume-unchanged or skip-worktree is skipped before anything is written, and nothing
//   is written at all when git can't say which files are flagged.
//   Stops at the first git call that fails and returns it, with the paths skipped so far
//   named in err: files handled before it stay rolled back. Where a skipped path's index
//   could not be put back as it was, its reason and err say so.
export async function rollback(git, root, { files = [], deleteAdded = false, copy } = {}) {
  const chosen = files.filter((file) => file.status !== "unversioned");
  const flags = await flagged(git, root, chosen.map((file) => file.path));
  if (!flags.ok) return { ...flags, skipped: [], snapshot: null };
  const tracked = chosen.filter((file) => !flags.paths.has(file.path));
  const known = await inHead(git, root, tracked.map((file) => file.path));
  if (!known.ok) return { ...known, skipped: [], snapshot: null };
  // Untracking (and deleting) takes both: listed as added, or as a conflict (a file both
  // sides added has no HEAD version), and missing from HEAD. Anything else goes back to
  // HEAD, and git refuses a path HEAD lacks instead of removing it.
  const fresh = (file) => !known.paths.has(file.path) && (file.status === "added" || file.status === "conflict");
  const wanted = tracked.filter((file) => !fresh(file)).map((file) => file.path);
  const blocked = await inTheWay(git, root, wanted);
  if (!blocked.ok) return { ...blocked, skipped: [], snapshot: null };
  const skipped = [...[...flags.paths].map((path) => ({ path, reason: FLAGGED.reason, msg: FLAGGED.msg })), ...blocked.skipped];
  const restore = wanted.filter((path) => !skipped.some((skip) => skip.path === path));
  const untrack = tracked.filter(fresh).map((file) => file.path);
  const recorded = await record(git, root, [...restore, ...untrack], copy);
  if (!recorded.ok) return notRecorded(recorded);
  const { snapshot } = recorded;
  const fail = (r) => ({ ...r, ok: false, ...notRolledBack(r, skipped), skipped, snapshot });
  const index = await entries(git, root, restore);
  if (!index.ok) return fail(index);
  const away = await onDisk(git, root, restore);
  if (!away.ok) return fail(away);
  // Deleted: not in the index (a staged deletion), or git finds no file at the path. Only
  // for a name HEAD lists exactly as given: an index entry is put back by that name. A path
  // HEAD lacks goes to checkout, which refuses it.
  const gone = (path) => known.paths.has(path) && (!index.entries.has(path) || away.missing.has(path));
  // --literal-pathspecs: a file may be called "*.ts" or ":x"; it must never match others.
  // This checkout overwrites what is at the path: only for files onDisk finds there.
  for (const chunk of chunks(restore.filter((path) => !gone(path)))) {
    const r = await git(root, ["--literal-pathspecs", "checkout", "-q", "HEAD", "--", ...chunk]);
    if (!r.ok) return fail(r);
  }
  const back = await bringBack(git, root, restore.filter(gone), index.entries, known.paths);
  skipped.push(...back.skipped);
  if (!back.ok) return fail(back);
  // The file is deleted by git itself (`git rm` without --cached), never by an `rm` of
  // ours: git only removes what its index has, so a path that turns out to be untracked
  // (--ignore-unmatch lets the call go on) is left alone.
  // -f: git refuses to drop an entry whose staged content differs from the file's.
  const how = deleteAdded ? [] : ["--cached"];
  for (const chunk of chunks(untrack)) {
    const r = await git(root, ["--literal-pathspecs", "rm", "-q", "-f", "--ignore-unmatch", ...how, "--", ...chunk]);
    if (!r.ok) return fail(r);
  }
  if (skipped.length) return fail({ code: -1, out: "", err: "" });
  return { ok: true, code: 0, out: "", err: "", skipped, snapshot };
}

// Nothing has been written when this is returned, so no path is listed as skipped.
// cause: the msg of the failure, when git-snapshot.js worded it (see wordRollback).
const notRecorded = (r) => ({
  ok: false, code: r.code, out: "", skipped: [], snapshot: null,
  err: `Nothing was rolled back: the rollback couldn't be recorded first.\n${r.err}`,
  msg: { key: "restore.notRecorded", args: { err: r.err }, ...(r.msg ? { cause: r.msg } : {}) },
});

// "path: reason" per line, each reason in t's language (as it came, without t).
const reasonLines = (skipped, t) => skipped.map((skip) => `${skip.path}: ${t ? sentence(t, skip.msg, skip.reason) : skip.reason}`).join("\n");

// The failure `r` (git's, or this module's with its msg) followed by the skipped paths:
// { err, msg }. Without skipped paths, r's own err and msg.
function notRolledBack(r, skipped) {
  if (!skipped.length) return { err: r.err, ...(r.msg ? { msg: r.msg } : {}) };
  const list = reasonLines(skipped), err = `Not rolled back, to keep what is there now:\n${list}`;
  if (!r.err) return { err, msg: { key: "dialogs.rollback.notRolledBack", args: { list } } };
  // cause: the msg of the failure before the list, when this module worded it.
  return { err: `${r.err}\n${err}`, msg: { key: "dialogs.rollback.failedNotRolledBack", args: { err: r.err, list }, ...(r.msg ? { cause: r.msg } : {}) } };
}

// wordRollback(t, r) → r.msg ({ key, args }) with its values worded in t's language too:
// the skipped paths' reasons, and the failure before them when this module wrote it.
// For whoever words a rollback's result, whose args were written in English: then
// t(key, args) is all in t's language. undefined when r has no msg.
export function wordRollback(t, r) {
  const msg = r?.msg;
  if (!msg) return msg;
  const args = { ...msg.args };
  if ("list" in args) args.list = reasonLines(r.skipped ?? [], t);
  if (msg.cause) args.err = sentence(t, msg.cause, args.err);
  return { key: msg.key, args };
}

// Brings deleted `paths` back from HEAD without removing or overwriting anything:
// { ok, skipped } (on a failed git call, the failure plus the paths skipped so far).
// The index entry goes back to HEAD's first (`restore --staged` leaves the disk alone),
// then the file is written with `checkout-index` without --force, which refuses when
// anything is at the path or a folder above it is not a folder, under whatever spelling
// the disk folds to it. Where it refuses, or a failed git call leaves it unconfirmed, the
// path is skipped and its index put back as it was.
// `before`: each path's index entries before the call; `head`: HEAD's mode and object.
async function bringBack(git, root, paths, before, head) {
  const skipped = [], refused = new Map();
  if (!paths.length) return { ok: true, skipped };
  const refuse = (list, reason) => { for (const path of list) if (!refused.has(path)) refused.set(path, reason); };
  const done = async (r) => {
    const undo = await putBack(git, root, [...refused.keys()], before, head);
    for (const [path, why] of refused) {
      skipped.push(undo.failed.has(path)
        ? { path, reason: `${why.reason}; ${NOT_PUT_BACK}`, msg: why.notPutBack }
        : { path, reason: why.reason, msg: why.msg });
    }
    if (!undo.failed.size) return { ...r, skipped };
    // The undo's failure is told beside the first one, never instead of it.
    const paths = [...undo.failed].join("\n");
    const lost = `The index could not be put back as it was for:\n${paths}\n${undo.err}`;
    const code = r.ok ? undo.code : r.code;
    if (r.ok) return { ok: false, code, out: "", err: lost, msg: { key: "dialogs.rollback.indexLost", args: { paths, err: undo.err } }, skipped };
    return { ok: false, code, out: "", err: `${r.err}\n${lost}`, msg: { key: "dialogs.rollback.failedIndexLost", args: { gitErr: r.err, paths, err: undo.err } }, skipped };
  };
  for (const chunk of chunks(paths)) {
    const r = await git(root, ["--literal-pathspecs", "restore", "-q", "--staged", "--source=HEAD", "--", ...chunk]);
    // Some of the chunk may be back to HEAD in the index already: put them all back.
    if (!r.ok) { refuse(paths, UNCHECKED); return done(r); }
  }
  // A staged deletion whose place git now finds a file at holds another spelling of it.
  const now = await onDisk(git, root, paths);
  if (!now.ok) { refuse(paths, UNCHECKED); return done(now); }
  refuse(paths.filter((path) => !now.missing.has(path)), ON_DISK);
  // checkout-index stops at the first folder it can't make and skips a path that is taken,
  // and its exit says neither which: after a failure, git is asked which paths are still
  // missing, and those are tried again, halved when a call wrote nothing. A path no longer
  // missing was written, or shares its place on disk with another path of the call that
  // was: it counts as written only if git confirms it holds what HEAD has.
  const queue = chunks(paths.filter((path) => now.missing.has(path)));
  while (queue.length) {
    const chunk = queue.pop();
    const r = await git(root, ["checkout-index", "--", ...chunk]);
    if (r.ok) continue;
    const after = await onDisk(git, root, chunk);
    if (!after.ok) { refuse([...queue.flat(), ...chunk], UNCHECKED); return done(after); }
    const left = chunk.filter((path) => after.missing.has(path));
    const there = chunk.filter((path) => !after.missing.has(path));
    const same = await holdHead(git, root, there, head, after);
    if (!same.ok) { refuse([...queue.flat(), ...chunk], UNCHECKED); return done(same); }
    refuse(there.filter((path) => !same.paths.has(path)), ON_DISK);
    if (left.length < chunk.length) { if (left.length) queue.push(left); }
    else if (left.length === 1) refuse(left, ON_DISK);
    else queue.push(left.slice(0, left.length >> 1), left.slice(left.length >> 1));
  }
  return done({ ok: true });
}

// Which of `paths` (each with something at it on disk, index HEAD's) hold what HEAD has:
// { ok, paths: Set }. `disk`: onDisk's answer for them. The kind and executable bit come
// from the mode diff-files saw on disk (none listed: the disk matched the index entry).
// `hash-object` reads through the same filters as checkout, so a written file hashes to
// HEAD's object. It follows a link, so a link (mode 120000) or a submodule is taken by its
// mode alone.
async function holdHead(git, root, paths, head, disk) {
  const found = new Set();
  const mode = (path) => head.get(path).split(" ")[0];
  const kept = paths.filter((path) => (disk.modes.get(path) ?? mode(path)) === mode(path));
  const files = kept.filter((path) => /^100/.test(mode(path)));
  for (const path of kept) if (!files.includes(path)) found.add(path);
  for (const chunk of chunks(files)) {
    const r = await git.read(root, ["hash-object", "--", ...chunk]);
    if (!r.ok) return r;
    const objects = r.out.split("\n");
    chunk.forEach((path, i) => { if (head.get(path).endsWith(` ${objects[i]}`)) found.add(path); });
  }
  return { ok: true, paths: found };
}

// Puts the index of `paths` back as `before` had it: no entry (a staged deletion), its own
// staged content, or the conflict (`--unresolve` reads what git kept when it was resolved).
// An entry that was HEAD's already needs nothing.
// → { ok, failed: Set }: a call that fails doesn't stop the others; the paths it was for
// are in `failed`, and the last failure's code and err come with them.
async function putBack(git, root, paths, before, head) {
  const removed = [], staged = [], conflicts = [];
  for (const path of paths) {
    const was = before.get(path);
    if (!was) removed.push(path);
    else if (was.some((entry) => entry.stage !== "0")) conflicts.push(path);
    else if (`${was[0].mode} ${was[0].object}` !== head.get(path)) staged.push(path);
  }
  const failed = new Set();
  let last = { ok: true };
  const each = async (list, args, cost) => {
    for (const chunk of chunks(list, cost)) {
      const r = await git(root, args(chunk));
      if (!r.ok) { last = r; for (const path of chunk) failed.add(path); }
    }
  };
  await each(removed, (chunk) => ["update-index", "--force-remove", "--", ...chunk]);
  await each(staged, (chunk) => ["update-index", ...chunk.flatMap((path) => ["--cacheinfo", before.get(path)[0].mode, before.get(path)[0].object, path])], (path) => path.length * 3 + 120);
  await each(conflicts, (chunk) => ["update-index", "--unresolve", "--", ...chunk]);
  return { ...last, failed };
}

// The index entries of `paths`: { ok, entries: Map(path → [{ mode, object, stage }]) }.
// A path the index lacks has no key.
async function entries(git, root, paths) {
  const found = new Map(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...chunk]);
    if (!r.ok) return r;
    // "<mode> <object> <stage>\t<path>"
    for (const line of r.out.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const path = line.slice(tab + 1);
      // A pathspec also matches the files under a folder of that name.
      if (!asked.has(path)) continue;
      const [mode, object, stage] = line.slice(0, tab).split(" ");
      found.set(path, [...(found.get(path) ?? []), { mode, object, stage }]);
    }
  }
  return { ok: true, entries: found };
}

// What git finds on disk at each of `paths` (index entries without a flag):
// { ok, missing: Set, modes: Map(path → mode on disk) }.
// missing: no file git can take for the path. Asked two ways, and a path either of them
// calls missing is missing, so a wrong answer sends it down the way that overwrites nothing:
// - `diff-files` counts as missing a path whose place holds a folder or sits under a link.
// - `ls-files --deleted` takes a folder or another spelling at the path for the file.
// modes: from diff-files, for a path whose stat differs from its index entry: the mode the
// disk has (120000 a link, 100755 an executable).
async function onDisk(git, root, paths) {
  const missing = new Set(), modes = new Map(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const [diff, deleted] = await Promise.all([
      git.read(root, ["--literal-pathspecs", "diff-files", "--raw", "-z", "--", ...chunk]),
      git.read(root, ["--literal-pathspecs", "ls-files", "--deleted", "-z", "--", ...chunk]),
    ]);
    for (const r of [diff, deleted]) if (!r.ok) return r;
    const words = diff.out.split("\0");
    // -z: ":<mode> <mode> <object> <object> <status>" and the path, each ended by NUL.
    for (let i = 0; i + 1 < words.length; i += 2) {
      const path = words[i + 1];
      if (!asked.has(path)) continue;
      if (words[i].endsWith(" D")) missing.add(path);
      else modes.set(path, words[i].split(" ")[1]);
    }
    for (const path of deleted.out.split("\0")) if (asked.has(path)) missing.add(path);
  }
  return { ok: true, missing, modes };
}

// Which of `paths` have an index entry flagged assume-unchanged (which core.ignoreStat
// sets on what git stages) or skip-worktree: { ok, paths: Set }.
async function flagged(git, root, paths) {
  const found = new Set(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, ["--literal-pathspecs", "ls-files", "-v", "-z", "--", ...chunk]);
    if (!r.ok) return r;
    // "<tag> <path>": a lower-case tag is assume-unchanged, S is skip-worktree (s both).
    // A pathspec also matches the files under a folder of that name.
    for (const line of r.out.split("\0")) if (/^[a-zS] /.test(line) && asked.has(line.slice(2))) found.add(line.slice(2));
  }
  return { ok: true, paths: found };
}

// Which of `paths` are in the way of a tracked file or folder under exactly that name:
// { ok: true, skipped: [{ path, reason }] }. Restoring the index of `f` would drop the
// staged files of a folder `f`, and restoring `a/b` would drop a staged file `a`, before
// the disk gets a say; and a reason that names what is there reads better than ON_DISK.
// Asked of git, not the disk: the repository may be on another machine. --others without
// --exclude-standard counts ignored files too. Other spellings are left to the disk.
async function inTheWay(git, root, paths) {
  const skipped = [];
  if (!paths.length) return { ok: true, skipped };
  const listed = await listAt(git, root, paths, () => []);
  if (!listed.ok) return listed;
  const above = await filesAbove(git, root, paths);
  if (!above.ok) return above;
  const under = (set, path) => [...set].some((entry) => entry.startsWith(`${path}/`));
  for (const path of paths) {
    const near = (set) => folders(path).find((parent) => set.has(parent));
    const tracked = near(above.indexed), untracked = near(above.loose);
    if (under(listed.indexed, path) || under(listed.loose, path)) {
      skipped.push({ path, reason: "a folder is there now", msg: { key: "dialogs.rollback.skipFolder", args: {} } });
    } else if (listed.loose.has(path)) {
      skipped.push({ path, reason: "a file git doesn't track is there", msg: { key: "dialogs.rollback.skipUntracked", args: {} } });
    } else if (untracked) {
      skipped.push({ path, reason: `a file git doesn't track is there at ${untracked}`, msg: { key: "dialogs.rollback.skipUntrackedAt", args: { at: untracked } } });
    } else if (tracked) {
      skipped.push({ path, reason: `a file git tracks is there at ${tracked}`, msg: { key: "dialogs.rollback.skipTrackedAt", args: { at: tracked } } });
    }
  }
  return { ok: true, skipped };
}

// "a/b/c" → ["a", "a/b"]: the folders a file at it needs.
const folders = (path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));

// The index entries and untracked files at (or under) each of `paths`:
// { ok, indexed: Set, loose: Set }. `wrap` adds an exclude after each name, or nothing.
async function listAt(git, root, paths, wrap) {
  const indexed = new Set(), loose = new Set();
  // Each name goes on the command line up to twice, with its magic.
  const calls = chunks(paths, (name) => name.length * 6 + 40)
    .map((chunk) => chunk.flatMap((name) => [`:(literal)${name}`, ...wrap(name)]));
  for (const chunk of calls) {
    const [cached, others] = await Promise.all([
      git.read(root, ["ls-files", "-z", "--cached", "--", ...chunk]),
      git.read(root, ["ls-files", "-z", "--others", "--", ...chunk]),
    ]);
    if (!cached.ok) return cached;
    if (!others.ok) return others;
    for (const path of cached.out.split("\0")) if (path) indexed.add(path);
    for (const path of others.out.split("\0")) if (path) loose.add(path);
  }
  return { ok: true, indexed, loose };
}

// Which folders above `paths` are something else now: { ok, indexed: Set, loose: Set } of
// the ones that are a file or link in the index, or on disk and untracked.
// Each folder is asked as `:(literal)a` minus `:(exclude,literal)a/`, so only an entry
// named `a` comes back, never the whole tree under a real folder. A folder or an empty
// folder answers nothing; so does a folder holding only untracked files. An exclude
// applies to the whole call, so `a/` would hide `a/b` asked beside it: each depth is asked
// on its own.
async function filesAbove(git, root, paths) {
  const indexed = new Set(), loose = new Set();
  const byDepth = [];
  for (const parent of new Set(paths.flatMap(folders))) (byDepth[parent.split("/").length - 1] ??= []).push(parent);
  for (const names of byDepth.filter(Boolean)) {
    const r = await listAt(git, root, names, (name) => [`:(exclude,literal)${name}/`]);
    if (!r.ok) return r;
    for (const path of r.indexed) indexed.add(path);
    for (const path of r.loose) loose.add(path);
  }
  return { ok: true, indexed, loose };
}

// HEAD's mode and object of each of `paths` it has: { ok: true, paths: Map(path →
// "<mode> <object>") }. What a file is rolled back to is decided by this, not by the
// status it was listed with: the list may be minutes old, and "added" on a file HEAD has
// by now would stage its deletion.
async function inHead(git, root, paths) {
  const found = new Map();
  // A repository without a commit: exit 1 and no words. HEAD has nothing.
  const head = await git.read(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  if (head.code === 1) return { ok: true, paths: found };
  if (!head.ok) return head;
  for (const chunk of chunks(paths)) {
    // Lists nothing for a path HEAD lacks. Without --literal-pathspecs a name like ":top"
    // is read as pathspec magic and a file HEAD has goes missing from the answer.
    const r = await git.read(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", "HEAD", "--", ...chunk]);
    if (!r.ok) return r;
    // -z: "<mode> <type> <object>\t<path>", each ended by NUL.
    for (const line of r.out.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const [mode, , object] = line.slice(0, tab).split(" ");
      found.set(line.slice(tab + 1), `${mode} ${object}`);
    }
  }
  return { ok: true, paths: found };
}
