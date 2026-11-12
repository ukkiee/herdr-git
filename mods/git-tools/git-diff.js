// Reading one file's diff as rows the Diff tab draws one by one.

// readDiff(git, root, { path, commit, status, oldPath })
//   git: from makeGit (git.js). root: the repository root. path: relative to root.
//   commit: null → the working file against HEAD (an unversioned file is all added lines,
//   a deleted one all removed); a hash → that commit against its first parent (no parent:
//   all added). status: optional hint from git-status.js for a working file; "unversioned"
//   saves asking git whether the file is tracked.
//   oldPath: for a file the commit renamed, the path it had in the first parent
//   (git-show.js `from`): the file is compared with that one, so a rename without a
//   change has no rows. Ignored for a working file.
//   → { ok, err, binary, truncated, from, to, rows }
//   from / to: what is compared, for the header: "HEAD" and "Working Tree", or two short
//   hashes. `from` is "" when that side doesn't exist (an unversioned file, a repository
//   or a commit with nothing before it).
//   rows: [{ kind: "hunk" | "context" | "add" | "del" | "note", old, new, text }] with
//   old/new line numbers (null where a side has none). "note" is git's own remark inside a
//   hunk ("No newline at end of file"). Stops at MAX_ROWS rows or MAX_CHARS characters and
//   sets truncated. A binary file has no rows and binary: true.

export const MAX_ROWS = 5000;
export const MAX_CHARS = 400000;

// The person's git config must not change what comes back: no colors, no external diff
// or textconv program, three lines of context, the a/ b/ prefixes. Renames are off
// because one path is asked about: the other half of a rename isn't in the question.
const PLAIN = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
// A path is a path, not a pattern: `app/[id]/page.tsx` must not be read as a glob.
const LITERAL = "--literal-pathspecs";

const short = (hash) => String(hash).slice(0, 7);
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Unified diff text for one file → { binary, truncated, rows }. Everything before the
// first hunk is git's header (names, modes, hashes): only "Binary files … differ" matters.
export function parseDiff(out) {
  const rows = [];
  let binary = false, truncated = false, chars = 0, old = 0, next = 0, inHunk = false;
  // Walks the text line by line instead of splitting it: it can be megabytes long and
  // only the first MAX_ROWS lines are wanted.
  for (let start = 0; start < out.length;) {
    let end = out.indexOf("\n", start);
    if (end < 0) end = out.length;
    const line = out.slice(start, end);
    start = end + 1;
    const hunk = HUNK.exec(line);
    if (!inHunk && !hunk) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { binary = true; break; }
      continue;
    }
    let row;
    if (hunk) {
      old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true;
      row = { kind: "hunk", old: null, new: null, text: line };
    } else {
      // A file with CRLF endings keeps its \r in the diff; it isn't part of what is shown.
      const text = line.endsWith("\r") ? line.slice(1, -1) : line.slice(1);
      const mark = line[0];
      if (mark === "+") row = { kind: "add", old: null, new: next++, text };
      else if (mark === "-") row = { kind: "del", old: old++, new: null, text };
      else if (mark === " " || line === "") row = { kind: "context", old: old++, new: next++, text };
      else if (mark === "\\") row = { kind: "note", old: null, new: null, text: line.slice(2) };
      else { inHunk = false; continue; }
    }
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const room = MAX_CHARS - chars;
    if (row.text.length > room) {
      // One very long line (a minified file): show what fits of it.
      if (room > 0) rows.push({ ...row, text: row.text.slice(0, room) });
      truncated = true;
      break;
    }
    chars += row.text.length;
    rows.push(row);
  }
  return { binary, truncated, rows };
}

// err: git's own words; without any, ours (with msg, i18n.js).
const failed = (err, from = "", to = "", msg = { key: "dialogs.diff.unreadable", args: {} }) => ({
  ok: false, err: err || "git could not read the diff.", ...(err ? {} : { msg }), binary: false, truncated: false, from, to, rows: [],
});
const done = (out, from, to) => ({ ok: true, err: "", ...parseDiff(out), from, to });

