// The turns of one read a screen repeats (the repository it finds, a dialog's plan, a tab's
// commits). Pure: no herdr import, so node tests it (read-turns.test.mjs).
//
// A git call can fail to answer at all (herdr's exec has been seen to lose its answer: no
// process left and the promise never settles). A screen that waits for "the read going" to
// end before it reads again would then wait forever, Refresh included. So a read counts as
// going only for `stuck` ms after it started, a newer read may always start, and an answer
// is used unless a newer one was used already.
//
// A screen that reads again while its reads go unanswered must not pile them up: each one
// holds the runner's places (git.js) until its clock gives up on it, and the ones queued
// behind wait their turn even once git answers again. `most` caps the reads going at once;
// an ask past it is kept, one for however many came, and starts when a read ends.
//
// readTurns({ stuck?, now?, most? }) → {
//   start() → turn   a new read begins (the one before may still answer)
//   ask() → turn | null  start(), unless `most` reads are going (stuck ones too): then
//                    null, and the ask is kept for again()
//   again()          true, once, when an ask was kept and a read has ended since: ask now
//   busy()           the newest read hasn't ended and started less than `stuck` ms ago
//   stuck()          the newest read hasn't ended and started `stuck` ms ago or more
//   use(turn)        true when this answer may be shown: no newer one was shown yet
//   end(turn)        the read is over, answered or not; true when it was the newest (the
//                    screen's "reading" ends here, and what waited for it may run)
//   drop()           nothing going is waited for any more (another repository): no answer
//                    started before is used, and no ask is kept
// }
// most: Infinity unless given (ask then always starts). Make one per screen and kind of
// read, never at module level (copies may share modules).

// Past the longest a runner with a clock waits for one read: two tries of exec's default
// 30 s plus the 5 s it waits beyond that (git.js).
export const STUCK = 80000;

export function readTurns({ stuck = STUCK, now = Date.now, most = Infinity } = {}) {
  let turn = 0, used = 0, at = 0, open = false, kept = false;
  const going = new Set();
  const late = () => open && now() - at >= stuck;
  const start = () => { turn++; at = now(); open = true; going.add(turn); return turn; };
  return {
    start,
    ask() {
      if (going.size >= most) { kept = true; return null; }
      kept = false;
      return start();
    },
    again() {
      if (!kept || going.size >= most) return false;
      kept = false;
      return true;
    },
    busy: () => open && !late(),
    stuck: late,
    use(t) {
      if (t <= used || t > turn) return false;
      used = t;
      return true;
    },
    end(t) {
      going.delete(t);
      if (t !== turn || !open) return false;
      open = false;
      return true;
    },
    drop() { used = turn; open = false; going.clear(); kept = false; },
  };
}

// pageAt(list, skip, page) → `list` with `page` (what was read from `skip` on) after it, or
// null when the list doesn't end at `skip` any more. use() lets an older answer through
// while no newer one was shown, so the same next page asked twice (More pressed again while
// the first read went unanswered) answers twice; placed both times, its items would show
// twice and the next page would skip as many.
export function pageAt(list, skip, page) {
  const have = list ?? [];
  return have.length === skip ? [...have, ...page] : null;
}
