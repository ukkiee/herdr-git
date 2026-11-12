#!/usr/bin/env node
// Builds the git-tools Icon theme from Atom Material Icons' generator repository.
//
//   node tools/gen-icon-theme.mjs <iconGenerator folder> [mod folder]
//
// Input: the AtomMaterialUI/iconGenerator repository at commit PINNED_COMMIT, unpacked.
// The script never downloads; get the folder with either of
//   git clone https://github.com/AtomMaterialUI/iconGenerator && git -C iconGenerator archive PINNED_COMMIT | tar -x -C <folder>
//   curl -L https://codeload.github.com/AtomMaterialUI/iconGenerator/tar.gz/PINNED_COMMIT | tar -xz   (then use the folder it makes)
// The folder is checked against the pinned rule files' SHA-256, so another version is refused.
//
// Output (the mod folder defaults to mods/git-tools next to this script):
//   icons/theme/files, folders, foldersOpen   every icon of those three source folders,
//                                             with XML comments (the per-file license header) removed
//   icons/theme/LICENSE                       the source LICENSE, verbatim
//   icons/theme/NOTICE.md                     source, commit, plugin version, what was changed
//   icon-theme-data.js                        the rules, in source order, with lookup hints, plus icon facts
//
// Same input, same bytes: lists are in source order or sorted by code point, and nothing from
// the running machine (date, path, locale) is written.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_COMMIT = "90e051eecb393c6380be18a1941c3096170c15d6";
export const PLUGIN_VERSION = "Atom Material Icons 210.0.2";
const PINNED_SHA256 = {
  "icon_associations.xml": "4c22a900ff6d52a4a88c786414fa085bf96f00625883e173dd42ffdd4fc280c2",
  "folder_associations.xml": "110e3ed7a3d74cb8fab49591c14e966f775e36882f541c10949ca4f39d07c886",
};
const ICON_DIRS = ["files", "folders", "foldersOpen"];

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Only <regex> entries name files or folders; the four <type> entries match IDE file
// types (Images, SVG), which a name alone can't tell.
function readRules(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  return [...body.matchAll(/<regex\b([\s\S]*?)\/>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])])),
  );
}

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const stripComments = (svg) => svg.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s+/, "");

// --- Lookup hints: what each rule's pattern can match, read from its source ---------------------
// The mod only runs a rule's regex for names it could match, from tables these hints fill (it
// never reads a pattern itself: QuickJS is too slow at it for a mod's start). A rule whose every
// match is one of a few whole names gets `names`; one whose every match ends in "." and a few
// extensions without "." or "/" gets `exts` (that "." is then the name's last one); one of the
// form ".*\.ext$" also gets `sure` (the extension alone decides). Anything the reading doesn't
// cover (".*" before the end, a back reference, syntax it doesn't know) gets neither, and every
// name tries it. The reading may answer too much (it ignores lookarounds and anchors), never too
// little: the rule's own regex still decides. `needles`: runs of plain characters, one of which
// any match holds. `path`: the pattern holds "/" and sees the path. `rank`: the rule's place in
// rank order (higher priority first, then source order).

// ".*\.ext$" or ".*\.(a|b)$" with plain extensions: letters, digits, "_" and "-", none of which
// a regex reads as a quantifier ("c+" is one or more "c"; such a pattern takes the parser's way).
// (".*" doesn't cross a line break; the mod gives such a name the rule all the same.)
const EXTENSION_ONLY = /^\.\*\\\.(?:\(([A-Za-z0-9_\-|]+)\)|([A-Za-z0-9_\-]+))\$$/;
// Most strings one part of a pattern may stand for before the reading gives up on it.
const MAX_STRINGS = 256;
// Most characters a character class may stand for and still be listed.
const MAX_CLASS = 64;

