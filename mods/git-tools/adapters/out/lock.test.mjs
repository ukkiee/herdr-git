// node lock.test.mjs: one write at a time per repository, across copies of the mod that
// share one value (no app, no git). The time is passed in, so the test sets it.
import assert from "node:assert/strict";
import { STALE, makeLocks, sameRepo, repoName } from "./lock.js";

// One shared-state slot, as Herdr keeps it for every copy.
const sharedSlot = (start) => {
  let value = start;
  return { read: () => value, write: (v) => { value = v; } };
};
const clock = () => {
  let t = 1_000_000;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  return now;
};

const A = { on: null, root: "/repo/a" };
const B = { on: null, root: "/repo/b" };
const A_ON_VPS = { on: "vps", root: "/repo/a" };

// (1) One copy holds a repository: another copy can't take it, but can take another one.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeLocks(slot, "panel", now), log = makeLocks(slot, "log", now);
  assert.deepEqual(panel.take(A, "Committing…"), { ok: true });
  assert.deepEqual(log.take(A, "Fetching…"), { ok: false, label: "Committing…" });
  assert.deepEqual(log.holder(A), { label: "Committing…", mine: false });
  assert.deepEqual(panel.holder(A), { label: "Committing…", mine: true });
  // Not even the holder starts a second write on it.
  assert.deepEqual(panel.take(A, "Pushing…"), { ok: false, label: "Committing…" });
  // Another repository, and the same path on another machine, are free.
  assert.deepEqual(log.take(B, "Fetching…"), { ok: true });
  assert.equal(panel.holder(A_ON_VPS), null);
  assert.deepEqual(log.take(A_ON_VPS, "Checking out…"), { ok: true });
}

// (2) Released, it can be taken; a copy that closes lets go of all it holds.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeLocks(slot, "panel", now), log = makeLocks(slot, "log", now);
  panel.take(A, "Committing…");
  panel.take(B, "Pushing…");
  panel.release(A);
  assert.equal(log.holder(A), null);
  assert.deepEqual(log.take(A, "Fetching…"), { ok: true });
  assert.deepEqual(log.take(B, "Fetching…"), { ok: false, label: "Pushing…" });
  panel.releaseAll();
  assert.deepEqual(log.take(B, "Fetching…"), { ok: true });
  // The log copy's own lock on A is still there.
  assert.deepEqual(panel.take(A, "Committing…"), { ok: false, label: "Fetching…" });
}

// (3) A holder that stops beating for more than STALE is ignored, and a new copy takes
// the repository. One that keeps beating keeps it.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeLocks(slot, "panel", now), log = makeLocks(slot, "log", now);
  panel.take(A, "Committing…");
  panel.take(B, "Pushing…");
  for (let i = 0; i < 4; i++) { now.add(5000); panel.beat(); }
  assert.deepEqual(log.take(A, "Fetching…"), { ok: false, label: "Committing…" }, "beating: still held");
  // The panel goes without closing (a crash): no more beats.
  now.add(STALE);
  assert.deepEqual(log.holder(A), { label: "Committing…", mine: false }, "at exactly STALE: still held");
  now.add(1);
  assert.equal(log.holder(A), null);
  assert.deepEqual(log.take(A, "Fetching…"), { ok: true });
  assert.deepEqual(log.holder(A), { label: "Fetching…", mine: true });
  // The dead copy's other record went with the take: the value doesn't grow.
  assert.deepEqual(Object.keys(slot.read()).length, 1);
  // The dead copy waking up later doesn't get its lock back by beating.
  panel.beat();
  assert.deepEqual(log.holder(A), { label: "Fetching…", mine: true });
  assert.equal(panel.holder(B), null);
}

// The clock is set back by more than STALE while a copy holds a repository: its record now
// lies ahead and counts as dead until the holder's next beat, which writes the time again
// and keeps the repository held. Someone else's record from the future is not renewed.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeLocks(slot, "panel", now), log = makeLocks(slot, "log", now);
  panel.take(A, "Committing…");
  now.add(-60_000);
  assert.equal(log.holder(A), null, "between the jump and the next beat: free (a known gap)");
  panel.beat();
  assert.deepEqual(panel.holder(A), { label: "Committing…", mine: true });
  assert.deepEqual(log.take(A, "Fetching…"), { ok: false, label: "Committing…" });
  now.add(STALE);
  assert.deepEqual(log.holder(A), { label: "Committing…", mine: false }, "beaten after the jump: alive for STALE");
  log.beat();
  now.add(-60_000);
  log.beat();
  assert.equal(log.holder(A), null, "another copy's beats don't renew the panel's record");
}

// (4) Nobody releases a record that isn't theirs, and beating doesn't touch others'.
{
  const slot = sharedSlot(), now = clock();
  const panel = makeLocks(slot, "panel", now), log = makeLocks(slot, "log", now);
  panel.take(A, "Committing…");
  log.release(A);
  log.releaseAll();
  assert.deepEqual(log.take(A, "Fetching…"), { ok: false, label: "Committing…" });
  now.add(STALE - 1);
  log.beat();
  now.add(2);
  assert.deepEqual(log.take(A, "Fetching…"), { ok: true }, "the log's beats kept nothing of the panel's alive");
}

