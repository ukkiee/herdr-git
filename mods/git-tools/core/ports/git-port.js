// The shape the git use cases expect of their git runner, kept apart from the runner
// itself (git.js) so they need not import it: the READ flags of a command that only
// looks, the environment of a read whose failure is told by git's words (ASK_IN_C,
// outsideRepo), and how a long path list is split over commands (chunks). A runner
// git(cwd, args, { timeout?, env? }) answers { ok, code, out, err } and never throws
// (git.js makeGit says what each field holds). Imports nothing, "herdr" least of all.

// Reads must write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the Commit panel watches the folder, and a read that touched .git would start the next read.
// log.showSignature off: with the person's setting on, git puts a signed commit's
// verification lines ahead of what `log` or `show` was asked to print.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "log.showSignature=false"];

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

// Being outside a repository is told only by git's words: its exit code (128) is the same
// for other failures. git says them in the person's language when it has its translations,
// so a read that asks where the repository is goes with `{ env: ASK_IN_C }`, and git's words
// are always these. Every other answer is told by exit codes and state files, never words.
export const ASK_IN_C = { LC_ALL: "C" };
// outsideRepo(r) → whether a read asked with ASK_IN_C failed for being outside a repository.
export const outsideRepo = (r) => r.code > 0 && /not a git repository/i.test(r.err);
