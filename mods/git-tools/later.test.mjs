// node later.test.mjs: work put off to a timer or a task never stays put off for good when the
// host refuses the timer or the task (no app, no git).
// Herdr refuses a host task past 1024 outstanding for every mod together, by throwing from
// cx.timer.after, cx.spawn, cx.sleep or exec. A screen that marked "a timer will take this
// up" and then had the timer refused kept the mark, and with it skipped every later try: the
// Log panel stopped following the focused folder until the app restarted.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { oneTimer, dwell, DWELL, each, spawnOrUndo } from "./later.js";

const REFUSED = "exceeded the per-runtime outstanding host task limit of 1024";

// A cx whose timers the test fires, and whose timers and tasks throw while refusing.
const fakeCx = () => {
  const timers = [];
  let refusing = false;
  const cx = {
    timer: { after: (ms, fn) => { if (refusing) throw new Error(`cx.timer.after(ms, fn) ${REFUSED}`); timers.push({ ms, fn }); } },
    spawn: (body) => { if (refusing) throw new Error(`cx.spawn(fn) ${REFUSED}`); body(cx); },
  };
  return { cx, fire: () => { for (const t of timers.splice(0)) t.fn(cx); }, timers: () => timers.map((t) => t.ms), refuse: (on) => { refusing = on; } };
};

// oneTimer: one timer at a time; a refused one leaves nothing set, so the next call tries again.
{
  const f = fakeCx(), one = oneTimer();
  let ran = 0;
  assert.equal(one.after(f.cx, 0, () => ran++), true);
  assert.equal(one.after(f.cx, 0, () => ran++), false, "one at a time");
  assert.equal(one.busy(), true);
  f.fire();
  assert.deepEqual([ran, one.busy()], [1, false]);
  f.refuse(true);
  assert.equal(one.after(f.cx, 0, () => ran++), false);
  assert.equal(one.busy(), false, "a refused timer leaves nothing set");
  f.refuse(false);
  assert.equal(one.after(f.cx, 0, () => ran++), true, "and the next call sets one");
  f.fire();
  assert.equal(ran, 2);
}

// dwell: the first look reads at once. After a move, reads wait until the folder has been the
// same DWELL ms: one timer then, the time still left, however often a read is asked meanwhile.
{
  let now = 1000;
  const f = fakeCx(), d = dwell({ now: () => now });
  assert.equal(DWELL, 500);
  assert.equal(d.hold(f.cx, () => {}), false, "nothing moved yet: read now");
  d.moved();
  const asked = [];
  assert.equal(d.hold(f.cx, () => asked.push(now)), true);
  now += 200;
  assert.equal(d.hold(f.cx, () => asked.push(now)), true);
  assert.deepEqual(f.timers(), [DWELL], "one timer");
  // Moved again before it rang: the timer finds time still left and the read waits on.
  now += 200;
  d.moved();
  now += 100;
  f.fire();
  assert.deepEqual(asked, [1500]);
  assert.equal(d.hold(f.cx, () => asked.push(now)), true);
  assert.deepEqual(f.timers(), [400]);
  now += 400;
  f.fire();
  assert.equal(d.hold(f.cx, () => {}), false, "stayed DWELL ms: read now");
  assert.equal(d.late(), false);
}

// dwell, with the timer refused: late() says so once the time is up, so the screen's render
// or poll takes the held read up instead.
{
  let now = 0;
  const f = fakeCx(), d = dwell({ now: () => now });
  d.moved();
  f.refuse(true);
  assert.equal(d.hold(f.cx, () => {}), true);
  assert.equal(d.late(), false);
  now += DWELL;
  assert.equal(d.late(), true);
  f.refuse(false);
  assert.equal(d.hold(f.cx, () => {}), false);
  assert.equal(d.late(), false);
}

// dwell, moved on before the held read's timer rang, to a place with no folder: nothing
// there calls hold, so the hold of the folder left must go with the move. Kept, it would make
// late() hold for good, and a screen that takes late() up in render would draw, set a timer
// and draw again for as long as it stays there.
{
  let now = 0;
  const f = fakeCx(), d = dwell({ now: () => now });
  d.moved();
  assert.equal(d.hold(f.cx, () => {}), true);
  now += 100;
  d.moved();
  now += 400;
  f.fire(); // its read finds no folder and returns before hold
  now += DWELL;
  assert.equal(d.late(), false, "a move drops the hold of the folder left");
}

// dwell, the same with no move: the timer rang and its read returned before hold (no folder
// there, or a write under way). The timer was set, so nothing is late.
{
  let now = 0;
  const f = fakeCx(), d = dwell({ now: () => now });
  d.moved();
  assert.equal(d.hold(f.cx, () => {}), true);
  now += DWELL;
  f.fire();
  now += DWELL;
  assert.equal(d.late(), false, "a timer that rang leaves nothing late");
}

// dwell, a refused timer, then a move to a place with no folder: late() is about the folder
// held, and that one was left.
{
  let now = 0;
  const f = fakeCx(), d = dwell({ now: () => now });
  d.moved();
  f.refuse(true);
  assert.equal(d.hold(f.cx, () => {}), true);
  f.refuse(false);
  now += 100;
  d.moved();
  now += DWELL;
  assert.equal(d.late(), false, "a move drops a hold whose timer was refused");
}