const ANY = { kind: "any" };
const EMPTY = { kind: "empty" };
const range = (from, to) => Array.from({ length: to.charCodeAt(0) - from.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(from.charCodeAt(0) + i));
const DIGITS = range("0", "9");

// JavaScript regex source (no flags) → tree of { kind: "alt", branches: [[item]] }, items being
// { atom, min, max }. Throws on what it doesn't read; the caller then leaves the rule unread.
function parse(source) {
  let i = 0;
  const fail = () => { throw new Error(`unread pattern at ${i}`); };
  const escape = (inClass) => {
    const c = source[i++];
    if (c === undefined) fail();
    if (c === "d") return { kind: "set", chars: DIGITS };
    // \s follows the engine's Unicode tables (QuickJS runs the mod, Node reads the pattern), so
    // it stands for any character rather than a list one engine could outgrow.
    if (c === "s" || c === "w" || c === "D" || c === "S" || c === "W") return ANY;
    if (c === "b" && inClass) return { kind: "char", c: "\b" };
    if (c === "b" || c === "B") return EMPTY;
    if (/[1-9]/.test(c) || c === "k") fail();
    if (c === "x" || c === "u") {
      const hex = source.slice(i, i + (c === "x" ? 2 : 4));
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== (c === "x" ? 2 : 4)) fail();
      i += hex.length;
      return { kind: "char", c: String.fromCharCode(parseInt(hex, 16)) };
    }
    if (c === "c" || c === "p" || c === "P") fail();
    const named = { t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", 0: "\0" }[c];
    return { kind: "char", c: named ?? c };
  };
  // A class too wide to list: read to its end and stand for any character.
  const skipClass = () => {
    while (source[i] !== "]") {
      if (i >= source.length) fail();
      if (source[i] === "\\") i++;
      i++;
    }
    i++;
    return ANY;
  };
  const charClass = () => {
    if (source[i] === "^") return skipClass();
    const chars = new Set();
    while (source[i] !== "]") {
      if (i >= source.length) fail();
      let a;
      if (source[i] === "\\") { i++; a = escape(true); } else a = { kind: "char", c: source[i++] };
      if (source[i] === "-" && source[i + 1] !== "]" && a.kind === "char") {
        i++;
        let b;
        if (source[i] === "\\") { i++; b = escape(true); } else b = { kind: "char", c: source[i++] };
        if (b.kind !== "char" || b.c < a.c) fail();
        if (b.c.charCodeAt(0) - a.c.charCodeAt(0) >= MAX_CLASS) return skipClass();
        for (const c of range(a.c, b.c)) chars.add(c);
      } else if (a.kind === "char") chars.add(a.c);
      else if (a.kind === "set") for (const c of a.chars) chars.add(c);
      else return skipClass();
    }
    i++;
    return chars.size && chars.size <= MAX_CLASS ? { kind: "set", chars: [...chars] } : chars.size ? ANY : fail();
  };
  const atom = () => {
    const c = source[i++];
    if (c === "(") {
      if (source[i] === "?") {
        const head = source.slice(i, i + 3);
        if (head.startsWith("?:")) i += 2;
        else if (head.startsWith("?=") || head.startsWith("?!")) { i += 2; alt(); i++; return EMPTY; }
        else if (head === "?<=" || head === "?<!") { i += 3; alt(); i++; return EMPTY; }
        else fail();
      }
      const inner = alt();
      if (source[i++] !== ")") fail();
      return { kind: "group", alt: inner };
    }
    if (c === "[") return charClass();
    if (c === ".") return ANY;
    if (c === "^" || c === "$") return EMPTY;
    if (c === "\\") return escape(false);
    if (c === ")" || c === "|" || c === "*" || c === "+" || c === "?") fail();
    return { kind: "char", c };
  };
  const quantified = () => {
    const a = atom();
    let min = 1, max = 1;
    const q = source[i];
    if (q === "?") { min = 0; i++; }
    else if (q === "*") { min = 0; max = Infinity; i++; }
    else if (q === "+") { max = Infinity; i++; }
    else if (q === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
        i += m[0].length;
      }
    }
    if ((min !== 1 || max !== 1) && source[i] === "?") i++;
    if (a.kind === "empty") return { atom: a, min: 1, max: 1 };
    return { atom: a, min, max };
  };
  const alt = () => {
    const branches = [[]];
    while (i < source.length && source[i] !== ")") {
      if (source[i] === "|") { i++; branches.push([]); continue; }
      branches[branches.length - 1].push(quantified());
    }
    return { kind: "alt", branches };
  };
  const tree = alt();
  if (i !== source.length) fail();
  return tree;
}

