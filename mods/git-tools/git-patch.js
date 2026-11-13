// Patches outside the Log: Create Patch from local changes, and Apply Patch (from a file
// or the clipboard) on the working tree.
// Every git function takes `git` from makeGit (git.js) and the repository root, and
// returns { ok, code, out, err, msg?, … } instead of throwing. No `herdr` import: node
// tests it (git-patch.test.mjs).

import { chunks } from "./git.js";

// A commit the mod makes for itself needs no name the person configured.
const IDENTITY = ["-c", "user.name=git-tools", "-c", "user.email=git-tools@localhost"];
// One per worktree, in its own git folder. The panel runs this under the repository's
// write lock, so two of them never share the file.
const SCRATCH = "git-tools-patch-index";

// Before git runs: nothing changed.
const refuse = (err, msg) => ({ ok: false, code: -1, out: "", err, msg });

// ---- Reading a patch

// A C-quoted name as git writes one ("a/\355\225\234.txt"): escapes, and octal bytes
// that are UTF-8. → { name, end } (end: the index after the closing quote), or null.
const ESCAPES = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
function unquote(text, start = 0) {
  if (text[start] !== '"') return null;
  let bytes = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      try { return { name: decodeURIComponent(bytes), end: i + 1 }; } catch { return null; }
    }
    if (ch !== "\\") { bytes += encodeURIComponent(ch); continue; }
    const next = text[++i];
    if (/[0-7]/.test(next ?? "")) {
      bytes += `%${parseInt(text.slice(i, i + 3), 8).toString(16).padStart(2, "0")}`;
      i += 2;
    } else if (next in ESCAPES) bytes += encodeURIComponent(ESCAPES[next]);
    else return null;
  }
  return null;
}

// What follows "--- " or "+++ ": the name without git's trailing tab or a diff's date,
// null for /dev/null.
function headerName(rest) {
  const quoted = unquote(rest);
  const name = quoted ? quoted.name : rest.split("\t")[0];
  return name === "/dev/null" ? null : name;
}

// git apply's default -p1: the name after its first folder ("a/x" → "x").
const strip = (name) => (name === null ? null : name.includes("/") ? name.slice(name.indexOf("/") + 1) : name);

// The two names on a "diff --git" line: quoted ones read exactly; unquoted ones that
// hold spaces are split in the middle, which is right whenever both names are the same
// (a rename or copy says its names on lines of their own).
function gitLineNames(rest) {
  const first = unquote(rest);
  if (first) {
    const second = rest[first.end] === " " ? unquote(rest, first.end + 1) : null;
    return second ? [first.name, second.name] : [first.name, rest.slice(first.end + 1)];
  }
  const half = (rest.length - 1) / 2;
  return Number.isInteger(half) && rest[half] === " " ? [rest.slice(0, half), rest.slice(half + 1)] : [rest, rest];
}

// "@@ -12,3 +12,4 @@" → [3, 4]: the lines the hunk has on each side.
function hunkSize(line) {
  const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  return m ? [m[1] === undefined ? 1 : Number(m[1]), m[2] === undefined ? 1 : Number(m[2])] : null;
}