// Beats only write while something is held: an idle copy doesn't redraw every copy.
{
  let writes = 0;
  const slot = sharedSlot(), now = clock();
  const counted = { read: slot.read, write: (v) => { writes++; slot.write(v); } };
  const panel = makeLocks(counted, "panel", now);
  panel.beat(); panel.releaseAll();
  assert.equal(writes, 0);
}

// (5) The value is the person's saved shared state: nothing yet, an older shape, or
// edited by hand. Nothing throws, junk counts as free, and a take repairs the value.
{
  const junk = [undefined, null, "text", 7, [], { x: 1 }, { '[null,"/repo/a"]': "Committing…" },
    { '[null,"/repo/a"]': { owner: 5, label: null, beat: "soon" } }, { '[null,"/repo/a"]': null },
    { '[null,"/repo/a"]': { owner: "other", label: "Committing…", beat: Infinity } }];
  for (const value of junk) {
    const now = clock(), slot = sharedSlot(value);
    const log = makeLocks(slot, "log", now);
    assert.equal(log.holder(A), null, JSON.stringify(value));
    log.beat(); log.release(A); log.releaseAll();
    assert.deepEqual(log.take(A, "Fetching…"), { ok: true }, JSON.stringify(value));
    assert.deepEqual(makeLocks(slot, "panel", now).take(A, "Committing…"), { ok: false, label: "Fetching…" });
  }
  // A record from the future (the clock was set back) is not held forever.
  const now = clock(), slot = sharedSlot({ '[null,"/repo/a"]': { owner: "other", label: "Committing…", beat: now() + 3_600_000 } });
  assert.equal(makeLocks(slot, "log", now).holder(A), null);
}

// (6) A record carries what runs as a message key too ({ key, args }), so each copy words
// it in its own language; the label stays for a copy that reads only the label. A record
// with only a label (from a copy of the mod that doesn't write the key) still holds the
// repository and is shown by its label; a key that isn't well formed is left out.
{
  const slot = sharedSlot(), now = clock();
  const ko = makeLocks(slot, "ko", now), en = makeLocks(slot, "en", now);
  assert.deepEqual(ko.take(A, "커밋 중…", { key: "commit.committing" }), { ok: true });
  assert.deepEqual(slot.read()[JSON.stringify([null, A.root])], { owner: "ko", label: "커밋 중…", work: { key: "commit.committing", args: {} }, beat: now() });
  assert.deepEqual(en.holder(A), { label: "커밋 중…", work: { key: "commit.committing", args: {} }, mine: false });
  assert.deepEqual(en.take(A, "Fetching…", { key: "log.fetching" }), { ok: false, label: "커밋 중…", work: { key: "commit.committing", args: {} } });
  assert.deepEqual(ko.take(B, "Pushing to origin…", { key: "dialogs.push.pushingTo", args: { remote: "origin" } }), { ok: true });
  assert.deepEqual(en.holder(B).work, { key: "dialogs.push.pushingTo", args: { remote: "origin" } });

  const old = sharedSlot({ [JSON.stringify([null, A.root])]: { owner: "old", label: "Committing…", beat: now() } });
  const reader = makeLocks(old, "new", now);
  assert.deepEqual(reader.holder(A), { label: "Committing…", mine: false });
  assert.deepEqual(reader.take(A, "Fetching…", { key: "log.fetching" }), { ok: false, label: "Committing…" });

  for (const work of ["commit.committing", { key: 5 }, { key: "x", args: "y" }, null]) {
    const odd = sharedSlot({ [JSON.stringify([null, A.root])]: { owner: "odd", label: "Committing…", work, beat: now() } });
    assert.deepEqual(makeLocks(odd, "new", now).holder(A), { label: "Committing…", mine: false }, JSON.stringify(work));
  }
}

// sameRepo: a write's repository against the one a panel shows. Same only when both the
// root and the machine match; a missing side is never the same.
{
  assert.equal(sameRepo(A, { root: "/repo/a", on: null, git: () => {}, folder: "/repo/a/src" }), true);
  assert.equal(sameRepo({ root: "/repo/a" }, A), true, "no `on` is this computer");
  assert.equal(sameRepo(A, B), false);
  assert.equal(sameRepo(A, A_ON_VPS), false);
  assert.equal(sameRepo(A_ON_VPS, { on: "vps", root: "/repo/a" }), true);
  assert.equal(sameRepo(A, null), false);
  assert.equal(sameRepo(null, A), false);
  assert.equal(sameRepo(null, null), false);
  assert.equal(sameRepo({ on: null }, { on: null }), false, "no root is no repository");
}

// repoName: the folder name a failure from another repository is prefixed with.
{
  assert.equal(repoName("/Users/me/work/slowhook"), "slowhook");
  assert.equal(repoName("/Users/me/work/slowhook/"), "slowhook");
  assert.equal(repoName("C:\\work\\second"), "second");
  assert.equal(repoName("/"), "/");
}

console.log("ok");
