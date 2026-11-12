// Rollback snapshots: what a Rollback threw away, kept inside the repository so Restore can
// bring it back (docs/adr/0002-rollback-snapshots-in-a-private-ref.md).
// A snapshot is a commit whose first parent is the HEAD of that moment and whose tree is
// HEAD's with the rolled-back paths as the working tree had them, so the snapshot against
// its first parent is the change that was rolled back. Its second parent is a commit on
// that HEAD whose tree holds the same paths as the index had them (what was staged), for
// Restore to stage again. Older snapshots have no second parent and are read the same way,
// without staging. Snapshots pile up in the reflog of SNAPSHOTS,
// which is not a branch or a tag: no branch list, tag list, Commit list or push sees it.
// No `herdr` import: node tests it against real repositories (git-snapshot.test.mjs).

import { chunks } from "./git.js";
import { sentence } from "./i18n.js";

export const SNAPSHOTS = "refs/git-tools/rollback";
// How many snapshots the Restore dialog lists.
export const LIST_LIMIT = 50;

// Snapshots are made and read by git alone, under a name of their own: no hooks, no
// signing prompt, and an identity even where the user has none configured.
const IDENTITY = ["-c", "user.name=git-tools", "-c", "user.email=git-tools@localhost"];
// The index snapshots are built and added files written from, in the repository's git
// folder, one per copy of git-tools (copy: its id, lower-case hex). Another app's copies
// have other ids, so none of them writes this copy's file between its steps; copies of the
// same app take turns under the write lock. git can't delete a file, so it is emptied when
// done and reused by the copy's next snapshot. A file named without an id
// (git-tools-rollback-index) may be in the folder: it is never read or written.
const COPY = /^[0-9a-f]{1,64}$/;
const scratchIndex = (dir, copy) => `${dir}/git-tools-rollback-index-${copy}`;
const noCopy = { ok: false, code: -1, out: "", err: "This copy of git-tools has no id to name its scratch index with.", msg: { key: "restore.noCopy" } };

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// A line of a snapshot's message naming a path that was in a conflict, which its second
// parent can't hold: this prefix, then the path as a JSON string (any byte a name holds
// stays on the line).
const CONFLICT = "Conflict: ";
// The same for a path the index only announced (`git add -N`, intent-to-add). The index
// lists such an entry as an empty file, which a tree can't tell from one really staged
// empty: the second parent leaves the path out, so a Restore that doesn't read this line
// brings the file back unstaged rather than staged empty.
const INTENT = "Intent: ";

