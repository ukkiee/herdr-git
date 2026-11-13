// The conflict module: a conflicted file's three versions, taking one side, saving a
// result, undoing a resolution, and resolving every simple conflict at once. Takes the
// git runner (git.js), so node tests it against real repositories.
//
// "ours" and "theirs" are git's: ours is stage 2 (HEAD; in a rebase, the branch being
// rebuilt onto), theirs stage 3 (the branch merged, the commit picked or rebuilt). Which
// one a screen calls "mine" is the caller's choice.
//
// Every result is { ok, code, out, err, … } and nothing throws. A sentence the module
// writes itself comes in English (err) with msg: { key, args } from messages-conflicts.js.

import { READ } from "./git.js";
import { merge, applyNonConflicting, resolveSimple, resolved, resultText } from "./merge-chunks.js";

const done = (extra = {}) => ({ ok: true, code: 0, out: "", err: "", ...extra });
const failed = (err, msg, extra = {}) => ({ ok: false, code: 1, out: "", err, msg, ...extra });
const notConflicted = (path) => failed(`${path} is not in conflict.`, { key: "conflicts.notConflicted", args: { path } });
const writeFailed = (path, err) => failed(`Couldn't write ${path}: ${err}`, { key: "conflicts.writeFailed", args: { path, err } });

// A path given to git as it is: no wildcard or magic in a file name means anything.
const literal = (path) => `:(literal)${path}`;
const STAGE = { ours: 2, theirs: 3 };

// The unmerged index entries: { [path]: { [stage]: { mode, id } } }, for one path or all.
async function unmergedEntries(git, root, path) {
  const r = await git(root, [...READ, "ls-files", "-u", "-z", ...(path === undefined ? [] : ["--", literal(path)])]);
  if (!r.ok) return { r };
  const entries = {};
  for (const item of r.out.split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(item);
    if (!m) continue;
    (entries[m[4]] ??= {})[m[3]] = { mode: m[1], id: m[2] };
  }
  return { r, entries };
}

// Text that can't be shown and written back as text: a NUL byte (git's own test), or a
// byte sequence that isn't UTF-8 (it comes back with U+FFFD and would be written changed).
const unreadable = (text) => text.includes("\0") || text.includes("�");

// readVersions(git, root, path, { read? }) → { ok, path, binary, has, base, ours, theirs,
// worktree? }. base, ours, theirs: the text of stages 1, 2, 3, null where that side has no
// file (deleted, or no common base). binary: one of them can't be shown as text (also a
// file marked binary in .gitattributes, a link or a submodule); then all three are null
// and `has` says which exist. worktree: the file on disk, when `read(absolutePath)` is
// given (readTextFile), null when it can't be read.
export async function readVersions(git, root, path, { read } = {}) {
  const { r, entries } = await unmergedEntries(git, root, path);
  if (!entries) return r;
  const stages = entries[path];
  if (!stages) return notConflicted(path);
  const has = { base: !!stages[1], ours: !!stages[2], theirs: !!stages[3] };
  const texts = {};
  let binary = Object.values(stages).some((s) => s.mode !== "100644" && s.mode !== "100755");
  const attr = await git(root, [...READ, "check-attr", "-z", "diff", "--", path]);
  if (attr.ok && attr.out.split("\0")[2] === "unset") binary = true;
  for (const [name, stage] of [["base", 1], ["ours", 2], ["theirs", 3]]) {
    if (binary || !stages[stage]) { texts[name] = null; continue; }
    const blob = await git(root, [...READ, "cat-file", "blob", stages[stage].id]);
    if (!blob.ok) return blob;
    if (unreadable(blob.out)) binary = true;
    texts[name] = blob.out;
  }
  if (binary) Object.assign(texts, { base: null, ours: null, theirs: null });
  const out = done({ path, binary, has, ...texts });
  if (typeof read === "function") {
    try { out.worktree = await read(`${root}/${path}`); } catch { out.worktree = null; }
    if (typeof out.worktree !== "string") out.worktree = null;
  }
  return out;
}

// acceptSide(git, root, path, side) → result. The path becomes resolved in the index with
// that side's version, on disk too; when that side deleted the file, it is deleted.
export async function acceptSide(git, root, path, side) {
  if (!STAGE[side]) return failed(`Unknown side: ${side}.`, { key: "conflicts.unknownSide", args: { side: String(side) } });
  const { r, entries } = await unmergedEntries(git, root, path);
  if (!entries) return r;
  const stages = entries[path];
  if (!stages) return notConflicted(path);
  if (!stages[STAGE[side]]) return git(root, ["rm", "-q", "--", literal(path)]);
  const take = await git(root, ["checkout", `--${side}`, "--", literal(path)]);
  if (!take.ok) return take;
  return git(root, ["add", "--", literal(path)]);
}

