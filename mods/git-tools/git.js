// The git runner every git-*.js module is handed. It takes `exec` as an argument instead
// of importing "herdr", so node can test the git modules against real repositories.

// Reads must write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the Commit panel watches the folder, and a read that touched .git would start the next read.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// makeGit(exec, on) → git(cwd, args, { timeout?, env? }) → { ok, code, out, err }.
// Never throws: a program that can't start or a machine that can't be reached is
// { ok: false, code: -1 }. `out` is stdout exactly as git wrote it (-z output and diffs
// depend on it); `err` is trimmed stderr, or trimmed stdout when stderr is empty (hooks
// and some git errors print there).
// `on`: the space's machine, null for this computer. `env`: herdr's exec has no env
// option, so variables go through the `env` program. `timeout`: ms (exec's default is 30 s,
// its cap 10 min).
export function makeGit(exec, on) {
  const git = async (cwd, args, { timeout, env } = {}) => {
    const options = { cwd, on };
    if (timeout) options.timeout = timeout;
    const vars = Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
    let r;
    try { r = vars.length ? await exec("env", [...vars, "git", ...args], options) : await exec("git", args, options); }
    catch (error) { return { ok: false, code: -1, out: "", err: String(error?.message ?? error) }; }
    const out = r.stdout ?? "";
    return { ok: r.code === 0, code: r.code, out, err: (r.stderr ?? "").trim() || out.trim() };
  };
  // For anything that only looks: status, log, diff, for-each-ref, rev-parse.
  git.read = (cwd, args, options) => git(cwd, [...READ, ...args], options);
  return git;
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