// HEAD's commit: { ok: true, head } with null in a repository without a commit.
async function headCommit(git, root) {
  const r = await git.read(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  if (r.code === 1) return { ok: true, head: null };
  if (!r.ok) return r;
  return { ok: true, head: r.out.trim() };
}

// record(git, root, paths, copy) → { ok, code, out, err, msg?, snapshot }
//   Records `paths` as the working tree has them now (a file's content, a link, or its
//   absence) on top of HEAD, as a new snapshot. snapshot: its commit hash, or null when
//   `paths` is empty. With a commit, the index of `paths` is recorded too, as the second
//   parent (indexCommit); paths in a conflict are named in the message's body. The real
//   index and the working tree are not touched: the trees are built in the scratch index
//   of `copy` (the calling copy's id, lower-case hex), which goes in the message's body
//   too. Fails without an id, or with git's words when any step fails, and then no
//   snapshot is added. Each tree is checked before it becomes part of a snapshot: every
//   path it changes against HEAD must be one of `paths`.
export async function record(git, root, paths, copy) {
  if (!COPY.test(String(copy ?? ""))) return { ...noCopy, snapshot: null };
  if (!paths.length) return { ok: true, code: 0, out: "", err: "", snapshot: null };
  const dir = await git.read(root, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return { ...dir, snapshot: null };
  const env = { GIT_INDEX_FILE: scratchIndex(dir.out.trim(), copy) };
  const at = await headCommit(git, root);
  if (!at.ok) return { ...at, snapshot: null };
  const made = await build(git, root, paths, env, at.head, copy);
  // Emptied whether or not the snapshot was made; a failure here leaves only a stale file.
  await git(root, ["read-tree", "--empty"], { env });
  return made;
}

async function build(git, root, paths, env, head, copy) {
  const fail = (r) => ({ ...r, ok: false, snapshot: null });
  const base = await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
  if (!base.ok) return fail(base);
  // --add takes a file HEAD lacks, --remove drops one the working tree lacks. Paths, not
  // pathspecs: a name like ":x" or "*.ts" is that file only.
  for (const chunk of chunks(paths)) {
    const r = await git(root, ["update-index", "--add", "--remove", "--", ...chunk], { env });
    if (!r.ok) return fail(r);
  }
  const tree = await git(root, ["write-tree"], { env });
  if (!tree.ok) return fail(tree);
  const odd = await outside(git, root, head, tree.out.trim(), paths);
  if (!odd.ok) return fail(odd);
  const message = `Rollback: ${paths.length} ${paths.length === 1 ? "file" : "files"}`;
  // Without a commit there is no first parent to put the index's commit after: such a
  // snapshot holds no index, like one made before snapshots held it.
  const index = head ? await indexCommit(git, root, paths, env, head, message, copy) : { ok: true, parents: [], conflicts: [], intents: [] };
  if (!index.ok) return fail(index);
  // The snapshot before it and the copy's id go in the message's body. Without them, a
  // rollback of the same files in the same state within the same second is the same commit
  // (one copy after another, or two apps' copies that read the same snapshot before
  // theirs), and moving the ref to the hash it already has adds nothing to the reflog.
  const before = await git.read(root, ["rev-parse", "-q", "--verify", SNAPSHOTS]);
  if (!before.ok && before.code !== 1) return fail(before);
  const after = before.ok ? ["-m", `After ${before.out.trim()}`] : [];
  const named = [...index.conflicts.map((path) => `${CONFLICT}${JSON.stringify(path)}`), ...index.intents.map((path) => `${INTENT}${JSON.stringify(path)}`)];
  const conflicts = named.length ? ["-m", named.join("\n")] : [];
  const parents = [head, ...index.parents].filter(Boolean).flatMap((parent) => ["-p", parent]);
  const commit = await git(root, [...IDENTITY, "commit-tree", "--no-gpg-sign", tree.out.trim(), ...parents, "-m", message, ...after, "-m", `Copy ${copy}`, ...conflicts]);
  if (!commit.ok) return fail(commit);
  const hash = commit.out.trim();
  // --create-reflog: git keeps a reflog only for branches and HEAD unless told to.
  const ref = await git(root, [...IDENTITY, "update-ref", "--create-reflog", "-m", message, SNAPSHOTS, hash]);
  if (!ref.ok) return fail(ref);
  return { ok: true, code: 0, out: "", err: "", snapshot: hash };
}

// indexCommit: the snapshot's second parent. A commit on `head` whose tree is HEAD's with
// each of `paths` as the real index has it now: its staged entry, or nothing for a staged
// deletion. A path in a conflict (stages 1 to 3) can't be in a tree: it stays HEAD's and
// comes back in `conflicts`, for the snapshot's message. A path only announced
// (intent-to-add) is left out of the tree and comes back in `intents`, for the message too.
// Built in the scratch index `env` names, which holds the snapshot's own tree until this
// starts.
// → { ok, parents: [hash], conflicts: [path], intents: [path] }
async function indexCommit(git, root, paths, env, head, message, copy) {
  const staged = await indexEntries(git, root, paths);
  if (!staged.ok) return staged;
  const announced = await intentPaths(git, root, paths);
  if (!announced.ok) return announced;
  const base = await git(root, ["read-tree", head], { env });
  if (!base.ok) return base;
  const removed = [], conflicts = [], entries = [], intents = [];
  for (const path of paths) {
    const list = staged.entries.get(path);
    if (announced.paths.has(path)) { intents.push(path); removed.push(path); }
    else if (!list) removed.push(path);
    else if (list.some((entry) => entry.stage !== "0")) conflicts.push(path);
    else entries.push([path, list[0]]);
  }
  for (const chunk of chunks(removed)) {
    const r = await git(root, ["update-index", "--force-remove", "--", ...chunk], { env });
    if (!r.ok) return r;
  }
  for (const chunk of chunks(entries, ([path]) => path.length * 3 + 120)) {
    const r = await git(root, ["update-index", "--add", ...chunk.flatMap(([path, { mode, object }]) => ["--cacheinfo", mode, object, path])], { env });
    if (!r.ok) return r;
  }
  const tree = await git(root, ["write-tree"], { env });
  if (!tree.ok) return tree;
  const odd = await outside(git, root, head, tree.out.trim(), paths);
  if (!odd.ok) return odd;
  const commit = await git(root, [...IDENTITY, "commit-tree", "--no-gpg-sign", tree.out.trim(), "-p", head, "-m", `Index of ${message}`, "-m", `Copy ${copy}`]);
  if (!commit.ok) return commit;
  return { ok: true, parents: [commit.out.trim()], conflicts, intents };
}

// Which of `paths` the real index only announces (`git add -N`): { ok, paths: Set }.
// Comparing the index with the working tree, git names such an entry as added ("A"),
// which an entry it really holds never is; `ls-files -s` shows it as an empty file.
// An announced file missing from the disk reads as deleted instead, so it isn't found.
async function intentPaths(git, root, paths) {
  const found = new Set(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, ["--literal-pathspecs", "diff-files", "--raw", "--no-renames", "-z", "--", ...chunk]);
    if (!r.ok) return r;
    // ":<modes> <objects> <status>\0<path>\0" for each entry.
    const words = r.out.split("\0");
    for (let i = 0; i + 1 < words.length; i += 2) {
      if (words[i].endsWith(" A") && asked.has(words[i + 1])) found.add(words[i + 1]);
    }
  }
  return { ok: true, paths: found };
}

// The real index's entries of `paths`: { ok, entries: Map(path → [{ mode, object, stage }]) }.
// A path the index lacks has no key.
async function indexEntries(git, root, paths) {
  const found = new Map(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...chunk]);
    if (!r.ok) return r;
    // "<mode> <object> <stage>\t<path>"; a path names the files under a folder of that name too.
    for (const line of r.out.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0 || !asked.has(line.slice(tab + 1))) continue;
      const [mode, object, stage] = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      found.set(path, [...(found.get(path) ?? []), { mode, object, stage }]);
    }
  }
  return { ok: true, entries: found };
}