async function readWorking(git, root, path, status) {
  const to = "Working Tree";
  // Nothing in git to compare with: every line of the file is an added line.
  // `diff --no-index` answers 1 when the two sides differ, which is the expected answer.
  // It also answers 1 for a file it can't open, but then it prints no diff.
  const allAdded = async () => {
    const r = await git.read(root, ["diff", "--no-index", ...PLAIN, "--", "/dev/null", path]);
    return r.code === 0 || (r.code === 1 && r.out) ? done(r.out, "", to) : failed(r.err, "", to);
  };
  // The hint comes from a list that may be older than the index: a file committed since
  // is compared with HEAD like any other.
  if (status === "unversioned") {
    const known = await git.read(root, [LITERAL, "ls-files", "--cached", "--", path]);
    if (known.code < 0) return failed(known.err, "", to);
    if (!known.out.trim()) return allAdded();
  }
  const r = await git.read(root, [LITERAL, "diff", ...PLAIN, "HEAD", "--", path]);
  if (!r.ok) {
    // A repository without a commit has no HEAD to compare with. Asked instead of read
    // from git's message, which is translated on some machines.
    const head = await git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return head.code === 1 ? allAdded() : failed(r.err, "HEAD", to);
  }
  if (!r.out) {
    // No difference, or a file git doesn't track (opened without the status hint).
    const others = await git.read(root, [LITERAL, "ls-files", "--others", "--", path]);
    if (others.ok && others.out.trim()) return allAdded();
  }
  return done(r.out, "HEAD", to);
}

async function readCommitted(git, root, path, commit, oldPath) {
  // "<hash> <parent> <parent>…": the full hash and whether there is anything before it.
  const info = await git.read(root, ["rev-list", "--parents", "-n", "1", String(commit), "--"]);
  const [hash, parent] = info.out.trim().split(/\s+/);
  if (!info.ok || !hash) return failed(info.err, "", short(commit));
  const from = parent ? short(parent) : "", to = short(hash);
  if (parent && oldPath && oldPath !== path) {
    // The two files themselves, each named by its commit and path, so nothing depends on
    // git pairing them as a rename again. A path the parent lacks makes git fail, and the
    // file is then read as any other file of the commit.
    const renamed = await git.read(root, ["diff", ...PLAIN, `${parent}:${oldPath}`, `${hash}:${path}`, "--"]);
    if (renamed.ok) return done(renamed.out, from, to);
  }
  const r = parent
    ? await git.read(root, [LITERAL, "diff", ...PLAIN, parent, hash, "--", path])
    : await git.read(root, [LITERAL, "diff-tree", "-p", "--root", "--no-commit-id", ...PLAIN, hash, "--", path]);
  return r.ok ? done(r.out, from, to) : failed(r.err, from, to);
}

// touchesDiff(changed, root, path) → whether a batch of changes on disk can change the
// working file's diff against HEAD. changed: absolute paths, as a folder watch on `root`
// reports them. True for the file, a folder above it, anything under its name (a folder
// took its place), the root's own git folder (HEAD or a branch moved) except its object
// store, and any path that isn't under `root` as written: the root itself stands for
// "everything may have changed", and a path spelled another way can't be judged.
export function touchesDiff(changed, root, path) {
  const slashed = (text) => String(text ?? "").replace(/\\/g, "/");
  const base = slashed(root).replace(/\/+$/, ""), file = `${base}/${path}`, gitDir = `${base}/.git`;
  return (changed ?? []).some((entry) => {
    const at = slashed(entry);
    if (!at.startsWith(`${base}/`)) return true;
    if (at === file || file.startsWith(`${at}/`) || at.startsWith(`${file}/`)) return true;
    if (at === gitDir) return true;
    return at.startsWith(`${gitDir}/`) && at !== `${gitDir}/objects` && !at.startsWith(`${gitDir}/objects/`);
  });
}

export async function readDiff(git, root, { path, commit = null, status = null, oldPath = null } = {}) {
  if (!path) return { ...failed("No file to show."), msg: { key: "dialogs.diff.noFile", args: {} } };
  return commit ? readCommitted(git, root, path, commit, oldPath) : readWorking(git, root, path, status);
}
