// Pull, updating a branch from its tracked branch, Update Project (merge, rebase, or reset
// to the remote branch), and the range of commits an update brought in (the Update Info
// tab). Every function takes `git` from makeGit (git.js) and the repository root, and
// returns a result instead of throwing; a sentence the mod words itself comes in English
// in `err` with its key in `msg` (messages-remote.js). No `herdr` import: node tests it
// against real repositories with a local bare remote (git-remote.test.mjs).
//
// What came of a request is told as git-operation.js tells it (`outcome`):
//   done     it finished; `updated` is { from, to } when the branch moved
//   empty    there was nothing to bring in
//   stopped  a conflict (or an edit) left the operation in progress
//   refused  nothing changed: local changes stood in the way (`blocked`, the files, and
//            `request`, what Smart runs again), or a reason in `msg` (no tracked branch,
//            a detached HEAD, a branch that diverged from its tracked branch)
//   failed   anything else, git's words in err. `fetchFailed`: the fetch itself failed,
//            so the remote may be asking for a password nobody can type here.
// changed: the repository may have changed. Anything that fetched did: the remote
// branches move even when the merge step then fails.
//
// A remote never gets to ask: every fetch runs with GIT_TERMINAL_PROMPT=0, so a remote
// that wants a password fails at once instead of waiting for a terminal there is none of.

import { readStatus } from "./git-status.js";
import { readOperation, settle } from "./git-operation.js";
import { blockedBy, checkoutBranch, smartRun } from "./git-smart.js";
import { fetchAll } from "./git-branch.js";
import { resetTo } from "./git-reset.js";

const FETCH = { timeout: 5 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: "0" } };
// The merge or rebase step may run hooks for minutes; an editor would wait forever.
const STEP = { timeout: 10 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } };

// The pull dialog's options, in its order. Anything else is never passed on to git.
export const PULL_OPTIONS = ["--rebase", "--ff-only", "--no-ff", "--squash", "--no-commit", "--no-verify"];
// Also accepted from the branch menus: "Pull into … Using Merge".
const ACCEPTED = new Set([...PULL_OPTIONS, "--no-rebase"]);

const str = (value) => (typeof value === "string" ? value : "");
const refuse = (err, msg, extra = {}) => ({ ok: false, code: -1, out: "", err, msg, outcome: "refused", operation: null, updated: null, changed: false, ...extra });
const failedWith = (r, extra = {}) => ({ ok: false, code: r.code ?? -1, out: r.out ?? "", err: r.err ?? "", ...(r.msg ? { msg: r.msg } : {}), outcome: "failed", operation: null, updated: null, changed: false, ...extra });

