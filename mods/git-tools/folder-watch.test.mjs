// node folder-watch.test.mjs: a folder watch ends when the screen stops it, and holds nothing
// of the host's after that (no app, no git).
// Each pending watchFolder call and the task waiting on it are host tasks, and Herdr refuses
// any past 1024 outstanding for every mod together. A watch that only ended at its folder's
// next change stayed pending for good on a quiet repository: every visit to a folder added
// one more.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchSettled, SETTLE } from "./folder-watch.js";

const settle = () => new Promise((go) => setImmediate(go));

// herdr's watchFolder: a promise per call, resolved by change(paths) or by its cancel() (with
// []), as herdr.d.ts has it. `pending` counts the calls neither.
const fakeWatch = () => {
  const calls = new Set();
  const watchFolder = (dir) => {
    let call;
    const p = new Promise((resolve, reject) => { call = { dir, resolve, reject }; });
    calls.add(call);
    p.cancel = () => { if (calls.delete(call)) call.resolve([]); };
    return p;
  };
  const change = (paths) => { for (const c of [...calls]) { calls.delete(c); c.resolve(paths(c.dir)); } };
  const fail = () => { for (const c of [...calls]) { calls.delete(c); c.reject(new Error("can't watch")); } };
  return { watchFolder, change, fail, pending: () => calls.size, dirs: () => [...calls].map((c) => c.dir) };
};

// A screen's cx: tasks that run at once, timers the test fires. refuse(true): its timers throw,
// as at the host's limit.
const fakeCx = () => {
  const timers = [];
  let refusing = false;
  const cx = {
    spawn: (body) => { body(cx); },
    timer: { after: (ms, fn) => { if (refusing) throw new Error("cx.timer.after(ms, fn) exceeded the per-runtime outstanding host task limit of 1024"); timers.push({ ms, fn }); } },
  };
  return { cx, fire: () => { for (const t of timers.splice(0)) t.fn(cx); }, timers: () => timers.map((t) => t.ms), refuse: (on) => { refusing = on; } };
};

// Stopped, the watch lets go of its pending call at once, though the folder never changes.
{
  const w = fakeWatch(), { cx } = fakeCx();
  let live = true, wakes = 0;
  const watch = watchSettled(w.watchFolder, "/repo/.git", { live: () => live, wake: () => wakes++ }, cx);
  await settle();
  assert.equal(w.pending(), 1);
  live = false;
  watch?.stop?.();
  await settle();
  assert.equal(w.pending(), 0, "the pending watch is cancelled");
  assert.equal(wakes, 0);
}

// A panel that moves through many folders keeps one watch going, the newest folder's.
{
  const w = fakeWatch(), { cx } = fakeCx();
  let watch = null;
  for (let i = 0; i < 50; i++) {
    watch?.stop();
    watch = watchSettled(w.watchFolder, `/f${i}`, { wake: () => {} }, cx);
    await settle();
    assert.ok(w.pending() <= 1, `one watch at a time (${w.pending()} after ${i + 1} folders)`);
  }
  assert.deepEqual(w.dirs(), ["/f49"]);
}

// A change wakes the screen at once and once more SETTLE ms later; the watch goes on. A change
// wakes() turns down wakes nothing.
{
  const w = fakeWatch(), f = fakeCx();
  const woke = [];
  const watch = watchSettled(w.watchFolder, "/r", { wakes: (paths) => paths.includes("/r/HEAD"), wake: () => woke.push("wake") }, f.cx);
  await settle();
  w.change(() => ["/r/other"]);
  await settle();
  assert.deepEqual(woke, []);
  w.change(() => ["/r/HEAD"]);
  await settle();
  assert.deepEqual([woke.length, f.timers()], [1, [SETTLE]]);
  f.fire();
  assert.equal(woke.length, 2);
  assert.equal(w.pending(), 1, "still watching");
  watch.stop();
  await settle();
  assert.equal(w.pending(), 0);
}

// settle: 0 wakes once per change, with no second look.
{
  const w = fakeWatch(), f = fakeCx();
  let wakes = 0;
  watchSettled(w.watchFolder, "/r", { settle: 0, wake: () => wakes++ }, f.cx);
  await settle();
  w.change(() => ["/r/a"]);
  await settle();
  assert.deepEqual([wakes, f.timers()], [1, []]);
}

// The host refuses the second look's timer: the watch goes on (the change was read once).
{
  const w = fakeWatch(), f = fakeCx();
  let wakes = 0, failed = 0;
  watchSettled(w.watchFolder, "/r", { wake: () => wakes++, failed: () => failed++ }, f.cx);
  await settle();
  f.refuse(true);
  w.change(() => ["/r/a"]);
  await settle();
  assert.deepEqual([wakes, failed, w.pending()], [1, 0, 1]);
  f.refuse(false);
  w.change(() => ["/r/b"]);
  await settle();
  assert.deepEqual([wakes, f.timers()], [2, [SETTLE]]);
}

