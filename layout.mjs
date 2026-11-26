// Turns Herdr's `main` layout into the `git-tools` layout: the Changes button opens the Commit panel,
// the Files button the Files panel, a Log panel sits under the work area, and a Git
// button beside the Changes button shows and hides it, with the VCS widget left of it. See
// docs/adr/0001-clone-main-layout.md.
//
//   node layout.mjs <main.json>              check only: exit 1 and the reason if it can't be done
//   node layout.mjs <main.json> <out.json>   write the transformed layout to out.json
//   node layout.mjs --portable <main.json> <out.json> [<herdr version>]
//                                            write the layout the repository ships
//                                            (`toPortable`), for the version given or
//                                            else the one `herdr-app --version` prints
//   node layout.mjs --copy <from> <to>       copy the mod folder, writing only what differs
//                                            and deleting the modules <from> no longer has

export const MOD = "git-tools";
export const LOG_ID = "git-log";
// `work` is not resizable, so the Log panel's boundary needs a column of its own.
export const WRAP_ID = "git-work";
export const LOG_HEIGHT = 320;
// The tab bar draws the Files and Changes buttons itself and takes no others, so the Git
// button is a block of its own right of it, in a row that takes the tab bar's place.
export const TABS_ROW_ID = "git-tabs";
export const BUTTON_ID = "git-log-button";
export const BUTTON_WIDTH = 64;
// The VCS widget (branch, commits to pull and push, an operation in progress) sits left
// of the Git button in the same row. A block's width is fixed in the layout, so the
// widget gets one that holds a usual branch name and cuts longer ones short.
export const WIDGET_ID = "git-vcs-widget";
export const WIDGET_WIDTH = 240;

const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
};

const fail = (error) => ({ ok: false, error });

// Pure: returns { ok: true, layout } or { ok: false, error }, never touches its input.
// It fails rather than guesses when `main` isn't shaped as expected: a Herdr update that
// moves these nodes must be noticed, not papered over.
// button: whether the Git button goes beside the tab bar. Without it the tab bar is left
// (or put back) as Herdr has it.
export function toMainGit(main, { button = true } = {}) {
  if (!main || typeof main !== "object" || !Array.isArray(main.children)) return fail("the layout has no node tree");
  const layout = structuredClone(main);

  const work = find(layout, "work");
  if (!work) return fail("node `work` (the column right of the sidebar) is missing");
  if (work.type !== "column" || !Array.isArray(work.children)) return fail("node `work` is not a column");

  // On our own output, the tab bar already sits inside its row.
  const oldRow = work.children.find((c) => c.id === TABS_ROW_ID);
  const tabs = (oldRow?.children ?? work.children).find((c) => c.id === "tabs");
  if (!tabs) return fail("node `tabs` (the tab bar) is missing from `work`");
  if (tabs.type !== "block") return fail("node `tabs` is not a block");

  // On our own output, work-body already sits inside the wrapper.
  const oldWrap = work.children.find((c) => c.id === WRAP_ID);
  const holder = oldWrap ?? work;
  const body = (holder.children ?? []).find((c) => c.id === "work-body");
  if (!body) return fail("node `work-body` (the row under the tab bar) is missing from `work`");

  const stack = find(body, "panel-body");
  if (!stack) return fail("node `panel-body` (the side panel's stack) is missing from `work-body`");
  if (stack.type !== "stack" || !Array.isArray(stack.children)) return fail("node `panel-body` is not a stack");
  const changes = stack.children.find((c) => c.id === "changes");
  if (!changes) return fail("node `changes` (what the Changes button opens) is missing from `panel-body`");
  if (changes.type !== "block") return fail("node `changes` is not a block");
  const files = stack.children.find((c) => c.id === "files");
  if (!files) return fail("node `files` (what the Files button opens) is missing from `panel-body`");
  if (files.type !== "block") return fail("node `files` is not a block");

  // The tab bar's Changes and Files buttons open the nodes by id, so the ids stay and
  // the mod changes.
  changes.content = { mod: MOD, props: { view: "commit" } };
  files.content = { mod: MOD, props: { view: "files" } };

  const log = {
    id: LOG_ID, type: "block", hidden: true, size: { px: LOG_HEIGHT }, min: 120, max: 900,
    // work-body pads its own bottom; these line the panel up with the cards above it.
    padding: [0, 8],
    content: { mod: MOD, props: { view: "log" } },
  };
  const wrap = { id: WRAP_ID, type: "column", children: [body, log] };
  work.children[work.children.indexOf(oldWrap ?? body)] = wrap;

  // The row is as tall as the tab bar was; inside it the tab bar takes the width left
  // over, so its own size (a height) goes to the row. No boundary to drag between them.
  const height = oldRow ? oldRow.size : tabs.size;
  const { size: _height, ...bar } = tabs;
  // The button's block is the window's top right corner, which was the tab bar's: around
  // the button it moves the window when the tab bar does.
  const drag = tabs.window_drag === undefined ? {} : { window_drag: tabs.window_drag };
  const widget = { id: WIDGET_ID, type: "block", size: { px: WIDGET_WIDTH }, ...drag, content: { mod: MOD, props: { view: "vcs-widget" } } };
  const gitButton = { id: BUTTON_ID, type: "block", size: { px: BUTTON_WIDTH }, ...drag, content: { mod: MOD, props: { view: "log-button" } } };
  const row = { id: TABS_ROW_ID, type: "row", ...(height ? { size: height } : {}), resizable: false, children: [bar, widget, gitButton] };
  work.children[work.children.indexOf(oldRow ?? tabs)] = button ? row : { ...bar, ...(height ? { size: height } : {}) };
  return { ok: true, layout };
}

