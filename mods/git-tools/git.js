// The git runner every git-*.js module is handed. It takes `exec` as an argument instead
// of importing "herdr", so node can test the git modules against real repositories.

import { READ } from "./git-port.js";

// The recorder every runner without its own hands its writes to (main.js installs the Git
// console's, app-files.js). One value for all copies, never a copy's state: every copy
// installs the same function, so it doesn't matter whether copies share this module.
let installed = null;

// recordWith(fn | null): installs the recorder for runners made without one.
export function recordWith(fn) { installed = typeof fn === "function" ? fn : null; }

// A command that only looks starts with the READ flags (git.read): the console leaves it out.
const reads = (args) => args[0] === READ[0];

// herdr-core runs only so many execs at once for everyone (16 when seen) and refuses the next
// at once ("16 execs are running already"). A screen reads several things side by side and
// every screen reads when Herdr starts, so one runner keeps at most PARALLEL of its own going
// and queues the rest. The queue is the runner's: a copy only waits on its own execs, never on
// another copy's (that copy's promise would run this one's work, and drop it when it closes).
export const PARALLEL = 4;
// A refusal by that limit ran nothing, so it is tried again (up to TRIES runs in all) once one
// of the runner's own execs ends. With none of its own going there is nothing to wait for
// without a timer (a module has no `cx`), and the refusal is the answer.
const BUSY = /execs are running already/;
const TRIES = 5;
// The time limit of a command that may write and names none: exec's cap. A hook
// (reference-transaction, post-checkout) may run past exec's 30 s default, and git
// stopped halfway may leave a ref half written or a lock behind.
const WRITE_TIMEOUT = 600000;

// herdr's exec gives up on a command at its timeout (30 s unless given) and rejects, yet its
// answer has been seen to go missing: no process left and a promise that never settles. A
// runner given a clock stops waiting LATE ms past the command's timeout, gives its place in
// line to the next call and answers with a failure. A read is asked once more first: it
// changes nothing. A command that may write is not, as it may have done its work.
const EXEC_TIMEOUT = 30000;
const LATE = 5000;
const UNANSWERED = Symbol("unanswered");

// makeGit(exec, on, { record?, wait? }) → git(cwd, args, { timeout?, env? }) → { ok, code, out, err }.
// Never throws: a program that can't start, a machine that can't be reached or an answer
// that never came is { ok: false, code: -1 }. `out` is stdout exactly as git wrote it (-z
// output and diffs depend on it); `err` is trimmed stderr, or trimmed stdout when stderr is
// empty (hooks and some git errors print there).
// `on`: the space's machine, null for this computer. `env`: herdr's exec has no env
// option, so variables go through the `env` program. `timeout`: ms (exec's default is 30 s,
// its cap 10 min); a command without the READ flags that names none gets WRITE_TIMEOUT.
// record(call): gets every command that may write once it ended, { at (ms), cwd, on,
// args (git's, without env), code, stdout, stderr }, and is awaited so one copy's records
// land in order. Default: the installed one (recordWith). Its failure never fails git.
// wait(ms, ring) → stop: the screen's clock (clock.js; main.js gives each screen one), which
// calls ring() about `ms` from now unless stop() comes first. Without it, when it throws (the
// host refused its timer, or its copy closed) or when it never rings (its copy closed), the
// runner waits for exec's answer however long it takes.
export function makeGit(exec, on, { record, wait } = {}) {
  const note = async (call) => {
    const fn = record ?? installed;
    if (!fn || reads(call.args)) return;
    try { await fn(call); } catch { /* the console misses one line; git's result stands */ }
  };
  let running = 0, flying = 0;
  const queue = [], refused = [];
  const take = () => (running < PARALLEL ? (running++, Promise.resolve()) : new Promise((go) => queue.push(go)));
  const give = () => { const next = queue.shift(); if (next) next(); else running--; };
  // An exec of this runner answered (`ran`: it ran, not refused). One that ran made room for
  // one refused call; once none is flying, nothing else will wake the rest, so all hear it.
  const landed = (ran) => {
    if (flying === 0) for (const go of refused.splice(0)) go(ran);
    else if (ran) refused.shift()?.(true);
  };
  // The exec's answer, or UNANSWERED once the clock rings first. The clock's only hold on
  // the call is the ring it was handed, and the call takes it back (stop) once exec answers:
  // a ring still held reaches the call's promise and so the answer, and a big repository's
  // ref list is megabytes in the heap every mod shares. Not Promise.race with a timer's
  // promise: the app's engine kept the winner's value until the loser settled.
  const answer = (running, ms) => {
    if (!wait) return running;
    return new Promise((resolve, reject) => {
      let stop = null;
      try { stop = wait(ms, () => resolve(UNANSWERED)); } catch { stop = null; }
      Promise.resolve(running).then(
        (r) => { stop?.(); resolve(r); },
        (error) => { stop?.(); reject(error); },
      );
    });
  };
  const run = async (cwd, args, { timeout, env } = {}) => {
    const options = { cwd, on };
    if (timeout) options.timeout = timeout;
    else if (!reads(args)) options.timeout = WRITE_TIMEOUT;
    const vars = Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
    const at = Date.now(), limit = (options.timeout || EXEC_TIMEOUT) + LATE;
    // `threw` apart from `failed`: an exec may reject with no error at all (undefined, "").
    let r, failed, threw, again = reads(args);
    for (let tries = 1; ; tries++) {
      await take();
      failed = undefined; threw = false;
      let lost = false;
      flying++;
      try {
        r = await answer(vars.length ? exec("env", [...vars, "git", ...args], options) : exec("git", args, options), limit);
        if (r === UNANSWERED) { lost = threw = true; failed = new Error(`git did not answer in ${limit / 1000} s.`); }
      }
      catch (error) { failed = error; threw = true; }
      finally { flying--; give(); }
      const busy = threw && !lost && BUSY.test(String(failed?.message ?? failed));
      landed(!busy);
      if (lost && again) { again = false; continue; }
      if (!busy || tries >= TRIES) break;
      let ran = false;
      while (!ran && flying > 0) ran = await new Promise((go) => refused.push(go));
      if (!ran) break;
    }
    if (threw) {
      const err = String(failed?.message ?? failed);
      await note({ at, cwd, on: on ?? null, args, code: -1, stdout: "", stderr: err });
      return { ok: false, code: -1, out: "", err };
    }
    const out = r.stdout ?? "";
    await note({ at, cwd, on: on ?? null, args, code: r.code, stdout: out, stderr: r.stderr ?? "" });
    return { ok: r.code === 0, code: r.code, out, err: (r.stderr ?? "").trim() || out.trim() };
  };
  // Two functions over `run`, not `run` with a `read` that calls it: a function holding a
  // closure over itself is a cycle, and the app's JS engine frees no cycles, so every
  // runner made (a panel makes one per folder it shows, some reads one each) would stay.
  const git = (cwd, args, options) => run(cwd, args, options);
  // For anything that only looks: status, log, diff, for-each-ref, rev-parse.
  git.read = (cwd, args, options) => run(cwd, [...READ, ...args], options);
  return git;
}