// saveResult(git, root, path, text, { write }) → result. Writes the text to the file and
// marks it resolved. write(absolutePath, text): writeTextFile for this computer's space,
// remoteWriter for another machine's; it may throw or return { ok: false, err }.
// A failed write leaves the conflict as it was.
export function saveResult(git, root, path, text, { write } = {}) {
  return saveWith(git, root, path, typeof write === "function" ? (target) => write(target, text) : null);
}

// saveStaged(git, root, path, file, placer) → result, as saveResult, with the text in a
// staged file (stageText) instead of in hand. placer: localPlacer or remotePlacer. The
// staged file is removed afterwards, whatever happened.
export async function saveStaged(git, root, path, file, placer) {
  try {
    return await saveWith(git, root, path, placer ? (target) => placer.place(file, target) : null);
  } finally {
    try { await placer?.drop(file); } catch { /* nothing more to do with it */ }
  }
}

async function saveWith(git, root, path, put) {
  const { r, entries } = await unmergedEntries(git, root, path);
  if (!entries) return r;
  if (!entries[path]) return notConflicted(path);
  if (!put) return writeFailed(path, "no way to write files");
  try {
    const w = await put(`${root}/${path}`);
    if (w && w.ok === false) return writeFailed(path, String(w.err ?? ""));
  } catch (error) {
    return writeFailed(path, String(error?.message ?? error));
  }
  return git(root, ["add", "--", literal(path)]);
}

// unresolve(git, root, path) → result. The path is in conflict again, with the stages the
// operation left (git keeps them when a conflict is resolved) and the file as git left it:
// conflict markers, or the one side's version when the other deleted it. Whatever was in
// the file is replaced.
export async function unresolve(git, root, path) {
  const back = await git(root, ["update-index", "--unresolve", "--", path]);
  if (!back.ok) return back;
  const { r, entries } = await unmergedEntries(git, root, path);
  if (!entries) return r;
  const stages = entries[path];
  // git says nothing when it has no record of the path's conflict.
  if (!stages) return failed(`Couldn't undo the resolution of ${path}: git has no record of its conflict.`, { key: "conflicts.cannotUnresolve", args: { path } });
  if (stages[2] && stages[3]) {
    const marked = await git(root, ["checkout", "-m", "--", literal(path)]);
    // A file git can't merge line by line (a binary) gets ours, as the operation left it.
    if (marked.ok) return marked;
  }
  return git(root, ["checkout", stages[2] ? "--ours" : "--theirs", "--", literal(path)]);
}

// resolveSimpleAll(git, root, { write, paths? }) → { ok, resolved, left }. Every conflicted
// file (or those of `paths`) whose changes all merge without a real conflict is saved with
// that merge and marked resolved: the changes on one side, the same change on both, and
// conflicts on different lines. Files with a real conflict, a deleted side or that can't
// be shown as text are left as they are. A save that fails stops nothing: the file is
// left, and the first failure is the result's err and msg.
export async function resolveSimpleAll(git, root, { write, paths } = {}) {
  let list = paths;
  if (!list) {
    const { r, entries } = await unmergedEntries(git, root);
    if (!entries) return r;
    list = Object.keys(entries);
  }
  list = [...new Set(list)].sort();
  const done_ = [], left = [];
  let failure = null;
  for (const path of list) {
    const v = await readVersions(git, root, path);
    if (!v.ok || v.binary || v.ours === null || v.theirs === null) { left.push(path); continue; }
    const state = resolveSimple(applyNonConflicting(merge(v.base ?? "", v.ours, v.theirs), "all"));
    if (!resolved(state)) { left.push(path); continue; }
    const saved = await saveResult(git, root, path, resultText(state), { write });
    if (saved.ok) done_.push(path);
    else { left.push(path); failure ??= saved; }
  }
  return failure
    ? { ...failure, resolved: done_, left }
    : done({ resolved: done_, left });
}

// The most text one remote call carries. Linux refuses a single argument over 128 KiB.
export const REMOTE_CHUNK_BYTES = 96 * 1024;

// UTF-8 parts of `text`, none over `limit` bytes, never splitting a letter. At least one.
function parts(text, limit) {
  const out = [];
  let start = 0, bytes = 0, i = 0;
  while (i < text.length) {
    const c = text.codePointAt(i), width = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4, units = c > 0xffff ? 2 : 1;
    if (bytes + width > limit) { out.push(text.slice(start, i)); start = i; bytes = 0; }
    bytes += width; i += units;
  }
  out.push(text.slice(start));
  return out;
}

// The first part goes into a copy of the file (cp -p keeps its mode), the others are
// appended, then the copy takes the file's name, so the file is never half written.
const FIRST = 'if [ -f "$2" ]; then cp -p "$2" "$3" || exit 1; fi; printf "%s" "$1" > "$3"';
const NEXT = 'printf "%s" "$1" >> "$2"';
const MOVE = 'mv -f "$1" "$2"';
const DROP = 'rm -f "$1"';

