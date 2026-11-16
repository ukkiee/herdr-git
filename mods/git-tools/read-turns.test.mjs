// node read-turns.test.mjs: a screen's repeated read never stays "going" past STUCK, a newer
// read can always start, and an answer older than one already used is dropped (no app, no git).
import assert from "node:assert/strict";
import { readTurns, STUCK } from "./read-turns.js";

// A clock the test moves by hand.
const clock = () => { let t = 1000; return { now: () => t, pass: (ms) => { t += ms; } }; };

// One read: going until it ends, its answer used, then nothing going.
{
  const c = clock(), reads = readTurns({ now: c.now });
  assert.equal(reads.busy(), false);
  const a = reads.start();
  assert.equal(reads.busy(), true);
  assert.equal(reads.use(a), true);
  assert.equal(reads.end(a), true, "the newest read ended");
  assert.equal(reads.busy(), false);
}

// A read whose answer never comes holds back a new one only until STUCK has passed since it
// started: after that the screen is not "reading" any more and the next read starts.
{
  const c = clock(), reads = readTurns({ now: c.now });
  reads.start();
  c.pass(STUCK - 1);
  assert.equal(reads.busy(), true);
  assert.equal(reads.stuck(), false);
  c.pass(1);
  assert.equal(reads.busy(), false, "past STUCK it no longer counts as going");
  assert.equal(reads.stuck(), true);
  const b = reads.start();
  assert.equal(reads.busy(), true);
  assert.equal(reads.stuck(), false, "the new read has its own time");
  assert.equal(reads.use(b), true);
  assert.equal(reads.end(b), true);
  assert.equal(reads.stuck(), false);
}

// The screen's own limit: a short one for a dialog that reads every two seconds.
{
  const c = clock(), reads = readTurns({ now: c.now, stuck: 4000 });
  reads.start();
  c.pass(3999);
  assert.equal(reads.busy(), true);
  c.pass(1);
  assert.equal(reads.busy(), false);
}

// A newer read started while an older one runs: the older answer is still used when it lands
// first (both read the same thing), the newer replaces it, and the older ending doesn't end
// the newer one's "going".
{
  const c = clock(), reads = readTurns({ now: c.now });
  const a = reads.start(), b = reads.start();
  assert.equal(reads.use(a), true, "nothing newer was used yet");
  assert.equal(reads.end(a), false, "not the newest");
  assert.equal(reads.busy(), true, "the newer one still runs");
  assert.equal(reads.use(b), true);
  assert.equal(reads.end(b), true);
  assert.equal(reads.busy(), false);
}

// The older answer landing after the newer one was used is dropped: what is shown never goes
// back to an older read.
{
  const c = clock(), reads = readTurns({ now: c.now });
  const a = reads.start(), b = reads.start();
  assert.equal(reads.use(b), true);
  assert.equal(reads.end(b), true);
  assert.equal(reads.use(a), false);
  assert.equal(reads.end(a), false);
  assert.equal(reads.busy(), false);
}

// A stuck read that answers after all, once a newer one started: used if the newer one hasn't
// answered yet, ignored after; either way the newer one is what ends the going.
{
  const c = clock(), reads = readTurns({ now: c.now });
  const a = reads.start();
  c.pass(STUCK);
  const b = reads.start();
  assert.equal(reads.use(a), true);
  assert.equal(reads.end(a), false);
  assert.equal(reads.busy(), true);
  assert.equal(reads.use(b), true);
  assert.equal(reads.end(b), true);
}

// drop(): what is going is no longer waited for (another repository, another folder): its
// answer is never used, nothing counts as going, and the next read starts fresh.
{
  const c = clock(), reads = readTurns({ now: c.now });
  const a = reads.start();
  reads.drop();
  assert.equal(reads.busy(), false);
  assert.equal(reads.use(a), false);
  assert.equal(reads.end(a), false);
  const b = reads.start();
  assert.equal(reads.use(b), true);
  assert.equal(reads.end(b), true);
}

// Turns are the screen's own: two screens never share one.
{
  const c = clock(), one = readTurns({ now: c.now }), two = readTurns({ now: c.now });
  one.start();
  assert.equal(two.busy(), false);
}

// STUCK is past the longest a git runner with a clock waits for one read (git.js: two tries
// of exec's 30 s plus 5 s each).
assert.ok(STUCK > 2 * 35000);

console.log("ok");
