// node files-tree.test.mjs: the Files panel's pure decisions (search order, marks and dots,
// visible rows, what a refresh keeps, arrow keys).
import assert from "node:assert/strict";
import { markLookup, rankSearch, visibleRows, keepPressed, pressLands, moveKey, stripFailure, failureKey } from "./files-tree.js";

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
  assert.deepEqual(visibleRows(new Map(), new Set()), []);
}

// An open folder with nothing read for it yet (just pressed, or brought back open on
// returning to a space) shows a "reading" row under it. A folder whose read failed or
// that is gone shows nothing under it, not a "reading" row forever; an empty folder
// shows nothing either.
{
  const tree = new Map([
    ["", [{ name: "a", dir: true }, { name: "bad", dir: true }, { name: "empty", dir: true }, { name: "z.txt", dir: false }]],
    ["empty", []],
  ]);
  const open = new Set(["a", "a/deeper", "bad", "empty"]);
  assert.deepEqual(visibleRows(tree, open, new Set(["bad"])), [
    { path: "a", name: "a", folder: true, depth: 0, open: true },
    { path: "a/", name: "", folder: false, depth: 1, open: false, loading: true },
    { path: "bad", name: "bad", folder: true, depth: 0, open: true },
    { path: "empty", name: "empty", folder: true, depth: 0, open: true },
    { path: "z.txt", name: "z.txt", folder: false, depth: 0, open: false },
  ]);
  // Read now: the row goes and what the folder holds takes its place.
  tree.set("a", [{ name: "f.txt", dir: false }]);
  assert.deepEqual(visibleRows(tree, open, new Set(["bad"])).map((r) => r.path), ["a", "a/f.txt", "bad", "empty", "z.txt"]);
  // The root not read yet has no rows at all (the panel shows its own loading notice).
  assert.deepEqual(visibleRows(new Map(), new Set(["a"])), []);
}

// A refresh ending: the folders it read take their new reads; a folder a press read while
// it ran (the refresh never asked for it) keeps that read, with its cut and its failure;
// folders closed meanwhile give their place up. The root always stays.
{
  const fresh = (name) => ({ ok: true, entries: [{ name, dir: false }], limited: false });
  const read = new Map([["", fresh("new-root")], ["a", fresh("new-a")], ["closed", fresh("x")]]);
  const pressed = { ok: true, entries: [{ name: "p", dir: false }], limited: true };
  const pressedFailed = { ok: false, entries: [], limited: false, gone: false, denied: true };
  const now = new Map([["", fresh("old-root")], ["a", fresh("old-a")], ["b", pressed], ["bad", pressedFailed], ["c", fresh("c")]]);
  const kept = keepPressed(read, now, new Set(["a", "b", "bad"]));
  assert.deepEqual([...kept.keys()].sort(), ["", "a", "b", "bad"]);
  assert.deepEqual(kept.get(""), fresh("new-root"));
  assert.deepEqual(kept.get("a"), fresh("new-a"));
  assert.equal(kept.get("b"), pressed);
  assert.equal(kept.get("bad"), pressedFailed);
  // Nothing pressed meanwhile: just what the refresh read, less what was closed.
  assert.deepEqual([...keepPressed(read, new Map(), new Set(["a"])).keys()].sort(), ["", "a"]);
}

// A refresh whose read of an open folder failed doesn't keep the old reads of the open
// folders below it, nor a read a press made below it meanwhile: under a failed folder
// nothing is shown, so nothing there may count toward the cut or the room left.
{
  const fresh = (name) => ({ ok: true, entries: [{ name, dir: true }], limited: true });
  const denied = { ok: false, entries: [], limited: false, gone: false, denied: true };
  const read = new Map([["", fresh("p")], ["p", denied], ["q", fresh("r")]]);
  const now = new Map([["", fresh("p")], ["p", fresh("c")], ["p/c", fresh("d")], ["p/c/d", fresh("e")], ["p/x", fresh("y")], ["q", fresh("r")], ["q/r", fresh("s")]]);
  const kept = keepPressed(read, now, new Set(["p", "p/c", "p/c/d", "p/x", "q", "q/r"]));
  assert.deepEqual([...kept.keys()].sort(), ["", "p", "q", "q/r"]);
  assert.equal(kept.get("p"), denied);
}