// toPortable(main, version) → { ok: true, layout } or { ok: false, error }: the layout the
// repository ships as layouts/git-tools.json, which Herdr's gallery copies as it is to
// every OS. So it has no Git button and no VCS widget block (`button: false`): the tab bar
// ends with the window's own buttons on every OS but macOS, and a block right of it would
// sit outside them. The Log panel's Commit list toolbar draws the widget instead. It has no
// `link_handlers`, which Herdr fills in for each person from the mods they have.
// `cloned_from` is the note Herdr's own clone writes: the Herdr version whose `main` it
// was built from. Herdr keeps that note and never updates a clone from it.
export function toPortable(main, version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+\S*$/.test(version)) return fail(`"${version}" is not a Herdr version`);
  const r = toMainGit(main, { button: false });
  if (!r.ok) return r;
  const { link_handlers: _handlers, cloned_from: _note, ...layout } = r.layout;
  return { ok: true, layout: { ...layout, cloned_from: { name: "main", version } } };
}

// herdrVersion(text) → the version in what `herdr-app --version` prints ("herdr-app 0.1.18"),
// or null.
export const herdrVersion = (text) => /^herdr-app (\d+\.\d+\.\d+\S*)\s*$/.exec(String(text).trim())?.[1] ?? null;

// carryOver(layout, old) → `layout` with what the git-tools.json it replaces holds that
// isn't built from `main`:
//   - `cloned_from`, the note Herdr's clone left, unless `layout` has its own.
//   - `link_handlers`, the mods that take Ctrl/Cmd-clicks on terminal links, in order.
//     Herdr adds a mod with link rules to a layout's list once and then remembers it did,
//     so a list lost here would never come back. The old list wins over one `main`
//     carries: the person may have reordered it or taken mods out.
// `old`: the parsed old file, or null. Neither argument is modified.
export function carryOver(layout, old) {
  const out = { ...layout };
  if (old?.cloned_from && !out.cloned_from) out.cloned_from = old.cloned_from;
  const handlers = old?.link_handlers;
  if (Array.isArray(handlers) && handlers.every((id) => typeof id === "string")) out.link_handlers = handlers;
  return out;
}

// readMain(fs, from, { button }) → { ok: true, layout } or { ok: false, error }: reads
// Herdr's main layout from the file `from` and transforms it with `toMainGit`. `error` is
// a sentence for the person, naming the file. `fs`: node's fs module.
export function readMain(fs, from, { button = true } = {}) {
  let main;
  try { main = JSON.parse(fs.readFileSync(from, "utf8")); }
  catch (e) { return fail(`Cannot read ${from}: ${e.message}`); }
  const r = toMainGit(main, { button });
  return r.ok ? r : fail(`${from} is not shaped like the Herdr main layout this was built for: ${r.error}.`);
}

// writeLayout(fs, layout, to): writes `layout` to the file `to` whole (`writeWhole`), with
// what the file it replaces carries over (`carryOver`). Throws as fs does.
export function writeLayout(fs, layout, to) {
  let old = null;
  try { old = JSON.parse(fs.readFileSync(to, "utf8")); } catch {}
  writeWhole(fs, to, JSON.stringify(carryOver(layout, old), null, 2) + "\n");
}

// writeWhole(fs, path, text): replaces the file whole or not at all. The text goes to a
// file next to it (same folder, so the rename can't cross disks) and is renamed over it;
// a write that fails halfway (a full disk) leaves the old file as it was. Throws as
// fs does. `fs`: node's fs module, passed in so a failing one can be tested.
export function writeWhole(fs, path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, path);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

// Tests sit next to the modules they test but are not part of the installed mod.
export const isTest = (name) => name.endsWith(".test.mjs");
const isModule = (name) => name.endsWith(".js") || name.endsWith(".mjs");

// files(fs, root, { hidden }) → [path relative to root], sorted: every file under `root`,
// in subfolders too. hidden: false leaves out files and folders whose name starts with ".".
const files = (fs, root, { hidden = true } = {}) => {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true })) {
      if (!hidden && entry.name.startsWith(".")) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(next);
    }
  };
  walk("");
  return out.sort();
};