const changedWhileRecording = (path) => ({
  ok: false, code: -1, out: "",
  err: `The recorded files changed while they were being recorded (${path}); another rollback may be running on this repository. Try again.`,
  msg: { key: "restore.recordChanged", args: { path } },
});

// Every path the tree changes against `head` (or every path, without a commit) must be
// one of `paths`. → { ok } or a failure naming the first path that doesn't belong.
async function outside(git, root, head, tree, paths) {
  const r = head
    ? await git.read(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", head, tree])
    : await git.read(root, ["ls-tree", "-r", "-z", "--name-only", tree]);
  if (!r.ok) return r;
  const asked = new Set(paths);
  const stray = r.out.split("\0").find((path) => path && !asked.has(path));
  return stray === undefined ? { ok: true } : changedWhileRecording(stray);
}

const STATUS = { M: "modified", T: "modified", A: "added", D: "deleted" };

// listSnapshots(git, root) → { ok, code, err, snapshots }
//   snapshots: the newest LIST_LIMIT, newest first: [{ hash, time, files }]. time: when it
//   was made, unix seconds. files: [{ path, status }] by path, status "modified" |
//   "added" | "deleted" against the HEAD it was made on. [] when nothing was ever rolled
//   back here. One git call, plus one more only when that call fails.
export async function listSnapshots(git, root) {
  // -g walks the reflog, so every snapshot is listed, not only the ref's tip and what it
  // reaches. -z ends the header and each status and path with NUL. The output is read
  // word by word: a status is always followed by its path, so a path is never taken for
  // anything else whatever bytes it holds, and a word that starts with \x01 where a status
  // could be is the next entry's header (a status never does). A snapshot holding the
  // index has two parents: without --diff-merges=first-parent (git 2.31) git lists no
  // files for it; with it, the change against the first, the HEAD it was made on.
  const r = await git.read(root, ["log", "-g", `--max-count=${LIST_LIMIT}`, "--format=%x01%H %ct", "--name-status", "--no-renames", "--root", "--diff-merges=first-parent", "-z", "--no-color", SNAPSHOTS, "--"]);
  if (!r.ok) {
    // Never rolled back: no such ref. Asked of git, not read from its words, which may be
    // in another language.
    const ref = await git.read(root, ["rev-parse", "-q", "--verify", SNAPSHOTS]);
    if (ref.code === 1) return { ok: true, code: 0, err: "", snapshots: [] };
    return { ok: false, code: r.code, err: r.err, snapshots: [] };
  }
  const snapshots = [], words = r.out.split("\0");
  let entry = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith("\x01")) {
      const [hash, time] = word.slice(1).trim().split(" ");
      entry = { hash, time: Number(time), files: [] };
      snapshots.push(entry);
      continue;
    }
    // The first status of an entry comes after a line break; the output ends with NUL.
    const status = STATUS[word.replace(/^\n/, "")[0]];
    const path = words[++i];
    if (entry && status && path !== undefined) entry.files.push({ path, status });
  }
  for (const { files } of snapshots) files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, code: 0, err: "", snapshots };
}

