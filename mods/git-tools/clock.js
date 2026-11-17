// The clock a copy hands its git runners (main.js; git.js `wait`). Pure: takes the host's
// timer as an argument, so node tests it (clock.test.mjs).
//
// Every timer that waits is one of the host tasks Herdr counts, and it refuses any past 1024
// outstanding for every mod together. A runner gives up on a call LATE ms past its timeout
// (35 s for a read), and most calls answer in milliseconds: one timer per call would hold one
// task per git call of the last 35 s, which switching spaces quickly took to the limit. So
// one copy's calls share one timer, set for the soonest deadline, cancelled once no call
// waits. A timer, not cx.sleep: a sleep can't be cancelled and holds its task until it ends.

// makeClock(arm, now?) → {
//   wait(ms, ring) → stop   ring() once, about ms from now, unless stop() came first. Throws
//                           when the host refuses the timer and none is set: the call then
//                           waits without a clock.
//   close()                 the copy closes: every deadline and the timer go
// }
// arm(ms, fire) → { cancel() }: the host's one-shot timer (cx.timer.after); it may throw.
// The clock holds `ring` only until stop(): a runner's ring resolves the call's promise, and
// what a held ring reaches stays in memory (a big repository's ref list is megabytes).
export function makeClock(arm, now = Date.now) {
  const state = { arm, now, due: new Set(), timer: null };
  return { wait: (ms, ring) => wait(state, ms, ring), close: () => close(state) };
}

function wait(state, ms, ring) {
  const call = { at: state.now() + ms, ring };
  state.due.add(call);
  try { aim(state); }
  catch (error) {
    // A timer already set rings later than this deadline, but it does ring: the call keeps
    // that one. With none set, the call waits without a clock.
    if (!state.timer) { state.due.delete(call); throw error; }
  }
  return () => drop(state, call);
}

function drop(state, call) {
  if (!state.due.delete(call) || state.due.size) return;
  const timer = state.timer;
  state.timer = null;
  timer?.task.cancel();
}

// The timer set for the soonest deadline, unless the one set rings by then. The new timer
// is set before the old one is cancelled: a refused one leaves the old in place.
function aim(state) {
  let soonest = Infinity;
  for (const call of state.due) if (call.at < soonest) soonest = call.at;
  const timer = state.timer;
  if (soonest === Infinity) {
    state.timer = null;
    timer?.task.cancel();
    return;
  }
  if (timer && timer.at <= soonest) return;
  // The handler gets the deadline, not the record holding its task: a record reached from
  // its own task's handler would be a cycle, which the app's engine never frees.
  const task = state.arm(Math.max(0, soonest - state.now()), () => fire(state, soonest));
  state.timer = { at: soonest, task };
  timer?.task.cancel();
}

function fire(state, at) {
  if (state.timer?.at !== at) return;
  state.timer = null;
  const now = state.now(), rung = [];
  for (const call of state.due) if (call.at <= now) rung.push(call);
  for (const call of rung) state.due.delete(call);
  try { aim(state); } catch { /* refused: the deadlines left get a timer at the next wait() */ }
  for (const call of rung) {
    try { call.ring(); } catch { /* one caller's trouble is its own */ }
  }
}

function close(state) {
  state.due.clear();
  const timer = state.timer;
  state.timer = null;
  timer?.task.cancel();
}
