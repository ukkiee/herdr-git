// node layout.test.mjs: the main → main-git transform, on layouts shaped like Herdr's
// `main`, and how the install writes files the person already has.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { toMainGit, writeWhole, copyChanged, LOG_ID, MOD } from "./layout.mjs";

// The parts of Herdr's shipped `main` the transform touches, plus a field of each
// kind it must leave alone.
const main = () => ({
  id: "root", type: "row", titlebar: "none", background: "canvas",
  children: [
    { id: "sidebar", type: "column", size: { px: 268 }, resizable: false, children: [
      { id: "spaces", type: "block", content: { mod: "spaces" } },
    ] },
    { id: "work", type: "column", resizable: false, children: [
      { id: "tabs", type: "block", size: { px: 42 }, content: { mod: "tabs" } },
      { id: "work-body", type: "row", padding: 8, gap: 8, children: [
        { id: "main", type: "block", content: { tab: "active" } },
        { id: "panel", type: "column", hidden: true, size: { px: 368 }, min: 280, max: 900, children: [
          { id: "panel-body", type: "stack", active: "files", children: [
            { id: "files", type: "block", content: { mod: "files" } },
            { id: "changes", type: "block", content: { mod: "changes" } },
          ] },
        ] },
      ] },
      { id: "status", type: "block", size: { px: 28 }, content: { mod: "workspace-status" } },
    ] },
  ],
});

const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
};
const parentOf = (node, id) => {
  for (const child of node?.children ?? []) {
    if (child.id === id) return node;
    const hit = parentOf(child, id);
    if (hit) return hit;
  }
  return null;
};

// Changes button: the node keeps its id (the tab bar opens it by id), only the mod changes.
{
  const input = main(), before = JSON.stringify(input);
  const r = toMainGit(input);
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(input), before, "the input layout is not modified");
  const changes = find(r.layout, "changes");
  assert.deepEqual(changes, { id: "changes", type: "block", content: { mod: MOD, props: { view: "commit" } } });
  assert.equal(parentOf(r.layout, "changes").id, "panel-body");
  assert.deepEqual(find(r.layout, "files"), find(main(), "files"), "the Files panel is untouched");
  assert.deepEqual(find(r.layout, "sidebar"), find(main(), "sidebar"), "the sidebar is untouched");
  assert.equal(r.layout.titlebar, "none");
}

// Log panel: under everything right of the sidebar's work area (tab bar above, status bar
// below), hidden, 320px, behind a boundary that can be dragged.
{
  const { layout } = toMainGit(main());
  const log = find(layout, LOG_ID);
  assert.equal(log.type, "block");
  assert.deepEqual(log.content, { mod: MOD, props: { view: "log" } });
  assert.equal(log.hidden, true);
  assert.deepEqual(log.size, { px: 320 });
  const wrap = parentOf(layout, LOG_ID);
  assert.equal(wrap.type, "column");
  assert.notEqual(wrap.resizable, false, "the Log panel's boundary can be dragged");
  assert.deepEqual(wrap.children.map((c) => c.id), ["work-body", LOG_ID], "below the work area and the side panel");
  const work = find(layout, "work");
  assert.equal(work.resizable, false, "the work column itself stays as it was");
  assert.deepEqual(work.children.map((c) => c.id), ["tabs", wrap.id, "status"], "below the tab bar, above the status bar");
  // Expected from a fresh copy of the input, with the one allowed change made by hand:
  // the side panel keeps its width, limits and hidden state.
  const expected = main();
  find(expected, "changes").content = { mod: MOD, props: { view: "commit" } };
  assert.deepEqual(find(layout, "work-body"), find(expected, "work-body"));
}

// Running it on its own output changes nothing.
{
  const once = toMainGit(main()).layout;
  const twice = toMainGit(once);
  assert.equal(twice.ok, true);
  assert.deepEqual(twice.layout, once);
}

// A `main` without an expected node fails and names the node.
for (const id of ["work", "work-body", "panel-body", "changes"]) {
  const input = main();
  const parent = parentOf(input, id);
  parent.children = parent.children.filter((c) => c.id !== id);
  const r = toMainGit(input);
  assert.equal(r.ok, false, `${id} missing`);
  assert.equal(r.layout, undefined);
  assert.match(r.error, new RegExp(`\\b${id}\\b`));
}

// The right ids in the wrong places fail too, instead of producing a layout that looks fine.
{
  const input = main();
  const body = find(input, "work-body"), work = find(input, "work");
  work.children = work.children.filter((c) => c.id !== "work-body");
  find(input, "sidebar").children.push(body);
  assert.equal(toMainGit(input).ok, false, "work-body outside work");
}
{
  const input = main();
  const stack = find(input, "panel-body");
  const changes = stack.children.pop();
  find(input, "work-body").children.push(changes);
  assert.equal(toMainGit(input).ok, false, "changes outside panel-body");
}
{
  const input = main();
  find(input, "work").type = "row";
  assert.equal(toMainGit(input).ok, false, "work is not a column");
}
assert.equal(toMainGit(null).ok, false);
assert.equal(toMainGit({}).ok, false);

// ---- writing files the person already has

