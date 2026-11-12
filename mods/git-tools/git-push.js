// Pushing. Every function takes `git` from makeGit (git.js) and the
// repository root, and returns a result instead of throwing.
// Nothing here may ever pass a bare --force, -f or a "+refspec": the only way to
// overwrite a remote branch is --force-with-lease, built in one place (push).

// Branches a force push is refused on, before `git push` runs.
export const PROTECTED = ["main", "master"];

// Shown at most. A first push of an old repository can be its whole history.
const MAX_COMMITS = 1000;
const fail = (err, extra = {}) => ({ ok: false, code: -1, out: "", err, ...extra });
const QUOTE = ["-c", "core.quotePath=false"];
// git's own words when it said any, else ours with their msg (i18n.js).
const said = (r, err, msg) => (r.err ? { err: r.err } : { err, msg });

// Where the current branch goes: its upstream, else `origin` and the same name.
// → { ok, err, branch, remote, target, tracked, protected }
async function destination(git, root) {
  const none = { branch: null, remote: null, target: null, tracked: false, protected: false };
  // The full ref, cut here: `symbolic-ref --short` answers "heads/main" when a tag "main"
  // exists too, which would push the wrong branch and miss that main is protected.
  const head = await git.read(root, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = head.ok ? head.out.trim() : "";
  if (!ref.startsWith("refs/heads/")) {
    // Exit 1 with nothing said: HEAD is a commit, not a branch.
    const detached = (head.code === 1 && !head.err) || head.ok;
    if (detached) return fail("HEAD is detached: check out a branch to push.", { ...none, msg: { key: "dialogs.push.detached", args: {} } });
    const { err, msg } = said(head, "git could not read HEAD.", { key: "dialogs.push.noHead", args: {} });
    return fail(err, { ...none, ...(msg ? { msg } : {}) });
  }
  const branch = ref.slice("refs/heads/".length);
  const [remotes, toRemote, toRef] = await Promise.all([
    git.read(root, ["remote"]),
    git.read(root, ["config", "--get", `branch.${branch}.remote`]),
    git.read(root, ["config", "--get", `branch.${branch}.merge`]),
  ]);
  if (!remotes.ok) {
    const { err, msg } = said(remotes, "git could not list the remotes.", { key: "dialogs.push.noRemoteList", args: {} });
    return fail(err, { ...none, branch, ...(msg ? { msg } : {}) });
  }
  const names = remotes.out.split("\n").filter(Boolean);
  const upRemote = toRemote.ok ? toRemote.out.trim() : "", upRef = toRef.ok ? toRef.out.trim() : "";
  // An upstream that is a local branch (remote ".") or not a branch isn't somewhere to push.
  const tracked = Boolean(upRemote) && upRemote !== "." && upRef.startsWith("refs/heads/");
  const remote = tracked ? upRemote : "origin", target = tracked ? upRef.slice("refs/heads/".length) : branch;
  // Either name counts: a local `work` that tracks origin/main would overwrite main.
  const found = { branch, remote, target, tracked, protected: PROTECTED.includes(branch) || PROTECTED.includes(target) };
  if (!names.length) {
    return fail("This repository has no remote. Add one first: git remote add origin <url>", { ...found, msg: { key: "dialogs.push.noRemote", args: {} } });
  }
  if (!names.includes(remote)) {
    return tracked
      ? fail(`The upstream remote "${remote}" of ${branch} is not defined.`, { ...found, msg: { key: "dialogs.push.upstreamUndefined", args: { remote, branch } } })
      : fail(`${branch} has no upstream branch and there is no remote named "origin".`, { ...found, msg: { key: "dialogs.push.noOrigin", args: { branch } } });
  }
  return { ok: true, err: "", ...found };
}

// readPushPlan(git, root) → { ok, err, branch, remote, target, tracked, protected, isNew, commits, more }
//   branch: the current branch. remote / target: where it goes: its upstream, else
//   "origin" and the same name (tracked: false; the push then sets the upstream).
//   protected: the branch or its target is in PROTECTED (no Force Push).
//   isNew: the remote had no such branch when it was last fetched from or pushed to.
//   commits: [{ hash, parent, subject, author, time }], what HEAD has that no branch of
//   that remote has, newest first. parent: the first parent's hash, null for a root
//   commit. time: commit date, unix seconds. more: true when only the newest 1,000 are listed.
//   Nothing is fetched: "the remote" is what the last fetch or push saw.
//   ok is false (with what could be read) on a detached HEAD and when there is no remote
//   to push to; `err` says which.
export async function readPushPlan(git, root) {
  const to = await destination(git, root);
  const plan = { ok: to.ok, err: to.err, ...(to.msg ? { msg: to.msg } : {}), branch: to.branch, remote: to.remote, target: to.target, tracked: to.tracked, protected: to.protected, isNew: false, commits: [], more: false };
  if (!to.ok) return plan;
  const [seen, head] = await Promise.all([
    git.read(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${to.remote}/${to.target}`]),
    git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
  ]);
  plan.isNew = !seen.ok;
  // A branch without commits has nothing to push, and `git log HEAD` would fail on it.
  if (!head.ok) return plan;
  // %aN: the author as .mailmap maps them, as the Commit list shows them.
  const r = await git.read(root, ["log", "-z", "--format=%H%x00%P%x00%aN%x00%ct%x00%s", "--no-show-signature", "--no-color",
    `--max-count=${MAX_COMMITS + 1}`, "HEAD", "--not", `--remotes=${to.remote}`, "--"]);
  if (!r.ok) return { ...plan, ok: false, ...said(r, "git log failed", { key: "dialogs.gitCommandFailed", args: { command: "git log" } }) };
  const parts = r.out.split("\0");
  for (let i = 0; i + 5 <= parts.length; i += 5) {
    const [hash, parents, author, time, subject] = parts.slice(i, i + 5);
    plan.commits.push({ hash, parent: parents ? parents.split(" ")[0] : null, subject, author, time: Number(time) });
  }
  if (plan.commits.length > MAX_COMMITS) { plan.commits.length = MAX_COMMITS; plan.more = true; }
  return plan;
}

const STATUS = { A: "added", D: "deleted" };

// readPushFiles(git, root, { from, to }) → { ok, err, files: [{ path, status }] }
//   The files that differ between two commits (the dialog's right side); status is
//   "modified" | "added" | "deleted", as in git-status.js, and renames show as a delete
//   and an add.
//   from: null → everything being pushed up to `to`: the difference from the last commit
//   on `to`'s first-parent line that the remote already has. When the remote has none of
//   them (a first push, or `to` is a root commit), every file in `to` is "added".
//   One commit's own changes: { from: commit.parent, to: commit.hash } (readPushPlan).
export async function readPushFiles(git, root, { from = null, to = "HEAD" } = {}) {
  let since = from;
  if (!since) {
    const at = await destination(git, root);
    if (!at.ok) return { ok: false, err: at.err, ...(at.msg ? { msg: at.msg } : {}), files: [] };
    // Walking first parents only, the walk stops at one commit at most: git lists that
    // boundary with a "-" in front.
    const edge = await git.read(root, ["rev-list", "--first-parent", "--boundary", to, "--not", `--remotes=${at.remote}`, "--"]);
    if (!edge.ok) return { ok: false, ...said(edge, "git rev-list failed", { key: "dialogs.gitCommandFailed", args: { command: "git rev-list" } }), files: [] };
    since = edge.out.split("\n").find((line) => line.startsWith("-"))?.slice(1) ?? null;
  }
  if (!since) {
    const tree = await git.read(root, [...QUOTE, "ls-tree", "-r", "-z", "--name-only", to, "--"]);
    if (!tree.ok) return { ok: false, ...said(tree, "git ls-tree failed", { key: "dialogs.gitCommandFailed", args: { command: "git ls-tree" } }), files: [] };
    return { ok: true, err: "", files: tree.out.split("\0").filter(Boolean).map((path) => ({ path, status: "added" })) };
  }
  const r = await git.read(root, [...QUOTE, "diff", "--name-status", "-z", "--no-renames", since, to, "--"]);
  if (!r.ok) return { ok: false, ...said(r, "git diff failed", { key: "dialogs.gitCommandFailed", args: { command: "git diff" } }), files: [] };
  const parts = r.out.split("\0"), files = [];
  for (let i = 0; i + 2 <= parts.length; i += 2) files.push({ path: parts[i + 1], status: STATUS[parts[i][0]] ?? "modified" });
  return { ok: true, err: "", files };
}

// A push waits on the network and on the remote's hooks; this is exec's cap.
const PUSH_TIMEOUT = 600000;

// push(git, root, { force }) → { ok, code, out, err }
//   Pushes the current branch to where readPushPlan says it goes, and sets the upstream
//   when it had none. On failure `err` is git's own output and nothing local changed.
//   Runs with GIT_TERMINAL_PROMPT=0: a remote that wants a user name or password fails
//   ("terminal prompts disabled") instead of waiting for an answer nobody can type.
//   force: true → Force Push, which is --force-with-lease and nothing else: the remote
//   branch is overwritten only while it is still where this repository last saw it (or
//   still absent, when it never saw one). If someone pushed there since the last fetch,
//   git refuses. Refused here, before `git push` starts, when the branch or its target
//   is in PROTECTED.
export async function push(git, root, { force = false } = {}) {
  const at = await destination(git, root);
  if (!at.ok) return fail(at.err, at.msg ? { msg: at.msg } : {});
  const args = ["push"];
  if (force) {
    if (at.protected) {
      const name = PROTECTED.includes(at.target) ? at.target : at.branch;
      return fail(`Force Push is not allowed on the protected branch "${name}".`, { msg: { key: "dialogs.push.protected", args: { name } } });
    }
    // The expected value is spelled out. Left to git, a branch with no remote-tracking
    // ref has no lease to check; here an unknown or unreadable one means "must not
    // exist", so a failed read can only make the push stricter.
    const seen = await git.read(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${at.remote}/${at.target}`]);
    args.push(`--force-with-lease=refs/heads/${at.target}:${seen.ok ? seen.out.trim() : ""}`);
  }
  if (!at.tracked) args.push("--set-upstream");
  // --end-of-options: a remote may be called "--force"; it must stay a name.
  // Full ref names on both sides: a tag or a remote branch of the same name can't be meant.
  args.push("--end-of-options", at.remote, `refs/heads/${at.branch}:refs/heads/${at.target}`);
  return git(root, args, { timeout: PUSH_TIMEOUT, env: { GIT_TERMINAL_PROMPT: "0" } });
}