// Why a path was not restored: the English sentence and its message key (i18n.js).
const REASONS = {
  notIn: { reason: "it isn't in this rollback", msg: { key: "restore.skipNotIn" } },
  flagged: { reason: "git is told not to watch this file (assume-unchanged or skip-worktree); clear that flag to restore it", msg: { key: "restore.skipFlagged" } },
  headMoved: { reason: "HEAD has another version of it now", msg: { key: "restore.skipHeadMoved" } },
  changed: { reason: "it was changed after the rollback", msg: { key: "restore.skipChanged" } },
  tracked: { reason: "git tracks a file at this path now", msg: { key: "restore.skipTracked" } },
  taken: { reason: "something is there on disk now", msg: { key: "restore.skipTaken" } },
  broken: { reason: "git failed while writing it: it is neither as HEAD has it nor as it was before the rollback", msg: { key: "restore.skipBroken" } },
};
// Why a restored path's staging was not brought back.
const STAGING = {
  changed: { reason: "something else is staged for it now", msg: { key: "restore.stagingChanged" } },
  conflict: { reason: "it was in a conflict, and a conflict can't be brought back", msg: { key: "restore.stagingConflict" } },
};

// restore(git, root, { snapshot, paths, copy })
//   → { ok, code, out, err, msg?, restored, skipped, stagingSkipped, changed }
//   Brings `paths` of `snapshot` (a hash from listSnapshots) back as they were just before
//   that rollback: a modified file gets that content, a deleted file is deleted again, an
//   added file comes back. Then each restored path's index entry goes back to what the
//   snapshot's second parent holds (what was staged), only where the index has HEAD's entry
//   now (none, where HEAD lacks the path) and the snapshot's differs from the HEAD it was
//   made on. Where something else is staged now, or the path was in a conflict (the
//   snapshot's message names it), the index stays and the path is in stagingSkipped:
//   [{ path, reason, msg }]; one whose index already holds the snapshot's needs nothing. A
//   path the message names as only announced (intent-to-add) is announced again. A
//   snapshot without a second parent (made before snapshots held the index, or in a
//   repository without a commit) leaves the index alone: an added file comes back untracked.
//   restored: the paths brought back. skipped: [{ path, reason, msg }] for each path that
//   changed in the meantime and is left exactly as it is, its index included:
//   - HEAD has another version of it than the HEAD the snapshot was made on;
//   - a modified or deleted file isn't as HEAD has it in the working tree (or git doesn't
//     track it any more);
//   - an added file's place is taken: git tracks a file there, or anything is there on
//     disk (a file, a folder, a link, another spelling the disk takes as the same name,
//     or a file or link where a folder above it should be). A file under that very name
//     that git would record with the snapshot's content and mode is the file already
//     restored: it is in `restored` and left untouched;
//   - its index entry is flagged assume-unchanged or skip-worktree;
//   - the snapshot doesn't hold a change of it.
//   An added file's place is left to the disk: the file is written by a git command that
//   refuses where anything is in its way, never by guessing names, from the scratch index
//   of `copy` (the calling copy's id, as for record; without one nothing is restored).
//   ok is false when a path or its staging was skipped (err lists them) or a git call
//   failed (its words, and the paths restored before it in `restored`). When git fails partway through
//   writing files, the disk is read again: those it holds as the snapshot has them are in
//   `restored`, those git left neither as HEAD has them nor as the snapshot has them are
//   skipped with that reason. changed: anything on disk changed or may have (a write
//   that ended without a result, code -1), also when a git call
//   after a written file failed (a screen reads the repository again).
//   msg comes with an err this module wrote, also around git's words (wordRestore).
export async function restore(git, root, { snapshot, paths = [], copy } = {}) {
  // already: the restored paths that were on disk as recorded, so nothing was written.
  const restored = [], skipped = [], already = [], stagingSkipped = [];
  // touched: git changed a path on disk that is not in `restored` (a batch that failed),
  // or the index.
  let touched = false;
  const moved = () => restored.length > already.length || touched;
  const failed = (r) => {
    const out = { ok: false, code: r.code, out: r.out ?? "", restored, skipped, stagingSkipped, changed: moved() };
    if (!skipped.length) return { ...out, err: r.err, ...(r.msg ? { msg: r.msg } : {}) };
    const list = reasonList(skipped), cause = r.msg ? { cause: r.msg } : {};
    if (!r.err) return { ...out, err: notRestored(skipped), msg: { key: "restore.notRestored", args: { list } } };
    return { ...out, err: `${r.err}\n${notRestored(skipped)}`, msg: { key: "restore.failedNotAll", args: { err: r.err, list }, ...cause } };
  };
  // A hash only: anything else could be read as an option or a revision expression.
  if (!HASH.test(String(snapshot ?? ""))) return { ok: false, code: -1, out: "", err: "No rollback to restore from.", msg: { key: "restore.noSnapshot" }, restored, skipped, stagingSkipped, changed: false };
  if (!COPY.test(String(copy ?? ""))) return { ...noCopy, restored, skipped, stagingSkipped, changed: false };
  const asked = [...new Set(paths)];
  if (!asked.length) return { ok: true, code: 0, out: "", err: "", restored, skipped, stagingSkipped, changed: false };
  const made = await madeOn(git, root, snapshot);
  if (!made.ok) return failed(made);
  const [parent = null, staging = null] = made.parents;
  const at = await headCommit(git, root);
  if (!at.ok) return failed(at);
  const none = { ok: true, entries: new Map() };
  const [mine, then, now, index, held] = await Promise.all([
    inTree(git, root, snapshot, asked),
    parent ? inTree(git, root, parent, asked) : none,
    at.head ? inTree(git, root, at.head, asked) : none,
    inIndex(git, root, asked),
    staging ? inTree(git, root, staging, asked) : none,
  ]);
  for (const r of [mine, then, now, index, held]) if (!r.ok) return failed(r);

  const skip = (path, why) => skipped.push({ path, ...REASONS[why] });
  const kind = (path) => {
    const was = then.entries.get(path), is = mine.entries.get(path);
    if (was === is) return null;
    return !was ? "added" : !is ? "deleted" : "modified";
  };
  const tracked = [], added = [];
  for (const path of asked) {
    const k = kind(path);
    if (!k) skip(path, "notIn");
    else if (index.flagged.has(path)) skip(path, "flagged");
    else if (now.entries.get(path) !== then.entries.get(path)) skip(path, "headMoved");
    else if (k === "added" && index.paths.has(path)) skip(path, "tracked");
    else (k === "added" ? added : tracked).push(path);
  }
  const changed = await differFromHead(git, root, tracked, at.head);
  if (!changed.ok) return failed(changed);
  for (const path of tracked) if (changed.paths.has(path)) skip(path, "changed");
  const write = tracked.filter((path) => !changed.paths.has(path));

  // Working tree only (no --staged), so the index stays; without overlay, a file the
  // snapshot lacks is deleted. Each of these holds what HEAD has, checked just above.
  for (const chunk of chunks(write)) {
    const r = await git(root, ["--literal-pathspecs", "restore", "-q", "--worktree", `--source=${snapshot}`, "--", ...chunk]);
    if (r.ok) { restored.push(...chunk); continue; }
    // git may have written some of the batch before it failed: the disk says which.
    const after = await afterFailure(git, root, snapshot, at.head, chunk);
    if (!after.ok) { touched = true; return failed(r); }
    restored.push(...after.restored);
    for (const path of after.broken) skip(path, "broken");
    if (after.broken.length) touched = true;
    return failed(r);
  }
  const fresh = await writeAdded(git, root, added, mine.entries, copy);
  // Before a failure after them is returned: those files are on disk.
  restored.push(...fresh.written, ...(fresh.kept ?? []));
  already.push(...(fresh.kept ?? []));
  if (fresh.unknown) touched = true;
  for (const path of fresh.taken) skip(path, "taken");
  if (!fresh.ok) return failed(fresh);

  if (staging) {
    const put = await putStaging(git, root, restored, { then: then.entries, now: now.entries, held: held.entries, conflicts: made.conflicts, intents: made.intents });
    stagingSkipped.push(...put.skipped);
    if (put.wrote) touched = true;
    if (!put.ok) return failed(put);
  }
  if (skipped.length || stagingSkipped.length) {
    const n = restored.length, files = `Restored ${n === 1 ? "1 file" : `${n} files`}.`;
    // list, staged: one "path: reason" line each; a screen words the reasons again from
    // each path's msg (restore.skip*, restore.staging*).
    const list = reasonList(skipped), staged = reasonList(stagingSkipped);
    const [err, msg] = !stagingSkipped.length
      ? [`${files} ${notRestored(skipped)}`, { key: "restore.notAll", args: { n, list } }]
      : !skipped.length
        ? [`${files} ${notStaged(stagingSkipped)}`, { key: "restore.stagingNotAll", args: { n, staged } }]
        : [`${files} ${notRestored(skipped)}\n${notStaged(stagingSkipped)}`, { key: "restore.notAllStaging", args: { n, list, staged } }];
    return { ok: false, code: -1, out: "", restored, skipped, stagingSkipped, changed: moved(), err, msg };
  }
  return { ok: true, code: 0, out: "", err: "", restored, skipped, stagingSkipped, changed: moved() };
}

