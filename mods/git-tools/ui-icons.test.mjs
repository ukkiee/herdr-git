// node ui-icons.test.mjs: button and menu icon names → files under icons/ (no app, no git).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_ICONS, iconShape, iconDraw } from "./ui-icons.js";

const here = dirname(fileURLToPath(import.meta.url));
const home = dirname(dirname(here)); // the folder Herdr resolves "mods/…" against
const onDisk = (p) => existsSync(join(home, p));
const UI = "mods/git-tools/icons/ui";
const OWN = "mods/git-tools/icons";

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Examples: a colored toolbar icon, its dark variant, a tinted tree arrow, the mod's own spinner.
{
  assert.deepEqual(iconDraw("refresh"), { path: `${UI}/icons/expui/general/refresh.svg`, tint: false });
  assert.deepEqual(iconDraw("refresh", { dark: true }), { path: `${UI}/icons/expui/general/refresh.svg`, tint: false });
  assert.deepEqual(iconDraw("restore", { dark: true }), { path: `${UI}/icons/expui/general/history_dark.svg`, tint: false });
  assert.deepEqual(iconDraw("restore"), { path: `${UI}/icons/expui/general/history.svg`, tint: false });
  assert.deepEqual(iconDraw("chevron-right", { dark: true }), { path: `${UI}/icons/expui/general/chevronRight.svg`, tint: true });
  assert.deepEqual(iconDraw("folder"), { path: `${UI}/glyphs/expui/nodes/folder.svg`, tint: true });
  assert.deepEqual(iconDraw("spinner"), { path: `${OWN}/spinner.svg`, tint: true });
  assert.equal(iconShape("search"), `${UI}/icons/expui/general/search.svg`);
  assert.equal(iconShape("favorite"), `${UI}/glyphs/expui/nodes/star.svg`);
}

// A turned-off button draws the same shape in one gray: tinted, and never the dark file
// (the tint replaces its colors anyway).
{
  assert.deepEqual(iconDraw("fetch", { disabled: true }), { path: `${UI}/icons/expui/vcs/fetch.svg`, tint: true });
  assert.deepEqual(iconDraw("copy", { dark: true, disabled: true }), { path: `${UI}/icons/expui/general/copy.svg`, tint: true });
  assert.deepEqual(iconDraw("copy", { dark: true }), { path: `${UI}/icons/expui/general/copy_dark.svg`, tint: false });
}

// Gray in the reference screen (drawn in the text color): the tree arrows, the Branch tree
// folder and the search field's magnifier. Every other icon from the set keeps its colors.
// The mod's own spinner and checkbox marks stay tinted.
{
  const tinted = Object.keys(UI_ICONS).filter((n) => iconDraw(n).tint).sort();
  assert.deepEqual(tinted, ["checkbox-all", "checkbox-some", "chevron-down", "chevron-right", "folder", "search", "spinner"]);
}

// Every name a screen asks for is in the table: icon("…") and iconButton(id, "…", …) literals.
{
  const used = new Set();
  for (const f of readdirSync(here).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(join(here, f), "utf8");
    for (const m of src.matchAll(/\bicon\(\s*"([^"]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bicon\([^)]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*\)/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of src.matchAll(/\biconButton\([^,]+,\s*"([^"]+)"/g)) used.add(m[1]);
  }
  for (const name of ["refresh", "fetch", "plus", "branch-delete", "restore", "rollback", "diff", "eye", "panel-bottom",
    "expand-all", "collapse-all", "regex", "case-sensitive", "filter-x", "x", "search", "chevron-down", "chevron-right",
    "folder", "branch-item", "check", "spinner"]) assert.ok(used.has(name), `the scan should see ${name}`);
  for (const name of used) assert.ok(name in UI_ICONS, `no icon for "${name}"`);
}

// Unknown names fail loudly instead of drawing nothing.
assert.throws(() => iconDraw("no-such-icon"), /no-such-icon/);

// Every file in the table is there, light and (where the table says so) dark.
{
  for (const name of Object.keys(UI_ICONS)) {
    assert.ok(onDisk(iconDraw(name).path), `${name}: ${iconDraw(name).path}`);
    assert.ok(onDisk(iconDraw(name, { dark: true }).path), `${name} dark`);
  }
}

// The table and the folder agree: every downloaded icon is used, and a _dark file is picked
// exactly when it exists.
{
  const svgs = walk(join(home, UI)).filter((p) => p.endsWith(".svg")).map((p) => relative(home, p));
  const picked = new Set(Object.keys(UI_ICONS).flatMap((n) => [iconDraw(n).path, iconDraw(n, { dark: true }).path]));
  for (const p of svgs) assert.ok(picked.has(p), `unused icon file ${p}`);
  for (const name of Object.keys(UI_ICONS)) {
    const light = iconDraw(name).path;
    if (!light.startsWith(UI)) continue;
    const dark = light.replace(/\.svg$/, "_dark.svg");
    assert.equal(iconDraw(name, { dark: true }).path, onDisk(dark) ? dark : light, name);
  }
}

// Only the mod's own spinner and checkbox marks are left of the old line icons.
{
  const own = readdirSync(join(home, OWN)).filter((f) => statSync(join(home, OWN, f)).isFile()).sort();
  assert.deepEqual(own, ["checkbox-all.svg", "checkbox-some.svg", "spinner.svg"]);
  const fromSet = Object.keys(UI_ICONS).filter((n) => !iconDraw(n).path.startsWith(UI)).sort();
  assert.deepEqual(fromSet, ["checkbox-all", "checkbox-some", "spinner"]);
}

// The source's license and where the files came from sit next to them.
{
  const license = readFileSync(join(home, UI, "LICENSE"), "utf8");
  assert.match(license, /The MIT License/);
  assert.match(license, /Copyright \(c\) 2017-2022 Elior "Mallowigi" Boukhobza/);
  const notice = readFileSync(join(home, UI, "NOTICE.md"), "utf8");
  assert.match(notice, /AtomMaterialUI\/a-file-icon-idea/);
  assert.match(notice, /12c2ce7a0dd4c00f92437034417d44dfbc8f7976/);
}

console.log("ok");
