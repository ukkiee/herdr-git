// node clock.test.mjs: the clock a copy hands its git runners (main.js, git.js `wait`) holds
// at most one host timer however many calls are going, and none once they have answered
// (no app, no git).
// Herdr refuses a host task past 1024 outstanding for every mod together (cx.sleep,
// cx.timer.after, exec, cx.spawn and folder watches alike). A runner that kept one timer per
// call until its deadline (35 s for a read) held one of those for every git call of the last
// 35 s: switching spaces quickly reached the limit.
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { makeClock } from "./clock.js";

const settle = () => new Promise((go) => setImmediate(go));

// The host's one-shot timers on a time the test moves: `outstanding` counts the timers set and
// neither fired nor cancelled, as Herdr counts them. refuse(true): it throws, as at its limit.
const fakeHost = () => {
  let now = 0, refusing = false;
  const timers = new Set();
  const after = (ms, fire) => {
    if (refusing) throw new Error("cx.timer.after(ms, fn) exceeded the per-runtime outstanding host task limit of 1024");
    const t = { at: now + ms, fire };
    timers.add(t);
    return { cancel: () => { timers.delete(t); } };
  };
  // Time moves on to `ms` from now, firing what falls due on the way at its own time (a
  // timer set by what fired fires too, if it falls due before the end).
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      await settle();
      const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = Math.max(now, next.at);
      timers.delete(next);
      next.fire();
    }
    now = end;
    await settle();
  };
  return { now: () => now, after, advance, outstanding: () => timers.size, refuse: (on) => { refusing = on; } };
};

// The copy's clock as main.js makes it, on the fake host.
const copyClock = (host) => makeClock(host.after, host.now);

// git that answers at once, and git whose answer never comes for args ending in "lost".
const exec = (cmd, args) => (args.at(-1) === "lost" ? new Promise(() => {}) : Promise.resolve({ code: 0, stdout: args.at(-1), stderr: "" }));

// Many calls that answer at once: at most one timer while they go, none after.
{
  const host = fakeHost(), clock = copyClock(host);
  const git = makeGit(exec, null, { wait: clock.wait });
  let most = 0;
  for (let i = 0; i < 100; i++) {
    const r = await git.read("/r", ["x", `n${i}`]);
    assert.equal(r.out, `n${i}`);
    most = Math.max(most, host.outstanding());
  }
  const many = Array.from({ length: 30 }, (_, i) => git.read("/r", ["x", `p${i}`]));
  most = Math.max(most, host.outstanding());
  await Promise.all(many);
  // Runners made one per folder or per read share the copy's one clock.
  for (let i = 0; i < 20; i++) await makeGit(exec, null, { wait: clock.wait })("/r", ["commit", "-m", "x"]);
  assert.ok(most <= 1, `at most one timer while calls went (${most})`);
  assert.equal(host.outstanding(), 0, "no timer once every call answered");
}

// A read whose answer never comes still gives up: asked once more after 35 s, a failure after
// 35 s more. Calls that answer meanwhile change nothing, and one timer serves them all.
{
  const host = fakeHost(), clock = copyClock(host);
  const git = makeGit(exec, null, { wait: clock.wait });
  let r = null;
  git.read("/r", ["x", "lost"]).then((v) => { r = v; });
  await settle();
  for (let i = 0; i < 5; i++) assert.equal((await git.read("/r", ["x", `q${i}`])).out, `q${i}`);
  assert.equal(host.outstanding(), 1);
  await host.advance(34999);
  assert.equal(r, null);
  await host.advance(1);
  assert.equal(r, null, "asked once more");
  assert.equal(host.outstanding(), 1);
  await host.advance(35000);
  assert.deepEqual([r?.ok, r?.code], [false, -1]);
  assert.match(r.err, /did not answer in 35 s/);
  assert.equal(host.outstanding(), 0);
}

// A sooner deadline than the one the timer is set for: a read lost behind a write's 605 s
// gives up at its own 35 s, still with one timer at a time.
{
  const host = fakeHost(), clock = copyClock(host);
  const git = makeGit(exec, null, { wait: clock.wait });
  let write = null, read = null;
  git("/r", ["commit", "-m", "lost"]).then((v) => { write = v; });
  await host.advance(1000);
  git.read("/r", ["x", "lost"]).then((v) => { read = v; });
  await settle();
  assert.equal(host.outstanding(), 1);
  await host.advance(70000);
  assert.match(read?.err ?? "", /did not answer in 35 s/);
  assert.equal(write, null);
  assert.equal(host.outstanding(), 1);
  await host.advance(535000);
  assert.match(write?.err ?? "", /did not answer in 605 s/);
  assert.equal(host.outstanding(), 0);
}

// The host refuses the timer (at its limit, or the copy closed): the call waits for git as
// without a clock, and the clock sets nothing it would have to undo.
{
  const host = fakeHost(), clock = copyClock(host);
  const git = makeGit(exec, null, { wait: clock.wait });
  host.refuse(true);
  assert.equal((await git.read("/r", ["x", "anyway"])).out, "anyway");
  host.refuse(false);
  assert.equal((await git.read("/r", ["x", "again"])).out, "again");
  assert.equal(host.outstanding(), 0);
}

// The copy closes: what its clock still waits for is dropped, and its timer goes.
{
  const host = fakeHost(), clock = copyClock(host);
  const git = makeGit(exec, null, { wait: clock.wait });
  git.read("/r", ["x", "lost"]);
  await settle();
  assert.equal(host.outstanding(), 1);
  clock.close();
  assert.equal(host.outstanding(), 0);
}

console.log("clock: ok");