// A folder that can't be watched calls failed() (the screen's timer still reads); a stopped
// one doesn't.
{
  const w = fakeWatch(), { cx } = fakeCx();
  let failed = 0;
  watchSettled(w.watchFolder, "/r", { wake: () => {}, failed: () => failed++ }, cx);
  await settle();
  w.fail();
  await settle();
  assert.equal(failed, 1);
  const stopped = watchSettled(w.watchFolder, "/s", { wake: () => {}, failed: () => failed++ }, cx);
  await settle();
  stopped.stop();
  w.fail();
  await settle();
  assert.equal(failed, 1);
}

// A screen that keeps a watch stops it when it leaves the folder: its unwatch() calls stop(),
// and the code that takes a move to another folder up (the method that calls stay.moved())
// reaches unwatch() before that, itself or through a method of the file that calls it (reset,
// setRepo). watch() doesn't count: it stops a watch only to start the next one. A screen that
// doesn't follow the folder stops its watch in close(). → what is missing, one line each.
export function unstopped(lines) {
  const methods = [];
  let open = null;
  for (const l of lines) {
    // Methods as the files write them: two spaces in, ending on a line of their own.
    const head = /^  (?:async )?(\w+)\([^)]*\) \{(.*)$/.exec(l.line);
    if (!open && head) {
      open = { name: head[1], lines: [l] };
      if (/\}\s*$/.test(head[2])) { methods.push(open); open = null; }
      continue;
    }
    if (!open) continue;
    open.lines.push(l);
    if (/^  \}\s*$/.test(l.line)) { methods.push(open); open = null; }
  }
  const out = [];
  const unwatch = methods.find((m) => m.name === "unwatch");
  if (!unwatch) return ["no unwatch()"];
  if (!unwatch.lines.some((l) => /\.stop\(\)/.test(l.line))) out.push(`${unwatch.lines[0].n}: unwatch() calls no stop()`);
  const stops = new Set(["unwatch", ...methods.filter((m) => m.name !== "watch" && m.lines.some((l) => /\bthis\.unwatch\(\)/.test(l.line))).map((m) => m.name)]);
  const calls = (ls) => ls.some((l) => [...l.line.matchAll(/\bthis\.(\w+)\(/g)].some((c) => stops.has(c[1])));
  const moves = methods.filter((m) => m.lines.some((l) => /\.stay\.moved\(\)/.test(l.line)));
  for (const m of moves) {
    const at = m.lines.findIndex((l) => /\.stay\.moved\(\)/.test(l.line));
    if (!calls(m.lines.slice(0, at + 1))) out.push(`${m.lines[at].n}: ${m.name}() moves on without unwatch()`);
  }
  if (!moves.length) {
    const close = methods.find((m) => m.name === "close");
    if (!close || !calls(close.lines)) out.push("close() leaves the watch going");
  }
  return out;
}
{
  const plain = (text) => text.split("\n").map((line, i) => ({ line, n: i + 1 }));
  const screen = (move, stop) => plain(`  refresh(cx) {\n    ${move}\n    this.stay.moved();\n  }\n  reset() {\n    this.unwatch();\n  }\n  watch(cx) {\n    this.unwatch();\n  }\n  unwatch() { ${stop} }`);
  assert.deepEqual(unstopped(screen("this.unwatch();", "this.watcher?.stop();")), []);
  assert.deepEqual(unstopped(screen("this.reset();", "this.watcher?.stop();")), [], "through a method that unwatches");
  assert.deepEqual(unstopped(screen("this.watch(cx);", "this.watcher?.stop();")), ["3: refresh() moves on without unwatch()"], "watch() is no way of leaving");
  assert.deepEqual(unstopped(screen("this.unwatch();", "this.watcher = null;")), ["11: unwatch() calls no stop()"]);
  assert.deepEqual(unstopped(plain("  close() { this.closed = true; }\n  unwatch() { this.watcher?.stop(); }")), ["close() leaves the watch going"]);
  assert.deepEqual(unstopped(plain("  close() { this.closed = true; this.unwatch(); }\n  unwatch() { this.watcher?.stop(); }")), []);
}

// The screens: no file watches a folder but through this module, every watch a screen starts
// is kept, so it can be stopped, and stopped when the screen leaves the folder (unstopped).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const code = (name) => readFileSync(join(here, name), "utf8").split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !/^\s*\/\//.test(line));
  const files = readdirSync(here).filter((name) => name.endsWith(".js")).sort();
  const problems = [];
  for (const name of files) {
    let keeps = false;
    for (const { line, n } of code(name)) {
      if (/\bwatchFolder\(/.test(line) && !["folder-watch.js", "ui.js"].includes(name)) problems.push(`${name}:${n}: watchFolder( outside folder-watch.js`);
      if (!/\bwatchSettled\(/.test(line) || name === "folder-watch.js" || /export (const|function) watchSettled/.test(line)) continue;
      if (/(=|\.push\(|return)\s*watchSettled\(/.test(line)) keeps = true;
      else problems.push(`${name}:${n}: a watch nobody keeps`);
    }
    // ui.js hands herdr's watchFolder in and returns the watch to its caller.
    if (keeps && name !== "ui.js") problems.push(...unstopped(code(name)).map((p) => `${name}:${p}`));
  }
  assert.deepEqual(problems, []);
}

console.log("folder-watch: ok");