// readPatchFiles(text) → { ok, files: [{ path, from?, status }], err?, msg? }
//   The files a patch changes, in its order, named as git apply names them (after the
//   first folder: "a/x" is x), so they can be picked with --include. status: "added",
//   "modified", "deleted" or "renamed" (from: the old name; a copy is "added"). path: the
//   new name, the old one for a deleted file. Reads git's patches and plain unified
//   diffs. Pure: the screen reads the text, from a file or the clipboard.
//   Empty text (msg patch.empty) and text with no file in it (patch.notPatch) are refused.
export function readPatchFiles(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.replace(/\r$/, ""));
  if (!lines.some((line) => line.trim())) return { ok: false, files: [], err: "The patch is empty.", msg: { key: "patch.empty", args: {} } };
  const files = [];
  let entry = null, left = null;
  const end = () => {
    if (!entry) return;
    const { status, from } = entry;
    const path = status === "deleted" ? entry.old : entry.new ?? entry.old;
    if (path) files.push({ path, ...(status === "renamed" ? { from } : {}), status });
    entry = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Inside a hunk every line is the file's, whatever it looks like.
    if (left) {
      if (line === "" || /^[ +\-\\]/.test(line)) {
        // "\ No newline at end of file" counts on neither side.
        if (line[0] !== "\\" && line[0] !== "+") left[0]--;
        if (line[0] !== "\\" && line[0] !== "-") left[1]--;
        if (left[0] <= 0 && left[1] <= 0) left = null;
        continue;
      }
      left = null;
    }
    if (line.startsWith("diff --git ")) {
      end();
      const [a, b] = gitLineNames(line.slice(11)).map(strip);
      entry = { git: true, old: a, new: b, status: "modified", from: null };
    } else if (line.startsWith("@@ ") && entry) {
      left = hunkSize(line);
    } else if (entry?.git && !left) {
      if (line.startsWith("new file mode")) entry.status = "added";
      else if (line.startsWith("deleted file mode")) entry.status = "deleted";
      else if (line.startsWith("rename from ")) { entry.status = "renamed"; entry.old = entry.from = headerName(line.slice(12)); }
      else if (line.startsWith("rename to ")) entry.new = headerName(line.slice(10));
      else if (line.startsWith("copy from ")) entry.status = "added";
      else if (line.startsWith("copy to ")) entry.new = headerName(line.slice(8));
      else if (line.startsWith("--- ")) { const name = strip(headerName(line.slice(4))); if (name) entry.old = name; }
      else if (line.startsWith("+++ ")) { const name = strip(headerName(line.slice(4))); if (name) entry.new = name; }
    } else if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && hunkSize(lines[i + 2] ?? "")) {
      end();
      const old = strip(headerName(line.slice(4))), now = strip(headerName(lines[i + 1].slice(4)));
      entry = { git: false, old, new: now, status: old === null ? "added" : now === null ? "deleted" : "modified", from: null };
      i++;
    }
  }
  end();
  if (!files.length) return { ok: false, files: [], err: "This is not a patch.", msg: { key: "patch.notPatch", args: {} } };
  return { ok: true, files };
}

// ---- Apply Patch

// The most of a patch file the Apply Patch dialog reads (readTextFile's limit, in bytes).
export const READ_LIMIT = 1024 * 1024;

// readMayBeCut(text) → whether `text`, as readTextFile gave it, may be only the start of a
// longer file. Counted in UTF-8 bytes (no TextEncoder: the app's runtime may lack it),
// with room for one character cut in two at the end.
export function readMayBeCut(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (n >= READ_LIMIT - 3) return true;
  }
  return false;
}

// homePath(typed, home) → the path with a leading "~" (alone or before "/") as `home`,
// the home folder of the machine the file is on. git and the reader run without a
// shell, so nothing else would expand it. "~name" and other paths are left as typed.
export function homePath(typed, home) {
  if (!home || !(typed === "~" || typed.startsWith("~/"))) return typed;
  const top = home.replace(/\/+$/, "");
  return typed === "~" ? top || "/" : `${top}${typed.slice(1)}`;
}

// A name as a git apply --include pattern that matches that file only.
const literal = (path) => path.replace(/[\\*?[]/g, (ch) => `\\${ch}`);
// A big patch on another machine outlasts exec's default 30 s.
const TIMEOUT = 120000;

// The paths in a conflict in the index, in git's order.
async function unmerged(git, root) {
  const r = await git.read(root, ["ls-files", "-u", "-z"]);
  if (!r.ok) return { ...r, paths: [] };
  const paths = [];
  for (const line of r.out.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab >= 0 && paths[paths.length - 1] !== line.slice(tab + 1)) paths.push(line.slice(tab + 1));
  }
  return { ok: true, paths };
}