// The strings a list of items stands for, or null when they are endless or too many.
function strings(items) {
  for (const item of items) if (item.max === Infinity || item.atom.kind === "any") return null;
  let out = [""];
  for (const item of items) {
    const one = atomStrings(item.atom);
    if (!one) return null;
    let reps = item.min === 0 ? [""] : [];
    let power = [""];
    for (let k = 1; k <= item.max; k++) {
      power = product(power, one);
      if (!power) return null;
      if (k >= item.min) reps = reps.concat(power);
      if (reps.length > MAX_STRINGS) return null;
    }
    out = product(out, reps);
    if (!out) return null;
  }
  return out;
}
function atomStrings(atom) {
  if (atom.kind === "char") return [atom.c];
  if (atom.kind === "set") return atom.chars;
  if (atom.kind === "empty") return [""];
  if (atom.kind === "group") {
    const out = [];
    for (const branch of atom.alt.branches) {
      const s = strings(branch);
      if (!s) return null;
      out.push(...s);
      if (out.length > MAX_STRINGS) return null;
    }
    return out;
  }
  return null;
}
function product(a, b) {
  if (a.length * b.length > MAX_STRINGS) return null;
  const out = [];
  for (const x of a) for (const y of b) out.push(x + y);
  return out;
}

// A branch with each plain group (exactly once) opened into its alternatives: one flat list of
// items per way through, or null when there would be too many.
function flatten(items) {
  let ways = [[]];
  for (const item of items) {
    if (item.atom.kind === "group" && item.min === 1 && item.max === 1) {
      const inner = [];
      for (const branch of item.atom.alt.branches) {
        const opened = flatten(branch);
        if (!opened) return null;
        inner.push(...opened);
      }
      const next = [];
      for (const way of ways) for (const tail of inner) next.push(way.concat(tail));
      if (next.length > MAX_STRINGS) return null;
      ways = next;
    } else ways = ways.map((way) => way.concat([item]));
  }
  return ways;
}

const isDot = (item) => item.min === 1 && item.max === 1 &&
  (item.atom.kind === "char" && item.atom.c === "." || item.atom.kind === "set" && item.atom.chars.length === 1 && item.atom.chars[0] === ".");

// Whole names and last extensions every way through can have, or null.
function shapeOf(ways, onPath) {
  const names = new Set(), exts = new Set();
  for (const way of ways) {
    const whole = onPath ? null : strings(way);
    if (whole) { for (const name of whole) names.add(name); continue; }
    let dot = -1;
    for (let k = way.length - 1; k >= 0; k--) if (isDot(way[k])) { dot = k; break; }
    if (dot < 0) return null;
    const tail = strings(way.slice(dot + 1));
    if (!tail || tail.some((ext) => ext.includes(".") || ext.includes("/"))) return null;
    for (const ext of tail) exts.add(ext);
  }
  return { names, exts };
}

// The longest run of plain characters on each way through, or null when a way has none.
function needlesOf(ways) {
  const out = new Set();
  for (const way of ways) {
    let longest = "", run = "";
    for (const item of way) {
      // Anchors and lookarounds take no characters: the ones around them stay side by side.
      if (item.atom.kind === "empty") continue;
      if (item.atom.kind === "char" && item.min === 1 && item.max === 1) {
        run += item.atom.c;
        if (run.length > longest.length) longest = run;
      } else run = "";
    }
    if (!longest) return null;
    out.add(longest);
  }
  return out;
}

