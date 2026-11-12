// Branches: reading, checkout, create, fetch, delete (git-branch.test.mjs).
// Every function takes `git` from makeGit (git.js) and the repository root, and returns
// a result instead of throwing. No forced checkout, no remote branch deletion.
// No `herdr` import: node tests it.

// What we refuse ourselves, in the shape git's own answers have.
const refused = (err, more = {}) => ({ ok: false, code: -1, out: "", err, ...more });

const HEADS = "refs/heads/", REMOTES = "refs/remotes/";

// The current branch's name, or null on a detached HEAD (or when git can't say).
// Read in full and cut here: `symbolic-ref --short` answers "heads/main" when a tag
// "main" exists too.
async function currentBranch(git, root) {
  const r = await git.read(root, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = r.ok ? r.out.trim() : "";
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) || null : null;
}
// Fields are split on NUL: a ref name can hold neither NUL nor a newline.
const REF_FORMAT = ["%(refname)", "%(objectname)", "%(symref)", "%(upstream:short)", "%(upstream:track,nobracket)"].join("%00");

// readBranches(git, root) → { ok, err, head, local, remote }
//   head: { branch, hash }: branch is null on a detached HEAD, hash is null in a
//     repository without commits (branch is then the one the first commit will make).
//   local: [{ name, hash, current, upstream, ahead, behind }], by name. upstream is the
//     remote branch it tracks ("origin/main") or null; ahead and behind count commits
//     against it and are 0 without one, or when it is gone from the remote.
//   remote: [{ name, hash }] with name like "origin/feature/login", by name. A remote's
//     HEAD pointer (origin/HEAD) is not a branch and is left out.
export async function readBranches(git, root) {
  const none = { head: { branch: null, hash: null }, local: [], remote: [] };
  const [refs, branch, at] = await Promise.all([
    git.read(root, ["for-each-ref", `--format=${REF_FORMAT}`, "--sort=refname", HEADS, REMOTES]),
    currentBranch(git, root),
    git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
  ]);
  if (!refs.ok) return { ok: false, err: refs.err, ...none };
  const head = { branch, hash: at.ok ? at.out.trim() || null : null };
  const local = [], remote = [];
  for (const line of refs.out.split("\n")) {
    if (!line) continue;
    const [ref, hash, symref, upstream, track] = line.split("\0");
    if (ref.startsWith(HEADS)) {
      const name = ref.slice(HEADS.length);
      local.push({
        name, hash, current: name === head.branch, upstream: upstream || null,
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      });
    } else if (ref.startsWith(REMOTES) && !symref) remote.push({ name: ref.slice(REMOTES.length), hash });
  }
  return { ok: true, err: "", head, local, remote };
}

// checkout(git, root, name, { remote })
//   A local branch: switch to it. remote: true → `name` is a remote branch
//   ("origin/x"): create local "x" tracking it and switch, or switch to "x" if it exists.
//   git's refusal (changes in the way) comes back in err; nothing is forced.
//   → { ok, code, out, err, branch }: branch is the local branch it went for.
export async function checkout(git, root, name, { remote = false } = {}) {
  let local = name;
  if (remote) {
    local = await localNameOf(git, root, name);
    if (!local) return refused(`'${name}' is not a remote branch.`, { branch: null, msg: { key: "log.notRemoteBranch", args: { name } } });
  }
  // --end-of-options: a branch may be called "-f"; it must not become --force. (The full
  // ref name can't be used: `checkout refs/heads/x` detaches HEAD instead of switching.)
  if (await hasRef(git, root, HEADS + local)) return { ...(await git(root, ["checkout", "--end-of-options", local, "--"])), branch: local };
  // Asked for by its local name and there is none: git would guess a remote branch of
  // that name and make one. Only a remote branch that was asked for makes a branch.
  if (!remote) return refused(`'${name}' is not a local branch.`, { branch: local, msg: { key: "log.notLocalBranch", args: { name } } });
  // The full ref: a local branch could be called "origin/x" too.
  return { ...(await git(root, ["checkout", "-b", local, "--track", REMOTES + name, "--"])), branch: local };
}

