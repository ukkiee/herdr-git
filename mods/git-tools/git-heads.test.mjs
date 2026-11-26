// node git-heads.test.mjs: what the VCS widget and its popup read (the current branch,
// commits to pull and to push, recent branches, tags) against throwaway repositories with
// a local bare remote (no app needed). Each case moves the repository with plain git, the
// way a terminal would, then reads it.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readHeads, widgetFace, faceOf, popupRows, popupStep, rowAgain } from "./git-heads.js";
import { readOperation } from "./git-operation.js";
import { translator } from "./i18n.js";
import { menuItems, branchContext } from "./log-menus.js";
import { trackedBranch } from "./git-branch.js";

// The person's own git settings stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-heads-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const git = makeGit(exec, null);
const raw = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
}).trim();
const commit = (cwd, file, text) => {
  writeFileSync(`${cwd}/${file}`, `${text}\n`);
  raw(cwd, ["add", "-A"]);
  raw(cwd, ["commit", "-q", "-m", text]);
  return raw(cwd, ["rev-parse", "HEAD"]);
};

// origin (bare), `other` pushes to it, `repo` is under test.
//   main: m1 - m2 (origin/main) - o1 - o2 (origin only), and locally m1 - m2 - l1: 1 to push, 2 to pull
//   topic: local only, no upstream
const origin = `${tmp}/origin.git`, repo = `${tmp}/repo`, other = `${tmp}/other`;
raw(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
raw(tmp, ["clone", "-q", origin, other]);
commit(other, "a.txt", "m1");
commit(other, "a.txt", "m2");
raw(other, ["push", "-q", "origin", "HEAD:main"]);
raw(tmp, ["clone", "-q", origin, repo]);
commit(other, "b.txt", "o1");
commit(other, "b.txt", "o2");
raw(other, ["push", "-q", "origin", "HEAD:main"]);
raw(repo, ["fetch", "-q"]);
commit(repo, "c.txt", "l1");

// The current branch, what it tracks, and the commits to pull (behind) and push (ahead).
{
  const r = await readHeads(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.current, { name: "main", upstream: "origin/main", gone: false, ahead: 1, behind: 2 });
  assert.deepEqual(r.head, { branch: "main", hash: raw(repo, ["rev-parse", "HEAD"]), detached: false });
  assert.deepEqual(r.remote.map((b) => b.name), ["origin/main"]);
}

// A branch that tracks nothing: no upstream, nothing to pull or push.
{
  raw(repo, ["checkout", "-q", "-b", "topic"]);
  const r = await readHeads(git, repo);
  assert.deepEqual(r.current, { name: "topic", upstream: null, gone: false, ahead: 0, behind: 0 });
}

// A branch whose remote branch was deleted and pruned: it still names it, gone.
{
  raw(repo, ["push", "-q", "-u", "origin", "topic"]);
  raw(origin, ["branch", "-q", "-D", "topic"]);
  raw(repo, ["fetch", "-q", "--prune"]);
  const r = await readHeads(git, repo);
  assert.deepEqual(r.current, { name: "topic", upstream: "origin/topic", gone: true, ahead: 0, behind: 0 });
  assert.deepEqual(r.local.find((b) => b.name === "topic").gone, true);
  // Its menus have nothing to update from, current or not: the VCS widget popup's rows
  // (popupRows) and the Branch tree's (readBranches' branch, as its target hands it), each
  // through branchContext. A current branch that never tracked one keeps Update on.
  const update = (menu, b, head) => menuItems(menu, () => true, branchContext(b, { head })).find((it) => it.id === "branch.update")?.disabled;
  const popupRow = (heads, name) => popupRows({ heads, op: { ok: true, kind: null, conflicts: [] }, query: "", folded: new Set(), handled: () => true }, translator("en"))
    .find((row) => row.kind === "branch" && row.scope === "local" && row.name === name);
  const treeRow = (heads, name) => { const b = heads.local.find((x) => x.name === name); return { name, scope: "local", current: b.current, upstream: trackedBranch(b), gone: b.gone }; };
  for (const row of [popupRow(r, "topic"), treeRow(r, "topic")]) {
    assert.deepEqual([row.current, row.upstream], [true, null]);
    assert.equal(update("currentBranch", row, r.head), true, "current, gone: Update off");
  }
  raw(repo, ["checkout", "-q", "main"]);
  const away = await readHeads(git, repo);
  for (const row of [popupRow(away, "topic"), treeRow(away, "topic")]) assert.equal(update("localBranch", row, away.head), true, "not current, gone: Update off");
  raw(repo, ["checkout", "-q", "-b", "untracked"]);
  const none = await readHeads(git, repo);
  for (const row of [popupRow(none, "untracked"), treeRow(none, "untracked")]) assert.equal(update("currentBranch", row, none.head), false, "current, never tracked: Update on");
  raw(repo, ["checkout", "-q", "topic"]);
  raw(repo, ["branch", "-q", "-D", "untracked"]);
}

// A detached HEAD: no current branch, the commit HEAD is on.
{
  raw(repo, ["checkout", "-q", "--detach", "main"]);
  const r = await readHeads(git, repo);
  assert.equal(r.ok, true);
  assert.equal(r.current, null);
  assert.deepEqual(r.head, { branch: null, hash: raw(repo, ["rev-parse", "HEAD"]), detached: true });
}

// Recent branches: the local branches HEAD was last checked out to or from, newest
// first, five at most. A branch deleted since, a commit checked out detached and a
// remote branch are not among them.
{
  const r0 = `${tmp}/recent`;
  raw(tmp, ["init", "-q", "-b", "main", r0]);
  commit(r0, "a.txt", "a");
  for (const b of ["b1", "b2", "b3", "b4", "b5", "b6", "gone"]) raw(r0, ["branch", b]);
  // Oldest first: main → b1 → b2 → … → b6 → gone → (detached) → b3 → b6.
  for (const b of ["b1", "b2", "b3", "b4", "b5", "b6", "gone"]) raw(r0, ["checkout", "-q", b]);
  raw(r0, ["checkout", "-q", "--detach"]);
  raw(r0, ["switch", "-q", "b3"]);
  raw(r0, ["branch", "-D", "gone"]);
  raw(r0, ["checkout", "-q", "b6"]);
  const r = await readHeads(git, r0);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.recent, ["b6", "b3", "b5", "b4", "b2"]);
  // A new repository has checked nothing out yet: none.
  const fresh = `${tmp}/fresh`;
  raw(tmp, ["init", "-q", "-b", "main", fresh]);
  const f = await readHeads(git, fresh);
  assert.equal(f.ok, true, f.err);
  assert.deepEqual(f.recent, []);
  assert.deepEqual(f.head, { branch: "main", hash: null, detached: false });
  assert.deepEqual(f.current, { name: "main", upstream: null, gone: false, ahead: 0, behind: 0 });
}

