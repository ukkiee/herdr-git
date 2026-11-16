// The git runner every git-*.js module is handed. It takes `exec` as an argument instead
// of importing "herdr", so node can test the git modules against real repositories.

// Reads must write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the Commit panel watches the folder, and a read that touched .git would start the next read.
// log.showSignature off: with the person's setting on, git puts a signed commit's
// verification lines ahead of what `log` or `show` was asked to print.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "log.showSignature=false"];

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

// The clock's only hold on a call is `call.ring`, which the call clears once exec answers.
// A clock outlives most answers (a read's runs 35 s, and one whose copy closed may never
// settle), and what a pending promise's handlers reach stays alive: handed the answer's
// own promise (Promise.race), it kept every answer until it rang. A big repository's ref
// list is megabytes, and all mods share one heap. A function of its own, so its handler
// shares no scope with the answer.
const ringLater = (clock, call) => { clock.then(() => call.ring?.(), () => {}); };

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
// wait(ms): the screen's clock, a promise that settles after `ms` (main.js gives each
// screen one). Without it, or when it throws or rejects (its copy closed), the runner waits
// for exec's answer however long it takes.
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
  // The exec's answer, or UNANSWERED once the clock rings first. A clock that rejects (its
  // copy closed) never rings: the call waits for exec, as without a clock.
  const answer = (running, ms) => {
    let clock;
    try { clock = wait ? Promise.resolve(wait(ms)) : null; }
    catch { clock = null; }
    if (!clock) return running;
    const call = { ring: null };
    ringLater(clock, call);
    return new Promise((resolve, reject) => {
      call.ring = () => resolve(UNANSWERED);
      Promise.resolve(running).then(
        (r) => { call.ring = null; resolve(r); },
        (error) => { call.ring = null; reject(error); },
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

// Paths go on the command line (herdr's exec has no stdin), so a long list is split to
// stay far below the smallest limit an OS or an ssh hop puts on one command.
const CHUNK_BYTES = 60000, CHUNK_PATHS = 1000;

// chunks(paths, cost?) → [[path]]: `paths` in order, in parts that each fit one command.
// cost: the bytes one path takes on the command line, worst case UTF-8; a caller that
// puts more around each path (pathspec magic, a mode and an object) says how much.
export function chunks(paths, cost = (path) => path.length * 3 + 1) {
  const out = [];
  let chunk = [], bytes = 0;
  for (const path of paths) {
    const size = cost(path);
    if (chunk.length && (bytes + size > CHUNK_BYTES || chunk.length >= CHUNK_PATHS)) { out.push(chunk); chunk = []; bytes = 0; }
    chunk.push(path); bytes += size;
  }
  if (chunk.length) out.push(chunk);
  return out;
}

// The repository a folder belongs to: { ok: true, root }, or { ok: false, notRepo, err }.
// notRepo tells "this folder isn't in a repository" (show the notice) from "git could not
// be asked" (show the error and try again later).
export async function repoRoot(git, folder) {
  const r = await git.read(folder, ["rev-parse", "--show-toplevel"]);
  const root = r.out.trim();
  if (r.ok && root) return { ok: true, root };
  return { ok: false, notRepo: r.code > 0 && /not a git repository/i.test(r.err), err: r.err };
}
