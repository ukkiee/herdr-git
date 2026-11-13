// node tools/docs.test.mjs: the public docs still say what the code does, wherever a
// mismatch can be found without reading the prose. RECIPE.md copies many facts out of the
// code (export names, shared-state keys, which files the mod reads), and README.md and
// README.ko.md say the same things in two languages; a code change that misses one of
// those copies leaves the docs wrong with no test failing. Each block below names the copy
// it guards and what to update when it fails.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MOD = join(root, "mods/git-tools");
const recipe = readFileSync(join(root, "RECIPE.md"), "utf8");
const recipeLines = recipe.split("\n");
const sources = readdirSync(MOD).filter((f) => f.endsWith(".js")).sort();

// Splits `text` at any of `seps` outside `code` and outside (), {} and []: the top-level
// items of a list written in prose, such as a table cell's exports.
function splitTop(text, seps) {
  const parts = [];
  let depth = 0, code = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") { code = !code; continue; }
    if (code) continue;
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (depth === 0) {
      const sep = seps.find((s) => text.startsWith(s, i));
      if (sep) { parts.push(text.slice(start, i)); start = i + sep.length; i = start - 1; }
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// RECIPE's "Git and pure modules" table. A row's second cell lists the files' exports: an
// item that starts with a name in code (`readLog`, `chunks(paths, cost?)`) is an export; an
// item in words ("the three versions, accepting a side") names none. So:
// - every name listed is exported by one of the row's files;
// - a row whose items are all names lists every export of its files (a new export shows
//   up in the table, or the row says in words what the file holds);
// - every module with its own `*.test.mjs` has a row (the table is the list of what node
//   tests, see its heading);
// - a row stays on one line, with any `|` inside it written `\|`: a line break or a bare
//   `|` cuts the row short where the table is shown.
// A file name with a placeholder (`messages-<area>.js`) stands for every file it matches,
// and each of those is named elsewhere in RECIPE ("Words" lists the areas).
{
  const problems = [];
  const at = recipeLines.indexOf("| file | exports |");
  assert.ok(at >= 0, 'RECIPE.md has the "| file | exports |" table');
  const inTable = new Set();
  for (let n = at + 2; recipeLines[n]?.trim(); n++) {
    const line = recipeLines[n];
    const cells = line.split(/(?<!\\)\|/);
    if (!line.startsWith("| ") || !line.endsWith(" |") || cells.length !== 4) {
      problems.push(`RECIPE.md line ${n + 1}: a table row on one line with two cells (write a | inside as \\|): ${line.slice(0, 80)}`);
      continue;
    }
    const files = [];
    for (const [, name] of cells[1].matchAll(/`([^`]+)`/g)) {
      if (!name.includes("<")) { files.push(name); continue; }
      const [head, tail] = name.split(/<[^>]+>/);
      const matched = sources.filter((f) => f.startsWith(head) && f.endsWith(tail));
      if (!matched.length) problems.push(`RECIPE.md line ${n + 1}: ${name} matches no file in mods/git-tools`);
      for (const f of matched) {
        if (!recipe.includes(`\`${f}\``)) problems.push(`${f}: not named in RECIPE.md (${name} stands for it; add it where the areas are listed)`);
      }
      files.push(...matched);
    }
    const exported = new Set();
    for (const f of files) {
      inTable.add(f);
      if (!existsSync(join(MOD, f))) { problems.push(`RECIPE.md line ${n + 1}: ${f} is not in mods/git-tools`); continue; }
      for (const name of Object.keys(await import(pathToFileURL(join(MOD, f)).href))) exported.add(name);
    }
    const items = splitTop(cells[2].replace(/\\\|/g, "|"), [",", ";", " and "]);
    const names = items.map((item) => item.match(/^`([A-Za-z_$][\w$]*)(?:`|\()/)?.[1]);
    for (const name of names) {
      if (name && !exported.has(name)) problems.push(`RECIPE.md line ${n + 1}: ${name} is not exported by ${cells[1].trim()}`);
    }
    if (names.every(Boolean)) {
      for (const name of exported) {
        if (!names.includes(name)) problems.push(`RECIPE.md line ${n + 1}: ${cells[1].trim()} also exports ${name}`);
      }
    }
  }
  for (const f of sources) {
    if (existsSync(join(MOD, f.replace(/\.js$/, ".test.mjs"))) && !inTable.has(f)) {
      problems.push(`${f}: has its own test but no row in RECIPE.md's table of git and pure modules`);
    }
  }
  assert.deepEqual(problems, [], "RECIPE.md's table of git and pure modules");
}

// The source of every module, without its whole-line comments: what the code calls, not
// what a comment mentions.
const code = Object.fromEntries(sources.map((f) => [f, readFileSync(join(MOD, f), "utf8").replace(/^\s*\/\/.*$/gm, "")]));
const flat = (text) => text.replace(/\s+/g, " ").trim();