// Tags, by name.
{
  const t = `${tmp}/tags`;
  raw(tmp, ["init", "-q", "-b", "main", t]);
  commit(t, "a.txt", "a");
  raw(t, ["tag", "v2.0"]);
  raw(t, ["tag", "-a", "-m", "one", "v1.0"]);
  const r = await readHeads(git, t);
  assert.deepEqual(r.tags, ["v1.0", "v2.0"]);
}

// Not a repository, or a machine that can't be reached: a result, never a throw.
{
  const r = await readHeads(git, tmp);
  assert.equal(r.ok, false);
  assert.ok(r.err);
  assert.equal(r.current, null);
  const down = await readHeads(makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps"), "/repo");
  assert.equal(down.ok, false);
  assert.deepEqual([down.recent, down.tags, down.local], [[], [], []]);
}

// What the widget keeps of a folder it left (faceOf) shows as the whole read does: a
// branch with commits to pull and to push, a detached HEAD, a merge in conflict, no
// repository. It holds none of the branch and tag lists.
{
  const face = `${tmp}/face`;
  raw(tmp, ["clone", "-q", origin, face]);
  commit(face, "d.txt", "f1");
  commit(other, "e.txt", "o3");
  raw(other, ["push", "-q", "origin", "HEAD:main"]);
  raw(face, ["fetch", "-q"]);
  raw(face, ["tag", "v-face"]);
  const looks = [];
  const look = async (where) => {
    const op = await readOperation(git, where);
    looks.push([await readHeads(git, where), op.ok ? op : null]);
  };
  await look(face);
  raw(face, ["checkout", "-q", "--detach"]);
  await look(face);
  raw(face, ["checkout", "-q", "main"]);
  raw(face, ["checkout", "-q", "-b", "clash"]);
  commit(face, "d.txt", "clash");
  raw(face, ["checkout", "-q", "main"]);
  commit(face, "d.txt", "main side");
  try { raw(face, ["merge", "-q", "clash"]); } catch { /* the conflict is the case */ }
  await look(face);
  await look(tmp);
  const kinds = looks.map(([h, op]) => widgetFace(h, op)?.kind ?? null);
  assert.deepEqual(kinds, ["branch", "detached", "progress", null]);
  assert.deepEqual(widgetFace(...looks[0]), { kind: "branch", name: "main", ahead: 1, behind: 1 });
  for (const [h, op] of looks) {
    assert.deepEqual(widgetFace(faceOf(h), op), widgetFace(h, op));
    for (const list of ["local", "remote", "tags", "recent"]) assert.equal(faceOf(h)?.[list], undefined, list);
  }
  raw(face, ["merge", "--abort"]);
}

// ---- what the widget shows (widgetFace)

const heads = (over = {}) => ({
  ok: true,
  head: { branch: "main", hash: "0acda529aa11bb22cc33dd44ee55ff6677889900", detached: false },
  current: { name: "main", upstream: "origin/main", ahead: 2, behind: 1 },
  local: [
    { name: "feature", upstream: null, ahead: 0, behind: 0, current: false },
    { name: "main", upstream: "origin/main", ahead: 2, behind: 1, current: true },
    { name: "topic", upstream: "origin/topic", ahead: 0, behind: 3, current: false },
  ],
  remote: [{ name: "origin/main" }, { name: "origin/topic" }, { name: "upstream/main" }],
  tags: ["v1.0"],
  recent: ["main", "topic", "feature"],
  ...over,
});
const op = (over = {}) => ({ ok: true, kind: null, branch: "main", head: "0acda529aa11bb22cc33dd44ee55ff6677889900", rebasing: null, step: null, conflicts: [], canContinue: false, canSkip: false, sequence: false, ...over });
const UU = [{ path: "f.txt", xy: "UU", ours: "modified", theirs: "modified" }];
const en = translator("en"), ko = translator("ko");

// A branch: its name and the commits to pull and push.
assert.deepEqual(widgetFace(heads(), op()), { kind: "branch", name: "main", ahead: 2, behind: 1 });
// A detached HEAD: the commit, as short as the Branch tree's HEAD row shows it.
assert.deepEqual(widgetFace(heads({ head: { branch: null, hash: "0acda529aa11", detached: true }, current: null }), op({ branch: null })), { kind: "detached", name: "0acda52" });
// Not a repository (or not read): nothing.
assert.equal(widgetFace({ ok: false }, null), null);
// A merge in conflict: ≫ opens the Conflicts dialog, ■ aborts; resolved, ≫ commits it.
{
  const f = widgetFace(heads(), op({ kind: "merge", conflicts: UU }));
  assert.deepEqual(f, { kind: "progress", name: { key: "ops.merging", args: { name: "main" } }, next: { key: "vcs.resolveConflicts", run: "conflicts" }, stop: { key: "ops.abortMerge" } });
  assert.equal(`⚠ ${ko(f.name.key, f.name.args)}`, "⚠ main 병합 중");
  assert.deepEqual([en(f.next.key), ko(f.next.key), ko(f.stop.key)], ["Resolve Conflicts…", "충돌 해결…", "병합 중단"]);
  assert.deepEqual(widgetFace(heads(), op({ kind: "merge", canContinue: true })).next, { key: "vcs.commitMerge", run: "continue" });
}
// A rebase: ≫ is Continue Rebase, which opens the Conflicts dialog while any are left.
{
  const at = { kind: "rebase", branch: null, rebasing: "feature", conflicts: UU, canSkip: true };
  const f = widgetFace(heads({ current: null, head: { branch: null, hash: "1234567890", detached: true } }), op(at));
  assert.deepEqual(f, { kind: "progress", name: { key: "ops.rebasing", args: { name: "feature" } }, next: { key: "vcs.continueRebase", run: "conflicts" }, stop: { key: "ops.abortRebase" } });
  assert.equal(ko(f.next.key), "리베이스 계속 진행");
  assert.equal(widgetFace(heads(), op({ ...at, conflicts: [], canContinue: true })).next.run, "continue");
}
// Cherry-pick and revert: in conflict, Resolve; resolved, Continue.
assert.deepEqual(widgetFace(heads(), op({ kind: "cherry-pick", canContinue: true })).next, { key: "vcs.continueCherryPick", run: "continue" });
assert.deepEqual(widgetFace(heads(), op({ kind: "revert", conflicts: UU })).next, { key: "vcs.resolveConflicts", run: "conflicts" });
assert.deepEqual(widgetFace(heads(), op({ kind: "revert", canContinue: true })).stop, { key: "ops.abortRevert" });

// ---- the popup (popupRows)

// Every action the popup has is handled here, unless a case says otherwise.
const all = () => true;
const shape = (rows) => rows.map((r) => r.kind === "rule" ? "|"
  : r.kind === "group" ? `[${r.label}]`
  : r.kind === "folder" ? `${r.label}/`
  : r.kind === "branch" ? `${r.scope}:${r.name}`
  : r.label);

// Nothing in progress: the actions on top, then the new ones, then the trees. The
// popup opens with Recent and Local open.
{
  const rows = popupRows({ heads: heads(), op: op(), query: "", folded: new Set(["remote", "tags"]), handled: all }, en);
  assert.deepEqual(shape(rows), [
    "Update Project…", "Commit…", "Push…", "|",
    "New Branch…", "New Worktree…", "Checkout Tag or Revision…", "|",
    "[Recent]", "recent:main", "recent:topic", "recent:feature",
    "[Local]", "local:feature", "local:main", "local:topic",
    "[Remote]", "[Tags]",
  ]);
  const main = rows.find((r) => r.scope === "recent" && r.name === "main");
  assert.deepEqual([main.current, main.upstream, main.ahead, main.behind], [true, "origin/main", 2, 1]);
  assert.deepEqual(popupRows({ heads: heads(), op: op(), query: "", folded: new Set(), handled: all }, ko).filter((r) => r.kind !== "branch" && r.kind !== "folder").map((r) => r.kind === "rule" ? "|" : r.label), [
    "프로젝트 업데이트…", "커밋…", "푸시…", "|", "새 브랜치…", "새 워크트리…", "태그 또는 리비전 체크아웃…", "|", "최근", "로컬", "원격", "태그",
  ]);
}

// A branch whose remote branch is gone shows as one that tracks nothing: no name on its
// right, so its menu has no tracked branch and nothing to update from.
{
  const gone = heads({ local: [{ name: "done", upstream: "origin/done", gone: true, ahead: 0, behind: 0, current: false }], recent: ["done"] });
  const rows = popupRows({ heads: gone, op: op(), query: "", folded: new Set(), handled: all }, en);
  assert.deepEqual(rows.filter((r) => r.name === "done").map((r) => [r.scope, r.upstream]), [["recent", null], ["local", null]]);
  const menu = menuItems("localBranch", () => true, { name: "done", current: "main", upstream: rows.find((r) => r.name === "done").upstream ?? "" });
  const items = new Map(menu.map((it) => [it.id, it.disabled]));
  assert.deepEqual([items.get("branch.checkoutAndUpdate"), items.get("branch.update"), items.has("branch.trackedBranch")], [true, true, false]);
}

// Remote branches sit under their remote's folder; tags by name.
{
  const rows = popupRows({ heads: heads(), op: op(), query: "", folded: new Set(["recent", "local"]), handled: all }, en);
  assert.deepEqual(shape(rows).slice(8), ["[Recent]", "[Local]", "[Remote]", "origin/", "remote:origin/main", "remote:origin/topic", "upstream/", "remote:upstream/main", "[Tags]", "tag:v1.0"]);
  // A row names its branch as the tree shows it: without the remote under its folder.
  assert.deepEqual(rows.filter((r) => r.scope === "remote").map((r) => r.label), ["main", "topic", "main"]);
}

// An action nothing does yet doesn't show, and the rules close up around what's left.
{
  const only = (ids) => (id) => ids.includes(id);
  const rows = popupRows({ heads: heads(), op: op(), query: "", folded: new Set(["recent", "local", "remote", "tags"]), handled: only(["vcs.commit", "vcs.push", "vcs.newBranch"]) }, en);
  assert.deepEqual(shape(rows), ["Commit…", "Push…", "|", "New Branch…", "|", "[Recent]", "[Local]", "[Remote]", "[Tags]"]);
  assert.deepEqual(rows.filter((r) => r.kind === "action").map((r) => r.id), ["vcs.commit", "vcs.push", "vcs.newBranch"]);
}

// An operation in progress: its items right after the actions on top, in the order the
// reference has them. Continue opens the Conflicts dialog while any are left (as ≫ does).
{
  const at = (over) => popupRows({ heads: heads(), op: op(over), query: "", folded: new Set(["recent", "local", "remote", "tags"]), handled: all }, ko);
  const middle = (rows) => shape(rows).slice(4, shape(rows).indexOf("|", 4));
  assert.deepEqual(middle(at({ kind: "rebase", rebasing: "feature", conflicts: UU, canSkip: true })), ["리베이스 중단", "리베이스 계속 진행", "커밋 건너 뛰기"]);
  assert.deepEqual(middle(at({ kind: "merge", conflicts: UU })), ["병합 중단"]);
  assert.deepEqual(middle(at({ kind: "cherry-pick", canContinue: true })), ["체리픽 중단", "Cherry-Pick 계속"]);
  assert.deepEqual(middle(at({ kind: "revert", conflicts: UU })), ["되돌리기 취소"]);
  const rebase = at({ kind: "rebase", rebasing: "feature", conflicts: UU, canSkip: true }).filter((r) => r.kind === "action");
  assert.deepEqual(rebase.slice(3, 6).map((r) => [r.id, r.run]), [["ops.abort", "abort"], ["ops.continue", "conflicts"], ["ops.skip", "skip"]]);
  assert.equal(at({ kind: "rebase", rebasing: "feature", canContinue: true, canSkip: true }).find((r) => r.id === "ops.continue").run, "continue");
}

// Search filters branch names and action names together; a group with nothing that
// matches goes, and one with matches opens whatever was folded.
{
  const rows = popupRows({ heads: heads(), op: op(), query: "TOP", folded: new Set(["recent", "local", "remote", "tags"]), handled: all }, en);
  assert.deepEqual(shape(rows), ["[Recent]", "recent:topic", "[Local]", "local:topic", "[Remote]", "origin/", "remote:origin/topic"]);
  assert.deepEqual(shape(popupRows({ heads: heads(), op: op(), query: "push", folded: new Set(), handled: all }, en)), ["Push…"]);
  assert.deepEqual(shape(popupRows({ heads: heads(), op: op(), query: "브랜치", folded: new Set(), handled: all }, ko)), ["새 브랜치…"]);
  assert.deepEqual(popupRows({ heads: heads(), op: op(), query: "nothing-like-this", folded: new Set(), handled: all }, en), []);
}

// A folded group is its count alone: none of what it hides is read or made into a row,
// so a repository with tens of thousands of tags opens the popup as fast as any.
{
  const reads = { n: 0 };
  const names = Array.from({ length: 30000 }, (_, i) => `v${i}`);
  const tags = new Proxy(names, { get: (list, key) => { if (typeof key === "string" && /^\d+$/.test(key)) reads.n++; return Reflect.get(list, key); } });
  const remote = Array.from({ length: 1500 }, (_, i) => ({ name: `origin/b${i}` }));
  const rows = popupRows({ heads: heads({ tags, remote }), op: op(), query: "", folded: new Set(["remote", "tags"]), handled: all }, en);
  assert.deepEqual(rows.filter((r) => r.kind === "group" && r.id !== "recent" && r.id !== "local").map((r) => [r.label, r.open, r.count]), [["Remote", false, 1500], ["Tags", false, 30000]]);
  assert.equal(rows.some((r) => r.kind === "branch" && (r.scope === "tag" || r.scope === "remote")), false);
  assert.equal(reads.n, 0);
  // Open, they are rows as before.
  const open = popupRows({ heads: heads({ tags: names.slice(0, 3), remote: remote.slice(0, 2) }), op: op(), query: "", folded: new Set(["recent", "local"]), handled: all }, en);
  assert.deepEqual(shape(open).slice(-8), ["[Remote]", "origin/", "remote:origin/b0", "remote:origin/b1", "[Tags]", "tag:v0", "tag:v1", "tag:v2"]);
}

// ↓ and ↑ in the popup skip lines and remote folders. While searching, the groups stay
// open whatever is pressed, so their heads are skipped too: ↓ after typing lands on the
// first branch. Without a search a head folds and unfolds, and the keys stop on it.
{
  const query = "TOP";
  const rows = popupRows({ heads: heads(), op: op(), query, folded: new Set(), handled: all }, en);
  const label = (i) => shape([rows[i]])[0];
  assert.equal(label(popupStep(rows, -1, 1, { query })), "recent:topic");
  assert.equal(label(popupStep(rows, popupStep(rows, -1, 1, { query }), 1, { query })), "local:topic");
  assert.equal(label(popupStep(rows, -1, -1, { query })), "remote:origin/topic");
  const plain = popupRows({ heads: heads(), op: op(), query: "", folded: new Set(["recent", "local", "remote", "tags"]), handled: all }, en);
  assert.equal(shape([plain[popupStep(plain, -1, 1, { query: "" })]])[0], shape(plain)[0]);
  assert.equal(shape([plain[popupStep(plain, -1, -1, { query: "" })]])[0], "[Tags]");
  assert.equal(popupStep([], -1, 1, { query: "" }), -1);
}

// rowAgain: the row the keyboard was on, found again in the rows of a newer read.
{
  const rows = [{ kind: "action", id: "vcs.commit" }, { kind: "group", id: "local" }, { kind: "branch", scope: "local", name: "main" }, { kind: "branch", scope: "recent", name: "main" }];
  assert.equal(rowAgain(rows, { kind: "branch", scope: "recent", name: "main", label: "main" }), 3);
  assert.equal(rowAgain(rows, { kind: "group", id: "local", open: false }), 1);
  assert.equal(rowAgain(rows, { kind: "branch", scope: "local", name: "gone" }), -1);
  assert.equal(rowAgain(rows, undefined), -1);
}

console.log("git-heads: ok");
