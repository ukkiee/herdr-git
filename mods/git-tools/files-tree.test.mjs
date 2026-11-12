// node files-tree.test.mjs: the Files panel's pure decisions (search order, marks and dots,
// visible rows, arrow keys).
import assert from "node:assert/strict";
import { markLookup, rankSearch, visibleRows, moveKey } from "./files-tree.js";

// Marks: a file's own mark, a whole ignored or untracked folder marking what's inside it,
// the nearest such folder deciding, and dots that skip ignored files but count deletions.
{
  const m = markLookup({
    "a/b/c.ts": "modified",
    "a/gone.ts": "deleted",
    "x/debug.log": "ignored",
    "build/": "ignored",
    "fresh/": "added",
    "fresh/out/": "ignored",
    "only-deleted/old.txt": "deleted",
    "c.txt": "conflict",
  });
  assert.equal(m.mark("a/b/c.ts"), "modified");
  assert.equal(m.mark("a/b"), null);
  assert.equal(m.mark("c.txt"), "conflict");
  assert.equal(m.mark("build"), "ignored");
  assert.equal(m.mark("build/deep/file.js"), "ignored");
  assert.equal(m.mark("buildx/file.js"), null);
  assert.equal(m.mark("fresh/new.txt"), "added");
  assert.equal(m.mark("fresh/out/bin"), "ignored");
  assert.equal(m.mark("x/debug.log"), "ignored");
  assert.equal(m.mark("x/other.log"), null);

  assert.equal(m.dot("a"), true);
  assert.equal(m.dot("a/b"), true);
  assert.equal(m.dot("x"), false);
  assert.equal(m.dot("build"), false);
  assert.equal(m.dot("build/deep"), false);
  assert.equal(m.dot("fresh"), true);
  assert.equal(m.dot("fresh/sub"), true);
  assert.equal(m.dot("fresh/out"), false);
  assert.equal(m.dot("only-deleted"), true);
  assert.equal(m.dot("elsewhere"), false);

  // The root inside an untracked folder: every path is added, a nearer ignored folder
  // still wins, and folders get dots unless ignored.
  const inside = markLookup({ "": "added", "out/": "ignored" });
  assert.equal(inside.mark("a.txt"), "added");
  assert.equal(inside.mark("src/deep/b.ts"), "added");
  assert.equal(inside.mark("out/bin"), "ignored");
  assert.equal(inside.dot("src"), true);
  assert.equal(inside.dot("out"), false);

  const none = markLookup({});
  assert.equal(none.mark("a"), null);
  assert.equal(none.dot("a"), false);
}

// Search: part of the path, any case. Files whose name matches come before files that
// match only through their folders, each group by path. An empty query finds nothing.
{
  const files = ["src/Button.tsx", "docs/button-guide.md", "button/index.ts", "button/util.ts", "lib/x.ts", "README.md", "a/MyButton.css"];
  const r = rankSearch(files, "BUTTON");
  assert.deepEqual(r.items.map((i) => i.path), [
    "a/MyButton.css",
    "docs/button-guide.md",
    "src/Button.tsx",
    "button/index.ts",
    "button/util.ts",
  ]);
  assert.equal(r.limited, false);
  assert.deepEqual(r.items[0], { path: "a/MyButton.css", name: "MyButton.css", dir: "a" });
  assert.deepEqual(rankSearch(files, "readme").items, [{ path: "README.md", name: "README.md", dir: "" }]);

  // A query with a slash matches across folders.
  assert.deepEqual(rankSearch(files, "n/ut").items.map((i) => i.path), ["button/util.ts"]);
  // Korean and spaces are just characters.
  assert.deepEqual(rankSearch(["문서/회의 기록.md", "x.md"], "회의 기").items.map((i) => i.path), ["문서/회의 기록.md"]);

  assert.deepEqual(rankSearch(files, ""), { items: [], limited: false });
  assert.deepEqual(rankSearch(files, "   "), { items: [], limited: false });
  assert.deepEqual(rankSearch(files, "zzz"), { items: [], limited: false });
  assert.deepEqual(rankSearch([], "a"), { items: [], limited: false });
}

// Search cuts at the limit, keeping the best first, and says it did.
{
  const files = ["f/a1", "f/a2", "f/a3", "a-folder/x", "a-folder/y"];
  const cut = rankSearch(files, "a", { limit: 3 });
  assert.deepEqual(cut.items.map((i) => i.path), ["f/a1", "f/a2", "f/a3"]);
  assert.equal(cut.limited, true);
  const exact = rankSearch(files, "a", { limit: 5 });
  assert.equal(exact.limited, false);
  assert.deepEqual(exact.items.map((i) => i.path), ["f/a1", "f/a2", "f/a3", "a-folder/x", "a-folder/y"]);
}

