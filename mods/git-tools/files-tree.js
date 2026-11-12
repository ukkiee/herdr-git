// What the Files panel shows and where its keys go, worked out from what files-data.js
// read. Pure: no git, no herdr, so node tests every decision and the screen only draws.
//
//   markLookup(marks) → { mark(path), dot(folder) }
//   rankSearch(files, query, { limit }) → { items: [{ path, name, dir }], limited }
//   visibleRows(entries, open) → [{ path, name, folder, depth, open }]
//   moveKey(rows, current, key) → { current, expand, collapse, preview }
//
// Paths are from the tree's root and use "/".

// The folders a path sits in, nearest first: "a/b/c" → ["a/b", "a"].
function ancestors(path) {
  const out = [];
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) out.push(path.slice(0, at));
  return out;
}

// markLookup: what a row shows, from readMarks' marks.
//   mark(path) → "modified" | "added" | "deleted" | "conflict" | "ignored" | null. A path
//   inside an ignored folder is "ignored", inside an untracked folder "added" (the nearest
//   such folder decides). A folder's own mark is that of the whole folder, if git gave one.
//   The key "" marks every path: the tree's root is inside such a folder.
//   dot(folder) → true when a changed file sits anywhere below it. Ignored files don't
//   count; deleted ones do.
//   Build it once per read: it indexes every mark.
export function markLookup(marks) {
  const changed = new Set();
  for (const [key, mark] of Object.entries(marks)) {
    if (mark === "ignored" || !key) continue;
    const path = key.endsWith("/") ? key.slice(0, -1) : key;
    if (key.endsWith("/")) changed.add(path);
    for (const folder of ancestors(path)) changed.add(folder);
  }
  const wide = (path) => {
    for (const folder of ancestors(path)) if (marks[`${folder}/`]) return marks[`${folder}/`];
    return marks[""] ?? null;
  };
  const mark = (path) => marks[path] ?? marks[`${path}/`] ?? wide(path);
  // A folder inside an untracked folder holds only new files, unless it is itself ignored.
  const dot = (folder) => changed.has(folder) || (mark(folder) ?? "ignored") !== "ignored";
  return { mark, dot };
}

export const SEARCH_SHOWN = 200;

// Case-insensitive first, then the raw compare, so the order is the same on every run.
function byPath(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// rankSearch: the search box's results.
//   files: readSearchList's paths. query: what was typed; trimmed, and empty means no
//   results (the tree shows again).
//   → { items: [{ path, name, dir }], limited }. A file is in when the query is part of
//   its path, any case. Files whose name holds the query come first, then those that
//   match only through their folders; each group by path. At most `limit`
//   (SEARCH_SHOWN); limited says more matched. dir is the folder part ("" at the root).
export function rankSearch(files, query, { limit = SEARCH_SHOWN } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return { items: [], limited: false };
  const named = [], pathed = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    if (!lower.includes(q)) continue;
    const at = path.lastIndexOf("/");
    (lower.slice(at + 1).includes(q) ? named : pathed).push(path);
  }
  const ranked = [...named.sort(byPath), ...pathed.sort(byPath)];
  const items = ranked.slice(0, Math.max(limit, 0)).map((path) => {
    const at = path.lastIndexOf("/");
    return { path, name: path.slice(at + 1), dir: at < 0 ? "" : path.slice(0, at) };
  });
  return { items, limited: ranked.length > items.length };
}

// Nesting deeper than this isn't drawn: a link back to a parent folder would otherwise
// open forever as someone keeps expanding it.
const MAX_DEPTH = 40;

// visibleRows: the tree as rows, top to bottom.
//   entries: Map of folder path ("" for the root) → readFolder's entries. open: Set of
//   folder paths shown open. A folder is drawn open only when it and every folder above
//   it are open; an open folder not read yet has no rows under it.
//   → [{ path, name, folder, depth, open }]
export function visibleRows(entries, open) {
  const out = [];
  const walk = (prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of entries.get(prefix) ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isOpen = entry.dir && open.has(path);
      out.push({ path, name: entry.name, folder: entry.dir, depth, open: isOpen });
      if (isOpen) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

// moveKey: what a key does in the tree or the search results.
//   rows: visibleRows' rows, or rankSearch's items (rows without `folder` are files).
//   current: the chosen row's path, or null. key: "up" | "down" | "left" | "right" | "enter".
//   → { current, expand, collapse, preview }: the row to choose next, and the folder to
//   open, the folder to close or the file to preview (null when none). Up and down stop
//   at the ends. Right opens a closed folder, or goes to an open one's first child. Left
//   closes an open folder, or goes to the parent folder; a row at the root stays. Enter
//   opens or closes a folder and previews a file. With no chosen row (or one no longer
//   shown) an arrow chooses the first row; another key changes nothing.
export function moveKey(rows, current, key) {
  const result = (path, more = {}) => ({ current: path, expand: null, collapse: null, preview: null, ...more });
  const at = rows.findIndex((r) => r.path === current);
  const arrow = key === "up" || key === "down" || key === "left" || key === "right";
  if (at < 0) return result(arrow && rows.length ? rows[0].path : null);
  const row = rows[at];
  if (key === "up") return result(rows[Math.max(0, at - 1)].path);
  if (key === "down") return result(rows[Math.min(rows.length - 1, at + 1)].path);
  if (key === "right") {
    if (!row.folder) return result(row.path);
    if (!row.open) return result(row.path, { expand: row.path });
    const next = rows[at + 1];
    return result(next && next.depth === row.depth + 1 ? next.path : row.path);
  }
  if (key === "left") {
    if (row.folder && row.open) return result(row.path, { collapse: row.path });
    const parent = row.path.slice(0, Math.max(0, row.path.lastIndexOf("/")));
    return result(parent && rows.some((r) => r.path === parent) ? parent : row.path);
  }
  if (key === "enter") {
    if (!row.folder) return result(row.path, { preview: row.path });
    return result(row.path, row.open ? { collapse: row.path } : { expand: row.path });
  }
  return result(row.path);
}
