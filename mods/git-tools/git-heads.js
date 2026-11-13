// What the VCS widget and its popup show of a repository's branches: the current branch
// with the commits to pull and to push against what it tracks, the branches checked out
// lately, every local and remote branch, and the tags. Takes `git` from makeGit (git.js)
// and the repository root, and returns a result instead of throwing. No `herdr` import:
// node tests it (git-heads.test.mjs).

import { readBranches } from "./git-branch.js";
import { operationName } from "./git-operation.js";

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

// ---- what the widget and the popup show (pure)

// The hash a detached HEAD shows as, as the reference product writes commits.
const SHORT = 8;
const ABORT = { merge: "ops.abortMerge", rebase: "ops.abortRebase", "cherry-pick": "ops.abortCherryPick", revert: "ops.abortRevert" };
// ≫ once no conflict is left: what goes on from there.
const GO_ON = { merge: "vcs.commitMerge", rebase: "vcs.continueRebase", "cherry-pick": "vcs.continueCherryPick", revert: "vcs.continueRevert" };

// widgetFace(heads, op) → what the VCS widget shows, or null (not a repository, not read):
//   { kind: "branch", name, ahead, behind }   the branch HEAD is on
//   { kind: "detached", name }                 the commit HEAD is on, short
//   { kind: "progress", name, next, stop }     an operation in progress: name { key, args }
//     (operationName), next: the ≫ button { key, run }, stop: the ■ button { key }.
//     run: "conflicts" (open the Conflicts dialog) while a file is still in conflict,
//     else "continue". A rebase's ≫ is Continue Rebase either way.
// heads: readHeads' result; op: readOperation's (null when not read).
export function widgetFace(heads, op) {
  if (!heads?.ok) return null;
  if (op?.kind) {
    const run = op.conflicts?.length ? "conflicts" : "continue";
    const key = op.kind === "rebase" || run === "continue" ? GO_ON[op.kind] : "vcs.resolveConflicts";
    return { kind: "progress", name: operationName(op), next: { key, run }, stop: { key: ABORT[op.kind] } };
  }
  if (heads.head?.detached) return { kind: "detached", name: (heads.head.hash ?? "HEAD").slice(0, SHORT) };
  return { kind: "branch", name: heads.current.name, ahead: heads.current.ahead, behind: heads.current.behind };
}

// The popup's actions, by section, in the reference product's order. The ones in the
// middle show only while an operation is in progress (ongoingItems).
const TOP = ["vcs.updateProject", "vcs.commit", "vcs.push"];
const NEW = ["vcs.newBranch", "vcs.newWorktree", "vcs.checkoutRef"];
const GROUPS = [["recent", "vcs.recent"], ["local", "vcs.local"], ["remote", "vcs.remote"], ["tags", "vcs.tags"]];

// The in-progress items: { id, key, run } with run "abort" | "continue" | "conflicts" |
// "skip" (Continue opens the Conflicts dialog while a file is in conflict, as ≫ does).
function ongoingItems(op) {
  if (!op?.kind) return [];
  const go = op.conflicts?.length ? "conflicts" : "continue";
  const abort = { id: "ops.abort", key: ABORT[op.kind], run: "abort" };
  if (op.kind === "rebase") {
    return [abort, { id: "ops.continue", key: "vcs.continueRebase", run: go }, ...(op.canSkip ? [{ id: "ops.skip", key: "ops.skipCommit", run: "skip" }] : [])];
  }
  if (op.kind === "cherry-pick") return [abort, { id: "ops.continue", key: "vcs.continueCherryPick", run: go }];
  return [abort];
}

// popupRows({ heads, op, query, folded, handled }, t) → the popup's rows, top to bottom:
//   { kind: "action", id, label, run? }     an action (run: an in-progress item's, above)
//   { kind: "rule" }                         a line between sections
//   { kind: "group", id, label, open, count } Recent, Local, Remote, Tags
//   { kind: "folder", label }                a remote, under Remote
//   { kind: "branch", scope, name, label, current, upstream, ahead, behind }
//     scope: "recent" | "local" | "remote" | "tag"; name: the full short name
//     ("origin/main"), label: as the tree shows it ("main" under origin).
// query: the search box's text; it keeps the actions and branches whose name holds it
// (any case), drops the groups left empty and opens the rest. folded: the group ids
// folded. handled(id): whether the screen does that action; one it doesn't is left out.
// t: the translator the labels are worded with.
export function popupRows({ heads, op, query = "", folded = new Set(), handled = () => true }, t) {
  const words = String(query).trim().toLowerCase();
  const hit = (text) => !words || text.toLowerCase().includes(words);
  const actions = (items) => items
    .map((it) => (typeof it === "string" ? { id: it, key: it } : it))
    .filter((it) => handled(it.id))
    .map((it) => ({ kind: "action", id: it.id, label: t(it.key), ...(it.run ? { run: it.run } : {}) }))
    .filter((r) => hit(r.label));
  const local = new Map((heads?.local ?? []).map((b) => [b.name, b]));
  const branch = (scope, name, label = name) => {
    const b = scope === "recent" || scope === "local" ? local.get(name) : null;
    return { kind: "branch", scope, name, label, current: Boolean(b?.current), upstream: b?.upstream ?? null, ahead: b?.ahead ?? 0, behind: b?.behind ?? 0 };
  };
  const trees = [];
  for (const [id, key] of GROUPS) {
    let rows;
    if (id === "remote") {
      rows = [];
      let remote = null;
      for (const b of heads?.remote ?? []) {
        if (!hit(b.name)) continue;
        const cut = b.name.indexOf("/"), name = cut < 0 ? "" : b.name.slice(0, cut);
        if (name !== remote) { remote = name; rows.push({ kind: "folder", label: name }); }
        rows.push(branch("remote", b.name, cut < 0 ? b.name : b.name.slice(cut + 1)));
      }
    } else {
      const names = id === "recent" ? heads?.recent ?? [] : id === "local" ? (heads?.local ?? []).map((b) => b.name) : heads?.tags ?? [];
      rows = names.filter(hit).map((name) => branch(id === "tags" ? "tag" : id, name));
    }
    const count = rows.filter((r) => r.kind === "branch").length;
    if (!count) continue;
    const open = Boolean(words) || !folded.has(id);
    trees.push({ kind: "group", id, label: t(key), open, count }, ...(open ? rows : []));
  }
  const sections = [actions(TOP), actions(ongoingItems(op)), actions(NEW), trees].filter((s) => s.length);
  return sections.flatMap((s, i) => (i ? [{ kind: "rule" }, ...s] : s));
}
