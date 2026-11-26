// node layout.test.mjs: the main → git-tools transform, on layouts shaped like Herdr's
// `main`, how the install writes files the person already has, and whether the
// repository's layouts/git-tools.json is still what Herdr's `main` gives. That last check
// reads layouts/main.json in the app home (`$HERDR_APP_HOME`, else ~/.config/herdr-app)
// and prints "skip: …" where there is none, as on CI.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { toMainGit, toPortable, herdrVersion, carryOver, writeWhole, copyChanged, copyReport, readMain, LOG_ID, MOD, TABS_ROW_ID, BUTTON_ID, BUTTON_WIDTH, WIDGET_ID, WIDGET_WIDTH } from "./layout.mjs";

// The parts of Herdr's shipped `main` the transform touches, plus a field of each
// kind it must leave alone.
const main = () => ({
  id: "root", type: "row", titlebar: "none", background: "canvas",
  children: [
    { id: "sidebar", type: "column", size: { px: 268 }, resizable: false, children: [
      { id: "spaces", type: "block", content: { mod: "spaces" } },
    ] },
    { id: "work", type: "column", resizable: false, children: [
      { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs" } },
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
  assert.deepEqual(find(r.layout, "sidebar"), find(main(), "sidebar"), "the sidebar is untouched");
  assert.equal(r.layout.titlebar, "none");
}

// Files button: the same, for the `files` node and the Files panel. The stack still opens
// on the Files panel and keeps both children in their order.
{
  const r = toMainGit(main());
  assert.deepEqual(find(r.layout, "files"), { id: "files", type: "block", content: { mod: MOD, props: { view: "files" } } });
  const stack = find(r.layout, "panel-body");
  assert.deepEqual(stack.children.map((c) => c.id), ["files", "changes"]);
  assert.equal(stack.active, "files");
  // Without the Git button (every OS but macOS) the Files panel is still there.
  assert.deepEqual(find(toMainGit(main(), { button: false }).layout, "files"), find(r.layout, "files"));
  // Fields Herdr may add to the block later are kept; only the content is the mod's.
  const input = main();
  Object.assign(find(input, "files"), { padding: 4, hidden: false });
  assert.deepEqual(find(toMainGit(input).layout, "files"), { id: "files", type: "block", padding: 4, hidden: false, content: { mod: MOD, props: { view: "files" } } });
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
  assert.deepEqual(work.children.map((c) => c.id), [TABS_ROW_ID, wrap.id, "status"], "below the tab bar, above the status bar");
  // Expected from a fresh copy of the input, with the one allowed change made by hand:
  // the side panel keeps its width, limits and hidden state.
  const expected = main();
  find(expected, "changes").content = { mod: MOD, props: { view: "commit" } };
  find(expected, "files").content = { mod: MOD, props: { view: "files" } };
  assert.deepEqual(find(layout, "work-body"), find(expected, "work-body"));
}

// Git button: a block right of the tab bar, so it sits beside the Changes button. The two
// share a row that takes the tab bar's place and height; the tab bar keeps the rest of
// what it had (dragging it still moves the window).
{
  const { layout } = toMainGit(main());
  const row = find(layout, TABS_ROW_ID);
  assert.equal(row.type, "row");
  assert.deepEqual(row.size, { px: 42 }, "as tall as the tab bar was");
  assert.equal(row.resizable, false, "no boundary to drag between the tab bar and the button");
  assert.deepEqual(row.children.map((c) => c.id), ["tabs", WIDGET_ID, BUTTON_ID]);
  assert.deepEqual(find(layout, "tabs"), { id: "tabs", type: "block", window_drag: true, content: { mod: "tabs" } });
  assert.deepEqual(find(layout, BUTTON_ID), { id: BUTTON_ID, type: "block", size: { px: BUTTON_WIDTH }, window_drag: true, content: { mod: MOD, props: { view: "log-button" } } });
}

// VCS widget: a block of its own in the same row, left of the Git button, a fixed width
// the tab bar gives up. Around the widget the strip moves the window as the tab bar does.
{
  const { layout } = toMainGit(main());
  assert.deepEqual(find(layout, WIDGET_ID), { id: WIDGET_ID, type: "block", size: { px: WIDGET_WIDTH }, window_drag: true, content: { mod: MOD, props: { view: "vcs-widget" } } });
  assert.equal(parentOf(layout, WIDGET_ID).id, TABS_ROW_ID);
  const input = main();
  delete find(input, "tabs").window_drag;
  assert.deepEqual(find(toMainGit(input).layout, WIDGET_ID), { id: WIDGET_ID, type: "block", size: { px: WIDGET_WIDTH }, content: { mod: MOD, props: { view: "vcs-widget" } } });
  // A git-tools layout made before the widget existed (the row holds the tab bar and the Git
  // button only) gets it on the next install, in its place.
  const older = toMainGit(main()).layout;
  const oldRow = find(older, TABS_ROW_ID);
  oldRow.children = oldRow.children.filter((c) => c.id !== WIDGET_ID);
  const again = toMainGit(older);
  assert.equal(again.ok, true);
  assert.deepEqual(again.layout, layout);
  // Only with the Git button: elsewhere the Log panel's toolbar draws the widget.
  assert.equal(find(toMainGit(main(), { button: false }).layout, WIDGET_ID), null);
  assert.equal(find(toMainGit(layout, { button: false }).layout, WIDGET_ID), null);
}

// The strip around the button moves the window exactly when the tab bar does: the block
// is the window's top right corner, which was the tab bar's.
{
  const input = main();
  delete find(input, "tabs").window_drag;
  const { layout } = toMainGit(input);
  assert.deepEqual(find(layout, BUTTON_ID), { id: BUTTON_ID, type: "block", size: { px: BUTTON_WIDTH }, content: { mod: MOD, props: { view: "log-button" } } });
}

// Without the button, the tab bar is as Herdr has it; asked for on a layout that has the
// button, the tab bar goes back to that.
{
  const plain = toMainGit(main(), { button: false });
  assert.equal(plain.ok, true);
  assert.deepEqual(find(plain.layout, "tabs"), find(main(), "tabs"));
  assert.equal(find(plain.layout, TABS_ROW_ID), null);
  assert.equal(find(plain.layout, BUTTON_ID), null);
  assert.deepEqual(find(plain.layout, "work").children.map((c) => c.id), ["tabs", parentOf(plain.layout, LOG_ID).id, "status"]);
  assert.deepEqual(toMainGit(toMainGit(main()).layout, { button: false }).layout, plain.layout);
  assert.deepEqual(toMainGit(plain.layout).layout, toMainGit(main()).layout);
}

// Running it on its own output changes nothing.
{
  const once = toMainGit(main()).layout;
  const twice = toMainGit(once);
  assert.equal(twice.ok, true);
  assert.deepEqual(twice.layout, once);
}

// A `main` without an expected node fails and names the node.
for (const id of ["work", "tabs", "work-body", "panel-body", "changes", "files"]) {
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
  const stack = find(input, "panel-body");
  const files = stack.children.shift();
  find(input, "work-body").children.push(files);
  assert.equal(toMainGit(input).ok, false, "files outside panel-body");
}
{
  const input = main();
  find(input, "files").type = "column";
  find(input, "files").children = [];
  const r = toMainGit(input);
  assert.equal(r.ok, false, "files is not a block");
  assert.match(r.error, /\bfiles\b/);
}
{
  const input = main();
  find(input, "work").type = "row";
  assert.equal(toMainGit(input).ok, false, "work is not a column");
}
assert.equal(toMainGit(null).ok, false);
assert.equal(toMainGit({}).ok, false);

// ---- what a rebuild keeps from the git-tools.json it replaces

// Herdr adds a mod with link rules to a layout's `link_handlers` once and then remembers
// it did, so a list the rebuild dropped would not come back. The old file's list wins,
// with its order and its removals; `cloned_from` stays as before.
{
  const built = () => toMainGit(main()).layout;
  const old = { cloned_from: { name: "main", version: "0.1.15" }, link_handlers: ["viewer", "browser"] };
  const input = built(), before = JSON.stringify(input);
  const kept = carryOver(input, old);
  assert.equal(JSON.stringify(input), before, "the new layout is not modified");
  assert.deepEqual(kept.link_handlers, ["viewer", "browser"]);
  assert.deepEqual(kept.cloned_from, old.cloned_from);
  const { link_handlers: _l, cloned_from: _c, ...rest } = kept;
  assert.deepEqual(rest, built(), "everything else is the new build");

  // A list `main` itself carries gives way to the old file's, and stays when there is none.
  const fromMain = toMainGit({ ...main(), link_handlers: ["shipped"] }).layout;
  assert.deepEqual(fromMain.link_handlers, ["shipped"]);
  assert.deepEqual(carryOver(fromMain, old).link_handlers, ["viewer", "browser"]);
  assert.deepEqual(carryOver(fromMain, { link_handlers: [] }).link_handlers, []);
  assert.deepEqual(carryOver(fromMain, {}).link_handlers, ["shipped"]);
  assert.deepEqual(carryOver(fromMain, null).link_handlers, ["shipped"]);

  // Something that isn't a list of mod names is left behind.
  assert.equal(carryOver(built(), { link_handlers: "viewer" }).link_handlers, undefined);
  assert.equal(carryOver(built(), { link_handlers: ["viewer", 1] }).link_handlers, undefined);

  // The new build's own `cloned_from` is kept over the old one.
  const note = { name: "main", version: "0.1.17" };
  assert.deepEqual(carryOver({ ...built(), cloned_from: note }, old).cloned_from, note);
}

// ---- the layout the repository ships

// The gallery file: no Git button and no VCS widget block on any OS, the tab bar as Herdr
// has it, no `link_handlers`, and `cloned_from` naming the version of `main` it came from.
{
  const input = { ...main(), cloned_from: { name: "terminals", version: "0.1.2" }, link_handlers: ["viewer"] };
  const before = JSON.stringify(input);
  const r = toPortable(input, "0.1.18");
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(input), before, "the input layout is not modified");
  const { cloned_from, ...rest } = r.layout;
  assert.deepEqual(cloned_from, { name: "main", version: "0.1.18" });
  assert.equal("link_handlers" in r.layout, false);
  assert.deepEqual(rest, toMainGit(main(), { button: false }).layout);
  assert.equal(find(r.layout, TABS_ROW_ID), null);
  assert.equal(find(r.layout, WIDGET_ID), null);
  assert.equal(find(r.layout, BUTTON_ID), null);
  // From a layout that has the Git button, the same file.
  assert.deepEqual(toPortable(toMainGit(main()).layout, "0.1.18").layout, toPortable(main(), "0.1.18").layout);
  // A `main` it can't transform fails as `toMainGit` does; so does a version that isn't one.
  const broken = main();
  find(broken, "panel-body").children = [];
  assert.match(toPortable(broken, "0.1.18").error, /\bchanges\b/);
  for (const version of [undefined, "", "herdr-app 0.1.18", "0.1"]) assert.equal(toPortable(main(), version).ok, false, String(version));
}

// What `herdr-app --version` prints.
assert.equal(herdrVersion("herdr-app 0.1.18\n"), "0.1.18");
assert.equal(herdrVersion("herdr-app 0.2.0-beta.1"), "0.2.0-beta.1");
assert.equal(herdrVersion(""), null);
assert.equal(herdrVersion("gpui-shell 0.7.1"), null);

// ---- writing files the person already has

// A disk that fills up halfway: the write puts part of the text down, then fails.
const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-layout-`));
const halfFs = { ...fs, writeFileSync(path, data) { fs.writeFileSync(path, String(data).slice(0, 10)); throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); } };
const leftovers = (dir, name) => fs.readdirSync(dir).filter((entry) => entry !== name);

// The git-tools layout file is replaced whole or not at all: a failed write leaves the old file.
{
  const dir = `${tmp}/layout`, file = `${dir}/git-tools.json`;
  fs.mkdirSync(dir);
  fs.writeFileSync(file, "the old layout\n");
  assert.throws(() => writeWhole(halfFs, file, "the new layout, much longer\n"), /no space left/);
  assert.equal(fs.readFileSync(file, "utf8"), "the old layout\n");
  assert.deepEqual(leftovers(dir, "git-tools.json"), [], "no half-written file left behind");
  writeWhole(fs, file, "the new layout\n");
  assert.equal(fs.readFileSync(file, "utf8"), "the new layout\n");
  assert.deepEqual(leftovers(dir, "git-tools.json"), []);
}

// `node layout.mjs <main.json> <out.json>` over an existing git-tools.json, as the install
// rebuilds it: the new build, with that file's `cloned_from` and `link_handlers`.
{
  const dir = `${tmp}/rebuild`, from = `${dir}/main.json`, to = `${dir}/git-tools.json`;
  fs.mkdirSync(dir);
  fs.writeFileSync(from, JSON.stringify(main()));
  const old = { ...toMainGit(main()).layout, cloned_from: { name: "main", version: "0.1.15" }, link_handlers: ["viewer"] };
  fs.writeFileSync(to, JSON.stringify(old));
  execFileSync(process.execPath, [fileURLToPath(new URL("./layout.mjs", import.meta.url)), from, to]);
  const written = JSON.parse(fs.readFileSync(to, "utf8"));
  assert.deepEqual(written.link_handlers, ["viewer"]);
  assert.deepEqual(written.cloned_from, old.cloned_from);
  assert.notEqual(find(written, LOG_ID), null, "the file is the rebuilt layout");
}

// `node layout.mjs --portable <main.json> <out.json> <version>` writes the shipped layout
// whole: nothing of the file it replaces comes along, `link_handlers` included.
{
  const dir = `${tmp}/portable`, from = `${dir}/main.json`, to = `${dir}/git-tools.json`;
  fs.mkdirSync(dir);
  fs.writeFileSync(from, JSON.stringify(main()));
  fs.writeFileSync(to, JSON.stringify({ ...toMainGit(main()).layout, link_handlers: ["viewer"] }));
  execFileSync(process.execPath, [fileURLToPath(new URL("./layout.mjs", import.meta.url)), "--portable", from, to, "0.1.99"]);
  const text = fs.readFileSync(to, "utf8");
  assert.equal(text, JSON.stringify(toPortable(main(), "0.1.99").layout, null, 2) + "\n");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["git-tools.json", "main.json"], "no temporary file left behind");
}

// The mod folder is copied by content. Herdr reloads every copy of a mod each time a file
// in its folder is saved, so a file that is already the same is not written again, and a
// file that differs is written whole under a hidden name (Herdr ignores those) and then
// renamed into place: Herdr never reads half a file. Tests are not copied, and the modules
// only the app home has are deleted; its other files stay.
{
  const from = `${tmp}/mod-from`, to = `${tmp}/mod-to`;
  fs.mkdirSync(`${from}/icons/theme`, { recursive: true });
  fs.mkdirSync(`${to}/icons`, { recursive: true });
  fs.writeFileSync(`${from}/main.js`, "export default 1;\n");
  fs.writeFileSync(`${from}/view.js`, "new view\n");
  fs.writeFileSync(`${from}/icons/theme/a.svg`, "<svg/>\n");
  fs.writeFileSync(`${from}/icons/x.svg`, "<svg new/>\n");
  fs.writeFileSync(`${from}/view.test.mjs`, "a test\n");
  fs.writeFileSync(`${from}/icons/theme/a.test.mjs`, "a test in a subfolder\n");
  fs.writeFileSync(`${to}/main.js`, "export default 1;\n");
  fs.writeFileSync(`${to}/view.js`, "old view, longer than the new one\n");
  fs.writeFileSync(`${to}/icons/x.svg`, "<svg old/>\n");
  fs.writeFileSync(`${to}/gone.js`, "only in the app home\n");
  fs.writeFileSync(`${to}/icons/gone.mjs`, "only in the app home\n");
  fs.writeFileSync(`${to}/icons/own.svg`, "only in the app home\n");
  const stamp = (file) => { const s = fs.statSync(file); return [s.ino, s.mtimeMs]; };
  const kept = stamp(`${to}/main.js`);
  const names = (dir, rel = "") => fs.readdirSync(`${dir}/${rel}`, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? names(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
  const hidden = () => names(to).filter((name) => name.split("/").pop().startsWith("."));

  // A disk that fills up: every file in place is still whole, nothing is deleted and
  // nothing is left behind.
  assert.throws(() => copyChanged(halfFs, from, to), /no space left/);
  assert.equal(fs.readFileSync(`${to}/gone.js`, "utf8"), "only in the app home\n");
  assert.equal(fs.readFileSync(`${to}/view.js`, "utf8"), "old view, longer than the new one\n");
  assert.equal(fs.readFileSync(`${to}/icons/x.svg`, "utf8"), "<svg old/>\n");
  assert.deepEqual(hidden(), []);

  const r = copyChanged(fs, from, to);
  assert.deepEqual(r, { written: ["icons/theme/a.svg", "icons/x.svg", "view.js"], same: 1, removed: ["gone.js", "icons/gone.mjs"] });
  assert.equal(copyReport(r), "3 files updated, 1 already the same, 2 removed.");
  assert.deepEqual(stamp(`${to}/main.js`), kept, "a file that is already the same is not written again");
  const mod = names(from).filter((name) => !name.endsWith(".test.mjs"));
  for (const name of mod) assert.equal(fs.readFileSync(`${to}/${name}`, "utf8"), fs.readFileSync(`${from}/${name}`, "utf8"), name);
  assert.deepEqual(names(to), [...mod, "icons/own.svg"].sort(), "no test copied, an icon only the app home has stays");
  assert.deepEqual(hidden(), []);
  const again = copyChanged(fs, from, to);
  assert.deepEqual(again, { written: [], same: 4, removed: [] }, "run again, nothing is written");
  assert.equal(copyReport(again), "0 files updated, 4 already the same.");

  // A folder the app home doesn't have yet.
  assert.deepEqual(copyChanged(fs, from, `${tmp}/mod-new`), { written: ["icons/theme/a.svg", "icons/x.svg", "main.js", "view.js"], same: 0, removed: [] });
  assert.deepEqual(names(`${tmp}/mod-new`), mod);
}

// readMain names the file in what it says goes wrong.
{
  const dir = `${tmp}/read`;
  fs.mkdirSync(dir);
  fs.writeFileSync(`${dir}/main.json`, JSON.stringify(main()));
  fs.writeFileSync(`${dir}/bad.json`, "{ not json");
  fs.writeFileSync(`${dir}/empty.json`, "{}");
  assert.equal(readMain(fs, `${dir}/main.json`).ok, true);
  assert.match(readMain(fs, `${dir}/bad.json`).error, /^Cannot read .*bad\.json: /);
  assert.equal(readMain(fs, `${dir}/empty.json`).error, `${dir}/empty.json is not shaped like the Herdr main layout this was built for: the layout has no node tree.`);
}

// ---- the repository's layouts/git-tools.json

// Always: the file is the shipped layout's shape, written by `--portable` (so a rebuild
// from the same `main` gives the same bytes).
const shippedPath = fileURLToPath(new URL("./layouts/git-tools.json", import.meta.url));
const shippedText = fs.readFileSync(shippedPath, "utf8");
const shipped = JSON.parse(shippedText);
{
  assert.deepEqual(find(shipped, "changes")?.content, { mod: MOD, props: { view: "commit" } });
  assert.deepEqual(find(shipped, "files")?.content, { mod: MOD, props: { view: "files" } });
  assert.deepEqual(find(shipped, LOG_ID)?.content, { mod: MOD, props: { view: "log" } });
  assert.equal(find(shipped, TABS_ROW_ID), null, "no row beside the tab bar");
  assert.equal(find(shipped, WIDGET_ID), null);
  assert.equal(find(shipped, BUTTON_ID), null);
  assert.equal(parentOf(shipped, "tabs")?.id, "work", "the tab bar as Herdr has it");
  assert.equal("link_handlers" in shipped, false, "no link_handlers: Herdr fills them in for each person");
  assert.equal(shipped.cloned_from?.name, "main");
  const again = toMainGit(shipped, { button: false });
  assert.equal(again.ok, true);
  assert.deepEqual(again.layout, shipped, "toMainGit(file, { button: false }) gives the file back");
  assert.deepEqual(toPortable(shipped, shipped.cloned_from.version).layout, shipped);
  assert.equal(shippedText, JSON.stringify(shipped, null, 2) + "\n", "written by layout.mjs --portable, not by hand");
}

// Where Herdr is installed: its `main` still gives the same file. Herdr rewrites `main` to
// the running version's on every start, so a difference means an update changed it.
{
  const herdrMain = `${process.env.HERDR_APP_HOME || `${homedir()}/.config/herdr-app`}/layouts/main.json`;
  const rebuild = `node layout.mjs --portable ${herdrMain} layouts/git-tools.json`;
  if (!fs.existsSync(herdrMain)) console.log(`skip: no ${herdrMain}, so layouts/git-tools.json was not compared with Herdr's main`);
  else {
    const r = toPortable(JSON.parse(fs.readFileSync(herdrMain, "utf8")), shipped.cloned_from.version);
    assert.ok(r.ok, `Herdr's main changed and no longer transforms (${r.error}): fix layout.mjs, then rebuild with ${rebuild}`);
    assert.deepEqual(r.layout, shipped, `Herdr's main changed: rebuild layouts/git-tools.json with ${rebuild}`);
  }
}

console.log("ok");
