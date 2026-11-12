// node bus.test.mjs: the value screens leave for each other, and what a screen that last
// looked at some point still has to handle (no app, no git).
import assert from "node:assert/strict";
import { KEEP, append, era, take, latest, makeCopy, post } from "./bus.js";

const changed = (root) => ({ type: "changed", root });

// The first event ever: a screen that has seen nothing gets it, once.
{
  const value = append(undefined, changed("/repo/a"));
  const first = take(value, 0);
  assert.deepEqual(first.events, [{ type: "changed", root: "/repo/a" }]);
  assert.equal(first.missed, false);
  assert.deepEqual(take(value, first.seen).events, []);
}

// Only the last few events are kept. A screen that was away for more than that gets
// what is left, in order, and is told it missed some.
{
  let value;
  for (const n of [1, 2, 3, 4, 5]) value = append(value, changed(`/repo/${n}`), 3);
  assert.equal(value.events.length, 3);
  const late = take(value, 0);
  assert.deepEqual(late.events.map((e) => e.root), ["/repo/3", "/repo/4", "/repo/5"]);
  assert.equal(late.missed, true);
  // One that looked after the third event missed nothing.
  const close = take(value, 3);
  assert.deepEqual(close.events.map((e) => e.root), ["/repo/4", "/repo/5"]);
  assert.equal(close.missed, false);
  assert.deepEqual(take(value, close.seen), { events: [], seen: 5, missed: false });
}

// A screen that opens now starts at the newest number: what was posted before it opened
// (also in an earlier run of the app: the value is saved) is not its business.
{
  let value;
  for (const n of [1, 2]) value = append(value, changed(`/repo/${n}`));
  const start = latest(value);
  assert.deepEqual(take(value, start).events, []);
  value = append(value, { type: "menu", key: "m1", value: "checkout" });
  assert.deepEqual(take(value, start), { events: [{ type: "menu", key: "m1", value: "checkout" }], seen: 3, missed: false });
}

// The numbers started over (the shared state was cleared or replaced): a screen that
// remembers a higher number takes what is there and is told it missed some.
{
  const value = append(append(undefined, changed("/repo/a")), changed("/repo/b"));
  const r = take(value, 40);
  assert.deepEqual(r.events.map((e) => e.root), ["/repo/a", "/repo/b"]);
  assert.equal(r.seen, 2);
  assert.equal(r.missed, true);
  // Started over and back at the same number, or past it: told apart by the era.
  const old = era(value);
  const again = append(append(undefined, changed("/repo/c")), changed("/repo/d"));
  assert.notEqual(era(again), old);
  for (const [v, roots] of [[again, ["/repo/c", "/repo/d"]], [append(again, changed("/repo/e")), ["/repo/c", "/repo/d", "/repo/e"]]]) {
    const s = take(v, 2, old);
    assert.deepEqual(s.events.map((e) => e.root), roots);
    assert.equal(s.missed, true);
  }
  assert.deepEqual(take(again, 2, era(again)), { events: [], seen: 2, missed: false });
}

// The value is whatever the shared state holds: nothing yet, or damaged by hand.
{
  for (const junk of [undefined, null, "text", 7, [], {}, { seq: "x", events: "y" }, { seq: 3, events: [null, 5, { type: "changed" }] }]) {
    const start = latest(junk);
    assert.equal(Number.isFinite(start), true);
    assert.deepEqual(take(junk, start), { events: [], seen: start, missed: false });
    const next = append(junk, changed("/repo/a"));
    assert.deepEqual(take(next, start), { events: [{ type: "changed", root: "/repo/a" }], seen: start + 1, missed: false });
  }
  // The number moved on but its events are not there: missed.
  assert.deepEqual(take({ seq: 3, events: [null, 5, { type: "changed" }] }, 0), { events: [], seen: 3, missed: true });
}

// ---- copies of the mod on one shared value

