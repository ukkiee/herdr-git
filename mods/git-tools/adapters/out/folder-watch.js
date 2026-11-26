// Watching a folder (this computer only). Pure: takes herdr's watchFolder as an argument, so
// node tests it (folder-watch.test.mjs); ui.js hands it the real one.
//
// A pending watchFolder call and the task waiting on it are two of the host tasks Herdr
// counts (it refuses any past 1024 outstanding for every mod together), and at most 64
// folders may be watched at once by every mod together. A watch ends at its folder's next
// change at the soonest, which on a quiet repository is never: so the screen keeps what this
// returns and stops it when it stops showing the folder, which cancels the pending call.

// A git command in a terminal (a merge, a checkout) writes a burst of files, and a watch
// wakes at the first. What lands before the next watchFolder call listens can go unseen,
// so a wake is read at once and once more this long after.
export const SETTLE = 1000;

// watchSettled(watchFolder, dir, { live, wakes, wake, failed, settle }, cx) → { stop() }:
// calls wake(cx) after each change under `dir` for which wakes(paths) holds (default: any),
// then once more `settle` ms later (default SETTLE; 0: no second look), until stop() or
// until live() stops holding. stop() cancels the pending call at once. failed() runs when the
// folder can't be watched (too large on Linux, gone, or the host refused the call): the
// caller's timer still reads.
export function watchSettled(watchFolder, dir, { live = () => true, wakes = () => true, wake, failed = () => {}, settle = SETTLE }, cx) {
  const hold = { stopped: false, pending: null };
  const going = () => !hold.stopped && live();
  try { cx.spawn((cx) => loop(watchFolder, dir, hold, { going, wakes, wake, failed, settle }, cx)); }
  catch { failed(); }
  return { stop: () => stop(hold) };
}

function stop(hold) {
  hold.stopped = true;
  const pending = hold.pending;
  hold.pending = null;
  pending?.cancel?.();
}

async function loop(watchFolder, dir, hold, { going, wakes, wake, failed, settle }, cx) {
  let settling = false;
  try {
    while (going()) {
      const watch = hold.pending = watchFolder(dir);
      let paths;
      try { paths = await watch; }
      finally { if (hold.pending === watch) hold.pending = null; }
      if (!going()) return;
      if (!wakes(paths)) continue;
      // A wake whose read the host refused, or a refused timer, costs that read only: the
      // watch goes on, and the screen's own timer reads.
      try { wake(cx); } catch { /* see above */ }
      if (!settle || settling) continue;
      try {
        cx.timer.after(settle, (cx) => { settling = false; if (going()) wake(cx); });
        settling = true;
      } catch { /* no second look this time */ }
    }
  } catch {
    if (going()) failed();
  }
}