async function hashOf(git, root, ref) {
  const r = await git.read(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok ? r.out.trim() : null;
}
const isAncestor = async (git, root, a, b) => (await git.read(root, ["merge-base", "--is-ancestor", a, b])).code === 0;

// ---- what tracks what

// readTracking(git, root, name?) → { ok, err, branch, upstream }
//   branch: `name`, else the branch HEAD is on (null on a detached HEAD).
//   upstream: { ref, name, remote, branch } of its tracked branch ("refs/remotes/origin/main",
//   "origin/main", "origin", "main"), or null. A local branch tracked through remote "."
//   has remote "." and its own ref.
export async function readTracking(git, root, name) {
  let branch = str(name) || null;
  if (!branch) {
    const r = await git.read(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
    if (r.code !== 0 && r.code !== 1) return { ok: false, err: r.err, branch: null, upstream: null };
    branch = r.ok ? r.out.trim() : null;
  }
  if (!branch) return { ok: true, err: "", branch: null, upstream: null };
  const r = await git.read(root, ["for-each-ref", "--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${branch}`]);
  if (!r.ok) return { ok: false, err: r.err, branch, upstream: null };
  const [ref, short, remote, remoteRef] = r.out.replace(/\n$/, "").split("\0");
  if (!ref) return { ok: true, err: "", branch, upstream: null };
  return { ok: true, err: "", branch, upstream: { ref, name: short, remote: remote || ".", branch: (remoteRef ?? "").replace(/^refs\/heads\//, "") } };
}

// The remotes and their branches: [{ name, branches: [name without the remote] }], both
// sorted. A remote's own name may hold slashes: a ref goes to the longest that fits.
async function readRemotes(git, root) {
  const names = await git.read(root, ["remote"]);
  if (!names.ok) return names;
  const remotes = names.out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  const refs = await git.read(root, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/remotes/"]);
  if (!refs.ok) return refs;
  const by = new Map(remotes.map((r) => [r, []]));
  for (const line of refs.out.split("\n")) {
    const [ref, symref] = line.split("\0");
    if (!ref || symref) continue; // origin/HEAD
    const short = ref.slice("refs/remotes/".length);
    const remote = remotes.filter((r) => short.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
    if (remote) by.get(remote).push(short.slice(remote.length + 1));
  }
  return { ok: true, remotes: remotes.map((r) => ({ name: r, branches: by.get(r).sort() })) };
}

// readPullTargets(git, root) → { ok, err, branch, upstream: { remote, branch } | null, remotes }
//   What the pull dialog offers: the branch HEAD is on, its tracked branch, and every
//   remote with its branches (readRemotes).
export async function readPullTargets(git, root) {
  const tracking = await readTracking(git, root);
  if (!tracking.ok) return { ok: false, err: tracking.err, branch: null, upstream: null, remotes: [] };
  const list = await readRemotes(git, root);
  if (!list.ok) return { ok: false, err: list.err, branch: tracking.branch, upstream: null, remotes: [] };
  const up = tracking.upstream && tracking.upstream.remote !== "." ? { remote: tracking.upstream.remote, branch: tracking.upstream.branch } : null;
  return { ok: true, err: "", branch: tracking.branch, upstream: up, remotes: list.remotes };
}

// pullDefault(targets, remembered) → { remote, branch } | null: the branch the pull
//   dialog starts on. remembered ("origin/feature", the one picked last time) while it
//   still exists; else the tracked branch; else the first remote's branch of the current
//   branch's name; else the first remote's first branch.
export function pullDefault(targets, remembered) {
  const remotes = targets?.remotes ?? [];
  const has = (remote, branch) => remotes.some((r) => r.name === remote && r.branches.includes(branch));
  const split = typeof remembered === "string" ? remotes.filter((r) => remembered.startsWith(`${r.name}/`)).sort((a, b) => b.name.length - a.name.length)[0] : null;
  if (split && has(split.name, remembered.slice(split.name.length + 1))) return { remote: split.name, branch: remembered.slice(split.name.length + 1) };
  if (targets?.upstream && has(targets.upstream.remote, targets.upstream.branch)) return { ...targets.upstream };
  const same = remotes.find((r) => r.branches.includes(targets?.branch));
  if (same) return { remote: same.name, branch: targets.branch };
  const first = remotes.find((r) => r.branches.length);
  return first ? { remote: first.name, branch: first.branches[0] } : null;
}

// splitRemoteBranch(git, root, "origin/feature") → { remote, branch } | null.
export async function splitRemoteBranch(git, root, name) {
  const r = await git.read(root, ["remote"]);
  if (!r.ok) return null;
  const n = str(name);
  const remote = r.out.split("\n").map((s) => s.trim()).filter((s) => s && n.startsWith(`${s}/`) && n.length > s.length + 1).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: n.slice(remote.length + 1) } : null;
}

// ---- pull

const fetchRemote = (git, root, remote) => git(root, ["fetch", "--end-of-options", remote], FETCH);

// The result of a request that ran on the current branch: settle's word (git-operation.js),
// the files in the way when git refused, and the range when HEAD moved.
async function settled(git, root, before, run, request, from) {
  const after = await readOperation(git, root);
  let blocked = [];
  if (!run.ok && after.ok && !after.kind && !after.conflicts.length && after.head === before.head) {
    const found = await blockedBy(git, root, request);
    blocked = found.ok ? found.paths : [];
  }
  const outcome = settle(before, after, run, { blocked });
  const to = after.ok ? after.head : null;
  const updated = outcome === "done" && from && to && from !== to ? { from, to } : null;
  return {
    ok: outcome === "done" || outcome === "stopped", code: run.code ?? -1, out: run.out ?? "", err: run.err ?? "", ...(run.msg ? { msg: run.msg } : {}),
    outcome, operation: after.ok ? after : null, updated, changed: true,
    ...(blocked.length ? { blocked, request } : {}),
  };
}

// pull(git, root, { remote, branch, options }) → a result (above), with `request` (the
//   pull as Smart runs it again) when local changes refused it.
//   branch: the remote's branch name ("main"); options: PULL_OPTIONS (others dropped).
//   The remote is fetched first on its own, so a failed fetch is told apart from a merge
//   step that failed (fetchFailed). Without an option, git does as the person's settings
//   say (pull.rebase, pull.ff).
export async function pull(git, root, { remote, branch, options = [] } = {}) {
  const opts = (Array.isArray(options) ? options : []).filter((o) => ACCEPTED.has(o));
  const request = { type: "pull", remote: str(remote), branch: str(branch), options: opts, rebase: opts.includes("--rebase"), target: `${str(remote)}/${str(branch)}` };
  if (!request.remote || !request.branch) return refuse("Choose a remote and a branch to pull.", { key: "remote.pickBranch" });
  const before = await readOperation(git, root);
  if (!before.ok) return failedWith(before);
  const fetched = await fetchRemote(git, root, request.remote);
  if (!fetched.ok) return failedWith(fetched, { fetchFailed: true, changed: true });
  const run = await git(root, ["pull", ...opts, "--end-of-options", request.remote, `refs/heads/${request.branch}`], STEP);
  return settled(git, root, before, run, request, before.head);
}

// ---- Update Project

// The method a branch updates by: "merge" | "rebase".
const methodOf = (method) => (method === "rebase" ? "rebase" : "merge");

// The current branch and its tracked branch, or a refusal with the reason.
async function currentTracking(git, root) {
  const t = await readTracking(git, root);
  if (!t.ok) return { no: failedWith(t) };
  if (!t.branch) return { no: refuse("HEAD is detached: there is no branch to update.", { key: "remote.detached" }) };
  if (!t.upstream) return { no: refuse(`The branch '${t.branch}' has no tracked branch.`, { key: "remote.noTracked", args: { name: t.branch } }) };
  return { t };
}

// updateProject(git, root, { method, now? }) → a result (above)
//   Fetches every remote, then brings the current branch's tracked branch in by `method`
//   ("merge" or "rebase"). Tracked local changes are put away first and brought back
//   after (Smart, git-smart.js: a stop leaves them in the stash with the mark). A detached
//   HEAD or a branch without a tracked branch is refused with the reason, and nothing is
//   fetched. now: the time in the stash's message.
export async function updateProject(git, root, { method, now = new Date() } = {}) {
  const { t, no } = await currentTracking(git, root);
  if (no) return no;
  const fetched = await fetchAll(git, root);
  if (!fetched.ok) return failedWith(fetched, { fetchFailed: true, changed: true });
  const before = await readOperation(git, root);
  if (!before.ok) return failedWith(before, { changed: true });
  const incoming = await hashOf(git, root, t.upstream.ref);
  if (!incoming) return failedWith({ err: `The tracked branch '${t.upstream.name}' is not there.`, msg: { key: "remote.trackedGone", args: { name: t.upstream.name } } }, { changed: true });
  if (before.head && await isAncestor(git, root, incoming, before.head)) {
    return { ok: true, code: 0, out: "", err: "", outcome: "empty", operation: before, updated: null, changed: true };
  }
  const how = methodOf(method);
  const step = (g, r) => g(r, how === "rebase" ? ["rebase", t.upstream.ref] : ["merge", t.upstream.ref], STEP);
  const status = await readStatus(git, root);
  const local = status.ok && status.changes.some((c) => c.status !== "conflict" && c.status !== "unversioned" && c.xy);
  if (!local) return settled(git, root, before, await step(git, root), { type: how, target: t.upstream.ref }, before.head);
  const r = await smartRun(git, root, { request: { type: "Update" }, run: step, now });
  const to = r.operation?.head ?? null;
  const ended = r.outcome === "done" || (r.outcome === "stopped" && !r.operation?.kind);
  return { ...r, updated: ended && before.head && to && to !== before.head ? { from: before.head, to } : null, changed: true };
}

// resetToRemote(git, root, { copy }) → a result with `snapshot`
//   Fetches every remote, then resets the current branch hard to its tracked branch:
//   local commits and changes go. The changes are recorded first as a "Reset" snapshot
//   (git-reset.js resetTo, copy: the calling copy's id); not recorded, not reset.
export async function resetToRemote(git, root, { copy } = {}) {
  const { t, no } = await currentTracking(git, root);
  if (no) return no;
  const fetched = await fetchAll(git, root);
  if (!fetched.ok) return failedWith(fetched, { fetchFailed: true, changed: true });
  const from = await hashOf(git, root, "HEAD");
  const to = await hashOf(git, root, t.upstream.ref);
  if (!to) return failedWith({ err: `The tracked branch '${t.upstream.name}' is not there.`, msg: { key: "remote.trackedGone", args: { name: t.upstream.name } } }, { changed: true });
  const r = await resetTo(git, root, { commit: to, mode: "hard", copy });
  if (!r.ok) return { ...failedWith(r, { changed: true }), snapshot: r.snapshot ?? null };
  return { ok: true, code: 0, out: r.out ?? "", err: "", outcome: "done", operation: null, snapshot: r.snapshot, updated: from && from !== to ? { from, to } : null, changed: true };
}

// ---- updating a branch

// updateBranch(git, root, { name, method }, fetched?) → a result with `name`
//   A branch that isn't checked out moves to its tracked branch, fast-forward only,
//   without a checkout: its remote is fetched, then the local branch is fetched into from
//   the remote branch (git refuses a branch checked out in any worktree). One that
//   diverged from its tracked branch is refused with the reason. The current branch
//   updates as the project does (updateProject, by `method`).
//   fetched: a Set of the remotes fetched already (updateBranches fetches each once).
export async function updateBranch(git, root, { name, method } = {}, fetched = new Set()) {
  const branch = str(name);
  const t = await readTracking(git, root, branch);
  if (!t.ok) return { ...failedWith(t), name: branch };
  if (!t.upstream) return { ...refuse(`The branch '${branch}' has no tracked branch.`, { key: "remote.noTracked", args: { name: branch } }), name: branch };
  const current = await readTracking(git, root);
  if (current.ok && current.branch === branch) return { ...await updateProject(git, root, { method }), name: branch };
  let changed = false;
  if (t.upstream.remote !== "." && !fetched.has(t.upstream.remote)) {
    const f = await fetchRemote(git, root, t.upstream.remote);
    if (!f.ok) return { ...failedWith(f, { fetchFailed: true, changed: true }), name: branch };
    fetched.add(t.upstream.remote);
    changed = true;
  }
  const from = await hashOf(git, root, `refs/heads/${branch}`);
  const to = await hashOf(git, root, t.upstream.ref);
  if (!from || !to) return { ...failedWith({ err: `The tracked branch '${t.upstream.name}' is not there.`, msg: { key: "remote.trackedGone", args: { name: t.upstream.name } } }, { changed }), name: branch };
  if (from === to || await isAncestor(git, root, to, from)) return { ok: true, code: 0, out: "", err: "", outcome: "empty", operation: null, updated: null, changed, name: branch };
  if (!await isAncestor(git, root, from, to)) {
    return { ...refuse(`'${branch}' and '${t.upstream.name}' have diverged: it can only move forward.`, { key: "remote.diverged", args: { name: branch, upstream: t.upstream.name } }, { changed }), name: branch };
  }
  const r = await git(root, ["fetch", "--end-of-options", ".", `${t.upstream.ref}:refs/heads/${branch}`], FETCH);
  if (!r.ok) return { ...failedWith(r, { changed }), name: branch };
  return { ok: true, code: 0, out: r.out, err: "", outcome: "done", operation: null, updated: { from, to }, changed: true, name: branch };
}

// updateBranches(git, root, { names, method }) → { ok, results: [updateBranch's], changed }
//   The Branch tree's "Update Selected": each branch in turn, each remote fetched once.
export async function updateBranches(git, root, { names = [], method } = {}) {
  const fetched = new Set(), results = [];
  for (const name of (Array.isArray(names) ? names : []).filter((x) => typeof x === "string" && x)) {
    results.push(await updateBranch(git, root, { name, method }, fetched));
  }
  return { ok: results.every((r) => r.outcome !== "failed"), err: results.find((r) => r.outcome === "failed")?.err ?? "", results, changed: results.some((r) => r.changed) };
}

// checkoutAndUpdate(git, root, { name }) → a result
//   A local branch moves to its tracked branch (updateBranch, fast-forward only), then is
//   checked out. A refused or failed update checks nothing out. Local changes in the way
//   of the checkout refuse it with the files and the checkout `request` for Smart; the
//   branch has moved by then.
export async function checkoutAndUpdate(git, root, { name } = {}) {
  const up = await updateBranch(git, root, { name });
  if (up.outcome !== "done" && up.outcome !== "empty") return up;
  const request = { type: "checkout", name: str(name), remote: false };
  const c = await checkoutBranch(git, root, request);
  const common = { code: c.code ?? 0, out: c.out ?? "", err: c.err ?? "", ...(c.msg ? { msg: c.msg } : {}), operation: null, updated: up.updated, changed: true };
  if (c.outcome === "done") return { ...common, ok: true, outcome: "done" };
  return { ...common, ok: false, outcome: c.outcome, ...(c.blocked?.length ? { blocked: c.blocked, request } : {}) };
}

// ---- Update Info

const FIELDS = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s";

// readUpdate(git, root, { from, to, skip?, max? }) → { ok, err, commits, more, files }
//   What an update brought in: the commits `to` has and `from` hasn't, newest first,
//   without the ones of `from` a rebase replayed (same change, new commit). Each:
//   { hash, parents, author, email, time (unix seconds), subject }. files: how many files
//   differ between the two.
export async function readUpdate(git, root, { from, to, skip = 0, max = 1000 } = {}) {
  const none = { commits: [], more: false, files: 0 };
  const hex = /^[0-9a-f]{7,64}$/;
  if (!hex.test(str(from)) || !hex.test(str(to))) return { ok: false, err: "Not a commit range.", ...none };
  const r = await git.read(root, ["log", "-z", `--format=${FIELDS}`, "--cherry-pick", "--right-only", `--skip=${Math.max(0, skip | 0)}`, `--max-count=${Math.max(1, max | 0) + 1}`, `${from}...${to}`, "--"]);
  if (!r.ok) return { ok: false, err: r.err, ...none };
  const commits = r.out.split("\0").map((rec) => rec.replace(/^\n+/, "")).filter(Boolean).map((rec) => {
    const [hash, parents, author, email, time, subject] = rec.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], author, email, time: Number(time) || 0, subject: subject ?? "" };
  });
  const d = await git.read(root, ["diff", "--name-only", "-z", "--no-renames", from, to, "--"]);
  const files = d.ok ? d.out.split("\0").filter(Boolean).length : 0;
  const more = commits.length > max;
  return { ok: true, err: "", commits: more ? commits.slice(0, max) : commits, more, files };
}
