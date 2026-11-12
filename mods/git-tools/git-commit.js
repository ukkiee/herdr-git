// Committing. Every function takes `git` from makeGit (git.js) and the
// repository root, and returns a result instead of throwing. A sentence the mod words
// itself comes in English in `err` with its key in `msg` ({ key, args }, i18n.js);
// git's own words come without `msg`.

// Hooks can run for minutes (lint, tests); this is exec's cap.
const COMMIT_TIMEOUT = 600000;

// Paths are file names, never patterns: without this a file called `*.txt` or `[a].ts`
// would commit every file it matches.
const LITERAL = "--literal-pathspecs";

const fail = (err, extra = {}) => ({ ok: false, code: -1, out: "", err, ...extra });

// commit(git, root, { files, message, amend }) → { ok, code, out, err }
//   files: [{ path, status }], the Included files only. git's own staging is ignored:
//   only these paths are committed, as they are in the work tree now, and whatever else
//   is staged stays staged as it was.
//   message: the whole message, lines and all. It goes to git as an argument, never
//   through a file, so the same call works on another machine.
//   amend: rewrite the last commit instead of adding one. `files` may then be empty
//   (only the message changes).
//   Hooks run. When one fails nothing is committed and its output is in `err`.
export async function commit(git, root, { files = [], message = "", amend = false } = {}) {
  // Refused here, before anything is touched: git would refuse too, but only after the
  // untracked files had been registered.
  if (!message.trim()) return fail("Specify a commit message.", { msg: { key: "commit.noMessage" } });
  if (!files.length && !amend) return fail("No files to commit.", { msg: { key: "commit.noFiles" } });
  const paths = files.map((file) => file.path);
  // `commit --only` takes paths git knows. An untracked file is made known without
  // staging its content (the commit itself reads the work tree).
  // The list may be older than the index: a file it calls Unversioned may have been
  // staged or committed since. Only paths the index lacks right now are registered, so
  // only those are taken back below.
  const listed = files.filter((file) => file.status === "unversioned").map((file) => file.path);
  const fresh = await notInIndex(git, root, listed);
  if (!fresh.ok) return fresh;
  if (fresh.paths.length) {
    const added = await git(root, [LITERAL, "add", "--intent-to-add", "--", ...fresh.paths]);
    if (!added.ok) return added;
  }
  // With --amend, --only needs no paths: the message changes and staged files stay out.
  const args = [LITERAL, "commit", ...(amend ? ["--amend"] : []), "--only", "-m", message, "--", ...paths];
  const r = await git(root, args, { timeout: COMMIT_TIMEOUT });
  // A refused commit (a hook, a merge in progress) leaves git's own index alone, so the
  // only trace is the registration above: take it back and the files are untracked again.
  // Only when git itself said no (code > 0). After a timeout or a lost machine the commit
  // may have gone through, and un-adding a committed file would stage its deletion.
  if (r.code > 0 && fresh.paths.length) {
    const undo = await git(root, [LITERAL, "rm", "--cached", "--quiet", "--", ...fresh.paths]);
    if (!undo.ok) {
      const reason = undo.err || `code ${undo.code}`, files = fresh.paths.join(", ");
      const note = `These files are still registered for commit (git rm --cached failed: ${reason}): ${files}`;
      // git's output stays first and as it came; only the note after it is worded.
      return r.err
        ? { ...r, err: `${r.err}\n\n${note}`, msg: { key: "commit.stillRegisteredAfter", args: { output: r.err, reason, files } } }
        : { ...r, err: note, msg: { key: "commit.stillRegistered", args: { reason, files } } };
    }
  }
  return r;
}

// Which of `paths` the index has no entry for: { ok: true, paths }.
async function notInIndex(git, root, paths) {
  if (!paths.length) return { ok: true, paths };
  const r = await git.read(root, [LITERAL, "ls-files", "-z", "--cached", "--", ...paths]);
  if (!r.ok) return r;
  const known = new Set(r.out.split("\0").filter(Boolean));
  return { ok: true, paths: paths.filter((path) => !known.has(path)) };
}

// lastMessage(git, root) → { ok, err, message }: the last commit's full message.
// ok is false in a repository without commits.
export async function lastMessage(git, root) {
  const r = await git.read(root, ["log", "-1", "--format=%B"]);
  if (!r.ok) return r.err ? { ok: false, err: r.err, message: "" } : { ok: false, err: "No commits yet.", msg: { key: "commit.noCommitsYet" }, message: "" };
  return { ok: true, err: "", message: r.out.replace(/\n+$/, "") };
}

// headIsPushed(git, root) → { ok, err, pushed }: whether the last commit is on a remote
// (amending it then needs a force push). True when any remote-tracking branch contains
// it, as of the last fetch or push; nothing is fetched here.
// ok is false (and pushed false) in a repository without commits.
export async function headIsPushed(git, root) {
  const r = await git.read(root, ["for-each-ref", "--count=1", "--contains", "HEAD", "--format=%(refname)", "refs/remotes"]);
  if (!r.ok) return r.err ? { ok: false, err: r.err, pushed: false } : { ok: false, err: "git for-each-ref failed", msg: { key: "commit.forEachRefFailed" }, pushed: false };
  return { ok: true, err: "", pushed: r.out.trim() !== "" };
}
