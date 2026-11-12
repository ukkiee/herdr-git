// Paths as list rows, flat or as a folder tree, and three-state checks. Pure: no git,
// no herdr. The Commit panel, the Rollback and Push dialogs, the Branch tree
// (names split on "/") and Commit details use it.
//
// The checks are separate functions over a Set of paths: a tree without checkboxes
// (branches, a commit's files) just doesn't call them.

// Case-insensitive first so "README.md" sits among the r's; the raw compare after it
// keeps the order the same on every run.
function byName(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// "src/app/a.ts" → { dirs: ["src", "app"], name: "a.ts" }. A path ending in "/" (git
// reports an untracked nested repository that way) keeps the slash in its name.
function split(path) {
  const dirs = path.split("/");
  if (dirs.length > 1 && dirs[dirs.length - 1] === "") { dirs.pop(); dirs[dirs.length - 1] += "/"; }
  const name = dirs.pop();
  return { dirs, name };
}

function fileRow(item, depth, name, dir) {
  return { key: item.path, depth, folder: false, open: false, name, dir, path: item.path, count: 1, item, paths: [item.path] };
}

// buildRows(items, { grouped, collapsed, compact }) → rows in display order
//   items: [{ path, ... }] (anything else on an item is carried along as row.item).
//     A path is split on "/": file paths and branch names ("feat/login") alike.
//   grouped: false → one row per item, by name; true → a folder tree: in each folder
//     its folders first, then its files, both by name.
//   collapsed: Set of folder keys whose children are left out.
//   compact: true → a folder whose only child is another folder is drawn as one row
//     ("src/app"), the way changed files are grouped. Leave it off for branches.
//   row: { key, depth, folder, open, name, dir, path, count, item, paths }
//     folder rows: key is the folder's path plus "/" (so a file and a folder of the same
//     name never share a key), name the folder (or "a/b" when compact joined them), dir
//     the folder it sits in, count its files at any depth, paths all of their paths,
//     open false when collapsed, item null.
//     file rows: key is the path, name the last part, dir the rest ("" at the root),
//     item the input item, paths [path], count 1.
//   depth starts at 0; a caller that nests the rows under a group row adds its own.
export function buildRows(items, { grouped = false, collapsed = new Set(), compact = false } = {}) {
  if (!grouped) {
    return items
      .map((item) => { const { dirs, name } = split(item.path); return fileRow(item, 0, name, dirs.join("/")); })
      .sort((a, b) => byName(a.name, b.name) || byName(a.dir, b.dir));
  }
  const root = { name: "", path: "", folders: new Map(), files: [] };
  for (const item of items) {
    const { dirs, name } = split(item.path);
    let node = root;
    for (const dir of dirs) {
      let next = node.folders.get(dir);
      if (!next) { next = { name: dir, path: node.path ? `${node.path}/${dir}` : dir, folders: new Map(), files: [] }; node.folders.set(dir, next); }
      node = next;
    }
    node.files.push({ item, name });
  }
  const rows = [];
  // Returns the paths under `node` and appends its rows when `shown`.
  const walk = (node, depth, shown) => {
    const paths = [];
    for (const first of [...node.folders.values()].sort((a, b) => byName(a.name, b.name))) {
      let folder = first, name = first.name;
      while (compact && !folder.files.length && folder.folders.size === 1) {
        folder = folder.folders.values().next().value;
        name += `/${folder.name}`;
      }
      const key = `${folder.path}/`, open = !collapsed.has(key);
      const row = { key, depth, folder: true, open, name, dir: node.path, path: folder.path, count: 0, item: null, paths: null };
      if (shown) rows.push(row);
      row.paths = walk(folder, depth + 1, shown && open);
      row.count = row.paths.length;
      for (const path of row.paths) paths.push(path);
    }
    for (const file of node.files.sort((a, b) => byName(a.name, b.name))) {
      if (shown) rows.push(fileRow(file.item, depth, file.name, node.path));
      paths.push(file.item.path);
    }
    return paths;
  };
  walk(root, 0, true);
  return rows;
}

// folderKeys(items, { compact }) → every folder key of the grouped tree, for Collapse All
// (`collapsed = new Set(folderKeys(items))`); Expand All is an empty Set.
export function folderKeys(items, { compact = false } = {}) {
  return buildRows(items, { grouped: true, compact }).filter((row) => row.folder).map((row) => row.key);
}

// parentIndex(rows, index) → the index of the row this one sits under (the nearest row
// above with a smaller depth), or -1 at the top level. For the left arrow.
export function parentIndex(rows, index) {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth) return i;
  return -1;
}

// checkState(paths, included) → "all" | "some" | "none"
//   paths: a row's `paths` (or a whole group's). included: Set of Included paths.
//   Nothing to check ([]) is "none".
export function checkState(paths, included) {
  let on = 0;
  for (const path of paths) if (included.has(path)) on++;
  return on === 0 ? "none" : on === paths.length ? "all" : "some";
}

// toggleIncluded(included, paths) → a new Set: all of `paths` removed when every one was
// included, added otherwise (a click on a partly checked folder checks all of it).
export function toggleIncluded(included, paths) {
  const next = new Set(included);
  if (checkState(paths, included) === "all") for (const path of paths) next.delete(path);
  else for (const path of paths) next.add(path);
  return next;
}

// keepIncluded(included, items) → a new Set with only the paths still in `items`
// (after a refresh: files that are gone drop out, the rest stay Included).
export function keepIncluded(included, items) {
  const next = new Set();
  for (const item of items) if (included.has(item.path)) next.add(item.path);
  return next;
}