// hintOf(pattern) → { path?, sure?, names?, exts?, needles? }, lists sorted by code point.
export function hintOf(pattern) {
  const hint = {};
  if (pattern.includes("/")) hint.path = true;
  const ext = EXTENSION_ONLY.exec(pattern);
  if (ext) {
    hint.sure = true;
    hint.exts = [...new Set((ext[1] ?? ext[2]).split("|"))].sort(byCodePoint);
    return hint;
  }
  let ways = null;
  try {
    const tree = parse(pattern);
    ways = [];
    for (const branch of tree.branches) {
      const opened = flatten(branch);
      if (!opened) { ways = null; break; }
      ways.push(...opened);
    }
  } catch {
    ways = null;
  }
  if (!ways) return hint;
  const shape = shapeOf(ways, hint.path === true);
  if (shape?.names.size) hint.names = [...shape.names].sort(byCodePoint);
  if (shape?.exts.size) hint.exts = [...shape.exts].sort(byCodePoint);
  // A rule filed only under whole names is tried only for those names: its needles would add
  // nothing but bytes.
  if (hint.names && !hint.exts) return hint;
  const needles = needlesOf(ways);
  if (needles) hint.needles = [...needles].sort(byCodePoint);
  return hint;
}

// Each rule with its hint and its place in rank order.
function withHints(rules) {
  const rank = rules.map((_, i) => i).sort((a, b) => rules[b].priority - rules[a].priority || a - b);
  const place = new Array(rules.length);
  rank.forEach((i, at) => { place[i] = at; });
  return rules.map((rule, i) => ({ ...rule, rank: place[i], ...hintOf(rule.pattern) }));
}

export function generate(src, modDir) {
  const xml = {};
  for (const name of Object.keys(PINNED_SHA256)) {
    const buf = readFileSync(join(src, name));
    if (sha256(buf) !== PINNED_SHA256[name]) {
      throw new Error(`${name} is not the pinned version (${PINNED_COMMIT}); sha256 ${sha256(buf)}`);
    }
    xml[name] = buf.toString("utf8");
  }
  const icons = {};
  for (const d of ICON_DIRS) {
    icons[d] = readdirSync(join(src, "assets/icons", d)).filter((f) => f.endsWith(".svg")).sort(byCodePoint);
  }
  const has = Object.fromEntries(ICON_DIRS.map((d) => [d, new Set(icons[d])]));

  const skipped = [];
  // The plugin full-matches each pattern with java.util.regex; ^(?:...)$ gives JavaScript the same.
  const compiles = (r) => {
    try {
      new RegExp(`^(?:${r.pattern})$`);
      return true;
    } catch (err) {
      skipped.push({ kind: r.iconType === "FOLDER" ? "folder" : "file", name: r.name, reason: `pattern: ${err.message}` });
      return false;
    }
  };
  const toRule = (r, icon) => {
    const rule = { name: r.name, pattern: r.pattern, priority: Number(r.priority), icon };
    if (r.iconPack) rule.pack = r.iconPack;
    return rule;
  };

  const fileRules = [];
  for (const r of readRules(xml["icon_associations.xml"])) {
    const file = r.icon.split("/").pop();
    if (!has.files.has(file)) {
      skipped.push({ kind: "file", name: r.name, reason: `missing icon ${r.icon}` });
      continue;
    }
    if (compiles(r)) fileRules.push(toRule(r, file.slice(0, -4)));
  }
  const folderRules = [];
  for (const r of readRules(xml["folder_associations.xml"])) {
    const file = r.icon.split("/").pop();
    if (!has.folders.has(file)) {
      skipped.push({ kind: "folder", name: r.name, reason: `missing icon ${r.icon}` });
      continue;
    }
    if (compiles(r)) folderRules.push(toRule(r, file.slice(0, -4)));
  }

  const darkFiles = icons.files
    .filter((f) => f.endsWith("_dark.svg") && has.files.has(f.replace(/_dark\.svg$/, ".svg")))
    .map((f) => f.slice(0, -"_dark.svg".length));
  const closedOnly = icons.folders.filter((f) => !has.foldersOpen.has(f)).map((f) => f.slice(0, -4));

  const theme = join(modDir, "icons/theme");
  rmSync(theme, { recursive: true, force: true });
  for (const d of ICON_DIRS) {
    mkdirSync(join(theme, d), { recursive: true });
    for (const f of icons[d]) {
      writeFileSync(join(theme, d, f), stripComments(readFileSync(join(src, "assets/icons", d, f), "utf8")));
    }
  }
  writeFileSync(join(theme, "LICENSE"), readFileSync(join(src, "LICENSE")));
  writeFileSync(join(theme, "NOTICE.md"), notice({ icons, fileRules, folderRules, skipped }));
  writeFileSync(join(modDir, "icon-theme-data.js"), dataModule({ fileRules: withHints(fileRules), folderRules: withHints(folderRules), darkFiles, closedOnly, skipped }));
  return { icons, fileRules, folderRules, darkFiles, closedOnly, skipped };
}

