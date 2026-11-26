// node space-tab-reads.test.mjs: the screens openSpaceTab opens read in a way that survives
// being opened in place of the tab before (no app, no git). space-tabs.js opens the new tab
// and closes the old one; in the new tab's copy, the first read init starts directly gets no
// answer and its clock never rings (docs/herdr-mod-platform.md), while one started from a
// timer answers. So each such screen
// - starts no read straight from init: every `this.load(` in init sits inside a
//   `cx.timer.after(…)` call,
// - starts its first read from `cx.timer.after(0, …)`: without it the tab shows its
//   skeleton until the FIRST_LOOK read, every time,
// - reads once more after FIRST_LOOK when nothing was read yet,
// - keeps its reads' turns with readTurns, and never lets a read that is going block the
//   next one (`if (this.loading) { this.again = true; return; }`): an unanswered read
//   would keep Refresh from doing anything.
// Only the screen class is held to it (the file's default export): a file may hold other
// screens that open their own tabs (openTab).
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
const lines = (text) => text.split("\n").filter((line) => !/^\s*\/\//.test(line));

// The default-exported class's text, up to the first `}` at the start of a line.
export function screenClass(text) {
  const start = text.indexOf("\nexport default class ");
  if (start < 0) return "";
  const end = text.indexOf("\n}", start + 1);
  return text.slice(start + 1, end < 0 ? text.length : end + 2);
}

// The body of the class's init(…, cx), up to the next `  }` at the method's indent.
export function initBody(classText) {
  const m = classText.match(/\n {2}init\([^)]*\)\s*\{\n/);
  if (!m) return "";
  const from = m.index + m[0].length;
  const end = classText.indexOf("\n  }", from);
  return classText.slice(from, end < 0 ? classText.length : end);
}

// Each `cx.timer.after(…)` or `cx.timer.every(…)` call in text: where it is, its delay's
// text and the whole call, up to the `)` that closes it (parens counted, so a callback over
// several lines is whole).
export function timerCalls(text) {
  const out = [];
  const re = /\bcx\.timer\.(after|every)\(/g;
  for (let m; (m = re.exec(text));) {
    let depth = 1, i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
    out.push({ from: m.index, to: i, kind: m[1], delay: text.slice(re.lastIndex).match(/^\s*([\w.]*)/)[1], call: text.slice(m.index, i) });
    re.lastIndex = i;
  }
  return out;
}

const reads = (text) => /\bthis\.load\(/.test(text);

// What a screen class does wrong, as short reasons.
export function readProblems(classText) {
  const init = lines(initBody(classText)).join("\n");
  const timers = timerCalls(init);
  const outside = timers.reduceRight((text, t) => text.slice(0, t.from) + text.slice(t.to), init);
  const out = [];
  if (!init.trim()) out.push("no init");
  if (reads(outside)) out.push("init reads directly");
  const once = (delay) => timers.some((t) => t.kind === "after" && t.delay === delay && reads(t.call));
  if (!once("0")) out.push("no first read at timer 0");
  if (!once("FIRST_LOOK")) out.push("no FIRST_LOOK read");
  if (!/\bthis\.reads\s*=\s*readTurns\(/.test(classText) || !/\bthis\.reads\.start\(/.test(classText)) out.push("no readTurns");
  if (/if\s*\(\s*this\.loading\s*\)\s*\{\s*this\.again\s*=\s*true\s*;\s*return\s*;?\s*\}/.test(classText)) out.push("loading blocks the next read");
  return out;
}

// The checks themselves.
{
  const good = [
    "export default class A {",
    "  init(p, cx) {",
    "    this.x = 1; this.reads = readTurns();",
    "    cx.timer.after(0, (cx) => { this.load(cx); cx.notify(); });",
    "    cx.timer.after(FIRST_LOOK, (cx) => { if (this.x === null) this.load(cx); });",
    "  }",
    "  load(cx) { const turn = this.reads.start(); }",
    "}",
    "export class B {",
    "  load(cx) { if (this.loading) { this.again = true; return; } }",
    "}",
  ].join("\n");
  const text = `import x from "y";\n${good}\n`;
  assert.deepEqual(readProblems(screenClass(text)), []);
  // The same with the timers' callbacks over several lines.
  const spread = good
    .replace("cx.timer.after(0, (cx) => { this.load(cx); cx.notify(); });", "cx.timer.after(0, (cx) => {\n      this.load(cx);\n      cx.notify();\n    });")
    .replace("cx.timer.after(FIRST_LOOK, (cx) => { if (this.x === null) this.load(cx); });", "cx.timer.after(FIRST_LOOK, (cx) => {\n      if (this.x === null) this.load(cx);\n    });");
  assert.notEqual(spread, good);
  assert.deepEqual(readProblems(screenClass(`\n${spread}\n`)), []);
  // Without the timer 0 read, the first read waits for FIRST_LOOK.
  const late = good.replace("    cx.timer.after(0, (cx) => { this.load(cx); cx.notify(); });\n", "");
  assert.notEqual(late, good);
  assert.deepEqual(readProblems(screenClass(`\n${late}\n`)), ["no first read at timer 0"]);
  // A timer 0 that reads nothing does not count.
  const idle = good.replace("{ this.load(cx); cx.notify(); }", "{ cx.notify(); }");
  assert.deepEqual(readProblems(screenClass(`\n${idle}\n`)), ["no first read at timer 0"]);
  const bad = [
    "export default class A {",
    "  init(p, cx) {",
    "    // this.load(cx) in a comment is fine",
    "    this.load(cx);",
    "  }",
    "  load(cx) {",
    "    if (this.loading) { this.again = true; return; }",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(readProblems(screenClass(`\n${bad}\n`)), ["init reads directly", "no first read at timer 0", "no FIRST_LOOK read", "no readTurns", "loading blocks the next read"]);
  assert.equal(screenClass("export class A {}\n"), "");
}

// The view files that open their own screen with openSpaceTab.
const files = [...modFiles.keys()].filter((name) => name !== "space-tabs.js").sort()
  .filter((name) => /\bopenSpaceTab\(\s*\{\s*view\s*:/.test(readFileSync(modFiles.get(name), "utf8")));
// Five today; a sixth must hold to the same rules, and none may slip out unseen.
assert.ok(files.length >= 5, `space tab screens: ${files}`);

const problems = files.flatMap((name) => readProblems(screenClass(readFileSync(modFiles.get(name), "utf8"))).map((p) => `${name}: ${p}`));
assert.deepEqual(problems, []);

console.log(`space-tab-reads: ok (${files.length} screens)`);