// each: a refused task or timer costs only its own call; the calls after it still run, and the
// refusal goes no further. Any other error is thrown, once every call has run.
{
  const f = fakeCx();
  const ran = [];
  f.refuse(true);
  each(() => f.cx.spawn(() => ran.push("a")), () => { ran.push("b"); f.cx.timer.after(0, () => {}); }, () => ran.push("c"));
  assert.deepEqual(ran, ["b", "c"]);
  f.refuse(false);
  const bug = new TypeError("x is not a function");
  assert.throws(() => each(() => { throw bug; }, () => ran.push("d")), (e) => e === bug);
  assert.deepEqual(ran, ["b", "c", "d"], "the calls after a bug still run");
}

// spawnOrUndo: a refused task puts back what was set for it and is thrown on; a task that
// starts runs, and nothing is put back.
{
  const f = fakeCx();
  let undone = 0, ran = 0;
  spawnOrUndo(f.cx, () => undone++, () => { ran++; });
  assert.deepEqual([ran, undone], [1, 0]);
  f.refuse(true);
  assert.throws(() => spawnOrUndo(f.cx, () => undone++, () => { ran++; }), /host task limit/);
  assert.deepEqual([ran, undone], [1, 1]);
}

// The screens: a mark set for a timer or a task, or a write lock taken for one, is never
// followed by a bare cx.timer.after / cx.spawn that would leave it set when refused.
const here = dirname(fileURLToPath(import.meta.url));
const code = (name) => readFileSync(join(here, name), "utf8").split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !/^\s*\/\//.test(line));
export function leftSet(lines) {
  const out = [];
  lines.forEach(({ line, n }, i) => {
    // A mark on a line that returns right after is not followed by the call.
    const mark = /\b(this|host|panel|screen)\.\w+\s*=\s*true\b|\bscheduled\s*=\s*true\b|\.add\(/.test(line) && !/=\s*true\b[^;]*;.*\breturn\b/.test(line);
    const lock = /setBusy\((?!null)/.test(line) && !/setBusy\(work, cx, repo = /.test(line);
    if (!mark && !lock) return;
    const next = lines.slice(i + 1, i + (lock ? 7 : 3));
    const bare = next.find((l) => /^\s*cx\.(spawn|timer\.after)\(/.test(l.line));
    if (bare) out.push(`${n} → ${bare.n}: ${line.trim().slice(0, 60)}`);
  });
  return out;
}
{
  const plain = (text) => text.split("\n").map((line, i) => ({ line, n: i + 1 }));
  assert.deepEqual(leftSet(plain("    this.catching = true;\n    cx.timer.after(0, (cx) => {});")), ["1 → 2: this.catching = true;"]);
  assert.deepEqual(leftSet(plain("  panel.settling = true;\n  cx.spawn(async (cx) => {});")), ["1 → 2: panel.settling = true;"]);
  assert.deepEqual(leftSet(plain("    if (!host.setBusy(work, cx, repo)) return;\n    this.running = 1;\n    cx.spawn(async (cx) => {});")), ["1 → 3: if (!host.setBusy(work, cx, repo)) return;"]);
  assert.deepEqual(leftSet(plain("    this.catching = one.after(cx, 0, () => {});\n    cx.notify();")), []);
  assert.deepEqual(leftSet(plain("    this.loading = true;\n    spawnOrUndo(cx, () => { this.loading = false; }, async (cx) => {});")), []);
  assert.deepEqual(leftSet(plain("    if (this.loading) { this.again = true; return; }\n    cx.spawn(async (cx) => {});")), []);
}
// Marks that wait for nothing: set for the next render to act on, not for the task after it.
// There a refused task leaves only its read undone, and the screen asks again: the Branch
// tree's `stale` (rows to lay out again), whose read the Log panel's poll makes again once
// it has stayed unread STUCK ms (view-log.js unread).
const NOT_WAITS = [/^log-branches\.js:\d+ → \d+: if \(key !== this\.key\) \{ this\.key = key;/];
{
  const files = readdirSync(here).filter((name) => name.endsWith(".js")).sort();
  const problems = files.flatMap((name) => leftSet(code(name)).map((p) => `${name}:${p}`)).filter((p) => !NOT_WAITS.some((re) => re.test(p)));
  assert.deepEqual(problems, []);
}

// main.js: a screen's event, command or request that throws ends neither loop of the copy:
// one refused task must not leave the copy deaf to every later event (requests unanswered,
// "changed" never read).
{
  const main = code("main.js");
  const calls = main.filter(({ line }) => /this\.screen\.(command|serve|event)\?\.\(/.test(line));
  assert.equal(calls.length, 3);
  for (const { line, n } of calls) {
    const before = main.filter((l) => l.n < n && l.n >= n - 3).map((l) => l.line).join("\n");
    assert.match(before + line, /try \{/, `main.js:${n} is not inside a try`);
  }
}

console.log("later: ok");