// One shared-state slot, as Herdr keeps it, and a copy's timers, run by hand. Every copy
// made here uses the same imported module, as copies do in Herdr.
const sharedSlot = () => {
  let value;
  return { read: () => value, write: (v) => { value = v; } };
};
const fakeCx = () => {
  const due = [];
  return {
    timer: { after: (_ms, fn) => { due.push(fn); } },
    // Runs this copy's timers, then lets the promises they settled run.
    async run() { while (due.length) due.shift()(this); await new Promise((r) => setImmediate(r)); },
  };
};
const settled = async (promise) => {
  let state = "pending";
  promise.then((v) => { state = { value: v }; });
  await new Promise((r) => setImmediate(r));
  return state;
};

// Two copies each get every event once, and one copy closing stops only that copy.
{
  const slot = sharedSlot();
  const panel = makeCopy(slot), log = makeCopy(slot);
  const panelCx = fakeCx(), logCx = fakeCx();
  const panelNext = panel.next(), logNext = log.next();

  post(slot, changed("/repo/a"));
  panel.pump(panelCx); log.pump(logCx);
  await panelCx.run(); await logCx.run();
  assert.deepEqual(await settled(panelNext), { value: { type: "changed", root: "/repo/a" } });
  assert.deepEqual(await settled(logNext), { value: { type: "changed", root: "/repo/a" } });

  // Nothing new: nothing more for either.
  const panelAgain = panel.next();
  panel.pump(panelCx); await panelCx.run();
  assert.equal(await settled(panelAgain), "pending");

  // The log copy closes while waiting: its wait ends with null...
  const logWaiting = log.next();
  log.stop();
  assert.deepEqual(await settled(logWaiting), { value: null });
  assert.deepEqual(await settled(log.next()), { value: null });

  // ...and the panel still gets what comes after.
  post(slot, changed("/repo/b"));
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(panelAgain), { value: { type: "changed", root: "/repo/b" } });
}

// A menu's answer settles once, in the copy that opened the menu, and only there: the
// pick then starts as the opener's own work.
{
  const slot = sharedSlot();
  const panel = makeCopy(slot), log = makeCopy(slot), popup = makeCopy(slot);
  const panelCx = fakeCx(), logCx = fakeCx();
  const logNext = log.next();
  const picked = panel.wait("m1");

  popup.answer("m1", "group");
  popup.answer("m1", null); // the popup closing after the pick: too late, ignored
  assert.deepEqual(slot.read().events.map((e) => [e.key, e.value]), [["m1", "group"]]);

  // Another copy takes the new events first: the opener's answer is not its to settle.
  log.pump(logCx); await logCx.run();
  assert.equal(await settled(picked), "pending");
  assert.equal(await settled(logNext), "pending");

  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(picked), { value: "group" });

  // A second menu from the same opener gets its own answer, not the ignored one.
  const again = panel.wait("m2");
  popup.answer("m2", null);
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(again), { value: null });
}

// A menu's answer pushed out by more than KEEP events before the opener took it: the
// wait still ends, as a closed menu (null), in the opener's timer, and the opener is told
// to read everything again.
{
  const slot = sharedSlot();
  const panel = makeCopy(slot), popup = makeCopy(slot);
  const panelCx = fakeCx();
  const picked = panel.wait("m1");
  const next = panel.next();
  popup.answer("m1", "checkout");
  for (let n = 0; n < KEEP; n++) post(slot, changed(`/repo/${n}`));

  assert.equal(await settled(picked), "pending");
  panel.pump(panelCx);
  assert.equal(await settled(picked), "pending", "only in the timer");
  await panelCx.run();
  assert.deepEqual(await settled(picked), { value: null });
  assert.deepEqual(await settled(next), { value: { type: "changed" } });
}

// ---- a dialog asking the panel copy that opened it to run a git write

const clock = () => {
  let t = 1_000_000;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  return now;
};

