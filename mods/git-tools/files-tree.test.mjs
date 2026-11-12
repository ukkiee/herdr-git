// node files-tree.test.mjs: the Files panel's pure decisions (search order, marks and dots,
// visible rows, arrow keys).
import assert from "node:assert/strict";
import { markLookup, rankSearch } from "./files-tree.js";

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

console.log("ok");