// The parents of `snapshot` and the paths its message names as in a conflict or only
// announced: { ok, parents: [hash], conflicts: Set, intents: Set }.
async function madeOn(git, root, snapshot) {
  const r = await git.read(root, ["cat-file", "commit", snapshot]);
  if (!r.ok) return r;
  const end = r.out.indexOf("\n\n");
  const head = end < 0 ? r.out : r.out.slice(0, end), message = end < 0 ? "" : r.out.slice(end + 2);
  const parents = head.split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  const conflicts = new Set(), intents = new Set();
  for (const line of message.split("\n")) {
    const [prefix, set] = line.startsWith(CONFLICT) ? [CONFLICT, conflicts] : line.startsWith(INTENT) ? [INTENT, intents] : [];
    if (!prefix) continue;
    try {
      const path = JSON.parse(line.slice(prefix.length));
      if (typeof path === "string") set.add(path);
    } catch { /* not a line this module wrote */ }
  }
  return { ok: true, parents, conflicts, intents };
}

// Puts the staging of restored `paths` back on the real index (see restore).
// then, now, held: "<mode> <object>" by path in the HEAD the snapshot was made on, HEAD
// now, and the snapshot's second parent. intents: the paths the index only announced,
// which go back as announced (`git add -N`). → { ok, skipped, wrote } (on a failed git
// call, its failure too; wrote: an index write was started).
async function putStaging(git, root, paths, { then, now, held, conflicts, intents }) {
  const skipped = [], remove = [], stage = [], announce = [];
  const keep = paths.filter((path) => !conflicts.has(path) && (intents.has(path) || held.get(path) !== then.get(path)));
  for (const path of paths) if (conflicts.has(path)) skipped.push({ path, ...STAGING.conflict });
  const [index, announced] = await Promise.all([indexEntries(git, root, keep), intentPaths(git, root, keep)]);
  for (const r of [index, announced]) if (!r.ok) return { ...r, skipped, wrote: false };
  const entry = (path) => {
    if (announced.paths.has(path)) return "intent";
    const list = index.entries.get(path);
    if (!list) return undefined;
    return list.length === 1 && list[0].stage === "0" ? `${list[0].mode} ${list[0].object}` : "conflict";
  };
  for (const path of keep) {
    const is = entry(path), want = intents.has(path) ? "intent" : held.get(path);
    if (is === want) continue;
    if (is !== now.get(path)) skipped.push({ path, ...STAGING.changed });
    else if (want === undefined) remove.push(path);
    else if (want !== "intent") stage.push(path);
    else {
      // `add -N` leaves an entry the index holds as it is.
      if (is !== undefined) remove.push(path);
      announce.push(path);
    }
  }
  let wrote = false;
  for (const chunk of chunks(remove)) {
    wrote = true;
    const r = await git(root, ["update-index", "--force-remove", "--", ...chunk]);
    if (!r.ok) return { ...r, skipped, wrote };
  }
  for (const chunk of chunks(stage, (path) => path.length * 3 + 120)) {
    wrote = true;
    const r = await git(root, ["update-index", "--add", ...chunk.flatMap((path) => ["--cacheinfo", ...held.get(path).split(" "), path])]);
    if (!r.ok) return { ...r, skipped, wrote };
  }
  // -f: a file announced in spite of .gitignore was announced with -f too.
  for (const chunk of chunks(announce)) {
    wrote = true;
    const r = await git(root, ["--literal-pathspecs", "add", "-N", "-f", "--", ...chunk]);
    if (!r.ok) return { ...r, skipped, wrote };
  }
  return { ok: true, skipped, wrote };
}

