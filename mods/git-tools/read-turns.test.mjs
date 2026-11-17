// node read-turns.test.mjs: a screen's repeated read never stays "going" past STUCK, a newer
// read can always start (up to the screen's `most` at once), and an answer older than one
// already used is dropped (no app, no git: git.js's runner over an exec the test plays).
import assert from "node:assert/strict";
import { readTurns, pageAt, STUCK } from "./read-turns.js";
import { makeGit } from "./git.js";

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

// most: at most that many reads go at once, stuck ones included. An ask past it starts
// nothing and is kept, one however many came, until a read ends: again() then says once to
// start it. Without `most` asking never waits.
{
  const c = clock(), reads = readTurns({ now: c.now, stuck: 6000, most: 2 });
  const a = reads.ask();
  c.pass(6000);
  const b = reads.ask();
  assert.deepEqual([typeof a, typeof b], ["number", "number"]);
  c.pass(6000);
  assert.equal(reads.busy(), false, "both are stuck");
  assert.equal(reads.ask(), null, "two going already");
  assert.equal(reads.ask(), null);
  assert.equal(reads.again(), false, "no room yet");
  assert.equal(reads.end(a), false, "the older one ends, not the newest");
  assert.equal(reads.again(), true, "the kept ask may start now");
  assert.equal(reads.again(), false, "once");
  const d = reads.ask();
  assert.equal(typeof d, "number");
  assert.equal(reads.ask(), null);
  assert.equal(reads.end(b), false);
  assert.equal(reads.end(d), true);
  assert.equal(reads.again(), true);
  // An ask that found room keeps nothing; drop forgets what was kept.
  const e = reads.ask(), f = reads.ask();
  assert.equal(reads.ask(), null);
  reads.drop();
  assert.equal(reads.again(), false);
  assert.equal(typeof reads.ask(), "number");
  reads.end(e); reads.end(f);
  const free = readTurns({ now: c.now });
  for (let i = 0; i < 10; i++) assert.equal(typeof free.ask(), "number");
}

// The Conflicts dialog's way, with git.js's runner and a clock the test moves: it asks for a
// read every 2 s while none started in the last 6 s is going, at most 2 at once. Every
// git call goes unanswered for 10 minutes, then answers again. The reads going and the git
// calls waiting stay bounded the whole time, and once answers come the newest state is shown
// within a few reads.
{
  const POLL = 2000, UNANSWERED = 6000, OUTAGE = 600000;
  let now = 0, alarms = [];
  // The copy's clock (clock.js): ring() at now + ms unless the call takes it back first.
  const wait = (ms, go) => {
    const alarm = { at: now + ms, go };
    alarms.push(alarm);
    return () => { alarms = alarms.filter((a) => a !== alarm); };
  };
  let state = "before", answering = false, calls = 0, waiting = 0, mostWaiting = 0;
  const exec = (_cmd, _args) => {
    calls++;
    if (answering) return Promise.resolve({ code: 0, stdout: state, stderr: "" });
    waiting++; mostWaiting = Math.max(mostWaiting, waiting);
    return new Promise(() => {});
  };
  const git = makeGit(exec, null, { wait, record: () => {} });
  const reads = readTurns({ stuck: UNANSWERED, now: () => now, most: 2 });
  let shown = null, going = 0, mostGoing = 0, started = 0;
  const load = () => {
    const turn = reads.ask();
    if (turn === null) return;
    started++; going++; mostGoing = Math.max(mostGoing, going);
    (async () => {
      const [op] = await Promise.all([git.read("/r", ["status"]), git.read("/r", ["symbolic-ref", "-q", "HEAD"])]);
      going--;
      const used = reads.use(turn);
      reads.end(turn);
      if (reads.again()) load();
      if (used && op.ok) shown = op.out;
    })();
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((go) => setImmediate(go)); };
  // A call answered first took its alarm back; one that rings marks its unanswered call as
  // given up on.
  let next = POLL;
  const ring = async (until, done = () => false) => {
    while (!done()) {
      alarms.sort((x, y) => x.at - y.at);
      const t = Math.min(next, alarms[0]?.at ?? Infinity);
      if (t > until) { now = until; return; }
      now = t;
      if (t === next) { if (!reads.busy()) load(); next += POLL; }
      else { const a = alarms.shift(); if (!answering) waiting--; a.go(); }
      await settle();
    }
  };
  load();
  await settle();
  await ring(OUTAGE);
  assert.ok(mostGoing <= 2, `reads going at once: ${mostGoing}`);
  assert.ok(mostWaiting <= 4, `unanswered git calls at once: ${mostWaiting}`);
  assert.equal(shown, null);
  const before = started;
  state = "after"; answering = true;
  await ring(OUTAGE + 80000, () => shown === "after");
  assert.equal(shown, "after", "the newest state is shown within 80 s of git answering again");
  assert.ok(started - before <= 3, `reads started after git answered again before it showed: ${started - before}`);
}

// pageAt: a page read from `skip` goes after the list only when the list still ends there.
// The same page answered twice (More pressed again while the first read went unanswered),
// or a page that lands after a later one, is left out: nothing shows twice and the next
// page's skip (the list's length) stays right.
{
  const first = ["c1", "c2"];
  const once = pageAt(first, 2, ["c3", "c4"]);
  assert.deepEqual(once, ["c1", "c2", "c3", "c4"]);
  assert.deepEqual(first, ["c1", "c2"], "the list given isn't changed");
  assert.equal(pageAt(once, 2, ["c3", "c4"]), null, "the same page again");
  assert.equal(pageAt(once, 6, ["c7"]), null, "a page past a gap");
  assert.deepEqual(pageAt(null, 0, ["c1"]), ["c1"]);
  assert.deepEqual(pageAt(once, 4, []), once);
}

// STUCK is past the longest a git runner with a clock waits for one read (git.js: two tries
// of exec's 30 s plus 5 s each).
assert.ok(STUCK > 2 * 35000);

console.log("ok");