function notice({ icons, fileRules, folderRules, skipped }) {
  return `# Icon theme notice

The icons in \`files/\`, \`folders/\` and \`foldersOpen/\` and the rules in \`../../icon-theme-data.js\`
come from Atom Material Icons by Elior "Mallowigi" Boukhobza, MIT License (full text in \`LICENSE\`).

- Source: https://github.com/AtomMaterialUI/iconGenerator
- Commit: ${PINNED_COMMIT}
- Matches the rules and icon set of ${PLUGIN_VERSION}.
- Contents: ${icons.files.length} file icons, ${icons.folders.length} closed and ${icons.foldersOpen.length} open folder icons,
  ${fileRules.length} file rules and ${folderRules.length} folder rules.
- Changes: XML comments (the license header repeated in every SVG) are removed; nothing else in an icon is changed.
  Rules that point at an icon the source does not have are left out: ${skipped.map((s) => s.name).join(", ") || "none"}.
- Generated by \`tools/gen-icon-theme.mjs\`. Individual icons depict third-party logos and marks,
  which stay with their owners.
`;
}

function dataModule({ fileRules, folderRules, darkFiles, closedOnly, skipped }) {
  const list = (items) => `[\n${items.map((x) => `  ${JSON.stringify(x)},`).join("\n")}\n]`;
  return `// Generated by tools/gen-icon-theme.mjs from AtomMaterialUI/iconGenerator ${PINNED_COMMIT}. Do not edit.
// Rules keep the source order: equal priorities are settled by it.
// icon: a file name without ".svg" in icons/theme/files (file rules) or icons/theme/folders (folder rules).
// pack: the plugin's icon pack; packs it turns off by default are left out by icon-theme.js.
// rank: the rule's place in rank order (higher priority first, then source order).
// Lookup hints read from the pattern (see gen-icon-theme.mjs): path (the pattern sees the path),
// names (every whole name it can match), exts (every last extension it can match), sure (the
// extension alone decides), needles (one of these runs of characters is in any match). A rule
// with neither names nor exts is tried for every name.

export const SOURCE = ${JSON.stringify({ repository: "AtomMaterialUI/iconGenerator", commit: PINNED_COMMIT, plugin: PLUGIN_VERSION })};

export const FILE_RULES = ${list(fileRules)};

export const FOLDER_RULES = ${list(folderRules)};

// File icons that also have a "<icon>_dark" variant for dark backgrounds.
export const DARK_FILE_ICONS = ${JSON.stringify(darkFiles)};

// Folder icons with no open variant in icons/theme/foldersOpen.
export const CLOSED_ONLY_FOLDER_ICONS = ${JSON.stringify(closedOnly)};

// Source rules left out, with why.
export const SKIPPED_RULES = ${list(skipped)};
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src) {
    console.error("usage: node tools/gen-icon-theme.mjs <iconGenerator folder> [mod folder]");
    process.exit(2);
  }
  const modDir = out ?? join(dirname(fileURLToPath(import.meta.url)), "../mods/git-tools");
  const r = generate(resolve(src), resolve(modDir));
  console.log(
    `icons: ${ICON_DIRS.map((d) => `${d} ${r.icons[d].length}`).join(", ")}; rules: file ${r.fileRules.length}, folder ${r.folderRules.length}; skipped ${r.skipped.length}`,
  );
}
