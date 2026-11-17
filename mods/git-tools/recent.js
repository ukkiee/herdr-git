// What a panel keeps of the folders it left, so coming back shows them at once while they
// are read again. Pure: no herdr import (recent.test.mjs).
//
// The map is a field of the screen (or of one of its parts), never module state: a closing
// copy empties its screen's fields (let-go.js), and that must let what is kept go too.

// keepRecent(map, key, value, limit): `value` becomes the newest under `key`; past `limit`
// the oldest go. A handful of folders are gone back and forth between; the rest are read
// afresh.
export function keepRecent(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
  return map;
}

// takeRecent(map, key) → what was kept under `key` (undefined: nothing), taken out: the
// screen holds it from then on, not both.
export function takeRecent(map, key) {
  const was = map.get(key);
  map.delete(key);
  return was;
}

// moveRecent(map, from, kept, to, limit) → what was kept under `to`, taken out; then `kept`
// (null: nothing to keep) becomes the newest under `from`, the folder left. Taking out
// first: with the map full, the folder come back to is often the oldest one, and keeping
// first would push it out just before it is looked for. So the map holds `limit` folders
// besides the one shown.
export function moveRecent(map, from, kept, to, limit) {
  const was = takeRecent(map, to);
  if (kept && from != null) keepRecent(map, from, kept, limit);
  return was;
}

// firstBatch({ commits, seen, through }, batch) → the Commit list's first `batch` commits as
// log-list.js add sums them, or null when they can't be told apart from the rest.
//   commits: the commits read, in git's order; seen: how many git gave (git-log.js readLog's
//   read, merges left out under No Merges counted); through: the merges left out.
// Up to one batch read, all of it is kept. More than that, with every commit read shown,
// the first batch is: its graph is the one drawn before, and the next batch follows on from
// `seen`. Under No Merges with merges left out, where the first `batch` commits end in git's
// order is lost (`through` has no places), so a next batch read from a guessed `seen` would
// show commits twice or leave some out: null, and the list is read afresh.
export function firstBatch({ commits, seen, through }, batch) {
  if (seen <= batch) return { commits, seen, through };
  if (seen !== commits.length) return null;
  return { commits: commits.slice(0, batch), seen: batch, through: [] };
}