// A disk that fills up halfway: the write puts part of the text down, then fails.
const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-layout-`));
const halfFs = { ...fs, writeFileSync(path, data) { fs.writeFileSync(path, String(data).slice(0, 10)); throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); } };
const leftovers = (dir, name) => fs.readdirSync(dir).filter((entry) => entry !== name);

// The main-git file is replaced whole or not at all: a failed write leaves the old file.
{
  const dir = `${tmp}/layout`, file = `${dir}/main-git.json`;
  fs.mkdirSync(dir);
  fs.writeFileSync(file, "the old layout\n");
  assert.throws(() => writeWhole(halfFs, file, "the new layout, much longer\n"), /no space left/);
  assert.equal(fs.readFileSync(file, "utf8"), "the old layout\n");
  assert.deepEqual(leftovers(dir, "main-git.json"), [], "no half-written file left behind");
  writeWhole(fs, file, "the new layout\n");
  assert.equal(fs.readFileSync(file, "utf8"), "the new layout\n");
  assert.deepEqual(leftovers(dir, "main-git.json"), []);
}

// The mod folder is copied by content. Herdr reloads every copy of a mod each time a file
// in its folder is saved, so a file that is already the same is not written again, and a
// file that differs is written whole under a hidden name (Herdr ignores those) and then
// renamed into place: Herdr never reads half a file.
{
  const from = `${tmp}/mod-from`, to = `${tmp}/mod-to`;
  fs.mkdirSync(`${from}/icons/theme`, { recursive: true });
  fs.mkdirSync(`${to}/icons`, { recursive: true });
  fs.writeFileSync(`${from}/main.js`, "export default 1;\n");
  fs.writeFileSync(`${from}/view.js`, "new view\n");
  fs.writeFileSync(`${from}/icons/theme/a.svg`, "<svg/>\n");
  fs.writeFileSync(`${from}/icons/x.svg`, "<svg new/>\n");
  fs.writeFileSync(`${to}/main.js`, "export default 1;\n");
  fs.writeFileSync(`${to}/view.js`, "old view, longer than the new one\n");
  fs.writeFileSync(`${to}/icons/x.svg`, "<svg old/>\n");
  fs.writeFileSync(`${to}/gone.js`, "only in the app home\n");
  const stamp = (file) => { const s = fs.statSync(file); return [s.ino, s.mtimeMs]; };
  const kept = stamp(`${to}/main.js`);
  const names = (dir, rel = "") => fs.readdirSync(`${dir}/${rel}`, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? names(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
  const hidden = () => names(to).filter((name) => name.split("/").pop().startsWith("."));

  // A disk that fills up: every file in place is still whole, and nothing is left behind.
  assert.throws(() => copyChanged(halfFs, from, to), /no space left/);
  assert.equal(fs.readFileSync(`${to}/view.js`, "utf8"), "old view, longer than the new one\n");
  assert.equal(fs.readFileSync(`${to}/icons/x.svg`, "utf8"), "<svg old/>\n");
  assert.deepEqual(hidden(), []);

  assert.deepEqual(copyChanged(fs, from, to), { written: ["icons/theme/a.svg", "icons/x.svg", "view.js"], same: 1 });
  assert.deepEqual(stamp(`${to}/main.js`), kept, "a file that is already the same is not written again");
  for (const name of names(from)) assert.equal(fs.readFileSync(`${to}/${name}`, "utf8"), fs.readFileSync(`${from}/${name}`, "utf8"), name);
  assert.equal(fs.readFileSync(`${to}/gone.js`, "utf8"), "only in the app home\n", "a file only the app home has stays");
  assert.deepEqual(hidden(), []);
  assert.deepEqual(copyChanged(fs, from, to), { written: [], same: 4 }, "run again, nothing is written");

  // A folder the app home doesn't have yet.
  assert.deepEqual(copyChanged(fs, from, `${tmp}/mod-new`), { written: ["icons/theme/a.svg", "icons/x.svg", "main.js", "view.js"], same: 0 });
  assert.deepEqual(names(`${tmp}/mod-new`), names(from));
}

// The keys step of install.sh, run as install.sh runs it but on a disk that fills up:
// the person's keys.json is still whole and unchanged.
{
  const dir = `${tmp}/keys`, file = `${dir}/keys.json`;
  fs.mkdirSync(dir);
  const before = JSON.stringify({ global: { "cmd-x": "existing.action" }, terminal: {} }, null, 2) + "\n";
  fs.writeFileSync(file, before);
  const install = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  const script = install.slice(install.indexOf("<<'EOF'\n") + "<<'EOF'\n".length, install.lastIndexOf("\nEOF"));
  const wanted = fileURLToPath(new URL("./keys.json", import.meta.url));
  const run = (useFs) => vm.runInNewContext(script, { require: () => useFs, process: { argv: ["node", "-", file, wanted], pid: 4242 }, console: { log() {} } });
  assert.throws(() => run(halfFs), /no space left/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(leftovers(dir, "keys.json"), []);
  run(fs);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["layout:main-git"]["cmd-k"], "mod.open:git-tools");
  assert.deepEqual(leftovers(dir, "keys.json"), []);
}

console.log("ok");