// The keys of Herdr's shared state the mod writes. RECIPE lists them twice: in "Herdr and
// UI functions used" and in what the mod writes outside its folder, there with how many
// they are. Both lists are the keys the code passes to setShared, as a string or a
// `const NAME = "…"` of the same file.
{
  const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const keys = new Set(), problems = [];
  for (const [f, text] of Object.entries(code)) {
    for (const [, arg] of text.matchAll(/\bsetShared\(\s*([^,)]+)/g)) {
      const name = arg.trim();
      const key = name.match(/^"([^"]+)"$/)?.[1] ?? text.match(new RegExp(`\\bconst ${name} = "([^"]+)"`))?.[1];
      if (key) keys.add(key);
      else problems.push(`${f}: setShared(${name}, …) with a key this test can't read; give it as a string or a const of that file`);
    }
  }
  const want = [...keys].sort();
  const used = recipe.match(/`setShared` \(keys ([^)]*)\)/);
  const written = recipe.match(/(\w+) keys of the app\s+home's `shared\.json` \(through `setShared`\):([\s\S]*?), `localStorage`/);
  assert.ok(used && written, "RECIPE.md lists the shared-state keys in both places");
  const listed = (text) => [...text.matchAll(/`(git-tools\.[^`]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(problems, [], "setShared calls");
  assert.deepEqual(listed(used[1]), want, 'RECIPE.md "Herdr and UI functions used": `setShared` (keys …)');
  assert.deepEqual(listed(written[2]), want, "RECIPE.md: the keys of the app home's shared.json the mod writes");
  assert.equal(NUMBER[written[1].toLowerCase()], want.length, `RECIPE.md says "${written[1]} keys of the app home's shared.json"`);
}

// The files the mod reads directly. RECIPE says where in two places: after `readTextFile`
// in "Herdr and UI functions used", and in what the mod reads outside the repository
// ("Besides its own files in the app home …"). READERS gives the words each module that
// imports readTextFile has in both lists; a module that starts reading files gets its words
// here and in both lists, and words in a list that no module here stands for fail too
// (what is left of a list once READERS' words are taken out is only its frame).
{
  const READERS = {
    "app-files.js": "`console.jsonl` and `settings.json`",
    "view-apply-patch.js": "Apply Patch's patch file",
    "view-compare-files.js": "a compare Diff tab's working-tree side",
    "view-conflicts.js": "the Conflicts dialog's working-tree file",
    "view-files.js": "the Files panel's preview",
  };
  const readers = Object.entries(code)
    .filter(([, text]) => [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"herdr"/g)].some((m) => /\breadTextFile\b/.test(m[1])))
    .map(([f]) => f);
  assert.deepEqual(readers, Object.keys(READERS).sort(), "the modules that import readTextFile are READERS' (add a new one with its words, here and in RECIPE.md's two lists)");

  const at = recipe.indexOf("`readTextFile` (") + "`readTextFile` (".length;
  let end = at;
  for (let depth = 1; depth > 0; end++) depth += recipe[end] === "(" ? 1 : recipe[end] === ")" ? -1 : 0;
  const lists = {
    'RECIPE.md "Herdr and UI functions used": `readTextFile` (…)': { text: flat(recipe.slice(at, end - 1)), frame: "the app home's" },
    "RECIPE.md: Besides its own files in the app home …": {
      text: flat(recipe.match(/Besides its own files in the app home ([\s\S]*?) \(`readTextFile`/)?.[1] ?? ""),
      frame: "the mod reads a file directly only for",
    },
  };
  for (const [where, { text, frame }] of Object.entries(lists)) {
    let rest = text;
    for (const [f, words] of Object.entries(READERS)) {
      assert.ok(rest.includes(words), `${where} names ${f}'s reads as "${words}"`);
      rest = rest.replace(words, " ");
    }
    assert.equal(flat(rest.replace(/[(),]|\band\b/g, " ")), frame, `${where}: words besides READERS' (a reader no module here stands for?)`);
  }
}

// README.md and README.ko.md: the same sections in the same order, and each section holds
// the same numbers (limits, sizes, versions, steps), as a set and with "1,000" read as
// 1000. A number changed in one language only fails here. Both write numbers as digits
// ("6 times", "10,000자"), since a number in words ("six", "1만") is not compared.
{
  const sections = (file) => {
    const out = [];
    let fenced = false;
    for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      if (!fenced && /^#{1,6} /.test(line)) { out.push({ title: line, numbers: new Set() }); continue; }
      for (const n of line.match(/\d+(?:[.,]\d+)*/g) ?? []) out.at(-1).numbers.add(n.replace(/,(?=\d{3}(?!\d))/g, ""));
    }
    return out;
  };
  const en = sections("README.md"), ko = sections("README.ko.md");
  assert.equal(ko.length, en.length, "README.md and README.ko.md have as many sections");
  const problems = [];
  en.forEach((section, i) => {
    const only = (a, b) => [...a.numbers].filter((n) => !b.numbers.has(n)).sort();
    const enOnly = only(section, ko[i]), koOnly = only(ko[i], section);
    if (enOnly.length || koOnly.length) problems.push(`${section.title} | ${ko[i].title}: only in README.md [${enOnly}], only in README.ko.md [${koOnly}]`);
  });
  assert.deepEqual(problems, [], "README.md and README.ko.md, section by section");
}

console.log("docs: pass");