// copyChanged(fs, from, to) → { written, same: count, removed }
//   Makes folder `to` hold the mod in folder `from`. `written` and `removed` list paths
//   relative to the folder. Tests (`*.test.mjs`) are not copied.
//   Only the files `to` lacks or holds with other bytes are written. Herdr reloads every
//   copy of a mod each time a file in its folder is saved, so rewriting a file that is
//   already the same costs a reload for nothing, and a mod of thousands of files costs
//   thousands. Every file to write is first written whole beside its place under a hidden
//   name (Herdr doesn't reload for hidden files), then all are renamed into place one
//   after another: Herdr never reads half a file.
//   Then the `.js` and `.mjs` files `to` has and `from` doesn't are deleted (a module moved
//   or removed, a test an older install copied), in subfolders too: a module left behind
//   would still load where an old import names it. They go only after every rename, so the
//   whole install lands within the short span Herdr folds into one reload. Every other
//   file only `to` has stays (Herdr may keep files of its own there), as do hidden files
//   and everything in a hidden folder.
//   Throws as fs does. A failed write leaves nothing renamed, nothing deleted and no hidden
//   file behind; a failed delete leaves every file in place whole. `fs`: node's fs module.
export function copyChanged(fs, from, to) {
  const source = files(fs, from).filter((rel) => !isTest(rel));
  const pending = [], written = [];
  let same = 0;
  try {
    for (const rel of source) {
      const data = fs.readFileSync(`${from}/${rel}`), target = `${to}/${rel}`;
      let old = null;
      try { old = fs.readFileSync(target); } catch {}
      if (old && old.equals(data)) { same++; continue; }
      const cut = target.lastIndexOf("/"), dir = target.slice(0, cut);
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${dir}/.${target.slice(cut + 1)}.${process.pid}.tmp`;
      pending.push({ temp, target, rel });
      fs.writeFileSync(temp, data);
    }
    for (const { temp, target, rel } of pending) { fs.renameSync(temp, target); written.push(rel); }
  } catch (error) {
    for (const { temp } of pending) { try { fs.unlinkSync(temp); } catch {} }
    throw error;
  }
  const keep = new Set(source);
  const removed = fs.existsSync(to) ? files(fs, to, { hidden: false }).filter((rel) => isModule(rel) && !keep.has(rel)) : [];
  for (const rel of removed) fs.unlinkSync(`${to}/${rel}`);
  return { written, same, removed };
}

// copyReport({ written, same, removed }) → the line the copy prints.
export function copyReport({ written, same, removed }) {
  const gone = removed.length ? `, ${removed.length} removed` : "";
  return `${written.length} ${written.length === 1 ? "file" : "files"} updated, ${same} already the same${gone}.`;
}

const invoked = typeof process !== "undefined" && process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) {
  const fs = await import("node:fs");
  if (process.argv[2] === "--copy") {
    const [source, target] = process.argv.slice(3);
    if (!source || !target) { console.error("usage: node layout.mjs --copy <from> <to>"); process.exit(2); }
    try {
      console.log(copyReport(copyChanged(fs, source, target)));
    } catch (e) { console.error(`Cannot copy to ${target}: ${e.message}. Files already there are whole.`); process.exit(1); }
    process.exit(0);
  }
  if (process.argv[2] === "--portable") {
    const [source, target, given] = process.argv.slice(3);
    if (!source || !target) { console.error("usage: node layout.mjs --portable <main.json> <out.json> [<herdr version>]"); process.exit(2); }
    let version = given;
    if (!version) {
      const { spawnSync } = await import("node:child_process");
      version = herdrVersion(spawnSync("herdr-app", ["--version"], { encoding: "utf8" }).stdout ?? "");
      if (!version) { console.error("Cannot tell the Herdr version from `herdr-app --version`: give it after <out.json>."); process.exit(2); }
    }
    let main;
    try { main = JSON.parse(fs.readFileSync(source, "utf8")); }
    catch (e) { console.error(`Cannot read ${source}: ${e.message}`); process.exit(1); }
    const r = toPortable(main, version);
    if (!r.ok) { console.error(`${source} is not shaped like the Herdr main layout this was built for: ${r.error}.`); process.exit(1); }
    // Written whole, with nothing carried over from the file it replaces.
    try { writeWhole(fs, target, JSON.stringify(r.layout, null, 2) + "\n"); }
    catch (e) { console.error(`Cannot write ${target}: ${e.message}. The old file is unchanged.`); process.exit(1); }
    process.exit(0);
  }
  const [from, to] = process.argv.slice(2);
  if (!from) { console.error("usage: node layout.mjs <main.json> [<out.json>]"); process.exit(2); }
  // Only on macOS: elsewhere the tab bar ends with the window's own buttons (minimize,
  // maximize, close), and a block right of it would sit outside them.
  const r = readMain(fs, from, { button: process.platform === "darwin" });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  if (to) {
    try { writeLayout(fs, r.layout, to); }
    catch (e) { console.error(`Cannot write ${to}: ${e.message}. The old file is unchanged.`); process.exit(1); }
  }
}