// Every copy has its own id, and a request goes to one copy only: the panel that opened
// the dialog takes it (and says so at once); another copy never sees it.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeCopy(slot, { now }), other = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  assert.notEqual(panel.id, other.id);
  assert.equal(typeof panel.id, "string");
  const panelCx = fakeCx(), otherCx = fakeCx(), dialogCx = fakeCx();
  const panelNext = panel.next(), otherNext = other.next();

  const { key, reply } = dialog.request(panel.id, "push", { root: "/repo/a", force: false }, 3000);
  assert.equal(dialog.acked(key), false);

  other.pump(otherCx); await otherCx.run();
  assert.equal(await settled(otherNext), "pending", "not addressed to it");
  assert.equal(dialog.acked(key), false, "taken by nobody yet");

  now.add(2999);
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(panelNext), { value: { type: "request", key, action: "push", args: { root: "/repo/a", force: false } } });
  // The panel's mark is in the shared value at once: the dialog can tell without pumping.
  assert.equal(dialog.acked(key), true);

  // The answer settles in the dialog's own pump, and only there.
  panel.answer(key, { ok: true });
  other.pump(otherCx); await otherCx.run();
  assert.equal(await settled(reply), "pending");
  assert.equal(await settled(other.next()), "pending", "the mark and the answer are nobody else's events");
  dialog.pump(dialogCx); await dialogCx.run();
  assert.deepEqual(await settled(reply), { value: { ok: true } });
  assert.equal(dialog.acked(key), true);
}

// The dialog went (Esc) while the panel ran the write: the panel's answer is still left
// without an error, and the next events still reach the panel.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  const panelCx = fakeCx();
  const first = panel.next();
  const { key } = dialog.request(panel.id, "branch-create", { name: "x" }, 3000);
  panel.pump(panelCx); await panelCx.run();
  assert.equal((await settled(first)).value.key, key);
  dialog.stop();
  assert.doesNotThrow(() => panel.answer(key, { ok: false, err: "fatal: a branch named 'x' already exists" }));
  const next = panel.next();
  post(slot, changed("/repo/a"));
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(next), { value: changed("/repo/a") });
}

// Nobody took the request in time (the panel is gone, or was not drawn): the dialog
// can tell, gives up, and its wait ends. A panel that comes to it late doesn't run it, so
// "not started" stays true and pressing again can't run it twice.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  const panelCx = fakeCx(), dialogCx = fakeCx();
  const panelNext = panel.next();
  const { key, reply } = dialog.request(panel.id, "rollback", { files: [] }, 3000);
  now.add(3001);
  assert.equal(dialog.acked(key), false);
  dialog.drop(key);
  assert.deepEqual(await settled(reply), { value: null });
  panel.pump(panelCx); await panelCx.run();
  assert.equal(await settled(panelNext), "pending", "too late: not run");
  assert.equal(dialog.acked(key), false);
  // A late answer for a dropped request is ignored by the dialog.
  panel.answer(key, { ok: true });
  dialog.pump(dialogCx); await dialogCx.run();
  // A request to a copy that doesn't exist is never marked.
  const lost = dialog.request("no-such-copy", "push", {}, 3000);
  panel.pump(panelCx); await panelCx.run();
  assert.equal(dialog.acked(lost.key), false);
}

// The answer was pushed out by more than KEEP events before the dialog took it: its wait
// still ends (null: the result didn't arrive), as a menu's does.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  const panelCx = fakeCx(), dialogCx = fakeCx();
  const { key, reply } = dialog.request(panel.id, "push", {}, 3000);
  panel.pump(panelCx); await panelCx.run();
  panel.answer(key, { ok: true });
  for (let n = 0; n < KEEP; n++) post(slot, changed(`/repo/${n}`));
  dialog.pump(dialogCx); await dialogCx.run();
  assert.deepEqual(await settled(reply), { value: null });
}

// Events pushed out before a menu was opened or a request was made can't hold their
// answers: the copy is told to read everything again, but the new waits stay open and
// end with the real answers.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeCopy(slot, { now }), popup = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  const panelCx = fakeCx(), dialogCx = fakeCx();
  for (let n = 0; n <= KEEP; n++) post(slot, changed(`/repo/${n}`));
  const picked = panel.wait("m1");
  const next = panel.next();
  const { key, reply } = dialog.request(panel.id, "push", {}, 3000);
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(next), { value: { type: "changed" } }, "the missed events still say: read again");
  assert.equal(await settled(picked), "pending");
  popup.answer("m1", "checkout");
  panel.answer(key, { ok: true });
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(picked), { value: "checkout" });
  // The dialog never looked either: it missed the early events, not its answer.
  dialog.pump(dialogCx); await dialogCx.run();
  assert.deepEqual(await settled(reply), { value: { ok: true } });
}

