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
  const dot = (folder) => changed.has(folder) || (wide(folder) ?? "ignored") !== "ignored";
  return { mark, dot };
}
