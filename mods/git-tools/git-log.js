// Reading commits for the Commit list, and wording what a row shows (ref labels, times).
// No `herdr` import: node tests it (git-log.test.mjs).

import { formatTime } from "./i18n.js";

// Fields end in NUL and -z ends each commit in NUL, so a subject may hold anything a
// commit message can (quotes, pipes, control characters): nothing is split on text.
// %aN/%aE: the author as .mailmap maps them, the names the User list and filter use.
const FIELDS = ["%H", "%P", "%aN", "%aE", "%ct", "%at", "%D", "%s"];
const FORMAT = `--format=${FIELDS.join("%x00")}`;

// "HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main" → refs.
// Ref names hold no spaces, so ", " only ever separates. origin/HEAD and refs outside
// branches and tags (the stash, notes) are not labels.
function parseRefs(text) {
  const refs = [];
  let current = null;
  for (const part of text ? text.split(", ") : []) {
    let name = part;
    if (name.startsWith("HEAD -> ")) { name = name.slice(8); current = name; refs.push({ name: "HEAD", kind: "head" }); }
    else if (name === "HEAD") { refs.push({ name: "HEAD", kind: "head" }); continue; }
    if (name.startsWith("tag: ")) name = name.slice(5);
    if (name.startsWith("refs/heads/")) refs.push(name === current ? { name: name.slice(11), kind: "local", current: true } : { name: name.slice(11), kind: "local" });
    else if (name.startsWith("refs/remotes/")) { if (!name.endsWith("/HEAD")) refs.push({ name: name.slice(13), kind: "remote" }); }
    else if (name.startsWith("refs/tags/")) refs.push({ name: name.slice(10), kind: "tag" });
  }
  return refs;
}

// readLog(git, root, { skip, count, branch, extra, tags })
//   git: from makeGit (git.js). root: the repository root.
//   skip / count: the batch (count defaults to 1,000). branch: null → every branch, remote
//   branch and tag plus HEAD, in commit-date order (children before their parents, which
//   graph.js relies on); a ref name → only what that ref reaches.
//   tags: false leaves tags out, as labels and as places to start from (so a commit only
//   a tag reaches is missing). git then opens no tag at all, which is most of the time
//   the full read takes in a repository with tens of thousands of them.
//   extra: more `git log` arguments, from git-log-filter.js (already safe to pass on):
//   options first, then optionally "--" and paths.
//   The graph options (log-options.js readArgs):
//   order: "date" (children before parents, then newest first) or "topo" (a merged
//   branch's commits together under the merge). Both keep children before parents.
//   firstParent: follow only first parents from each starting point. A merge still
//   lists both parents; graph.js draws the first.
//   noMerges: merge commits are left out. git keeps the real parents of the commits
//   under a merge (`--no-merges` rewrites nothing), so merges are read and dropped here,
//   and the answer has through: [[merge, its first parent]] for graph.js to join the
//   lines across them, and read: how many commits git gave, which is what `skip` goes
//   on from (a batch may show fewer than it read).
//   → { ok, err, commits } (with noMerges also { read, through })
//   commit: { hash, parents: [hash], subject, author, email, time, authorTime, refs }
//     time: commit date, authorTime: author date, unix seconds. refs: [{ name, kind,
//     current? }] with kind "head" | "local" | "remote" | "tag". "head" marks the commit
//     HEAD is on; the branch HEAD is on has current: true (a detached HEAD has "head"
//     and no current).
//   A repository without commits is { ok: true, commits: [] }.
export async function readLog(git, root, { skip = 0, count = 1000, branch = null, extra = [], tags = true, order = "date", firstParent = false, noMerges = false } = {}) {
  const cut = extra.indexOf("--");
  const options = cut < 0 ? extra : extra.slice(0, cut), paths = cut < 0 ? [] : extra.slice(cut + 1);
  let revs;
  if (branch) revs = ["--end-of-options", branch];
  else {
    // HEAD is named so a detached HEAD's commits show; an unborn HEAD can't be named.
    const head = await git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (!head.ok && head.code !== 1) return { ok: false, err: head.err, commits: [] };
    revs = ["--branches", "--remotes", ...(tags ? ["--tags"] : []), ...(head.ok ? ["HEAD"] : [])];
  }
  const r = await git.read(root, ["log", "-z", FORMAT, order === "topo" ? "--topo-order" : "--date-order", ...(firstParent ? ["--first-parent"] : []),
    "--decorate=full", ...(tags ? [] : ["--decorate-refs-exclude=refs/tags/*"]), "--no-show-signature", "--no-color",
    `--skip=${Math.max(0, skip)}`, `--max-count=${Math.max(0, count)}`, ...options, ...revs, "--", ...paths]);
  if (!r.ok) return { ok: false, err: r.err, commits: [] };
  const parts = r.out.split("\0");
  const commits = [];
  for (let i = 0; i + FIELDS.length <= parts.length; i += FIELDS.length) {
    const [hash, parents, author, email, time, authorTime, refs, subject] = parts.slice(i, i + FIELDS.length);
    commits.push({ hash, parents: parents ? parents.split(" ") : [], subject, author, email, time: Number(time), authorTime: Number(authorTime), refs: parseRefs(refs) });
  }
  if (!noMerges) return { ok: true, err: "", commits };
  const through = commits.filter((c) => c.parents.length > 1).map((c) => [c.hash, c.parents[0]]);
  return { ok: true, err: "", commits: commits.filter((c) => c.parents.length <= 1), read: commits.length, through };
}