// shOn(exec, on) → run(script, args) → { ok, out, err }: a sh script on the machine `on`.
const shOn = (exec, on) => async (script, args) => {
  try {
    const r = await exec("sh", ["-c", script, "git-tools", ...args], { on });
    return r.code === 0
      ? { ok: true, out: r.stdout ?? "" }
      : { ok: false, err: (r.stderr ?? "").trim() || (r.stdout ?? "").trim() || `sh exited with ${r.code}` };
  } catch (error) {
    return { ok: false, err: String(error?.message ?? error) };
  }
};

// remoteWriter(exec, on) → write(absolutePath, text) → { ok, err }: writes a file on the
// machine `on` with sh, for a space on another machine (writeTextFile writes only on this
// one, and exec has no stdin), in parts of at most REMOTE_CHUNK_BYTES each.
export function remoteWriter(exec, on) {
  const run = shOn(exec, on);
  return async (path, text) => {
    const temp = `${path}.git-tools-${Math.random().toString(36).slice(2, 10)}.tmp`;
    const pieces = parts(String(text ?? ""), REMOTE_CHUNK_BYTES);
    let r = await run(FIRST, [pieces[0], path, temp]);
    for (let i = 1; r.ok && i < pieces.length; i++) r = await run(NEXT, [pieces[i], temp]);
    if (r.ok) r = await run(MOVE, [temp, path]);
    if (!r.ok) await run(DROP, [temp]);
    return r;
  };
}

// ---- a result handed over in a staged file
// A dialog asks a panel to save through the shared value every screen redraws on, so a
// result the size of the file can't ride in the request: the dialog writes it to a staged
// file on the space's machine (stageText) and the request names only that file. The
// panel puts the staged file's text in place (saveStaged) and removes it.

// Made by mktemp: the prefix and eight letters or digits. A request naming any other file
// is refused, so a request can never make the panel read or remove a file of the person's.
const STAGED = /^\/(?:[^\0]*\/)?git-tools-result\.[A-Za-z0-9]{8}$/;
// $1: the folder, "" for the machine's temporary folder.
const MAKE = 'd="${1:-${TMPDIR:-/tmp}}"; mkdir -p "$d" && mktemp "${d%/}/git-tools-result.XXXXXXXX"';
// $1 the staged file, $2 the file, $3 a temporary file next to it: as remoteWriter, the
// file keeps its mode and is never half written.
const PLACE = 'if [ -f "$2" ]; then cp -p "$2" "$3" || exit 1; fi; cat "$1" > "$3" && mv -f "$3" "$2"';

// isStaged(file) → whether `file` is a staged result's absolute path.
export const isStaged = (file) => typeof file === "string" && STAGED.test(file);

// stageText(exec, on, text, { dir }) → { ok, file } | { ok: false, err }: writes `text` to
// a new staged file on the machine `on` (null: this computer), byte for byte, in parts as
// remoteWriter does. dir: the folder to make it in (made when missing); none: the machine's
// temporary folder. The file is readable by the person only (mktemp's mode).
export async function stageText(exec, on, text, { dir = null } = {}) {
  const run = shOn(exec, on);
  const made = await run(MAKE, [dir ?? ""]);
  if (!made.ok) return made;
  const file = made.out.trim();
  if (!isStaged(file)) return { ok: false, err: `mktemp gave no usable file: ${file}` };
  const w = await remoteWriter(exec, on)(file, text);
  if (!w.ok) { await run(DROP, [file]); return { ok: false, err: w.err }; }
  return { ok: true, file };
}

// dropStaged(exec, on, file): removes a staged file (nothing for any other path).
export async function dropStaged(exec, on, file) {
  if (isStaged(file)) await shOn(exec, on)(DROP, [file]);
}

// A placer puts a staged file's text in a file and removes staged files:
//   place(staged, absolutePath) → { ok, err? } (may throw), drop(staged).

// remotePlacer(exec, on): for a space on another machine, with sh there (the text never
// leaves that machine). Byte for byte; the file keeps its mode.
export function remotePlacer(exec, on) {
  const run = shOn(exec, on);
  return {
    place: async (staged, path) => {
      const temp = `${path}.git-tools-${Math.random().toString(36).slice(2, 10)}.tmp`;
      const r = await run(PLACE, [staged, path, temp]);
      if (!r.ok) await run(DROP, [temp]);
      return r;
    },
    drop: (staged) => dropStaged(exec, on, staged),
  };
}

// localPlacer({ read, write, remove }): for this computer's space, so the file is written
// the way a local space writes (view-conflicts.js writerOn). read(file) → text,
// write(absolutePath, text), remove(file).
export function localPlacer({ read, write, remove }) {
  return {
    place: async (staged, path) => {
      const text = await read(staged);
      if (typeof text !== "string") return { ok: false, err: `Couldn't read ${staged}` };
      return write(path, text);
    },
    drop: async (staged) => { if (isStaged(staged)) await remove(staged); },
  };
}
