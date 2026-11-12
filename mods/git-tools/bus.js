// The value git-tools screens leave for each other in Herdr's shared state (ui.js posts
// and reads it; this file only works on the value, so node can test it).
//
// value: { seq, events: [{ seq, ...event }] }: the number of the newest event and the
// last few events, oldest first. Each screen remembers the number it has handled (`seen`).

// How many events the value keeps. It is saved with the person's shared state on every
// post, so it stays small; a screen that was away for longer is told it missed some.
export const KEEP = 8;

// The value is the person's saved shared state: it may hold nothing yet, or something
// edited by hand. Anything that isn't a numbered event is left out.
const kept = (value) => (Array.isArray(value?.events) ? value.events : [])
  .filter((e) => e && typeof e === "object" && Number.isFinite(e.seq));

// latest(value) → the newest event's number (0: nothing was ever posted). A screen that
// opens starts here: what was posted before it opened, in an earlier run of the app
// too, is not its business.
export function latest(value) {
  return Number.isFinite(value?.seq) ? value.seq : 0;
}

// era(value) → what tells this numbering from the next one (null: none yet). The numbers
// start over when the shared state is cleared, and may climb back to, or past, the number
// a screen remembers: then only this shows that they started over.
export function era(value) {
  return typeof value?.era === "string" ? value.era : null;
}

// append(value, event, keep) → the next value: `event` gets the next number and the
// oldest events beyond `keep` go. The first event of a numbering starts a new era.
export function append(value, event, keep = KEEP) {
  const seq = latest(value) + 1;
  const next = { seq, events: [...kept(value), { ...event, seq }].slice(-keep) };
  const same = Number.isFinite(value?.seq) ? era(value) : newId();
  if (same !== null) next.era = same;
  return next;
}

// Whether the numbering of `value` is not the one where `seen` (in era `from`) was counted.
// Without `from`, only numbers that went down show it. Having seen nothing of no era, the
// first era is where counting starts.
const restarted = (value, seen, from) => latest(value) < seen
  || (from !== undefined && era(value) !== from && !(from === null && seen === 0));

// take(value, seen, from) → { events, seen, missed }: the events after number `seen`, oldest
// first and without their numbers, and the number to remember next. `missed`: some
// events after `seen` are no longer in the value, or the numbers started over (the
// shared state was cleared): the screen should read everything again to be safe.
// from: era() of the value `seen` was counted in, when known.
export function take(value, seen, from) {
  const now = latest(value), restart = restarted(value, seen, from);
  if (now === seen && !restart) return { events: [], seen, missed: false };
  const fresh = kept(value).filter((e) => restart || e.seq > seen);
  const missed = restart || !fresh.length || fresh[0].seq !== seen + 1;
  return { events: fresh.map(({ seq: _seq, ...event }) => event), seen: now, missed };
}

// ---- a copy's side of it

// io: { read() → value, write(value) }: the shared-state slot (ui.js passes Herdr's).
export function post(io, event) {
  io.write(append(io.read(), event));
}

