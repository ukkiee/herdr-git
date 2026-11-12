// Turns Herdr's `main` layout into `main-git`: the Changes button opens the Commit panel,
// the Files button the Files panel, a Log panel sits under the work area, and a Git
// button beside the Changes button shows and hides it. See
// docs/adr/0001-clone-main-layout.md.
//
//   node layout.mjs <main.json>              check only: exit 1 and the reason if it can't be done
//   node layout.mjs <main.json> <out.json>   write the transformed layout to out.json
//   node layout.mjs --copy <from> <to>       copy the mod folder, writing only what differs

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
  const gitButton = {
    id: BUTTON_ID, type: "block", size: { px: BUTTON_WIDTH },
    ...(tabs.window_drag === undefined ? {} : { window_drag: tabs.window_drag }),
    content: { mod: MOD, props: { view: "log-button" } },
  };
  const row = { id: TABS_ROW_ID, type: "row", ...(height ? { size: height } : {}), resizable: false, children: [bar, gitButton] };
  work.children[work.children.indexOf(oldRow ?? tabs)] = button ? row : { ...bar, ...(height ? { size: height } : {}) };
  return { ok: true, layout };
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

// copyChanged(fs, from, to) → { written: [path relative to the folder], same: count }
//   Copies folder `from` over folder `to`, writing only the files `to` lacks or holds with
//   other bytes. Herdr reloads every copy of a mod each time a file in its folder is
//   saved, so rewriting a file that is already the same costs a reload for nothing, and
//   a mod of thousands of files costs thousands. Every file to write is first written
//   whole beside its place under a hidden name (Herdr doesn't reload for hidden files),
//   then all are renamed into place one after another: Herdr never reads half a file.
//   Files only `to` has are left alone. Throws as fs does, with nothing renamed when a
//   write failed and no hidden file left behind. `fs`: node's fs module.
export function copyChanged(fs, from, to) {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(rel ? `${from}/${rel}` : from, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push(next);
    }
  };
  walk("");
  files.sort();
  const pending = [], written = [];
  let same = 0;
  try {
    for (const rel of files) {
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
  return { written, same };
}

const invoked = typeof process !== "undefined" && process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) {
  const fs = await import("node:fs");
  if (process.argv[2] === "--copy") {
    const [source, target] = process.argv.slice(3);
    if (!source || !target) { console.error("usage: node layout.mjs --copy <from> <to>"); process.exit(2); }
    try {
      const r = copyChanged(fs, source, target);
      console.log(`${r.written.length} ${r.written.length === 1 ? "file" : "files"} updated, ${r.same} already the same.`);
    } catch (e) { console.error(`Cannot copy to ${target}: ${e.message}. Files already there are whole.`); process.exit(1); }
    process.exit(0);
  }
  const [from, to] = process.argv.slice(2);
  if (!from) { console.error("usage: node layout.mjs <main.json> [<out.json>]"); process.exit(2); }
  let main;
  try { main = JSON.parse(fs.readFileSync(from, "utf8")); }
  catch (e) { console.error(`Cannot read ${from}: ${e.message}`); process.exit(1); }
  // Only on macOS: elsewhere the tab bar ends with the window's own buttons (minimize,
  // maximize, close), and a block right of it would sit outside them.
  const r = toMainGit(main, { button: process.platform === "darwin" });
  if (!r.ok) {
    console.error(`${from} is not shaped like the Herdr main layout this was built for: ${r.error}.`);
    process.exit(1);
  }
  if (to) {
    // A clone made by Herdr records where it came from; keep that note when rebuilding.
    let old = null;
    try { old = JSON.parse(fs.readFileSync(to, "utf8")); } catch {}
    if (old?.cloned_from && !r.layout.cloned_from) r.layout.cloned_from = old.cloned_from;
    try { writeWhole(fs, to, JSON.stringify(r.layout, null, 2) + "\n"); }
    catch (e) { console.error(`Cannot write ${to}: ${e.message}. The old file is unchanged.`); process.exit(1); }
  }
}
