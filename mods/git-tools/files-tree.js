// What the Files panel shows and where its keys go, worked out from what files-data.js
// read. Pure: no git, no herdr, so node tests every decision and the screen only draws.
//
//   markLookup(marks) → { mark(path), dot(folder) }
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
//   dot(folder) → true when a changed file sits anywhere below it. Ignored files don't
//   count; deleted ones do.
//   Build it once per read: it indexes every mark.
export function markLookup(marks) {
  const changed = new Set();
  for (const [key, mark] of Object.entries(marks)) {
    if (mark === "ignored") continue;
    const path = key.endsWith("/") ? key.slice(0, -1) : key;
    if (key.endsWith("/")) changed.add(path);
    for (const folder of ancestors(path)) changed.add(folder);
  }
  const wide = (path) => {
    for (const folder of ancestors(path)) if (marks[`${folder}/`]) return marks[`${folder}/`];
    return null;
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