// applyPatch(git, root, { file, paths }) → { ok, code, out, err, msg?, threeWay, conflicts, changed }
//   Applies the patch in `file` (a path on the repository's machine) to the working tree,
//   only its files named in `paths` (as readPatchFiles names them). They are always named
//   to git, even when they are every file the dialog listed: a file git reads that the
//   list missed stays out. A long list goes in parts (chunks), one git apply each.
//   When it fits as it is, only the working tree changes. When it doesn't, it is applied
//   again as a 3-way merge, which git does on the index too: lines changed on one side
//   only merge, and lines changed on both stay in a conflict in the index (conflicts:
//   those paths, for the Conflicts dialog; ok is still true, msg patch.appliedConflicts).
//   threeWay: the 3-way merge applied it. A refusal (git's words, ok false) changes
//   nothing when the list is one part; a part refused after others leaves those applied.
//   Which way it went is read from the index's conflicts, never from git's words.
export async function applyPatch(git, root, { file, paths = [] } = {}) {
  const out = (r, more) => ({ ok: r.ok, code: r.code, out: r.out ?? "", err: r.err ?? "", ...(r.msg ? { msg: r.msg } : {}), threeWay: false, conflicts: [], changed: false, ...more });
  const list = paths.filter((path) => typeof path === "string" && path);
  if (!list.length) return out(refuse("No files are checked.", { key: "patch.noFiles", args: {} }));
  if (typeof file !== "string" || !file) return out(refuse("Enter the patch file's path.", { key: "patch.noFile", args: {} }));
  // "--include=" and an escape before each special character: at most twice the path.
  const parts = chunks(list, (path) => path.length * 6 + 11);
  const apply = (run, more, part) => run(root, ["apply", ...more, ...part.map((path) => `--include=${literal(path)}`), "--", file], { timeout: TIMEOUT });
  let check;
  for (const part of parts) { check = await apply(git.read, ["--check"], part); if (!check.ok) break; }
  if (check.ok) {
    let r;
    for (const part of parts) { r = await apply(git, [], part); if (!r.ok) break; }
    return out({ ...r, ...(r.ok ? { msg: { key: "patch.applied", args: {} } } : {}) }, { changed: true });
  }
  // git can't even read it: no 3-way would.
  if (check.code > 1) return out(check);
  const before = await unmerged(git, root);
  if (!before.ok) return out(before);
  // A part that fails leaving new conflicts was applied (its conflicts kept); one that
  // fails without any was refused, and the parts after it aren't tried.
  const seen = new Set(before.paths), conflicts = [];
  let r, refused = null;
  for (const part of parts) {
    r = await apply(git, ["--3way"], part);
    if (r.ok) continue;
    const now = await unmerged(git, root);
    const fresh = now.ok ? now.paths.filter((path) => !seen.has(path)) : [];
    if (!fresh.length) { refused = r; break; }
    for (const path of fresh) { seen.add(path); conflicts.push(path); }
  }
  if (refused) return out({ ...refused, err: refused.err || check.err }, { changed: true, threeWay: conflicts.length > 0, conflicts });
  if (!conflicts.length) return out({ ...r, msg: { key: "patch.appliedThreeWay", args: {} } }, { threeWay: true, changed: true });
  const n = conflicts.length;
  return out({ ...r, ok: true, err: "", msg: { key: "patch.appliedConflicts", args: { n } } }, { threeWay: true, conflicts, changed: true });
}

// ---- Create Patch from local changes

// changesCommit(git, root, { paths, message }) → { ok, code, out, err, msg?, hash, branch }
//   A commit on HEAD (none on a repository without commits) whose tree is HEAD's with each
//   of `paths` as the working tree has it now: changed, new (untracked too) or gone. No
//   ref names it, and the index and the working tree are left as they were (the tree is
//   built in a scratch index). Its patch is what the Patch File Settings dialog writes
//   for one commit (git-revision.js createPatch), so local changes take the same way as
//   a commit's. A rename is its old and its new path, both in `paths`.
//   message: the commit's message; empty: "Local changes".
//   branch: the branch HEAD is on (the patch file is offered under its name), null when
//   HEAD is detached.
export async function changesCommit(git, root, { paths = [], message = "" } = {}) {
  const list = paths.filter((path) => typeof path === "string" && path);
  if (!list.length) return { ...refuse("No files are checked.", { key: "patch.noFiles", args: {} }), hash: null };
  const dir = await git.read(root, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return { ...dir, hash: null };
  const env = { GIT_INDEX_FILE: `${dir.out.trim()}/${SCRATCH}` };
  const head = await git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok && head.err) return { ...head, hash: null };
  const parent = head.ok ? head.out.trim() : null;
  const made = await build(git, root, list, env, parent, String(message ?? ""));
  // Emptied whether or not the commit was made; a failure here leaves only a stale file.
  await git(root, ["read-tree", "--empty"], { env });
  if (!made.ok) return { ...made, branch: null };
  const branch = await git.read(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { ...made, branch: branch.ok ? branch.out.trim() || null : null };
}

async function build(git, root, paths, env, parent, message) {
  const fail = (r) => ({ ...r, ok: false, hash: null });
  const start = await git(root, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
  if (!start.ok) return fail(start);
  // --add takes a file HEAD lacks, --remove drops one the working tree lacks. Paths, not
  // pathspecs: a name like "*.ts" is that file only.
  for (const chunk of chunks(paths)) {
    const r = await git(root, ["update-index", "--add", "--remove", "--", ...chunk], { env });
    if (!r.ok) return fail(r);
  }
  const tree = await git(root, ["write-tree"], { env });
  if (!tree.ok) return fail(tree);
  // An empty -m makes commit-tree read the message from stdin, which never ends here.
  const words = message.trim() ? message : "Local changes";
  const commit = await git(root, [...IDENTITY, "commit-tree", "--no-gpg-sign", tree.out.trim(), ...(parent ? ["-p", parent] : []), "-m", words]);
  if (!commit.ok) return fail(commit);
  return { ok: true, code: 0, out: "", err: "", hash: commit.out.trim() };
}