// A press's read that arrives after a refresh put its folders in place lands only where it
// can be shown: the folder still open and every folder above it read fine now. Under a
// folder the refresh failed to read, or once the root failed, it is dropped.
{
  const fresh = (name) => ({ ok: true, entries: [{ name, dir: true }], limited: false });
  const denied = { ok: false, entries: [], limited: false, gone: false, denied: true };
  const folders = new Map([["", fresh("p")], ["p", denied], ["q", fresh("r")], ["q/r", fresh("s")]]);
  const open = new Set(["p", "p/c", "q", "q/r", "q/r/s"]);
  assert.equal(pressLands(folders, open, "p/c"), false);
  assert.equal(pressLands(folders, open, "q/r/s"), true);
  assert.equal(pressLands(folders, open, "q"), true);
  // Closed while it was read.
  assert.equal(pressLands(folders, new Set(["q"]), "q/r/s"), false);
  // The root failed: the panel holds no folders.
  assert.equal(pressLands(new Map(), open, "q"), false);
}

// The keys skip a "reading" row: it can't be chosen, and right on a folder still being
// read stays on it.
{
  const rows = visibleRows(new Map([["", [{ name: "a", dir: true }, { name: "b.txt", dir: false }]]]), new Set(["a"]));
  const stay = { expand: null, collapse: null, preview: null };
  assert.deepEqual(rows.map((r) => r.path), ["a", "a/", "b.txt"]);
  assert.deepEqual(moveKey(rows, "a", "down"), { current: "b.txt", ...stay });
  assert.deepEqual(moveKey(rows, "b.txt", "up"), { current: "a", ...stay });
  assert.deepEqual(moveKey(rows, "a", "right"), { current: "a", ...stay });
  assert.deepEqual(moveKey(rows, "a/", "enter"), { current: null, ...stay });
  const waiting = visibleRows(new Map([["", [{ name: "a", dir: true }]]]), new Set(["a"]));
  assert.deepEqual(moveKey(waiting, null, "down"), { current: "a", ...stay });
  assert.deepEqual(moveKey(waiting, "a", "down"), { current: "a", ...stay });
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

// The error strip after a refresh: a folder's read failure closed by hand stays closed
// while the same folder keeps failing the same way; another folder's failure, a changed
// failure, or the same one coming back after it cleared shows again.
{
  const denied = (folder) => ({ folder, error: { note: "files.denied", folder } });
  const shown = (failures, closed) => {
    const r = stripFailure(failures, closed);
    return { show: r.show, closed: r.closed };
  };
  // Nothing closed: the first failure shows.
  let r = shown([denied("a"), denied("b")], new Set());
  assert.deepEqual(r.show, denied("a"));
  // "a" closed: the next refresh shows "b", then nothing once "b" is closed too.
  r = shown([denied("a"), denied("b")], new Set([failureKey(denied("a"))]));
  assert.deepEqual(r.show, denied("b"));
  r = shown([denied("a"), denied("b")], new Set([...r.closed, failureKey(denied("b"))]));
  assert.equal(r.show, null);
  const bothClosed = r.closed;
  // The same folder failing another way shows again.
  r = shown([{ folder: "a", error: "a: Input/output error" }], bothClosed);
  assert.deepEqual(r.show, { folder: "a", error: "a: Input/output error" });
  // A failure gone from a refresh is forgotten: when it comes back it shows.
  r = shown([denied("b")], bothClosed);
  assert.equal(r.show, null);
  r = shown([denied("a"), denied("b")], r.closed);
  assert.deepEqual(r.show, denied("a"));
  // No failures: nothing shows and nothing stays closed.
  r = shown([], bothClosed);
  assert.equal(r.show, null);
  assert.equal(r.closed.size, 0);
}

console.log("ok");
