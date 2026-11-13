// node ui-ids.test.mjs: element ids a screen file must not reuse (no app, no git).
// dialogFrame(id, …) (ui.js) gives its title bar's × the id `${id}-close`. An element of
// the same screen with that id takes the ×'s clicks or gives it its own: a footer button
// named the same did nothing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The ids a file's dialogFrame calls give their × (written out as a string), and every
// other place the file writes that id as a string.
// Comment lines are left out: they may name the id they avoid.
export function closeIdClashes(text) {
  const source = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  const frames = [...source.matchAll(/dialogFrame\(\s*"([^"]+)"/g)].map((m) => m[1]);
  return frames.filter((id) => source.includes(`"${id}-close"`) || source.includes(`'${id}-close'`) || source.includes(`\`${id}-close\``));
}

// The check itself: a clash is found, a different id is not.
{
  assert.deepEqual(closeIdClashes(`dialogFrame("a", t, {}); button("a-close", "Close")`), ["a"]);
  assert.deepEqual(closeIdClashes(`dialogFrame("a", t, {}); button("a-dismiss", "Close")`), []);
  assert.deepEqual(closeIdClashes(`dialogFrame("a", t, {});\n  // Not "a-close": the × has it.\nbutton("a-dismiss")`), []);
}

{
  const clashes = [];
  for (const name of readdirSync(here)) {
    if (!name.endsWith(".js") || name === "ui.js") continue;
    for (const id of closeIdClashes(readFileSync(join(here, name), "utf8"))) clashes.push(`${name}: ${id}-close`);
  }
  assert.deepEqual(clashes, []);
}

// A tooltip stays up over the menu its element opened (the pointer is still on the
// element), so screens attach tooltips with ui.js tip(el, text), which leaves them off
// while a menu is open. The menu screens draw their own items' tooltips.
export function bareTooltips(text) {
  return text.split("\n").filter((line) => !/^\s*\/\//.test(line) && /\.tooltip\(/.test(line)).length;
}
{
  assert.equal(bareTooltips(`el.tooltip("x")`), 1);
  assert.equal(bareTooltips(`tip(el, "x")\n// .tooltip( in a comment`), 0);
  const MENUS = new Set(["ui.js", "view-menu.js", "view-vcs-popup.js"]);
  const bare = [];
  for (const name of readdirSync(here)) {
    if (!name.endsWith(".js") || MENUS.has(name)) continue;
    const n = bareTooltips(readFileSync(join(here, name), "utf8"));
    if (n) bare.push(`${name}: ${n}`);
  }
  assert.deepEqual(bare, []);
}

console.log("ok");
