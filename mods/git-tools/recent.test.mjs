// node recent.test.mjs: what a panel keeps of the folders it left (the newest few, taken
// out when used) and how much of the Commit list it keeps (no app, no git).
import assert from "node:assert/strict";
import { keepRecent, takeRecent, moveRecent, firstBatch } from "./recent.js";
import { layoutGraph } from "./graph.js";

// The newest last; the same key again moves to the end; past the limit the oldest goes.
{
  const m = new Map();
  keepRecent(m, "a", 1, 3);
  keepRecent(m, "b", 2, 3);
  keepRecent(m, "c", 3, 3);
  assert.deepEqual([...m.keys()], ["a", "b", "c"]);
  keepRecent(m, "a", 4, 3);
  assert.deepEqual([...m.entries()], [["b", 2], ["c", 3], ["a", 4]]);
  keepRecent(m, "d", 5, 3);
  assert.deepEqual([...m.keys()], ["c", "a", "d"], "the oldest goes past the limit");
}

// Taking one out removes it, so the screen and the map never hold it both.
{
  const m = new Map([["a", 1], ["b", 2]]);
  assert.equal(takeRecent(m, "a"), 1);
  assert.deepEqual([...m.keys()], ["b"]);
  assert.equal(takeRecent(m, "a"), undefined);
  assert.equal(takeRecent(m, "zz"), undefined);
}

// A move takes out the folder come back to before keeping the one left: with the map full,
// going round one folder more than the limit finds every folder still kept.
{
  const m = new Map();
  const order = ["a", "b", "c", "d"]; // limit 3, and the folder shown: four in all
  let shown = "a", hits = 0;
  for (let i = 1; i < order.length * 3; i++) {
    const to = order[i % order.length];
    if (moveRecent(m, shown, `kept ${shown}`, to, 3) !== undefined) hits++;
    shown = to;
  }
  assert.equal(hits, order.length * 3 - order.length, "every visit after the first round finds its folder");
  assert.equal(m.size, 3, "the limit holds");
  assert.ok(!m.has(shown), "the folder shown is not kept beside it");
}

// Nothing to keep of the folder left (none read yet): only the taking out.
{
  const m = new Map([["b", 2]]);
  assert.equal(moveRecent(m, "a", null, "b", 3), 2);
  assert.deepEqual([...m.keys()], []);
  assert.equal(moveRecent(m, null, null, "c", 3), undefined, "no folder before");
  assert.deepEqual([...m.keys()], []);
}

// ---- the Commit list's first batch (firstBatch)

// A history in git's order, as `git log` gives it: the merges are m*.
const c = (hash, ...parents) => ({ hash, parents, refs: [] });
const HISTORY = [
  c("c1", "m1"), c("m1", "c2", "x1"), c("c2", "c3"),
  c("x1", "c3"), c("c3", "m2"), c("m2", "c4", "x2"),
  c("c4", "c5"), c("x2", "c5"), c("c5"),
];
// git-log.js readLog's batch, read from `skip`: under No Merges the merges are dropped and
// come back as through, and read counts what git gave.
function batch(skip, count, noMerges) {
  const got = HISTORY.slice(skip, skip + count);
  if (!noMerges) return { commits: got };
  return { commits: got.filter((x) => x.parents.length <= 1), read: got.length, through: got.filter((x) => x.parents.length > 1).map((x) => [x.hash, x.parents[0]]) };
}
// The list's own sums over the batches read (log-list.js add).
function readOn(batches, noMerges) {
  const kept = { commits: [], seen: 0, through: [] };
  for (let i = 0; i < batches; i++) {
    const r = batch(kept.seen, 3, noMerges);
    kept.commits.push(...r.commits);
    kept.seen += r.read ?? r.commits.length;
    if (r.through?.length) kept.through.push(...r.through);
  }
  return kept;
}
const rowsOf = (kept) => layoutGraph(kept.commits, null, { through: kept.through }).rows;

// Up to one batch read: kept as it is.
{
  const one = readOn(1, false);
  assert.deepEqual(firstBatch(one, 3), one);
  const noMerges = readOn(1, true);
  assert.equal(noMerges.commits.length, 2);
  assert.deepEqual(firstBatch(noMerges, 3), noMerges);
}

// More read, all of it shown: the first batch, whose graph is the one drawn before, and the
// next read goes on from right after it.
{
  const all = readOn(3, false);
  const first = firstBatch(all, 3);
  assert.deepEqual(first.commits.map((x) => x.hash), ["c1", "m1", "c2"]);
  assert.equal(first.seen, 3);
  assert.deepEqual(first.through, []);
  assert.deepEqual(rowsOf(first), rowsOf(all).slice(0, 3), "the kept rows draw as before");
  assert.deepEqual(batch(first.seen, 3, false).commits[0].hash, "x1", "the next batch follows on");
}

// No Merges, more than one batch read. The graph would hold: the kept commits with the
// merges dropped among them draw as before. But where the kept commits end in git's
// order is lost (seen counts the merges too, through has no places), so a next batch read
// from a seen cut to the batch size shows a commit twice. Such a list is not kept.
{
  const all = readOn(2, true);
  assert.deepEqual(all.commits.map((x) => x.hash), ["c1", "c2", "x1", "c3"]);
  assert.equal(all.seen, 6);
  const kept = { commits: all.commits.slice(0, 3), seen: 3, through: all.through.filter(([m]) => m === "m1") };
  assert.deepEqual(rowsOf(kept), rowsOf(all).slice(0, 3), "the graph alone would hold");
  assert.equal(batch(kept.seen, 3, true).commits[0].hash, "x1", "but x1 would come twice");
  assert.equal(firstBatch(all, 3), null);
}
// One batch's worth shown out of more read is no first batch either.
assert.equal(firstBatch({ commits: [c("a")], seen: 4, through: [["m", "a"], ["n", "a"], ["o", "a"]] }, 3), null);

console.log("recent: ok");