// readNotPicked(git, root, branch) → { ok, err, notPicked: [hash] }
//   The commits of `branch` whose change the current branch (HEAD) has no copy of: not
//   reachable from HEAD and no commit there with an equal patch (`git cherry`'s "+").
//   Every other commit of the branch is already on the current branch.
export async function readNotPicked(git, root, branch) {
  const r = await git.read(root, ["cherry", "HEAD", branch]);
  if (!r.ok) return { ok: false, err: r.err || `git cherry failed (${r.code})`, notPicked: [] };
  const notPicked = r.out.split("\n").filter((line) => line.startsWith("+ ")).map((line) => line.slice(2).trim());
  return { ok: true, err: "", notPicked };
}

// readRefsState(git, root) → { ok, err, state }
//   One string that changes whenever a branch, a remote branch, a tag or HEAD moves
//   (commit, checkout, fetch, branch created or deleted). The Log panel compares it to
//   know when to read the list again, instead of reading on every change under .git.
export async function readRefsState(git, root) {
  const [refs, head] = await Promise.all([
    git.read(root, ["for-each-ref", "--format=%(objectname) %(refname) %(HEAD)"]),
    git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
  ]);
  if (!refs.ok) return { ok: false, err: refs.err, state: "" };
  return { ok: true, err: "", state: `${head.out.trim()}\n${refs.out}` };
}

// readGitDir(git, root) → { ok, err, dir }: the folder the repository keeps its refs in
// (absolute). For a linked worktree that is the main checkout's .git, where branches
// move. The Log panel watches it.
export async function readGitDir(git, root) {
  const r = await git.read(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dir = r.out.trim();
  if (r.ok && dir.startsWith("/")) return { ok: true, err: "", dir };
  return { ok: false, err: r.err, dir: null };
}

// refsChanged(dir, paths) → whether a batch of changed paths under the git folder can
// have moved a ref or HEAD (not the index, objects or lock files). A batch holding the
// folder itself means "anything may have changed".
export function refsChanged(dir, paths) {
  return paths.some((path) => path === dir || (!path.endsWith(".lock") && (/\/(HEAD|packed-refs|FETCH_HEAD|ORIG_HEAD)$/.test(path) || path.includes("/refs/"))));
}

// resolveCommit(git, root, text) → { ok, err, hash }: the full hash of the commit a
// (short) hash or ref names; ok: false and hash: null when there is none.
export async function resolveCommit(git, root, text) {
  const r = await git.read(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${text}^{commit}`]);
  const hash = r.out.trim();
  if (r.ok && hash) return { ok: true, err: "", hash };
  if (r.err) return { ok: false, err: r.err, hash: null };
  return { ok: false, err: `No commit ${text}`, hash: null, msg: { key: "log.noCommit", args: { text } } };
}

// ---- wording a row (pure)

// Long ref names lose their middle: both ends tell branches apart.
export function shortenMiddle(name, max = 28) {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

// labelRefs(refs, { max }) → [{ text, kind, current }]
//   The Ref labels of one commit. A local branch and the remote branches of the same
//   name are one label ("origin & main"). HEAD is a label only when detached. Order:
//   HEAD, the current branch, other local branches, remote branches, tags.
//   current: HEAD is here (the label to emphasize). max: longest text, see shortenMiddle.
export function labelRefs(refs, { max = 28 } = {}) {
  if (!refs.length) return [];
  const locals = refs.filter((r) => r.kind === "local").sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)));
  const remotes = refs.filter((r) => r.kind === "remote");
  const labels = [];
  if (refs.some((r) => r.kind === "head") && !locals.some((r) => r.current)) labels.push({ text: "HEAD", kind: "head", current: true });
  const merged = new Set();
  for (const local of locals) {
    const twins = remotes.filter((r) => r.name.slice(r.name.indexOf("/") + 1) === local.name);
    for (const twin of twins) merged.add(twin);
    const text = [...twins.map((r) => r.name.slice(0, r.name.indexOf("/"))), local.name].join(" & ");
    labels.push({ text, kind: "local", current: Boolean(local.current) });
  }
  for (const remote of remotes) if (!merged.has(remote)) labels.push({ text: remote.name, kind: "remote", current: false });
  for (const tag of refs) if (tag.kind === "tag") labels.push({ text: tag.name, kind: "tag", current: false });
  return labels.map((label) => ({ ...label, text: shortenMiddle(label.text, max) }));
}

// formatCommitTime(seconds, now) → "25 minutes ago" within the hour, "Today 2:30 PM",
// "Yesterday 11:06 PM", else "11/9/26, 9:05 AM". Local time. now: a Date. Always English;
// a screen writes the time in its own language with i18n.js formatTime(seconds, lang).
export function formatCommitTime(seconds, now = new Date()) {
  return formatTime(seconds, "en", now);
}
