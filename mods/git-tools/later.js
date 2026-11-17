// Work a screen puts off to a timer or a task. Pure: no herdr import (later.test.mjs).
//
// Herdr refuses a host task past 1024 outstanding for every mod together: cx.timer.after,
// cx.spawn, cx.sleep, exec and folder watches throw then (docs/herdr-mod-platform.md). What
// a screen marked for the timer or the task ("a timer will take the move up", "loading", the
// write lock) must not stay marked when the host refuses it: the mark would skip every later
// try, for as long as the copy lives.

// oneTimer() → {
//   after(cx, ms, fn) → bool  sets a timer that calls fn(cx), unless one set here still waits;
//                             true when this call set one. A refused timer sets nothing, so
//                             the next call tries again.
//   busy()                    a timer set here still waits
// }
// For what render notices and leaves to a timer (render may start nothing itself).
export function oneTimer() {
  const state = { set: false };
  return { after: (cx, ms, fn) => setOnce(state, cx, ms, fn), busy: () => state.set };
}

function setOnce(state, cx, ms, fn) {
  if (state.set) return false;
  state.set = true;
  try { cx.timer.after(ms, (cx) => { state.set = false; fn(cx); }); }
  catch { state.set = false; }
  return state.set;
}

// Switching spaces or tabs quickly passes through folders the person never stops on. A
// panel that follows the focused folder reads one only once it has stayed the same this
// long: what a move shows at once (the folder's remembered view, or its skeleton) still
// shows at once.
export const DWELL = 500;

// dwell({ now? }) → {
//   moved()            the followed folder changed now: its reads wait DWELL ms from now.
//                      A read held for the folder left is dropped: only a hold made after
//                      the move counts for late()
//   hold(cx, fn) → bool  true while the folder hasn't stayed DWELL ms: the read waits, and
//                      one timer calls fn(cx) when the time is up (fn reads again; a call
//                      while that timer waits sets no other). False once it has: read now.
//   late()             a read was held, its timer couldn't be set, and the time is up: the
//                      screen's render or poll takes it up. A timer that rang took its hold
//                      with it, whatever fn did then
// }
// Before the first move nothing is held: a panel's first look reads at once. A place with no
// folder never calls hold, so it is never late: a late() that held there would have the
// screen's render ask for a read that returns before hold, on every redraw.
export function dwell({ now = Date.now } = {}) {
  const state = { now, until: 0, held: false, set: false };
  return {
    moved: () => { state.until = state.now() + DWELL; state.held = false; },
    hold: (cx, fn) => hold(state, cx, fn),
    late: () => state.held && !state.set && state.now() >= state.until,
  };
}

function hold(state, cx, fn) {
  const left = state.until - state.now();
  if (left <= 0) { state.held = false; return false; }
  state.held = true;
  if (state.set) return true;
  state.set = true;
  try { cx.timer.after(left, (cx) => { state.set = false; state.held = false; fn(cx); }); }
  catch { state.set = false; }
  return true;
}

// What Herdr says when it refuses a task or a timer (docs/herdr-mod-platform.md).
const REFUSED = /outstanding host task limit/;

// each(...fns): calls every fn in turn, also past one whose task or timer the host refuses.
// For reads made one after another (a panel's parts, a preview beside its folder, the read
// that waited and the redraw after it): a refused one costs only itself, and the screen's
// next read or poll asks again, so its refusal is not thrown on. Any other error is, once
// every fn has run.
export function each(...fns) {
  let error = null;
  for (const fn of fns) {
    try { fn(); }
    catch (e) { if (!error && !REFUSED.test(String(e?.message ?? e))) error = e; }
  }
  if (error) throw error;
}

// spawnOrUndo(cx, undo, body): cx.spawn(body). When the host refuses the task, undo() puts
// back what was set for it (a "loading" mark, the write lock) and the refusal is thrown on,
// as cx.spawn would have, so it is still reported.
export function spawnOrUndo(cx, undo, body) {
  try { return cx.spawn(body); }
  catch (error) { undo(); throw error; }
}
