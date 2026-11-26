// node tree.test.mjs: paths → list rows, folding, three-state checks (no app, no git).
import assert from "node:assert/strict";
import { buildRows, checkState, toggleIncluded, keepIncluded, folderKeys, parentIndex } from "./tree.js";

// What a row looks like on screen: indent, a folder mark, the name, and the dim text after it.
const look = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.folder ? (r.open ? "v " : "> ") : ""}${r.name}${r.folder ? ` (${r.count})` : r.dir ? ` [${r.dir}]` : ""}`);

const files = [
  { path: "src/app/b.ts", status: "modified" },
  { path: "README.md", status: "modified" },
  { path: "src/app/a.ts", status: "deleted" },
  { path: "src/lib/x.ts", status: "added" },
  { path: "docs/guide.md", status: "modified" },
  { path: "a.ts", status: "modified" },
];

// Flat: one row per file, by file name, each with its folder to show dimmed after it.
{
  const rows = buildRows(files);
  assert.deepEqual(look(rows), [
    "a.ts",
    "a.ts [src/app]",
    "b.ts [src/app]",
    "guide.md [docs]",
    "README.md",
    "x.ts [src/lib]",
  ]);
  assert.deepEqual(rows[1], {
    key: "src/app/a.ts", depth: 0, folder: false, open: false, name: "a.ts", dir: "src/app", path: "src/app/a.ts",
    count: 1, item: files[2], paths: ["src/app/a.ts"],
  });
  assert.deepEqual(buildRows([]), []);
}

// Grouped: a folder tree. In each folder its folders come first, then its files; a folder
// counts the files under it at any depth.
{
  const rows = buildRows(files, { grouped: true });
  assert.deepEqual(look(rows), [
    "v docs (1)",
    "  guide.md [docs]",
    "v src (3)",
    "  v app (2)",
    "    a.ts [src/app]",
    "    b.ts [src/app]",
    "  v lib (1)",
    "    x.ts [src/lib]",
    "a.ts",
    "README.md",
  ]);
  const src = rows[2], app = rows[3];
  assert.deepEqual(src, {
    key: "src/", depth: 0, folder: true, open: true, name: "src", dir: "", path: "src", count: 3, item: null,
    paths: ["src/app/a.ts", "src/app/b.ts", "src/lib/x.ts"],
  });
  assert.deepEqual([app.key, app.dir, app.path, app.paths], ["src/app/", "src", "src/app", ["src/app/a.ts", "src/app/b.ts"]]);
  assert.equal(rows[4].item, files[2], "a file row carries its input item (the status rides along)");
}

// Collapsing a folder leaves its children out but keeps its count and paths, so its
// checkbox still stands for everything under it.
{
  const rows = buildRows(files, { grouped: true, collapsed: new Set(["src/app/"]) });
  assert.deepEqual(look(rows), [
    "v docs (1)",
    "  guide.md [docs]",
    "v src (3)",
    "  > app (2)",
    "  v lib (1)",
    "    x.ts [src/lib]",
    "a.ts",
    "README.md",
  ]);
  assert.deepEqual(rows[3].paths, ["src/app/a.ts", "src/app/b.ts"]);
  // A collapsed parent hides everything below, whatever the state of the folders inside.
  const outer = buildRows(files, { grouped: true, collapsed: new Set(["src/"]) });
  assert.deepEqual(look(outer), ["v docs (1)", "  guide.md [docs]", "> src (3)", "a.ts", "README.md"]);
  assert.equal(outer[2].paths.length, 3);
  // Collapse All takes every folder key; Expand All is no keys.
  assert.deepEqual(folderKeys(files), ["docs/", "src/", "src/app/", "src/lib/"]);
  assert.deepEqual(look(buildRows(files, { grouped: true, collapsed: new Set(folderKeys(files)) })), ["> docs (1)", "> src (3)", "a.ts", "README.md"]);
  // Flat rows have nothing to collapse.
  assert.equal(buildRows(files, { collapsed: new Set(["src/"]) }).length, 6);
}

// compact: a chain of folders with nothing else in them is one row, the way changed
// files are drawn ("src/app  2 files").
{
  const items = [{ path: "src/app/deep/a.ts" }, { path: "src/app/deep/b.ts" }, { path: "src/app/c.ts" }, { path: "docs/x/y/z.md" }];
  const rows = buildRows(items, { grouped: true, compact: true });
  assert.deepEqual(look(rows), [
    "v docs/x/y (1)",
    "  z.md [docs/x/y]",
    "v src/app (3)",
    "  v deep (2)",
    "    a.ts [src/app/deep]",
    "    b.ts [src/app/deep]",
    "  c.ts [src/app]",
  ]);
  assert.deepEqual([rows[0].key, rows[0].path, rows[0].dir], ["docs/x/y/", "docs/x/y", ""]);
  assert.deepEqual([rows[3].key, rows[3].dir], ["src/app/deep/", "src/app"]);
  assert.deepEqual(folderKeys(items, { compact: true }), ["docs/x/y/", "src/app/", "src/app/deep/"]);
  assert.deepEqual(look(buildRows(items, { grouped: true, compact: true, collapsed: new Set(["src/app/"]) })), ["v docs/x/y (1)", "  z.md [docs/x/y]", "> src/app (3)"]);
}

// Not only files: branch names split on "/" make the Branch tree's folders (no
// checkboxes there, so nothing but buildRows is used). Items carry what the caller needs.
{
  const branches = [
    { path: "main", current: true },
    { path: "feat/login" },
    { path: "feat/ui/dark-mode" },
    { path: "topic/two" },
    { path: "feat/api" },
  ];
  const rows = buildRows(branches, { grouped: true, collapsed: new Set(["topic/"]) });
  assert.deepEqual(look(rows), [
    "v feat (3)",
    "  v ui (1)",
    "    dark-mode [feat/ui]",
    "  api [feat]",
    "  login [feat]",
    "> topic (1)",
    "main",
  ]);
  assert.equal(rows[6].item.current, true);
  assert.equal(rows[2].path, "feat/ui/dark-mode", "the row's path is the whole branch name");
  // Remote branches: the remote is just the first folder.
  assert.deepEqual(look(buildRows([{ path: "origin/main" }, { path: "origin/feat/login" }], { grouped: true })), [
    "v origin (2)",
    "  v feat (1)",
    "    login [origin/feat]",
    "  main [origin]",
  ]);
}

// Odd paths: a deleted file and a new folder of the same name keep apart; an untracked
// nested repository (git writes it with a trailing "/") is one row; spaces and Korean pass.
{
  const rows = buildRows([{ path: "a" }, { path: "a/b.txt" }, { path: "vendor/lib/" }, { path: "새 폴더/새 파일.txt" }, { path: "my notes.md" }], { grouped: true });
  assert.deepEqual(look(rows), [
    "v a (1)",
    "  b.txt [a]",
    "v vendor (1)",
    "  lib/ [vendor]",
    "v 새 폴더 (1)",
    "  새 파일.txt [새 폴더]",
    "a",
    "my notes.md",
  ]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "every row key is unique");
  assert.equal(rows[3].path, "vendor/lib/", "the path stays as git gave it");
}

// The row a row sits under, for the left arrow.
{
  const rows = buildRows(files, { grouped: true });
  assert.equal(parentIndex(rows, 4), 3); // src/app/a.ts → app
  assert.equal(parentIndex(rows, 6), 2); // lib → src
  assert.equal(parentIndex(rows, 8), -1); // a.ts at the root
  assert.equal(parentIndex(rows, 0), -1);
}

// Three-state checks: a folder (or a group) is all, some or none of the files under it.
{
  const rows = buildRows(files, { grouped: true });
  const src = rows[2], app = rows[3], lib = rows[6];
  assert.deepEqual([src.name, app.name, lib.name], ["src", "app", "lib"]);
  const all = files.map((f) => f.path);
  let included = new Set();
  assert.equal(checkState(src.paths, included), "none");

  // Checking a folder checks every file under it; the folder above becomes "some".
  included = toggleIncluded(included, app.paths);
  assert.deepEqual([...included].sort(), ["src/app/a.ts", "src/app/b.ts"]);
  assert.deepEqual([checkState(app.paths, included), checkState(src.paths, included), checkState(lib.paths, included), checkState(all, included)], ["all", "some", "none", "some"]);

  // Unchecking one file leaves its folder partly checked.
  included = toggleIncluded(included, ["src/app/a.ts"]);
  assert.deepEqual([...included], ["src/app/b.ts"]);
  assert.equal(checkState(app.paths, included), "some");

  // A click on a partly checked folder checks all of it; a second click clears it.
  included = toggleIncluded(included, src.paths);
  assert.deepEqual([checkState(src.paths, included), checkState(app.paths, included), checkState(lib.paths, included)], ["all", "all", "all"]);
  assert.equal(checkState(all, included), "some");
  included = toggleIncluded(included, src.paths);
  assert.equal(included.size, 0);

  // The group's checkbox takes everything.
  included = toggleIncluded(new Set(["README.md"]), all);
  assert.equal(checkState(all, included), "all");
  assert.equal(included.size, 6);

  // The input Set is never changed (the screen compares old and new).
  const before = new Set(["a.ts"]);
  toggleIncluded(before, all);
  assert.deepEqual([...before], ["a.ts"]);
  assert.equal(checkState([], new Set(["a.ts"])), "none", "an empty folder or group is unchecked");

  // The same state holds for a collapsed folder and in the flat view: it's by path.
  const folded = buildRows(files, { grouped: true, collapsed: new Set(["src/"]) })[2];
  assert.equal(checkState(folded.paths, new Set(["src/lib/x.ts"])), "some");
}

// After a refresh the files still listed stay Included; the ones that went away drop out
// (and don't come back checked if they reappear).
{
  const included = new Set(["src/app/a.ts", "README.md", "docs/guide.md"]);
  const after = [{ path: "README.md", status: "modified" }, { path: "src/app/a.ts", status: "modified" }, { path: "new.txt", status: "unversioned" }];
  const kept = keepIncluded(included, after);
  assert.deepEqual([...kept].sort(), ["README.md", "src/app/a.ts"]);
  assert.equal(included.size, 3, "the input Set is not changed");
  assert.equal(keepIncluded(included, []).size, 0);
}

// A long list builds once and stays a plain array the screen can window over.
{
  const many = [];
  for (let i = 0; i < 3000; i++) many.push({ path: `pkg${i % 30}/dir${i % 7}/file${i}.txt` });
  assert.equal(buildRows(many).length, 3000);
  const tree = buildRows(many, { grouped: true });
  assert.equal(tree.filter((r) => !r.folder).length, 3000);
  assert.equal(tree.filter((r) => r.folder && r.depth === 0).length, 30);
  assert.equal(tree[0].count, 100);
  assert.equal(buildRows(many, { grouped: true, collapsed: new Set(folderKeys(many)) }).length, 30);
}

console.log("ok");
