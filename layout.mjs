// Turns Herdr's `main` layout into `main-git`: the Changes button opens the Commit panel
// and a Log panel sits under the work area. See docs/adr/0001-clone-main-layout.md.
//
//   node layout.mjs <main.json>              check only: exit 1 and the reason if it can't be done
//   node layout.mjs <main.json> <out.json>   write the transformed layout to out.json

export const MOD = "git-tools";
export const LOG_ID = "git-log";
// `work` is not resizable, so the Log panel's boundary needs a column of its own.
export const WRAP_ID = "git-work";
export const LOG_HEIGHT = 320;

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
export function toMainGit(main) {
  if (!main || typeof main !== "object" || !Array.isArray(main.children)) return fail("the layout has no node tree");
  const layout = structuredClone(main);

  const work = find(layout, "work");
  if (!work) return fail("node `work` (the column right of the sidebar) is missing");
  if (work.type !== "column" || !Array.isArray(work.children)) return fail("node `work` is not a column");

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

  // The tab bar's Changes button opens the node by id, so the id stays and the mod changes.
  changes.content = { mod: MOD, props: { view: "commit" } };

  const log = {
    id: LOG_ID, type: "block", hidden: true, size: { px: LOG_HEIGHT }, min: 120, max: 900,
    // work-body pads its own bottom; these line the panel up with the cards above it.
    padding: [0, 8],
    content: { mod: MOD, props: { view: "log" } },
  };
  const wrap = { id: WRAP_ID, type: "column", children: [body, log] };
  work.children[work.children.indexOf(oldWrap ?? body)] = wrap;
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

const invoked = typeof process !== "undefined" && process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) {
  const fs = await import("node:fs");
  const [from, to] = process.argv.slice(2);
  if (!from) { console.error("usage: node layout.mjs <main.json> [<out.json>]"); process.exit(2); }
  let main;
  try { main = JSON.parse(fs.readFileSync(from, "utf8")); }
  catch (e) { console.error(`Cannot read ${from}: ${e.message}`); process.exit(1); }
  const r = toMainGit(main);
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
