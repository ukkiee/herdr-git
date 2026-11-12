// Icon theme lookup: a file path or folder name → the Atom Material Icons file to draw.
// Pure: no herdr import, no file reads. Screens call this outside render or rely on its memo.
//
// Matching follows the Atom Material Icons plugin: each rule's pattern must match the whole name (a pattern
// with "/" matches the path instead), the highest priority wins, and equal priorities go to the
// earlier rule. The plugin ships many rules switched off but switches each one on as soon as a
// project holds a file it matches, so for files that exist every rule counts. Icon packs the
// plugin's settings turn off by default stay off.

import {
  FILE_RULES,
  FOLDER_RULES,
  DARK_FILE_ICONS,
  CLOSED_ONLY_FOLDER_ICONS,
} from "./icon-theme-data.js";

export const THEME_ROOT = "mods/git-tools/icons/theme";
export const DEFAULT_FILE_ICON = "file";
export const DEFAULT_FOLDER_ICON = "folder";
// AtomSettingsConfig.isUseAngularIcons defaults to false; every other pack defaults to on.
export const DEFAULT_DISABLED_PACKS = ["ANGULAR"];
// Rules whose icon can't be seen where it is drawn: these files get the default icon.
// "Zeit Now Ignore": a near-black shape with no twin for a dark background.
export const DEFAULT_EXCLUDE = ["Zeit Now Ignore"];

// The relative luminance at which white and black ink have the same contrast with a
// background ((1 + 0.05) / (L + 0.05) = (L + 0.05) / (0 + 0.05)), about 0.179. The _dark
// variants are light ink, the base icons dark ink: below it the light ink shows better.
const DARK_BELOW = Math.sqrt(1.05 * 0.05) - 0.05;

// darkColor(color) → whether the _dark icon variants show better on this background:
// "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" or "rgb(a)(r, g, b…)" with a relative luminance
// (sRGB) under DARK_BELOW. null for any other form. Transparency is not read.
export function darkColor(color) {
  const s = String(color ?? "").trim().toLowerCase();
  let rgb = null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    const h = hex[1].length <= 4 ? [...hex[1].slice(0, 3)].map((c) => c + c).join("") : hex[1].slice(0, 6);
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
    if (fn) rgb = fn.slice(1, 4).map(Number);
  }
  if (!rgb || rgb.some((v) => !Number.isFinite(v))) return null;
  const lin = (v) => { const c = Math.min(255, v) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]) < DARK_BELOW;
}

const ranksAbove = (a, b) => !b || a.priority > b.priority || (a.priority === b.priority && a.order < b.order);

// --- Rule tables --------------------------------------------------------------------------------
// tools/gen-icon-theme.mjs reads each pattern once and ships hints with the rule (see
// icon-theme-data.js): the whole names and last extensions it can match, whether the extension
// alone decides, runs of characters any match holds, and its place in rank order. Here they are
// only filed into maps: reading the patterns at a mod's start is too slow in QuickJS (Herdr
// stops the call). A rule without names or exts, a hand-made one included, is tried for every
// name; its regex still decides, as for every rule.

// The rules' indexes in rank order: from their generated `rank`, or sorted when a list lacks it.
function rankOrder(rules) {
  const at = new Array(rules.length);
  for (let i = 0; i < rules.length; i++) {
    const rank = rules[i].rank;
    if (!Number.isInteger(rank) || rank < 0 || rank >= rules.length || at[rank] !== undefined) {
      return rules.map((_, i) => i).sort((a, b) => rules[b].priority - rules[a].priority || a - b);
    }
    at[rank] = i;
  }
  return at;
}

const fileUnder = (map, key, entry) => {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
};

function compile(rules, disabledPacks, exclude) {
  const byName = new Map();
  const byExt = new Map();
  const always = [];
  // Filed in rank order, so every list is in rank order too.
  for (const order of rankOrder(rules)) {
    const rule = rules[order];
    if (rule.pack && disabledPacks.has(rule.pack)) continue;
    if (exclude.has(rule.name)) continue;
    const entry = {
      icon: rule.icon, priority: rule.priority, order, pattern: rule.pattern,
      // A generated rule says whether it sees the path; a hand-made one is asked.
      onPath: "rank" in rule ? rule.path === true : rule.pattern.includes("/"),
      sure: rule.sure === true, needles: rule.needles ?? null, re: null,
    };
    if (!rule.names && !rule.exts) { always.push(entry); continue; }
    if (rule.names) for (const name of rule.names) fileUnder(byName, name, entry);
    if (rule.exts) for (const ext of rule.exts) fileUnder(byExt, ext, entry);
  }
  // merged: an extension's rules and the always-tried ones in one rank order, made the first
  // time a name with that extension is looked up.
  return { byName, byExt, always, merged: new Map() };
}

