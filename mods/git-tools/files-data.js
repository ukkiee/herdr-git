// What the Files panel reads from disk and git: a folder's entries, each path's git mark,
// and the list the search box looks through. Takes `exec` as an argument instead of
// importing "herdr", so node can test it against real folders and repositories.
// Every function returns a result and never throws. Nothing here writes under .git.
//
//   readFolder(exec, folder, { on, platform, limit, room })
//     → { ok, entries: [{ name, dir }], limited, gone, err }
//   readMarks(exec, folder, { on })
//     → { ok, repo: { root, prefix } | null, marks: { [path]: mark }, err }
//   readSearchList(exec, folder, { on, platform, limit })
//     → { ok, repo: boolean, files: [path], limited, err }
//
// `on`: the space's machine, null for this computer. `platform`: the window's platform
// ("windows" reads folders with PowerShell on this computer). Paths in results are
// relative to `folder` and use "/". What the marks mean for a row (ignored under an
// ignored folder, a folder's dot) is files-tree.js's job.
import { makeGit } from "./git.js";

export const PER_FOLDER = 500;
export const TOTAL = 5000;
export const SEARCH_LIMIT = 20000;

// Case-insensitive first so "README.md" sits among the r's; the raw compare after it keeps
// the order the same on every run.
function byName(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Prints "d\0name\0" or "f\0name\0" per entry and stops one past the limit, so a huge
// folder costs no more than the limit. `[ -d ]` follows links: a link to a folder is a
// folder, a dangling link is a file. Exit 3: the folder isn't there.
const LIST = '[ -d "$1" ] || exit 3; n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt "$2" ] && break; done; exit 0';

// PowerShell's single-quoted string doubles its quotes, and it reads the curly ones as
// quotes too.
const psQuote = (text) => "'" + text.replace(/['‘’‚‛]/g, "$&$&") + "'";

// Windows PowerShell otherwise writes in the console code page; exec decodes UTF-8.
// Links keep folder attributes even when dangling, so their target is checked. Other
// reparse points (OneDrive's folders) have no LinkType and are folders.
async function windowsFolder(exec, folder, on, count) {
  const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 3 }; @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First " + count + " | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } " + psQuote(folder);
  const r = await exec("powershell", ["-NoProfile", "-Command", command], { on });
  if (r.code !== 0) return { code: r.code, err: (r.stderr ?? "").trim() };
  const parsed = JSON.parse(r.stdout || "[]");
  return { code: 0, entries: (Array.isArray(parsed) ? parsed : [parsed]).map((e) => ({ name: String(e.name), dir: Boolean(e.dir) })) };
}

async function shFolder(exec, folder, on, count) {
  const r = await exec("sh", ["-c", LIST, "files", folder, String(count - 1)], { on });
  if (r.code !== 0) return { code: r.code, err: (r.stderr ?? "").trim() };
  const fields = r.stdout.split("\0"), entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return { code: 0, entries };
}

// readFolder: one folder's entries, folders first and then by name, .git left out.
//   limit: entries kept from this folder (PER_FOLDER). room: entries the whole tree can
//   still take (TOTAL minus what other open folders hold; files-tree.js roomFor).
//   limited: the folder had more than min(limit, room). Which entries survive a cut is
//   the folder's own listing order, not the sorted order: the read stops early so a huge
//   folder stays cheap.
//   gone: the folder isn't there (deleted, or the root moved). err: the reader's words.
//   A machine without `sh` (a Windows host over ssh) is read with PowerShell.
export async function readFolder(exec, folder, { on = null, platform = null, limit = PER_FOLDER, room = TOTAL } = {}) {
  const keep = Math.max(0, Math.min(limit, room));
  const count = Math.max(limit, 0) + 1;
  let r;
  try {
    if (!on && platform === "windows") r = await windowsFolder(exec, folder, on, count);
    else {
      try { r = await shFolder(exec, folder, on, count); }
      catch (error) {
        if (on && String(error?.message ?? error).includes("cannot start sh: program not found")) r = await windowsFolder(exec, folder, on, count);
        else throw error;
      }
    }
  } catch (error) {
    return { ok: false, entries: [], limited: false, gone: false, err: String(error?.message ?? error) };
  }
  if (r.code !== 0) return { ok: false, entries: [], limited: false, gone: r.code === 3, err: r.err };
  const entries = r.entries.slice(0, keep).sort((a, b) => Number(b.dir) - Number(a.dir) || byName(a.name, b.name));
  return { ok: true, entries, limited: r.entries.length > keep, gone: false, err: "" };
}

// The repository `folder` is in: { ok, repo: { root, prefix } | null, err }. prefix is the
// folder's path from root with a trailing "/" ("" at the root). Not being in a repository
// is ok with repo null; a git that can't run or answers otherwise is not ok.
async function repoOf(git, folder) {
  const r = await git.read(folder, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (r.ok) {
    const [root, prefix = ""] = r.out.split("\n");
    if (root) return { ok: true, repo: { root, prefix }, err: "" };
  }
  if (r.code > 0 && /not a git repository/i.test(r.err)) return { ok: true, repo: null, err: "" };
  return { ok: false, repo: null, err: r.err };
}

// One porcelain v2 entry's path: the text after `fields` space-separated fields (a path
// may itself hold spaces, so it can't be split off the end).
function pathAfter(entry, fields) {
  let at = 0;
  for (let i = 0; i < fields; i++) at = entry.indexOf(" ", at) + 1;
  return entry.slice(at);
}

// X is HEAD → index, Y is index → work tree; the same reading as the Commit panel.
function changeOf(xy) {
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

// readMarks: the git mark of every changed or ignored path under `folder`.
//   marks: { [path]: "modified" | "added" | "deleted" | "conflict" | "ignored" }, paths
//   from `folder`. Untracked files are "added". A key ending in "/" is a whole folder:
//   an untracked folder ("added") or an ignored one ("ignored"); what's inside it isn't
//   listed, so a node_modules costs one line. Deleted files are marked though they are
//   no longer on disk (a folder's dot counts them). Paths elsewhere in the repository
//   are left out.
//   repo: { root, prefix }, or null outside a repository (marks is empty, ok is true).
//   Reads only: nothing under .git is written, so the folder watch isn't set off again.
export async function readMarks(exec, folder, { on = null } = {}) {
  const git = makeGit(exec, on);
  const where = await repoOf(git, folder);
  if (!where.ok || !where.repo) return { ok: where.ok, repo: null, marks: {}, err: where.err };
  const { prefix } = where.repo;
  const r = await git.read(folder, ["status", "--porcelain=v2", "-z", "--no-renames", "--ignored=matching", "--untracked-files=normal", "--", "."]);
  if (!r.ok) return { ok: false, repo: where.repo, marks: {}, err: r.err };
  const marks = {};
  const put = (path, mark) => { if (path.startsWith(prefix) && path.length > prefix.length) marks[path.slice(prefix.length)] = mark; };
  for (const entry of r.out.split("\0")) {
    const kind = entry[0];
    if (kind === "1") put(pathAfter(entry, 8), changeOf(entry.slice(2, 4)));
    else if (kind === "u") put(pathAfter(entry, 10), "conflict");
    else if (kind === "?") put(entry.slice(2), "added");
    else if (kind === "!") put(entry.slice(2), "ignored");
  }
  return { ok: true, repo: where.repo, marks, err: "" };
}