// The numbers started over (the shared state was cleared): a wait that began before can't
// tell what it lost and ends as closed (null), but a menu opened and a request made after
// it lost nothing and end with the real answers.
{
  const slot = sharedSlot(), now = clock();
  for (let n = 0; n < 20; n++) post(slot, changed(`/repo/${n}`));
  const panel = makeCopy(slot, { now }), popup = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  const panelCx = fakeCx(), dialogCx = fakeCx();
  const before = panel.wait("m-before");
  slot.write(undefined);
  const picked = panel.wait("m-after");
  const { key, reply } = dialog.request(panel.id, "push", {}, 3000);
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(before), { value: null });
  assert.equal(await settled(picked), "pending");
  assert.equal(dialog.acked(key), true);
  popup.answer("m-after", "checkout");
  panel.answer(key, { ok: true });
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(picked), { value: "checkout" });
  dialog.pump(dialogCx); await dialogCx.run();
  assert.deepEqual(await settled(reply), { value: { ok: true } });
}

// The numbers start over and reach, or pass, the number the panel had seen before it
// looked again: the restart still shows. The wait from before ends as closed, the one
// made after ends with its real answer, and later events still arrive.
for (const [before, after] of [[1, 0], [2, 1], [1, 1], [1, 3], [2, 0]]) {
  const label = `${before} events, cleared, ${after} more before the answer`;
  const slot = sharedSlot(), now = clock();
  for (let n = 0; n < before; n++) post(slot, changed(`/repo/${n}`));
  const panel = makeCopy(slot, { now }), popup = makeCopy(slot, { now });
  const panelCx = fakeCx();
  const old = panel.wait("m-before");
  slot.write(undefined);
  const picked = panel.wait("m-after");
  for (let n = 0; n < after; n++) post(slot, changed(`/repo/after-${n}`));
  popup.answer("m-after", "checkout");
  panel.pump(panelCx); await panelCx.run();
  assert.deepEqual(await settled(old), { value: null }, label);
  assert.deepEqual(await settled(picked), { value: "checkout" }, label);
  const events = [];
  let next = panel.next();
  const collect = async () => { for (let s; (s = await settled(next)) !== "pending"; next = panel.next()) events.push(s.value); };
  await collect();
  post(slot, changed("/repo/late"));
  panel.pump(panelCx); await panelCx.run();
  await collect();
  assert.equal(events.at(-1)?.root, "/repo/late", label);
}

// The panel closes while it runs a request it took: its last act leaves an answer for
// that request (whatever it is given, here "the result is unknown"), so the dialog's
// wait ends. A request it already answered keeps its answer.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeCopy(slot, { now }), dialog = makeCopy(slot, { now });
  const panelCx = fakeCx(), dialogCx = fakeCx();
  const done = dialog.request(panel.id, "branch-create", { name: "x" }, 3000);
  const running = dialog.request(panel.id, "push", {}, 3000);
  panel.pump(panelCx); await panelCx.run();
  assert.equal(dialog.acked(running.key), true);
  panel.answer(done.key, { ok: true });
  panel.stop({ ok: false, unknown: true });
  dialog.pump(dialogCx); await dialogCx.run();
  assert.deepEqual(await settled(done.reply), { value: { ok: true } });
  assert.deepEqual(await settled(running.reply), { value: { ok: false, unknown: true } });
  // Stopping without a value, or a second time, answers nothing more.
  const later = dialog.request(panel.id, "push", {}, 3000);
  panel.stop({ ok: false, unknown: true });
  dialog.pump(dialogCx); await dialogCx.run();
  assert.equal(await settled(later.reply), "pending", "a stopped copy never took it");
}

console.log("ok");