const NONE = [];

// Two lists in rank order → one, a rule in both kept once.
function merge(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || i < a.length && ranksAbove(a[i], b[j]) ? a[i++] : b[j++];
    if (out[out.length - 1] !== next) out.push(next);
  }
  return out;
}

// The rules a name with last extension `ext` (undefined: no ".") could match, besides those
// filed under its whole name, in rank order.
function candidates(tables, ext) {
  const own = ext === undefined ? undefined : tables.byExt.get(ext);
  if (!own) return tables.always;
  let list = tables.merged.get(ext);
  if (!list) tables.merged.set(ext, list = merge(own, tables.always));
  return list;
}

export function makeIconTheme({
  fileRules = FILE_RULES,
  folderRules = FOLDER_RULES,
  disabledPacks = DEFAULT_DISABLED_PACKS,
  exclude = DEFAULT_EXCLUDE,
  root = THEME_ROOT,
} = {}) {
  const packs = new Set(disabledPacks);
  const skip = new Set(exclude);
  let files = null;
  let folders = null;
  const fileMemo = new Map();
  const folderMemo = new Map();
  const dark = new Set(DARK_FILE_ICONS);
  const closedOnly = new Set(CLOSED_ONLY_FOLDER_ICONS);
  const stats = { evaluations: 0 };

  // The candidates for this name, in rank order across the two lists; the first that matches
  // is the answer. A rule filed under both the name and its extension comes up twice in a row.
  const best = (tables, name, path) => {
    stats.evaluations++;
    const dot = name.lastIndexOf(".");
    const named = tables.byName.get(name) ?? NONE;
    const rest = candidates(tables, dot >= 0 ? name.slice(dot + 1) : undefined);
    let i = 0, j = 0, last = null;
    for (;;) {
      let rule;
      if (i < named.length && (j >= rest.length || ranksAbove(named[i], rest[j]))) rule = named[i++];
      else if (j < rest.length) rule = rest[j++];
      else return undefined;
      if (rule === last) continue;
      last = rule;
      if (rule.sure) return rule.icon;
      const input = rule.onPath ? path : name;
      if (rule.needles && !rule.needles.some((needle) => input.includes(needle))) continue;
      rule.re ??= new RegExp(`^(?:${rule.pattern})$`);
      if (rule.re.test(input)) return rule.icon;
    }
  };

  // `path` is a file name or a repository-relative path ("src/app/a.ts"); patterns with "/"
  // see it with a leading "/", the way the plugin sees an absolute path's tail.
  const fileIcon = (path, { dark: onDark = false } = {}) => {
    let icon = fileMemo.get(path);
    if (icon === undefined) {
      files ??= compile(fileRules, packs, skip);
      const name = path.slice(path.lastIndexOf("/") + 1);
      icon = best(files, name, path.startsWith("/") ? path : `/${path}`) ?? DEFAULT_FILE_ICON;
      fileMemo.set(path, icon);
    }
    return `${root}/files/${onDark && dark.has(icon) ? `${icon}_dark` : icon}.svg`;
  };

  // `name` is one folder's name, not a path.
  const folderIcon = (name, { open = false } = {}) => {
    let icon = folderMemo.get(name);
    if (icon === undefined) {
      folders ??= compile(folderRules, packs, skip);
      icon = best(folders, name, `/${name}`) ?? DEFAULT_FOLDER_ICON;
      folderMemo.set(name, icon);
    }
    return open && !closedOnly.has(icon) ? `${root}/foldersOpen/${icon}.svg` : `${root}/folders/${icon}.svg`;
  };

  // Files the shipped hints into maps now, so the first row drawn only looks its name up.
  // Each rule's regex is made the first time a name needs it.
  const warm = () => {
    files ??= compile(fileRules, packs, skip);
    folders ??= compile(folderRules, packs, skip);
  };

  return { fileIcon, folderIcon, warm, stats };
}

// Shared by every screen and copy: the answer depends only on the name, so sharing the memo is safe.
const shared = makeIconTheme();
export const fileIcon = shared.fileIcon;
export const folderIcon = shared.folderIcon;
// warmIcons(): the rule tables filed once, outside render (main.js calls it as a copy starts).
export const warmIcons = shared.warm;
