// What the VCS widget and its popup show of a repository's branches: the current branch
// with the commits to pull and to push against what it tracks, the branches checked out
// lately, every local and remote branch, and the tags. Takes `git` from makeGit (git.js)
// and the repository root, and returns a result instead of throwing. No `herdr` import:
// node tests it (git-heads.test.mjs).

import { readBranches } from "./git-branch.js";

// The Recent group of the popup holds this many branches at most.
export const RECENT = 5;
// How far back the HEAD reflog is read for them: enough checkouts to find five branches
// that still exist, without reading years of history on every refresh.
const REFLOG_DEPTH = 300;
// The reflog line git writes for a checkout or a switch. git writes it in English
// whatever the person's language: it is stored, not shown.
const CHECKOUT = /^checkout: moving from (\S+) to (\S+)$/;

const EMPTY = { head: { branch: null, hash: null, detached: false }, current: null, local: [], remote: [], tags: [], recent: [] };

// readHeads(git, root) → { ok, code, out, err, head, current, local, remote, tags, recent }
//   head: { branch, hash, detached }: branch null on a detached HEAD, hash null before the
//     first commit (branch is then the one that commit will make).
//   current: { name, upstream, ahead, behind } for the branch HEAD is on, or null when
//     HEAD is detached. upstream: the remote branch it tracks ("origin/main") or null.
//     behind: its commits not here yet (to pull); ahead: commits here not on it (to push).
//     Both 0 without an upstream or when the upstream is gone.
//   local, remote: as git-branch.js readBranches has them.
//   tags: tag names, by name.
//   recent: up to RECENT local branches, the one checked out last first: each checkout's
//     branch and the one it left, from the HEAD reflog. Branches deleted since, commits
//     checked out detached and remote branches are left out. [] when the reflog is off
//     or empty.
//   Reads only.
export async function readHeads(git, root) {
  let branches, tags, log;
  try {
    [branches, tags, log] = await Promise.all([
      readBranches(git, root),
      git.read(root, ["for-each-ref", "--format=%(refname:strip=2)", "--sort=refname", "refs/tags"]),
      git.read(root, ["log", "-g", `-n${REFLOG_DEPTH}`, "--format=%gs", "HEAD", "--"]),
    ]);
  } catch (error) {
    return { ok: false, code: -1, out: "", err: String(error?.message ?? error), ...EMPTY };
  }
  if (!branches.ok) return { ok: false, code: -1, out: "", err: branches.err || tags.err || "", ...EMPTY };
  const head = { ...branches.head, detached: !branches.head.branch };
  const mine = branches.local.find((b) => b.name === head.branch);
  const current = head.branch
    ? { name: head.branch, upstream: mine?.upstream ?? null, ahead: mine?.ahead ?? 0, behind: mine?.behind ?? 0 }
    : null;
  const exists = new Set(branches.local.map((b) => b.name));
  const recent = [];
  // A repository without commits has no reflog yet, and git says so with an error.
  for (const line of log.ok ? log.out.split("\n") : []) {
    const m = CHECKOUT.exec(line.trim());
    if (!m) continue;
    for (const name of [m[2], m[1]]) {
      if (exists.has(name) && !recent.includes(name)) recent.push(name);
    }
    if (recent.length >= RECENT) break;
  }
  return {
    ok: true, code: 0, out: "", err: "",
    head, current, local: branches.local, remote: branches.remote,
    tags: tags.ok ? tags.out.split("\n").filter(Boolean) : [],
    recent: recent.slice(0, RECENT),
  };
}
