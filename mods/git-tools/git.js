// The git runner every git-*.js module is handed. It takes `exec` as an argument instead
// of importing "herdr", so node can test the git modules against real repositories.

// Reads must write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the Commit panel watches the folder, and a read that touched .git would start the next read.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

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

// makeGit(exec, on, { record? }) → git(cwd, args, { timeout?, env? }) → { ok, code, out, err }.
// Never throws: a program that can't start or a machine that can't be reached is
// { ok: false, code: -1 }. `out` is stdout exactly as git wrote it (-z output and diffs
// depend on it); `err` is trimmed stderr, or trimmed stdout when stderr is empty (hooks
// and some git errors print there).
// `on`: the space's machine, null for this computer. `env`: herdr's exec has no env
// option, so variables go through the `env` program. `timeout`: ms (exec's default is 30 s,
// its cap 10 min).
// record(call): gets every command that may write once it ended, { at (ms), cwd, on,
// args (git's, without env), code, stdout, stderr }, and is awaited so one copy's records
// land in order. Default: the installed one (recordWith). Its failure never fails git.
export function makeGit(exec, on, { record } = {}) {
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
  const git = async (cwd, args, { timeout, env } = {}) => {
    const options = { cwd, on };
    if (timeout) options.timeout = timeout;
    const vars = Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
    const at = Date.now();
    let r, failed;
    for (let tries = 1; ; tries++) {
      await take();
      failed = undefined;
      flying++;
      try { r = vars.length ? await exec("env", [...vars, "git", ...args], options) : await exec("git", args, options); }
      catch (error) { failed = error; }
      finally { flying--; give(); }
      const busy = Boolean(failed) && BUSY.test(String(failed?.message ?? failed));
      landed(!busy);
      if (!busy || tries >= TRIES) break;
      let ran = false;
      while (!ran && flying > 0) ran = await new Promise((go) => refused.push(go));
      if (!ran) break;
    }
    if (failed) {
      const err = String(failed?.message ?? failed);
      await note({ at, cwd, on: on ?? null, args, code: -1, stdout: "", stderr: err });
      return { ok: false, code: -1, out: "", err };
    }
    const out = r.stdout ?? "";
    await note({ at, cwd, on: on ?? null, args, code: r.code, stdout: out, stderr: r.stderr ?? "" });
    return { ok: r.code === 0, code: r.code, out, err: (r.stderr ?? "").trim() || out.trim() };
  };
  // For anything that only looks: status, log, diff, for-each-ref, rev-parse.
  git.read = (cwd, args, options) => git(cwd, [...READ, ...args], options);
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
