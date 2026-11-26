// node screen-fields.test.mjs: the fields main.js sets on every screen stay its own (no app,
// no git). main.js gives each screen this.bus, this.locks, this.wait, this.t and this.lang
// before init. A screen that writes one of them breaks what main.js put there, and
// `this.wait ??= …` writes nothing at all: the clock is already there, so the screen goes on
// with a function where it meant its own value (a skeleton size, then the whole screen
// failed to draw).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Every .js of the mod by file name, from all its folders but icons/: a name is unique in the mod.
const mod = join(here, "../../..");
const modPaths = readdirSync(mod, { recursive: true }).filter((p) => p.endsWith(".js") && !p.startsWith("icons/"));
const modFiles = new Map(modPaths.map((p) => [basename(p), join(mod, p)]));
assert.ok(modFiles.size > 0 && modFiles.size === modPaths.length, `${modPaths.length} files, ${modFiles.size} names`);
const code = (text) => text.split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !/^\s*\/\//.test(line));

// The names main.js sets on a screen: every `this.screen.<name> =`.
export function screenFields(mainText) {
  return [...new Set([...mainText.matchAll(/\bthis\.screen\.(\w+)\s*=(?![=>])/g)].map((m) => m[1]))].sort();
}

// The lines of a file that assign one of those names on `this` (=, ??=, ||=, &&=).
export function fieldWrites(text, fields) {
  const write = new RegExp(`\\bthis\\.(${fields.join("|")})\\s*(?:\\?\\?=|\\|\\|=|&&=|=(?![=>]))`);
  return code(text).filter(({ line }) => write.test(line)).map(({ line, n }) => `${n}: ${line.match(write)[1]}`);
}

// The ids a file gives skeletonSize, written out as strings.
export const sizeIds = (text) => code(text).flatMap(({ line }) => [...line.matchAll(/skeletonSize\(\s*"([^"]+)"/g)].map((m) => m[1]));

// The checks themselves.
{
  assert.deepEqual(screenFields(`this.screen.bus = x;\nthis.screen.wait = (ms) => s(ms);\nif (this.screen.t === y) {}`), ["bus", "wait"]);
  const f = ["wait", "t"];
  assert.deepEqual(fieldWrites(`x = this.wait ??= { id: "a" };`, f), ["1: wait"]);
  assert.deepEqual(fieldWrites(`this.t = translator(lang);`, f), ["1: t"]);
  assert.deepEqual(fieldWrites(`await this.wait(50);\nif (this.t === u) {}\nthis.waits ??= {};\nthis.title = 1;`, f), []);
  assert.deepEqual(fieldWrites(`// not this.wait ??= here`, f), []);
  assert.deepEqual(sizeIds(`a = skeletonSize("x-wait"); b = skeletonSize( "y-wait" )\n// skeletonSize("z")`), ["x-wait", "y-wait"]);
}

const fields = screenFields(readFileSync(modFiles.get("main.js"), "utf8"));
// main.js still names the clock this way; if it is renamed, this check must follow it.
assert.ok(fields.includes("wait") && fields.includes("bus"), `main.js fields: ${fields}`);

const files = [...modFiles.keys()].filter((name) => name !== "main.js").sort();
const texts = new Map(files.map((name) => [name, readFileSync(modFiles.get(name), "utf8")]));

// No file writes a field main.js owns. Parts of a screen (log-list.js and the like) are held
// to it too: they are drawn inside a screen and may become one.
{
  const writes = files.flatMap((name) => fieldWrites(texts.get(name), fields).map((w) => `${name}:${w}`));
  assert.deepEqual(writes, []);
}

// Each list a skeleton draws keeps its own size: two lists sharing one would measure each
// other's column, and two elements of one window sharing an id mix their sizes.
{
  const seen = new Map(), twice = [];
  for (const name of files) {
    for (const id of sizeIds(texts.get(name))) {
      if (seen.has(id)) twice.push(`${id}: ${seen.get(id)}, ${name}`);
      else seen.set(id, name);
    }
  }
  assert.deepEqual(twice, []);
}

console.log("screen-fields: ok");