// reasonList(skipped, word?) → "path: reason" lines. word(skip) gives the reason (a
// screen's, from skip.msg); without it, the English one.
export const reasonList = (skipped, word = (skip) => skip.reason) => skipped.map((skip) => `${skip.path}: ${word(skip)}`).join("\n");
const notRestored = (skipped) => `Not restored, to keep what is there now:\n${reasonList(skipped)}`;
const notStaged = (skipped) => `Restored without their staging:\n${reasonList(skipped)}`;

// wordRestore(t, r) → restore's r.msg with its English values worded in t's language: the
// skipped paths' reasons (list, staged), and the failure before them when this module
// wrote it (cause). git's words and the paths stay as they are. undefined when r has no msg.
export function wordRestore(t, r) {
  const msg = r?.msg;
  if (!msg) return msg;
  const args = { ...msg.args };
  const word = (skip) => sentence(t, skip.msg, skip.reason);
  if ("list" in args) args.list = reasonList(r.skipped ?? [], word);
  if ("staged" in args) args.staged = reasonList(r.stagingSkipped ?? [], word);
  if (msg.cause) args.err = sentence(t, msg.cause, args.err);
  return { key: msg.key, args };
}

// After `git restore` failed on `paths`: which of them the working tree now holds as the
// snapshot has them (restored), and which git changed without getting them there: no
// longer as HEAD has them (broken). The rest are as they were. → { ok, restored, broken }
async function afterFailure(git, root, snapshot, head, paths) {
  const off = new Set(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git(root, ["--literal-pathspecs", "-c", "diff.autoRefreshIndex=true", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", snapshot, "--", ...chunk]);
    if (!r.ok) return r;
    for (const path of r.out.split("\0")) if (asked.has(path)) off.add(path);
  }
  const moved = await differFromHead(git, root, paths.filter((path) => off.has(path)), head);
  if (!moved.ok) return moved;
  return { ok: true, restored: paths.filter((path) => !off.has(path)), broken: paths.filter((path) => moved.paths.has(path)) };
}

// Writes each of `paths` from a scratch index holding only them (the real index is left
// alone): `checkout-index` without --force refuses where anything is at the path or a
// folder above it isn't a folder, under whatever spelling the disk folds to it.
// One call per path: a refusal can stop a call before the paths after it.
// → { ok, written, taken } (on a failed git call, its failure too).
async function writeAdded(git, root, paths, entries, copy) {
  const written = [], taken = [];
  if (!paths.length) return { ok: true, written, taken };
  const dir = await git.read(root, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return { ...dir, written, taken };
  const env = { GIT_INDEX_FILE: scratchIndex(dir.out.trim(), copy) };
  const run = async () => {
    const empty = await git(root, ["read-tree", "--empty"], { env });
    if (!empty.ok) return empty;
    for (const chunk of chunks(paths, (path) => path.length * 3 + 120)) {
      const r = await git(root, ["update-index", "--add", ...chunk.flatMap((path) => ["--cacheinfo", ...entries.get(path).split(" "), path])], { env });
      if (!r.ok) return r;
    }
    for (const path of paths) {
      const r = await git(root, ["checkout-index", "--", path], { env });
      // -1: no result (it didn't start, or timed out after writing the file, say), so
      // nothing is known about this path or the ones left: the disk may have changed.
      if (r.code === -1) return { ...r, unknown: true };
      (r.ok ? written : taken).push(path);
    }
    const same = await sameOnDisk(git, root, taken, env);
    for (const path of same) { kept.push(path); taken.splice(taken.indexOf(path), 1); }
    return { ok: true };
  };
  const kept = [];
  const r = await run();
  await git(root, ["read-tree", "--empty"], { env });
  return { ...r, written, taken, kept };
}

// Which of `paths` (refused by checkout-index; each in the scratch index `env` names) the
// disk already holds under exactly that name, as a file with the content and mode git
// would record for it. git judges it the way it does when it adds the file: through the
// repository's line-ending conversion and filters, and core.fileMode for the executable
// bit. A folder, a link, or another spelling the disk folds to the name is not the file.
// Any git call that fails leaves the rest unconfirmed (kept as taken). → Set of paths
async function sameOnDisk(git, root, paths, env) {
  const same = new Set();
  if (!paths.length) return same;
  // By the real index: ls-files -o leaves out what the scratch index holds. A plain
  // pathspec lends its own spelling to the folders it names, so "Dir/new.txt" would be
  // listed for a disk holding "dir/new.txt". Matched without case, git reads every name
  // from the disk instead, and only one spelled exactly as the path is the path.
  const listed = new Set();
  for (const chunk of chunks(paths, (path) => path.length * 3 + 18)) {
    const r = await git.read(root, ["ls-files", "-o", "-z", "--", ...chunk.map((path) => `:(literal,icase)${path}`)]);
    if (!r.ok) return same;
    for (const path of r.out.split("\0")) listed.add(path);
  }
  const named = paths.filter((path) => listed.has(path));
  if (!named.length) return same;
  // The scratch entries carry no file times: refreshing has git compare each file's
  // cleaned content with the entry and record the times where they match. Its exit code
  // only says some didn't; diff-files below names those.
  const fresh = await git(root, ["update-index", "-q", "--refresh"], { env });
  if (fresh.code === -1) return same;
  const differ = new Set();
  for (const chunk of chunks(named)) {
    const r = await git.read(root, ["--literal-pathspecs", "diff-files", "--name-only", "-z", "--", ...chunk], { env });
    if (!r.ok) return same;
    for (const path of r.out.split("\0")) differ.add(path);
  }
  for (const path of named) if (!differ.has(path)) same.add(path);
  return same;
}

// The entries of `paths` in a commit's tree: { ok, entries: Map(path → "<mode> <object>") }.
// A path the tree lacks has no key.
async function inTree(git, root, commit, paths) {
  const found = new Map(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", commit, "--", ...chunk]);
    if (!r.ok) return r;
    // "<mode> <type> <object>\t<path>"; a path names the files under a folder of that name too.
    for (const line of r.out.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0 || !asked.has(line.slice(tab + 1))) continue;
      const [mode, , object] = line.slice(0, tab).split(" ");
      found.set(line.slice(tab + 1), `${mode} ${object}`);
    }
  }
  return { ok: true, entries: found };
}

// Which of `paths` the index has, and which of those are flagged assume-unchanged or
// skip-worktree: { ok, paths: Set, flagged: Set }.
async function inIndex(git, root, paths) {
  const found = new Set(), flagged = new Set(), asked = new Set(paths);
  for (const chunk of chunks(paths)) {
    const r = await git.read(root, ["--literal-pathspecs", "ls-files", "-v", "-z", "--", ...chunk]);
    if (!r.ok) return r;
    // "<tag> <path>": a lower-case tag is assume-unchanged, S is skip-worktree (s both).
    for (const line of r.out.split("\0")) {
      const path = line.slice(2);
      if (!asked.has(path)) continue;
      found.add(path);
      if (/^[a-zS] /.test(line)) flagged.add(path);
    }
  }
  return { ok: true, paths: found, flagged };
}

// Which of `paths` differ in the working tree from `head` (content, kind, executable bit,
// or missing, or no longer in the index): { ok, paths: Set }.
// Not a git.read: with diff.autoRefreshIndex off, a file whose times changed but whose
// content didn't (one Rollback just wrote) is listed as changed. With it on, git compares
// those contents and may save the new times in the index; the entries stay as they were.
async function differFromHead(git, root, paths, head) {
  const found = new Set(), asked = new Set(paths);
  if (!paths.length) return { ok: true, paths: found };
  for (const chunk of chunks(paths)) {
    const r = await git(root, ["--literal-pathspecs", "-c", "diff.autoRefreshIndex=true", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", head, "--", ...chunk]);
    if (!r.ok) return r;
    for (const path of r.out.split("\0")) if (asked.has(path)) found.add(path);
  }
  return { ok: true, paths: found };
}