const MENU = "menu"; // { type: "menu", key, value }: a popup menu's answer, or a request's
const REQUEST = "request"; // { type: "request", to, key, until, action, args }
const ACK = "ack"; // { type: "ack", key }: the copy a request went to has taken it

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// makeCopy(io, { id, now }) → one copy's side of the bus. main.js makes one per copy in
// init. Herdr runs a module once and shares it among copies, so everything a copy owns
// lives here, never at module level: one copy closing must not stop the others, and each
// copy must get every event itself.
//   id: this copy's id (made up when not given); requests are addressed by it.
//   now(): the time in ms (Date.now unless a test passes its own clock).
//
//   id                   this copy's id: a dialog's opener passes it as the dialog's owner
//   next()               Promise: the next event for this copy, null once stopped
//   stop(unanswered?)    this copy goes: a waiting next() gets null, and with a value,
//                        each request it took and hasn't answered is answered with it
//   pump(cx)             from this copy's render: new events are taken in this copy's
//                        timer, so what they start is this copy's work
//   wait(key)            Promise: the answer to the menu this copy opened under `key`;
//                        it settles only in this copy's pump, never in another copy's;
//                        null when the menu closed or its answer was pushed out unseen
//   answer(key, value)   from a menu's copy, or the copy that ran a request: posts the
//                        answer; the first call per key counts. Fine after the asking
//                        copy is gone: nobody takes it then.
//
// A dialog asks the copy that opened it to run a git write, so the write and what follows
// it belong to a copy that stays when the dialog is closed with Esc:
//   request(to, action, args, within) → { key, reply }: posts the request for copy `to`.
//                        reply settles like wait(key): with the answer, or null (dropped,
//                        or the answer pushed out unseen). `to` takes it only within
//                        `within` ms; later it is never run.
//   acked(key)           the addressed copy has taken the request (it marks that at once).
//                        Read from the shared value as well, so it holds before this
//                        copy's own pump has run.
//   drop(key)            the asker gives up on a request nobody took: reply settles null
//                        and a late answer is ignored.
// The addressed copy gets { type: "request", key, action, args } from next() and answers
// with answer(key, value) once the write is done.
export function makeCopy(io, { id = newId(), now = Date.now } = {}) {
  // Starts at the newest number: what was posted before this copy opened is not its business.
  let seen = latest(io.read()), from = era(io.read()), stopped = false, scheduled = false, wake = null, asked = 0;
  // menus: key → { resolve, from }. from: the newest number when the wait began; its
  // answer can only come after it. taken: requests this copy took and hasn't answered.
  const queue = [], menus = new Map(), answered = new Set(), acks = new Set(), taken = new Set();

  const hand = (e) => {
    if (wake) { const w = wake; wake = null; w(e); }
    else queue.push(e);
  };
  // restarted: the numbers already started over since this copy last looked, so `after`
  // counts in the new numbering.
  const awaitAnswer = (key) => new Promise((resolve) => {
    const value = io.read();
    menus.set(key, { resolve, after: latest(value), restarted: restarted(value, seen, from) });
  });
  const settle = (key, value) => {
    const wait = menus.get(key);
    if (wait) { menus.delete(key); wait.resolve(value); }
  };

  const deliver = () => {
    const value = io.read(), got = take(value, seen, from);
    // The numbers that went unseen: after `seen`, before the first one still kept.
    // Numbers that started over leave nothing to go by for a wait that began before:
    // it counts as hit. One that began after counts in the new numbers, where everything
    // before the first one kept went unseen.
    const restart = restarted(value, seen, from);
    const first = kept(value).find((e) => restart || e.seq > seen)?.seq ?? got.seen + 1;
    const lostUpTo = got.missed ? first - 1 : -Infinity;
    const lost = (wait) => (restart && !wait.restarted) || wait.after < lostUpTo;
    seen = got.seen;
    from = era(value);
    // Events came and went while this copy was hidden: any repository may have changed.
    const list = got.missed ? [{ type: "changed" }, ...got.events.filter((e) => e.type !== "changed")] : got.events;
    for (const e of list) {
      if (e.type === MENU) settle(e.key, e.value ?? null);
      else if (e.type === ACK) acks.add(e.key);
      else if (e.type === REQUEST) {
        // Past its time the asker has already said it didn't start: it must not run now.
        if (e.to !== id || stopped || !(now() <= e.until)) continue;
        post(io, { type: ACK, key: e.key });
        taken.add(e.key);
        hand({ type: REQUEST, key: e.key, action: e.action, args: e.args });
      } else hand(e);
    }
    // An answer may be among the events that went: a wait left open would never end, so
    // a wait that began before the last lost number counts as closed. One that began
    // after it lost nothing of its own.
    for (const [key, wait] of [...menus]) {
      if (lost(wait)) settle(key, null);
      else wait.restarted = false;
    }
  };

  return {
    id,
    next: () => new Promise((resolve) => {
      if (queue.length) resolve(queue.shift());
      else if (stopped) resolve(null);
      else wake = resolve;
    }),
    // unanswered: when given, every request this copy took and hasn't answered gets it as
    // the answer, so the askers stop waiting (synchronous: fine from close()).
    stop: (unanswered) => {
      stopped = true;
      if (wake) { const w = wake; wake = null; w(null); }
      if (unanswered === undefined) return;
      for (const key of [...taken]) answer(key, unanswered);
    },
    // Nothing may be started or redrawn from a render, hence the timer.
    pump: (cx) => {
      if (stopped || scheduled || !restarted(io.read(), seen, from) && latest(io.read()) === seen) return;
      scheduled = true;
      cx.timer.after(0, () => { scheduled = false; deliver(); });
    },
    wait: (key) => awaitAnswer(key),
    answer: (key, value) => answer(key, value),
    request: (to, action, args, within) => {
      const key = `req-${id}-${++asked}`;
      const reply = awaitAnswer(key);
      post(io, { type: REQUEST, to, key, until: now() + within, action, args: args ?? null });
      return { key, reply };
    },
    acked: (key) => acks.has(key) || kept(io.read()).some((e) => e.type === ACK && e.key === key),
    drop: (key) => settle(key, null),
  };

  function answer(key, value) {
    if (answered.has(key)) return;
    answered.add(key);
    taken.delete(key);
    post(io, { type: MENU, key, value: value ?? null });
  }
}