const hasRef = async (git, root, ref) => (await git.read(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;

// "origin/feature/login" → "feature/login". A remote's own name may hold slashes, so
// the remotes are asked for; the longest one that fits wins.
async function localNameOf(git, root, name) {
  const r = await git.read(root, ["remote"]);
  if (!r.ok) return null;
  let best = null;
  for (const remote of r.out.split("\n")) {
    if (remote && name.startsWith(`${remote}/`) && name.length > remote.length + 1 && (!best || remote.length > best.length)) best = remote;
  }
  return best ? name.slice(best.length + 1) : null;
}

// checkoutRevision(git, root, hash): a detached HEAD at that commit.
export async function checkoutRevision(git, root, hash) {
  return git(root, ["checkout", "--detach", "--end-of-options", String(hash), "--"]);
}

// checkBranchName(git, root, name) → { ok, reason, msg? }: whether a new branch may be
// called that (reason says why not: empty, taken, refused by git; msg comes with the
// reasons worded here, not with git's). Spaces around the name are ignored, as
// createBranch ignores them.
export async function checkBranchName(git, root, name) {
  const wanted = String(name ?? "").trim();
  if (!wanted) return { ok: false, reason: "Enter a branch name.", msg: { key: "log.enterBranchName", args: {} } };
  const invalid = { ok: false, reason: `'${wanted}' is not a valid branch name.`, msg: { key: "log.invalidBranchName", args: { name: wanted } } };
  // "-x" would read as an option; git refuses a branch called HEAD only since 2.16.
  if (wanted === "HEAD" || wanted.startsWith("-")) return invalid;
  const format = await git.read(root, ["check-ref-format", "--branch", wanted]);
  if (format.code < 0) return { ok: false, reason: format.err };
  // --branch also expands "@{-1}" to the branch before: a name must come back as itself.
  if (!format.ok || format.out.trim() !== wanted) return invalid;
  const refs = await git.read(root, ["for-each-ref", "--format=%(refname)", HEADS]);
  if (!refs.ok) return { ok: false, reason: refs.err };
  for (const ref of refs.out.split("\n")) {
    const existing = ref.slice(HEADS.length);
    if (!existing) continue;
    if (existing === wanted) return { ok: false, reason: `Branch '${wanted}' already exists.`, msg: { key: "log.branchExists", args: { name: wanted } } };
    // git keeps a branch as a file: a name can't be a branch and a folder of branches.
    if (existing.startsWith(`${wanted}/`)) return { ok: false, reason: `'${wanted}' is taken: branch '${existing}' exists under it.`, msg: { key: "log.branchUnder", args: { name: wanted, existing } } };
    if (wanted.startsWith(`${existing}/`)) return { ok: false, reason: `Branch '${existing}' exists, so nothing can be named '${existing}/…'.`, msg: { key: "log.branchAbove", args: { existing } } };
  }
  return { ok: true, reason: "" };
}

// createBranch(git, root, { name, from, checkout })
//   from: a full ref name ("refs/heads/x", "refs/remotes/origin/x") or a full commit hash;
//   null → HEAD. A short name or a short hash is refused: "topic" may be a branch and a
//   tag, "origin/x" a remote branch and a local one, and git would pick one of them.
//   checkout: also switch to it. The new branch gets no upstream, whatever it starts from.
//   A name checkBranchName refuses makes nothing (err is its reason). When switching is
//   refused (changes in the way), no branch is left behind.
export async function createBranch(git, root, { name, from = null, checkout = true } = {}) {
  const wanted = String(name ?? "").trim();
  const check = await checkBranchName(git, root, wanted);
  if (!check.ok) return refused(check.reason, check.msg ? { msg: check.msg } : {});
  // The start point is passed as the hash it names, never as typed: a branch called "-f"
  // would otherwise reach git as --force.
  // Without a start point git starts at HEAD, which also works before the first commit.
  const start = [];
  if (from !== null) {
    const at = await startPoint(git, root, from);
    if (!at.ok) return refused(at.err, at.msg ? { msg: at.msg } : {});
    start.push(at.hash);
  }
  if (checkout) return git(root, ["checkout", "-b", wanted, "--no-track", ...start, "--"]);
  return git(root, ["branch", "--no-track", "--", wanted, ...start]);
}

// The commit `from` names, taken exactly: { ok, hash } or { ok: false, err, msg? }.
// A ref must exist under exactly that name: rev-parse would also read "refs/heads/x" as
// refs/heads/refs/heads/x when the first is gone, and take "refs/heads/x~1". A hash must
// be a whole one of this repository: in a SHA-256 one, 40 characters are only a prefix.
async function startPoint(git, root, from) {
  const not = { ok: false, err: `'${from}' is not a branch or a commit.`, msg: { key: "log.notBranchOrCommit", args: { from: String(from) } } };
  const notFull = { ok: false, err: `'${from}' is not a full ref name or commit hash.`, msg: { key: "log.notFullRef", args: { from: String(from) } } };
  if (typeof from !== "string") return notFull;
  let object;
  if (from.startsWith("refs/")) {
    // --verify takes a full ref name only, and no expression on it.
    const ref = await git.read(root, ["show-ref", "--verify", "--", from]);
    if (ref.code < 0) return { ok: false, err: ref.err };
    const [hash, name] = ref.out.trim().split(" ");
    if (!ref.ok || name !== from) return not;
    object = hash;
  } else if (/^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(from)) {
    const whole = await git.read(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", from]);
    if (whole.code < 0) return { ok: false, err: whole.err };
    if (!whole.ok || whole.out.trim() !== from.toLowerCase()) return not;
    object = whole.out.trim();
  } else return notFull;
  const at = await git.read(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${object}^{commit}`]);
  if (!at.ok) return at.code < 0 ? { ok: false, err: at.err } : not;
  return { ok: true, hash: at.out.trim() };
}

// fetchAll(git, root): every remote, pruning remote branches that are gone.
// It never stops to ask for a password (nobody could answer): that is an error instead.
// Up to five minutes; herdr's exec gives a command 30 s unless told otherwise.
export async function fetchAll(git, root) {
  return git(root, ["fetch", "--all", "--prune"], { timeout: 300000, env: { GIT_TERMINAL_PROMPT: "0" } });
}

// deleteBranch(git, root, name, { confirmed }) → { ok, code, out, err, unmerged, deleted? }
//   Local branches only; the current branch and remote branches are refused, confirmed
//   or not.
//   unmerged: how many of its commits no other branch, remote branch, tag or HEAD
//   reaches, so would be lost. With any, it is refused (ok false, unmerged > 0) until
//   confirmed is true. This is our own count, not `git branch -d`'s idea of merged
//   (merged into its upstream or HEAD), so a branch that is pushed somewhere or still
//   part of another branch goes without a question.
//   deleted, when ok: { name, hash, upstream } for restoreBranch. hash is the full hash
//   it pointed at; upstream is { remote, merge } as its config had them ("origin" and
//   "refs/heads/x", or "." for a local branch), or null when it tracked nothing.
export async function deleteBranch(git, root, name, { confirmed = false } = {}) {
  const no = (err, unmerged = 0, msg = undefined) => ({ ...refused(err, msg ? { msg } : {}), unmerged });
  if (!(await hasRef(git, root, HEADS + name))) return no(`'${name}' is not a local branch. Only local branches can be deleted.`, 0, { key: "log.onlyLocalDelete", args: { name } });
  if ((await currentBranch(git, root)) === name) return no(`Cannot delete the current branch '${name}'.`, 0, { key: "log.deleteCurrent", args: { name } });
  const at = await hasRef(git, root, "HEAD");
  // --exclude takes the name without refs/heads/ and applies to the --branches after it.
  const lost = await git.read(root, ["rev-list", "--count", HEADS + name, "--not", `--exclude=${name}`, "--branches", "--remotes", "--tags", ...(at ? ["HEAD"] : [])]);
  if (!lost.ok) return no(lost.err);
  const unmerged = Number(lost.out.trim()) || 0;
  if (unmerged > 0 && !confirmed) return no(`Branch '${name}' has ${unmerged} unmerged ${unmerged === 1 ? "commit" : "commits"} that would be lost.`, unmerged, { key: "log.unmerged", args: { name, n: unmerged } });
  // Read before deleting: `branch -D` drops the branch's config section with it.
  const was = await branchState(git, root, name);
  if (!was.ok) return no(was.err, unmerged, was.msg);
  // -D: `-d` would refuse a branch that isn't merged into HEAD even when another branch
  // or the remote has all of it. The count above is the check.
  const r = await git(root, ["branch", "-D", "--", name]);
  return r.ok ? { ...r, unmerged, deleted: { name, hash: was.hash, upstream: was.upstream } } : { ...r, unmerged };
}

// restoreBranch(git, root, { name, hash, upstream }) → { ok, code, out, err, msg? }
//   Makes local branch `name` at `hash` again and, with an upstream, sets it back
//   ({ remote, merge }: deleteBranch's `deleted`). HEAD and the working tree stay as
//   they are. A branch of that name that exists now is left alone: git's refusal comes
//   back as it is, and no upstream is set. Nothing is forced.
export async function restoreBranch(git, root, { name, hash, upstream = null } = {}) {
  const label = String(name ?? "");
  if (!label || typeof hash !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
    return refused(`Branch '${label}' can't be restored: its commit isn't known.`, { msg: { key: "branches.unknownCommit", args: { name: label } } });
  }
  // The full ref with an empty old value: git makes it only if it doesn't exist. Not
  // `git branch`: it refuses a name like "-f" that deleteBranch can delete, and the
  // name never reaches git as an option.
  const made = await git(root, ["update-ref", "-m", "branch: restored", `${HEADS}${label}`, hash, ""]);
  if (!made.ok || !upstream) return made;
  for (const [part, value] of [["remote", upstream.remote], ["merge", upstream.merge]]) {
    const set = await git(root, ["config", "--", `branch.${label}.${part}`, String(value)]);
    if (!set.ok) return set;
  }
  return made;
}

// A local branch's commit and upstream: { ok, hash, upstream } or { ok: false, err, msg? }.
async function branchState(git, root, name) {
  const at = await git.read(root, ["rev-parse", "--verify", "--quiet", `${HEADS}${name}^{commit}`]);
  if (!at.ok) return at.err ? { ok: false, err: at.err } : { ok: false, err: `'${name}' is not a local branch.`, msg: { key: "log.notLocalBranch", args: { name } } };
  const [remote, merge] = await Promise.all(["remote", "merge"].map((part) => setting(git, root, `branch.${name}.${part}`)));
  if (remote.err !== undefined) return { ok: false, err: remote.err, msg: remote.msg };
  if (merge.err !== undefined) return { ok: false, err: merge.err, msg: merge.msg };
  return { ok: true, hash: at.out.trim(), upstream: remote.value && merge.value ? { remote: remote.value, merge: merge.value } : null };
}

// One config value: { value } (null when unset) or { err }. `config --get` exits 1 for
// an unset key, and only for that.
async function setting(git, root, key) {
  const r = await git.read(root, ["config", "--get", key]);
  if (r.ok) return { value: r.out.replace(/\n$/, "") };
  if (r.code === 1) return { value: null };
  return r.err ? { err: r.err } : { err: `git config ${key} failed.`, msg: { key: "log.configFailed", args: { key } } };
}