// Visible rows: the loaded folders drawn as a tree, open folders showing what they hold,
// in the order each folder's entries came (readFolder sorts them).
const entries = new Map([
  ["", [{ name: "src", dir: true }, { name: "empty", dir: true }, { name: "z.txt", dir: false }]],
  ["src", [{ name: "lib", dir: true }, { name: "main.js", dir: false }]],
  ["src/lib", [{ name: "util.js", dir: false }]],
  ["empty", []],
]);
{
  assert.deepEqual(visibleRows(entries, new Set()), [
    { path: "src", name: "src", folder: true, depth: 0, open: false },
    { path: "empty", name: "empty", folder: true, depth: 0, open: false },
    { path: "z.txt", name: "z.txt", folder: false, depth: 0, open: false },
  ]);
  // src/lib is remembered as open but src is closed: nothing under src shows.
  assert.deepEqual(visibleRows(entries, new Set(["src/lib"])).map((r) => r.path), ["src", "empty", "z.txt"]);
  assert.deepEqual(visibleRows(entries, new Set(["src", "src/lib", "empty"])), [
    { path: "src", name: "src", folder: true, depth: 0, open: true },
    { path: "src/lib", name: "lib", folder: true, depth: 1, open: true },
    { path: "src/lib/util.js", name: "util.js", folder: false, depth: 2, open: false },
    { path: "src/main.js", name: "main.js", folder: false, depth: 1, open: false },
    { path: "empty", name: "empty", folder: true, depth: 0, open: true },
    { path: "z.txt", name: "z.txt", folder: false, depth: 0, open: false },
  ]);
  // An open folder not read yet shows no children.
  assert.deepEqual(visibleRows(new Map([["", [{ name: "a", dir: true }]]]), new Set(["a"])).map((r) => r.path), ["a"]);
  assert.deepEqual(visibleRows(new Map(), new Set()), []);
}

// Arrow keys: up and down walk the visible rows and stop at the ends. Right opens a closed
// folder, then goes to its first child; on a file or an empty folder it stays. Left closes
// an open folder, otherwise goes to the parent; a row at the root stays. Enter opens or
// closes a folder and previews a file.
{
  const rows = visibleRows(entries, new Set(["src", "empty"]));
  // src, src/lib, src/main.js, empty, z.txt
  const stay = { expand: null, collapse: null, preview: null };
  const go = (current, key) => moveKey(rows, current, key);

  assert.deepEqual(go("src", "up"), { current: "src", ...stay });
  assert.deepEqual(go("src", "down"), { current: "src/lib", ...stay });
  assert.deepEqual(go("src/main.js", "down"), { current: "empty", ...stay });
  assert.deepEqual(go("z.txt", "down"), { current: "z.txt", ...stay });
  assert.deepEqual(go("z.txt", "up"), { current: "empty", ...stay });

  assert.deepEqual(go("src/lib", "right"), { current: "src/lib", ...stay, expand: "src/lib" });
  assert.deepEqual(go("src", "right"), { current: "src/lib", ...stay });
  assert.deepEqual(go("empty", "right"), { current: "empty", ...stay });
  assert.deepEqual(go("src/main.js", "right"), { current: "src/main.js", ...stay });

  assert.deepEqual(go("src", "left"), { current: "src", ...stay, collapse: "src" });
  assert.deepEqual(go("src/lib", "left"), { current: "src", ...stay });
  assert.deepEqual(go("src/main.js", "left"), { current: "src", ...stay });
  assert.deepEqual(go("z.txt", "left"), { current: "z.txt", ...stay });

  assert.deepEqual(go("src/lib", "enter"), { current: "src/lib", ...stay, expand: "src/lib" });
  assert.deepEqual(go("src", "enter"), { current: "src", ...stay, collapse: "src" });
  assert.deepEqual(go("z.txt", "enter"), { current: "z.txt", ...stay, preview: "z.txt" });

  // Nothing chosen yet (or the row went away): an arrow picks the first row, Enter does nothing.
  assert.deepEqual(go(null, "down"), { current: "src", ...stay });
  assert.deepEqual(go("gone.txt", "up"), { current: "src", ...stay });
  assert.deepEqual(go(null, "enter"), { current: null, ...stay });
  assert.deepEqual(moveKey([], null, "down"), { current: null, ...stay });
  // Another key changes nothing.
  assert.deepEqual(go("src", "tab"), { current: "src", ...stay });

  // Search results are rows too: up, down and Enter work on them.
  const results = rankSearch(["a/one.txt", "b/two.txt"], "t").items;
  assert.deepEqual(moveKey(results, "a/one.txt", "down"), { current: "b/two.txt", ...stay });
  assert.deepEqual(moveKey(results, "b/two.txt", "enter"), { current: "b/two.txt", ...stay, preview: "b/two.txt" });
}

console.log("ok");
