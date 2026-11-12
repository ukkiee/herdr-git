// node git-branch.test.mjs: branches against throwaway repositories with a local bare
// remote (no app needed). Each check calls a function, then reads the repository again
// with git itself.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { translator } from "./i18n.js";
import { readBranches, checkout, checkoutRevision, checkBranchName, createBranch, fetchAll, deleteBranch, restoreBranch, readDeletedBranches } from "./git-branch.js";

const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-branch-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const git = makeGit(exec, null);

const raw = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "Ann Lee", GIT_AUTHOR_EMAIL: "ann@example.com", GIT_COMMITTER_NAME: "Ann Lee", GIT_COMMITTER_EMAIL: "ann@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();
// Like raw, but a failure is an answer (null) instead of a throw.
const ask = (cwd, args) => { try { return raw(cwd, args); } catch { return null; } };
const commit = (cwd, file, text) => {
  writeFileSync(`${cwd}/${file}`, `${text}\n`);
  raw(cwd, ["add", "-A"]);
  raw(cwd, ["commit", "-q", "-m", text]);
  return raw(cwd, ["rev-parse", "HEAD"]);
};
const current = (cwd) => ask(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
const exists = (cwd, ref) => ask(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== null;
const names = (list) => list.map((b) => b.name);

// origin (bare) and two clones of it: `repo` is the one under test, `other` is a
// teammate who pushes so there is something to fetch.
//   main:          m1 - m2 (origin/main) - m3 (local only)
//   feature/login: m1 - f1 (origin) and locally reset to m1 + own commit: 1 ahead, 1 behind
//   topic/two:     m2 - t1, local only, no upstream
//   release/1.0:   origin only
const origin = `${tmp}/origin.git`, repo = `${tmp}/repo`, other = `${tmp}/other`;
raw(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
raw(tmp, ["clone", "-q", origin, other]);
const m1 = commit(other, "a.txt", "m1");
raw(other, ["push", "-q", "origin", "HEAD:main"]);
raw(other, ["checkout", "-q", "-b", "feature/login"]);
const f1 = commit(other, "login.txt", "f1");
raw(other, ["push", "-q", "origin", "feature/login"]);
raw(other, ["checkout", "-q", "-b", "release/1.0", m1]);
const r1 = commit(other, "release.txt", "r1");
raw(other, ["push", "-q", "origin", "release/1.0"]);
raw(other, ["checkout", "-q", "main"]);
const m2 = commit(other, "a.txt", "m2");
raw(other, ["push", "-q", "origin", "main"]);

raw(tmp, ["clone", "-q", origin, repo]);
raw(repo, ["checkout", "-q", "-b", "feature/login", "--track", "origin/feature/login"]);
raw(repo, ["reset", "-q", "--hard", m1]);
const fLocal = commit(repo, "mine.txt", "f-local");
raw(repo, ["checkout", "-q", "-b", "topic/two", "--no-track", "origin/main"]);
const t1 = commit(repo, "two.txt", "t1");
raw(repo, ["checkout", "-q", "main"]);
const m3 = commit(repo, "b.txt", "m3");

// ---- readBranches

{
  const r = await readBranches(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.head, { branch: "main", hash: m3 });
  assert.deepEqual(r.local, [
    { name: "feature/login", hash: fLocal, current: false, upstream: "origin/feature/login", ahead: 1, behind: 1 },
    { name: "main", hash: m3, current: true, upstream: "origin/main", ahead: 1, behind: 0 },
    { name: "topic/two", hash: t1, current: false, upstream: null, ahead: 0, behind: 0 },
  ]);
  // origin/HEAD is a pointer, not a branch.
  assert.deepEqual(r.remote, [
    { name: "origin/feature/login", hash: f1 },
    { name: "origin/main", hash: m2 },
    { name: "origin/release/1.0", hash: r1 },
  ]);
}

// A folder that isn't a repository: an error, and empty lists.
{
  const plain = `${tmp}/plain`;
  mkdirSync(plain);
  const r = await readBranches(git, plain);
  assert.equal(r.ok, false);
  assert.match(r.err, /not a git repository/i);
  assert.deepEqual([r.local, r.remote], [[], []]);
}

// A repository without commits: the branch HEAD will be born on, and nothing else.
{
  const empty = `${tmp}/empty`;
  mkdirSync(empty);
  raw(empty, ["init", "-q", "-b", "trunk"]);
  const r = await readBranches(git, empty);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.head, { branch: "trunk", hash: null });
  assert.deepEqual([r.local, r.remote], [[], []]);
}

// ---- checkout

// A local branch.
{
  const r = await checkout(git, repo, "topic/two");
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), "topic/two");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), t1);
}

// A remote branch with no local one: a local branch of the same name is made, tracks
// the remote branch, and becomes current.
{
  assert.equal(exists(repo, "refs/heads/release/1.0"), false);
  const r = await checkout(git, repo, "origin/release/1.0", { remote: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), "release/1.0");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), r1);
  assert.equal(raw(repo, ["rev-parse", "--abbrev-ref", "release/1.0@{upstream}"]), "origin/release/1.0");
}

// A remote branch whose local branch exists: switch to that one as it is (it is not
// moved to where the remote branch is).
{
  const r = await checkout(git, repo, "origin/feature/login", { remote: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), "feature/login");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), fLocal);
}

// A name that is only a remote branch is not a local branch to switch to: no local
// branch is made by guessing.
{
  raw(repo, ["branch", "-q", "-D", "release/1.0"]);
  const r = await checkout(git, repo, "release/1.0");
  assert.equal(r.ok, false);
  assert.ok(r.err);
  assert.deepEqual(r.msg, { key: "log.notLocalBranch", args: { name: "release/1.0" } });
  const notRemote = await checkout(git, repo, "nowhere/x", { remote: true });
  assert.equal(notRemote.ok, false);
  assert.equal(notRemote.err, "'nowhere/x' is not a remote branch.");
  assert.deepEqual(notRemote.msg, { key: "log.notRemoteBranch", args: { name: "nowhere/x" } });
  assert.equal(current(repo), "feature/login");
  assert.equal(exists(repo, "refs/heads/release/1.0"), false);
}

// Uncommitted changes in the way: git refuses, its words come back, nothing moved and
// the edit is still there.
{
  raw(repo, ["checkout", "-q", "main"]);
  writeFileSync(`${repo}/two.txt`, "in the way\n"); // untracked here, tracked on topic/two
  writeFileSync(`${repo}/a.txt`, "edited\n"); // m2 on main, m1 on feature/login
  const local = await checkout(git, repo, "topic/two");
  assert.equal(local.ok, false);
  assert.match(local.err, /two\.txt/);
  const other = await checkout(git, repo, "feature/login");
  assert.equal(other.ok, false);
  assert.match(other.err, /a\.txt/);
  // The same through a remote branch: refused, and no local branch is left behind.
  const viaRemote = await checkout(git, repo, "origin/release/1.0", { remote: true });
  assert.equal(viaRemote.ok, false);
  assert.match(viaRemote.err, /a\.txt/);
  assert.equal(exists(repo, "refs/heads/release/1.0"), false);
  assert.equal(current(repo), "main");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), m3);
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "edited\n");
  assert.equal(readFileSync(`${repo}/two.txt`, "utf8"), "in the way\n");
  // raw() trims: the first line is " M a.txt".
  assert.equal(raw(repo, ["status", "--porcelain"]), "M a.txt\n?? two.txt");
  raw(repo, ["checkout", "-q", "--", "a.txt"]);
  raw(repo, ["clean", "-q", "-f"]);
}

// ---- checkoutRevision, and the lists on a detached HEAD

{
  const r = await checkoutRevision(git, repo, m1);
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), null);
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), m1);
  const b = await readBranches(git, repo);
  assert.equal(b.ok, true, b.err);
  assert.deepEqual(b.head, { branch: null, hash: m1 });
  assert.deepEqual(names(b.local), ["feature/login", "main", "topic/two"]);
  assert.deepEqual(b.local.filter((x) => x.current), []);
  assert.deepEqual(names(b.remote), ["origin/feature/login", "origin/main", "origin/release/1.0"]);
  const bad = await checkoutRevision(git, repo, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(bad.ok, false);
  assert.ok(bad.err);
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), m1);
  raw(repo, ["checkout", "-q", "main"]);
}

// ---- checkBranchName

{
  assert.deepEqual(await checkBranchName(git, repo, "fix/new-thing"), { ok: true, reason: "" });
  // Spaces around a name are typing slips, not part of it.
  assert.deepEqual(await checkBranchName(git, repo, "  fix/new-thing "), { ok: true, reason: "" });
  for (const bad of ["", "   ", "has space", "double..dot", "ends.lock", "-dash", "tilde~1", "a:b", "trailing/", "/leading", "HEAD", "@{-1}", "back\\slash"]) {
    const r = await checkBranchName(git, repo, bad);
    assert.equal(r.ok, false, `"${bad}" should be refused`);
    assert.ok(r.reason, `"${bad}" needs a reason`);
  }
  const taken = await checkBranchName(git, repo, "topic/two");
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /already exists/);
  assert.deepEqual(taken.msg, { key: "log.branchExists", args: { name: "topic/two" } });
  // git keeps branches as files: "main/x" can't live next to "main", nor "topic" next
  // to "topic/two".
  for (const clash of ["main/x", "topic"]) {
    const r = await checkBranchName(git, repo, clash);
    assert.equal(r.ok, false, `"${clash}" should be refused`);
    assert.ok(r.reason);
  }
  // The reasons we word ourselves come with a message key; git's own words don't.
  assert.deepEqual((await checkBranchName(git, repo, "  ")).msg, { key: "log.enterBranchName", args: {} });
  assert.deepEqual((await checkBranchName(git, repo, "-dash")).msg, { key: "log.invalidBranchName", args: { name: "-dash" } });
  assert.deepEqual((await checkBranchName(git, repo, "double..dot")).msg, { key: "log.invalidBranchName", args: { name: "double..dot" } });
  assert.deepEqual((await checkBranchName(git, repo, "main/x")).msg, { key: "log.branchAbove", args: { existing: "main" } });
  assert.deepEqual((await checkBranchName(git, repo, "topic")).msg, { key: "log.branchUnder", args: { name: "topic", existing: "topic/two" } });
  const refusedToo = await createBranch(git, repo, { name: "topic/two", checkout: false });
  assert.deepEqual([refusedToo.ok, refusedToo.msg?.key], [false, "log.branchExists"]);
  // In English the key says exactly what the reason says.
  const en = translator("en");
  for (const name of ["", "-dash", "topic/two", "main/x", "topic"]) {
    const r = await checkBranchName(git, repo, name);
    assert.equal(en(r.msg.key, r.msg.args), r.reason);
  }
  // A remote branch's name is free to use locally.
  assert.equal((await checkBranchName(git, repo, "release/1.0")).ok, true);
}

// ---- createBranch

// From HEAD, switching to it.
{
  const r = await createBranch(git, repo, { name: "fix/from-head" });
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), "fix/from-head");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), m3);
  raw(repo, ["checkout", "-q", "main"]);
}

// From another branch, without switching.
{
  const r = await createBranch(git, repo, { name: "fix/from-topic", from: "refs/heads/topic/two", checkout: false });
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), "main");
  assert.equal(raw(repo, ["rev-parse", "fix/from-topic"]), t1);
}

// From a remote branch: no upstream is set, with or without switching.
{
  const stay = await createBranch(git, repo, { name: "fix/from-remote", from: "refs/remotes/origin/feature/login", checkout: false });
  assert.equal(stay.ok, true, stay.err);
  assert.equal(raw(repo, ["rev-parse", "fix/from-remote"]), f1);
  assert.equal(ask(repo, ["rev-parse", "--abbrev-ref", "fix/from-remote@{upstream}"]), null);
  const go = await createBranch(git, repo, { name: "fix/from-remote-2", from: "refs/remotes/origin/release/1.0", checkout: true });
  assert.equal(go.ok, true, go.err);
  assert.equal(current(repo), "fix/from-remote-2");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), r1);
  assert.equal(ask(repo, ["rev-parse", "--abbrev-ref", "fix/from-remote-2@{upstream}"]), null);
  raw(repo, ["checkout", "-q", "main"]);
}

// From a commit hash (New Branch… on a commit).
{
  const r = await createBranch(git, repo, { name: "fix/from-hash", from: m1, checkout: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(current(repo), "fix/from-hash");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), m1);
  raw(repo, ["checkout", "-q", "main"]);
}

// The branch picked is where it starts, even when another ref has the same short name:
// a tag "topic/two", or a local branch "origin/release/1.0" beside the remote one.
// A short name or a short hash could mean either, so it is refused and makes nothing.
{
  raw(repo, ["tag", "topic/two", m1]);
  raw(repo, ["branch", "origin/release/1.0", m1]);
  const fromBranch = await createBranch(git, repo, { name: "fix/beside-tag", from: "refs/heads/topic/two", checkout: false });
  assert.equal(fromBranch.ok, true, fromBranch.err);
  assert.equal(raw(repo, ["rev-parse", "refs/heads/fix/beside-tag"]), t1);
  const fromRemote = await createBranch(git, repo, { name: "fix/beside-local", from: "refs/remotes/origin/release/1.0", checkout: true });
  assert.equal(fromRemote.ok, true, fromRemote.err);
  assert.equal(current(repo), "fix/beside-local");
  assert.equal(raw(repo, ["rev-parse", "HEAD"]), r1);
  raw(repo, ["checkout", "-q", "main"]);
  for (const from of ["topic/two", "origin/release/1.0", m2.slice(0, 8)]) {
    const r = await createBranch(git, repo, { name: "fix/guessed", from, checkout: false });
    assert.equal(r.ok, false, from);
    assert.equal(exists(repo, "refs/heads/fix/guessed"), false);
  }
  raw(repo, ["tag", "-d", "topic/two"]);
  raw(repo, ["branch", "-D", "origin/release/1.0"]);
}

// A full ref starts the branch only when a ref of exactly that name exists: not when git
// could read the name as another ref (a branch called "refs/heads/gone" is
// refs/heads/refs/heads/gone), and not as an expression on a ref. A tag ref, plain or
// annotated, starts it at the tagged commit. Refused, nothing is made and HEAD stays.
{
  raw(repo, ["branch", "refs/heads/gone", m1]);
  raw(repo, ["tag", "plain", m1]);
  raw(repo, ["tag", "-a", "-m", "note", "noted", t1]);
  const head = raw(repo, ["rev-parse", "HEAD"]);
  for (const checkout of [false, true]) {
    for (const from of ["refs/heads/gone", "refs/heads/main~1", "refs/heads/main^{}", "refs/heads/topic/two^", "refs/tags/missing"]) {
      const r = await createBranch(git, repo, { name: "fix/inexact", from, checkout });
      assert.equal(r.ok, false, `${from} checkout=${checkout}`);
      assert.ok(r.err, from);
      assert.equal(exists(repo, "refs/heads/fix/inexact"), false, from);
      assert.equal(current(repo), "main");
      assert.equal(raw(repo, ["rev-parse", "HEAD"]), head);
    }
  }
  const plain = await createBranch(git, repo, { name: "fix/from-plain-tag", from: "refs/tags/plain", checkout: false });
  assert.equal(plain.ok, true, plain.err);
  assert.equal(raw(repo, ["rev-parse", "refs/heads/fix/from-plain-tag"]), m1);
  const noted = await createBranch(git, repo, { name: "fix/from-noted-tag", from: "refs/tags/noted", checkout: false });
  assert.equal(noted.ok, true, noted.err);
  assert.equal(raw(repo, ["rev-parse", "refs/heads/fix/from-noted-tag"]), t1);
  const upper = await createBranch(git, repo, { name: "fix/from-upper-hash", from: m1.toUpperCase(), checkout: false });
  assert.equal(upper.ok, true, upper.err);
  assert.equal(raw(repo, ["rev-parse", "refs/heads/fix/from-upper-hash"]), m1);
  raw(repo, ["branch", "-D", "refs/heads/gone", "fix/from-plain-tag", "fix/from-noted-tag", "fix/from-upper-hash"]);
  raw(repo, ["tag", "-d", "plain", "noted"]);
}

// In a SHA-256 repository a hash is full at 64 characters: the first 40 of one are refused
// like any short hash, and the whole 64 work.
if (ask(tmp, ["init", "-q", "--object-format=sha256", `${tmp}/sha256`]) !== null) {
  const repo256 = `${tmp}/sha256`;
  const head = commit(repo256, "a.txt", "s1");
  assert.equal(head.length, 64);
  for (const checkout of [false, true]) {
    const r = await createBranch(git, repo256, { name: "fix/prefix", from: head.slice(0, 40), checkout });
    assert.equal(r.ok, false);
    assert.equal(exists(repo256, "refs/heads/fix/prefix"), false);
    assert.equal(raw(repo256, ["rev-parse", "HEAD"]), head);
  }
  const whole = await createBranch(git, repo256, { name: "fix/whole", from: head, checkout: false });
  assert.equal(whole.ok, true, whole.err);
  assert.equal(raw(repo256, ["rev-parse", "refs/heads/fix/whole"]), head);
} else console.log("skipped: this git can't make a SHA-256 repository");

// A taken or a bad name makes nothing and moves nothing.
{
  const taken = await createBranch(git, repo, { name: "topic/two", from: m1 });
  assert.equal(taken.ok, false);
  assert.match(taken.err, /already exists/);
  assert.equal(raw(repo, ["rev-parse", "topic/two"]), t1);
  const bad = await createBranch(git, repo, { name: "has space" });
  assert.equal(bad.ok, false);
  assert.ok(bad.err);
  const nowhere = await createBranch(git, repo, { name: "fix/nowhere", from: "no-such-branch" });
  assert.equal(nowhere.ok, false);
  assert.ok(nowhere.err);
  assert.equal(exists(repo, "refs/heads/fix/nowhere"), false);
  assert.equal(current(repo), "main");
}

// Switching to the new branch would lose an edit: refused, and no branch is made.
{
  writeFileSync(`${repo}/a.txt`, "edited\n");
  const r = await createBranch(git, repo, { name: "fix/blocked", from: m1, checkout: true });
  assert.equal(r.ok, false);
  assert.match(r.err, /a\.txt/);
  assert.equal(exists(repo, "refs/heads/fix/blocked"), false);
  assert.equal(current(repo), "main");
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "edited\n");
  raw(repo, ["checkout", "-q", "--", "a.txt"]);
}

// ---- fetchAll

// The teammate pushes a new branch and a new commit and deletes a branch.
{
  raw(other, ["checkout", "-q", "-b", "hotfix/crash", "main"]);
  const h1 = commit(other, "crash.txt", "h1");
  raw(other, ["push", "-q", "origin", "hotfix/crash"]);
  raw(other, ["checkout", "-q", "main"]);
  const m4 = commit(other, "a.txt", "m4");
  raw(other, ["push", "-q", "origin", "main"]);
  raw(other, ["push", "-q", "origin", "--delete", "release/1.0"]);

  const before = await readBranches(git, repo);
  assert.deepEqual(names(before.remote), ["origin/feature/login", "origin/main", "origin/release/1.0"]);
  const r = await fetchAll(git, repo);
  assert.equal(r.ok, true, r.err);
  const after = await readBranches(git, repo);
  assert.deepEqual(after.remote, [
    { name: "origin/feature/login", hash: f1 },
    { name: "origin/hotfix/crash", hash: h1 },
    { name: "origin/main", hash: m4 },
  ]);
  // main: m3 is local only, m4 is on the remote only.
  const main = after.local.find((b) => b.name === "main");
  assert.deepEqual([main.ahead, main.behind], [1, 1]);
  assert.equal(exists(repo, "refs/remotes/origin/release/1.0"), false);
}

// A remote that can't be reached: git's error comes back.
{
  const lost = `${tmp}/lost`;
  raw(tmp, ["clone", "-q", origin, lost]);
  raw(lost, ["remote", "set-url", "origin", `${tmp}/no-such-remote.git`]);
  const r = await fetchAll(git, lost);
  assert.equal(r.ok, false);
  assert.ok(r.err);
}

// No remote at all: nothing to do, and that is fine.
{
  const solo = `${tmp}/solo`;
  mkdirSync(solo);
  raw(solo, ["init", "-q", "-b", "main"]);
  commit(solo, "a.txt", "s1");
  assert.equal((await fetchAll(git, solo)).ok, true);
}

// ---- deleteBranch

// Everything on it is on another branch too: deleted at once.
{
  assert.equal(exists(repo, "refs/heads/fix/from-topic"), true);
  const r = await deleteBranch(git, repo, "fix/from-topic"); // same commit as topic/two
  assert.equal(r.ok, true, r.err);
  assert.equal(r.unmerged, 0);
  assert.equal(exists(repo, "refs/heads/fix/from-topic"), false);
  // Only a remote branch still has its commit: nothing is lost either.
  const pushed = await deleteBranch(git, repo, "fix/from-remote");
  assert.equal(pushed.ok, true, pushed.err);
  assert.equal(exists(repo, "refs/heads/fix/from-remote"), false);
}

// Commits nothing else has: refused with their number until confirmed.
{
  raw(repo, ["checkout", "-q", "-b", "wip/lonely", "main"]);
  commit(repo, "w1.txt", "w1");
  const w2 = commit(repo, "w2.txt", "w2");
  raw(repo, ["checkout", "-q", "main"]);
  const r = await deleteBranch(git, repo, "wip/lonely");
  assert.equal(r.ok, false);
  assert.equal(r.unmerged, 2);
  assert.ok(r.err);
  assert.equal(r.err, "Branch 'wip/lonely' has 2 unmerged commits that would be lost.");
  assert.deepEqual(r.msg, { key: "log.unmerged", args: { name: "wip/lonely", n: 2 } });
  assert.equal(translator("en")("log.unmerged", { name: "x", n: 1 }), "Branch 'x' has 1 unmerged commit that would be lost.");
  assert.equal(raw(repo, ["rev-parse", "wip/lonely"]), w2);
  const sure = await deleteBranch(git, repo, "wip/lonely", { confirmed: true });
  assert.equal(sure.ok, true, sure.err);
  assert.equal(exists(repo, "refs/heads/wip/lonely"), false);
}

// The current branch and remote branches are never deleted, confirmed or not.
{
  for (const options of [{}, { confirmed: true }]) {
    const here = await deleteBranch(git, repo, "main", options);
    assert.equal(here.ok, false);
    assert.match(here.err, /current branch/i);
    assert.deepEqual(here.msg, { key: "log.deleteCurrent", args: { name: "main" } });
    const far = await deleteBranch(git, repo, "origin/feature/login", options);
    assert.equal(far.ok, false);
    assert.ok(far.err);
    assert.deepEqual(far.msg, { key: "log.onlyLocalDelete", args: { name: "origin/feature/login" } });
    const missing = await deleteBranch(git, repo, "no-such-branch", options);
    assert.equal(missing.ok, false);
  }
  assert.equal(current(repo), "main");
  assert.equal(exists(repo, "refs/heads/main"), true);
  assert.equal(raw(repo, ["rev-parse", "refs/remotes/origin/feature/login"]), f1);
  // The remote itself still has the branch.
  assert.equal(raw(origin, ["rev-parse", "refs/heads/feature/login"]), f1);
}

// On a detached HEAD a branch whose tip HEAD sits on loses nothing.
{
  raw(repo, ["checkout", "-q", "-b", "wip/here", "main"]);
  const here = commit(repo, "h.txt", "here");
  raw(repo, ["checkout", "-q", "--detach", here]);
  const r = await deleteBranch(git, repo, "wip/here");
  assert.equal(r.ok, true, r.err);
  assert.equal(exists(repo, "refs/heads/wip/here"), false);
  raw(repo, ["checkout", "-q", "main"]);
}

// ---- names that look like options, and tags named like branches

// A repository of its own, so the shared one above is not disturbed.
const lone = (name) => {
  const dir = `${tmp}/${name}`;
  mkdirSync(dir);
  raw(dir, ["init", "-q", "-b", "main"]);
  commit(dir, "keep.txt", "base");
  return dir;
};

// A branch called "-f" is a branch, never git's --force: switching to it keeps an
// uncommitted edit, and so does starting a new branch at it.
{
  const dir = lone("dash");
  const base = raw(dir, ["rev-parse", "HEAD"]);
  raw(dir, ["update-ref", "refs/heads/-f", base]);
  commit(dir, "later.txt", "later");
  writeFileSync(`${dir}/keep.txt`, "uncommitted\n");

  const made = await createBranch(git, dir, { name: "from-dash", from: "refs/heads/-f", checkout: true });
  assert.equal(readFileSync(`${dir}/keep.txt`, "utf8"), "uncommitted\n");
  assert.equal(made.ok, true, made.err);
  assert.equal(current(dir), "from-dash");
  assert.equal(raw(dir, ["rev-parse", "HEAD"]), base);

  const made2 = await createBranch(git, dir, { name: "from-dash-2", from: "refs/heads/-f", checkout: false });
  // As typed, "-f" is not a full ref name: refused before it reaches git.
  const typed = await createBranch(git, dir, { name: "from-dash-3", from: "-f", checkout: false });
  assert.equal(typed.ok, false);
  assert.deepEqual(typed.msg, { key: "log.notFullRef", args: { from: "-f" } });
  const gone = await createBranch(git, dir, { name: "from-gone", from: "refs/heads/no-such", checkout: false });
  assert.deepEqual([gone.ok, gone.err, gone.msg], [false, "'refs/heads/no-such' is not a branch or a commit.", { key: "log.notBranchOrCommit", args: { from: "refs/heads/no-such" } }]);
  assert.equal(exists(dir, "refs/heads/from-dash-3"), false);
  assert.equal(made2.ok, true, made2.err);
  assert.equal(raw(dir, ["rev-parse", "refs/heads/from-dash-2"]), base);

  raw(dir, ["update-ref", "refs/heads/-f", raw(dir, ["rev-parse", "main"])]);
  raw(dir, ["checkout", "-q", "main"]);
  const switched = await checkout(git, dir, "-f");
  assert.equal(readFileSync(`${dir}/keep.txt`, "utf8"), "uncommitted\n");
  assert.equal(switched.ok, true, switched.err);
  assert.equal(raw(dir, ["symbolic-ref", "HEAD"]), "refs/heads/-f");
}

// A tag "main" next to a branch "heads/main": `--short` names the current branch
// "heads/main". The current branch is still "main", and it can't be deleted.
{
  const dir = lone("same-tag");
  raw(dir, ["tag", "main"]);
  raw(dir, ["update-ref", "refs/heads/heads/main", "HEAD"]);
  const r = await readBranches(git, dir);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.head.branch, "main");
  assert.deepEqual(r.local.filter((b) => b.current).map((b) => b.name), ["main"]);
  const del = await deleteBranch(git, dir, "main", { confirmed: true });
  assert.equal(del.ok, false);
  assert.match(del.err, /current branch/);
  assert.equal(exists(dir, "refs/heads/main"), true);
}

// ---- deleting gives back what was deleted

// A clone of its own with a bare remote:
//   main:         b1 (origin/main), checked out
//   shared/done:  b1 - d1, pushed, tracking origin/shared/done (nothing would be lost)
//   wip/alone:    b1 - w1, local only, tracking local main (w1 would be lost)
const placed = (name) => {
  const bare = `${tmp}/${name}.git`, dir = `${tmp}/${name}`;
  raw(tmp, ["init", "-q", "--bare", "-b", "main", bare]);
  raw(tmp, ["clone", "-q", bare, dir]);
  commit(dir, "base.txt", "b1");
  raw(dir, ["push", "-q", "-u", "origin", "main"]);
  return dir;
};
const setting = (cwd, key) => ask(cwd, ["config", "--get", key]);

{
  const dir = placed("gone");
  raw(dir, ["checkout", "-q", "-b", "shared/done"]);
  const d1 = commit(dir, "done.txt", "d1");
  raw(dir, ["push", "-q", "-u", "origin", "shared/done"]);
  raw(dir, ["checkout", "-q", "-b", "wip/alone", "--track", "main"]);
  const w1 = commit(dir, "alone.txt", "w1");
  raw(dir, ["checkout", "-q", "main"]);

  // Merged: deleted at once, with its commit and what it tracked.
  const done = await deleteBranch(git, dir, "shared/done");
  assert.equal(done.ok, true, done.err);
  assert.deepEqual(done.deleted, { name: "shared/done", hash: d1, upstream: { remote: "origin", merge: "refs/heads/shared/done" } });

  // Not merged: the refused first try deleted nothing and gives nothing back.
  const first = await deleteBranch(git, dir, "wip/alone");
  assert.equal(first.ok, false);
  assert.equal(first.deleted, undefined);
  const alone = await deleteBranch(git, dir, "wip/alone", { confirmed: true });
  assert.equal(alone.ok, true, alone.err);
  assert.deepEqual(alone.deleted, { name: "wip/alone", hash: w1, upstream: { remote: ".", merge: "refs/heads/main" } });

  // ---- restoreBranch: the same name, commit and upstream; HEAD stays where it is.
  writeFileSync(`${dir}/base.txt`, "uncommitted\n");
  for (const [r, hash, remote, merge, upstream] of [
    [done, d1, "origin", "refs/heads/shared/done", "origin/shared/done"],
    [alone, w1, ".", "refs/heads/main", "main"],
  ]) {
    const back = await restoreBranch(git, dir, r.deleted);
    assert.equal(back.ok, true, back.err);
    const name = r.deleted.name;
    assert.equal(raw(dir, ["rev-parse", `refs/heads/${name}`]), hash);
    assert.equal(setting(dir, `branch.${name}.remote`), remote);
    assert.equal(setting(dir, `branch.${name}.merge`), merge);
    assert.equal(raw(dir, ["rev-parse", "--abbrev-ref", `${name}@{upstream}`]), upstream);
  }
  assert.equal(current(dir), "main");
  assert.equal(readFileSync(`${dir}/base.txt`, "utf8"), "uncommitted\n");
}

// A branch that tracked nothing comes back tracking nothing.
{
  const dir = placed("untracked");
  raw(dir, ["checkout", "-q", "-b", "plain", "--no-track"]);
  const p1 = commit(dir, "plain.txt", "p1");
  raw(dir, ["checkout", "-q", "main"]);
  const del = await deleteBranch(git, dir, "plain", { confirmed: true });
  assert.equal(del.ok, true, del.err);
  assert.deepEqual(del.deleted, { name: "plain", hash: p1, upstream: null });
  const back = await restoreBranch(git, dir, del.deleted);
  assert.equal(back.ok, true, back.err);
  assert.equal(raw(dir, ["rev-parse", "refs/heads/plain"]), p1);
  assert.equal(setting(dir, "branch.plain.remote"), null);
  assert.equal(setting(dir, "branch.plain.merge"), null);
  assert.equal(current(dir), "main");
}

// A branch of that name made since is left as it is: git refuses, and its commit and
// (missing) upstream stay.
{
  const dir = placed("taken");
  raw(dir, ["checkout", "-q", "-b", "topic", "--track", "origin/main"]);
  commit(dir, "topic.txt", "t1");
  raw(dir, ["checkout", "-q", "main"]);
  const del = await deleteBranch(git, dir, "topic", { confirmed: true });
  assert.equal(del.ok, true, del.err);
  const later = commit(dir, "later.txt", "later");
  raw(dir, ["branch", "--no-track", "topic", later]);
  const back = await restoreBranch(git, dir, del.deleted);
  assert.equal(back.ok, false);
  assert.match(back.err, /already exists/);
  assert.equal(raw(dir, ["rev-parse", "refs/heads/topic"]), later);
  assert.equal(setting(dir, "branch.topic.remote"), null);
  assert.equal(setting(dir, "branch.topic.merge"), null);
  assert.equal(current(dir), "main");
}

// A branch called "-f" comes back as a branch called "-f", with its upstream: never
// git's --force, so an uncommitted edit and HEAD stay.
{
  const dir = placed("dash-restore");
  const b1 = raw(dir, ["rev-parse", "HEAD"]);
  raw(dir, ["update-ref", "refs/heads/-f", b1]);
  raw(dir, ["config", "branch.-f.remote", "origin"]);
  raw(dir, ["config", "branch.-f.merge", "refs/heads/main"]);
  commit(dir, "more.txt", "more");
  writeFileSync(`${dir}/base.txt`, "uncommitted\n");
  const del = await deleteBranch(git, dir, "-f");
  assert.equal(del.ok, true, del.err);
  assert.deepEqual(del.deleted, { name: "-f", hash: b1, upstream: { remote: "origin", merge: "refs/heads/main" } });
  assert.equal(exists(dir, "refs/heads/-f"), false);
  const back = await restoreBranch(git, dir, del.deleted);
  assert.equal(back.ok, true, back.err);
  assert.equal(raw(dir, ["rev-parse", "refs/heads/-f"]), b1);
  assert.equal(setting(dir, "branch.-f.remote"), "origin");
  assert.equal(setting(dir, "branch.-f.merge"), "refs/heads/main");
  assert.equal(current(dir), "main");
  assert.equal(readFileSync(`${dir}/base.txt`, "utf8"), "uncommitted\n");
  // Taken now: refused, not overwritten.
  const again = await restoreBranch(git, dir, { ...del.deleted, hash: raw(dir, ["rev-parse", "main"]) });
  assert.equal(again.ok, false);
  assert.equal(raw(dir, ["rev-parse", "refs/heads/-f"]), b1);
}

// Without a known commit nothing is made, and the result says why in both words.
{
  const dir = placed("unknown");
  const r = await restoreBranch(git, dir, { name: "ghost", hash: "HEAD", upstream: null });
  assert.equal(r.ok, false);
  assert.equal(r.err, "Branch 'ghost' can't be restored: its commit isn't known.");
  assert.deepEqual(r.msg, { key: "branches.unknownCommit", args: { name: "ghost" } });
  assert.equal(exists(dir, "refs/heads/ghost"), false);
}

// ---- deleted branches are kept in the repository

const DELETED = "refs/git-tools/deleted-branches";
// Every commit `git log --all` shows, every branch and tag, and the reflog of the
// hidden ref (newest first), as git itself reads them.
const logAll = (cwd) => raw(cwd, ["log", "--all", "--format=%H"]).split("\n").filter(Boolean);
const refsShown = (cwd) => raw(cwd, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/tags"]).split("\n").filter(Boolean);
const roots = (cwd) => raw(cwd, ["rev-list", "--max-parents=0", "HEAD"]).split("\n").filter(Boolean);
const alive = (cwd, hash) => ask(cwd, ["cat-file", "-e", `${hash}^{commit}`]) !== null;

// A deleted branch's commits are gone from every list, yet stay in the repository
// through a gc that prunes everything unreachable now. The hidden ref rests on the root
// of HEAD's history.
{
  const dir = placed("kept");
  raw(dir, ["checkout", "-q", "-b", "wip/kept", "--track", "origin/main"]);
  const k1 = commit(dir, "k1.txt", "k1");
  const k2 = commit(dir, "k2.txt", "k2");
  raw(dir, ["checkout", "-q", "main"]);
  commit(dir, "main2.txt", "main two");
  const del = await deleteBranch(git, dir, "wip/kept", { confirmed: true });
  assert.equal(del.ok, true, del.err);
  assert.equal(exists(dir, "refs/heads/wip/kept"), false);
  for (const hash of [k1, k2]) {
    assert.equal(logAll(dir).includes(hash), false, "log --all doesn't show a deleted commit");
    assert.equal(refsShown(dir).includes(hash), false);
  }
  assert.deepEqual(roots(dir).includes(raw(dir, ["rev-parse", DELETED])), true, "the hidden ref rests on a root of HEAD's history");
  raw(dir, ["gc", "-q", "--prune=now"]);
  assert.equal(alive(dir, k1), true);
  assert.equal(alive(dir, k2), true);
}

// When the branch can't be recorded it is not deleted. Here the record's name is taken
// by a folder of refs, so git can't make the ref.
{
  const dir = placed("unrecorded");
  const b1 = raw(dir, ["rev-parse", "HEAD"]);
  raw(dir, ["update-ref", `${DELETED}/in-the-way`, b1]);
  raw(dir, ["checkout", "-q", "-b", "stays"]);
  const s1 = commit(dir, "s.txt", "s1");
  raw(dir, ["checkout", "-q", "main"]);
  const del = await deleteBranch(git, dir, "stays", { confirmed: true });
  assert.equal(del.ok, false);
  assert.equal(del.deleted, undefined);
  assert.equal(del.msg.key, "branches.notRecorded");
  assert.equal(del.msg.args.name, "stays");
  assert.ok(del.msg.args.err, "git's words come along");
  assert.equal(raw(dir, ["rev-parse", "refs/heads/stays"]), s1);
  assert.equal(translator("en")("branches.notRecorded", { name: "x", err: "fatal: y" }), "Branch 'x' was not deleted: it couldn't be recorded to restore later. fatal: y");
}

// HEAD's root commit amended away: the commit the ref rested on is out of HEAD's
// history and would show in `log --all`. The next Delete rests it on the new root.
{
  const dir = lone("amended");
  const c1 = raw(dir, ["rev-parse", "HEAD"]);
  raw(dir, ["branch", "first", c1]);
  raw(dir, ["checkout", "-q", "first"]);
  const x1 = commit(dir, "x.txt", "x1");
  raw(dir, ["checkout", "-q", "main"]);
  assert.equal((await deleteBranch(git, dir, "first", { confirmed: true })).ok, true);
  assert.equal(raw(dir, ["rev-parse", DELETED]), c1);
  raw(dir, ["commit", "-q", "--amend", "-m", "base, amended"]);
  const c2 = raw(dir, ["rev-parse", "HEAD"]);
  raw(dir, ["branch", "second", c2]);
  assert.equal((await deleteBranch(git, dir, "second")).ok, true);
  assert.deepEqual([raw(dir, ["rev-parse", DELETED])], roots(dir));
  assert.equal(raw(dir, ["rev-parse", DELETED]), c2);
  assert.equal(logAll(dir).includes(c1), false);
  assert.equal(logAll(dir).includes(x1), false);
}

// ---- readDeletedBranches

// Deleted here, in this order (one each unless said):
//   at-root, at-root-2: on b1, the commit the hidden ref rests on, while HEAD is on it too
//   (main moves on to m2)
//   at-root-3:  on b1 again, with HEAD elsewhere
//   feat/a:     a1, tracking origin/main
//   fix/50%:    p1, tracking local main ("."), a name with a "%"
//   -f:         f1, tracking nothing
//   twice:      t1, deleted, restored, deleted again: one line
//   same-back:  s1, deleted, then made again at s1 by hand: left out
//   moved:      v1, deleted, then a branch of that name made at m2: shown, not restorable
// A branch one commit past main, made by its full ref (a name may be "-f"), with an
// upstream when one is given as [remote, merge].
const branchAt = (dir, name, file, text, upstream = null) => {
  raw(dir, ["checkout", "-q", "--detach", "main"]);
  const hash = commit(dir, file, text);
  raw(dir, ["checkout", "-q", "main"]);
  raw(dir, ["update-ref", `refs/heads/${name}`, hash]);
  if (upstream) {
    raw(dir, ["config", `branch.${name}.remote`, upstream[0]]);
    raw(dir, ["config", `branch.${name}.merge`, upstream[1]]);
  }
  return hash;
};
const deleted = async (dir, name) => {
  const r = await deleteBranch(git, dir, name, { confirmed: true });
  assert.equal(r.ok, true, `${name}: ${r.err}`);
  return r;
};
const listed = placed("listed");
const started = Math.floor(Date.now() / 1000);
const b1 = raw(listed, ["rev-parse", "HEAD"]);
raw(listed, ["branch", "--no-track", "at-root", b1]);
raw(listed, ["branch", "--no-track", "at-root-2", b1]);
await deleted(listed, "at-root");
await deleted(listed, "at-root-2");
const lm2 = commit(listed, "m2.txt", "m2");
raw(listed, ["branch", "--no-track", "at-root-3", b1]);
await deleted(listed, "at-root-3");
const a1 = branchAt(listed, "feat/a", "a.txt", "a one", ["origin", "refs/heads/main"]);
await deleted(listed, "feat/a");
const p1 = branchAt(listed, "fix/50%", "p.txt", "p one", [".", "refs/heads/main"]);
await deleted(listed, "fix/50%");
const f1b = branchAt(listed, "-f", "f.txt", "f one");
await deleted(listed, "-f");
const tw1 = branchAt(listed, "twice", "t.txt", "t one");
const once = await deleted(listed, "twice");
assert.equal((await restoreBranch(git, listed, once.deleted)).ok, true);
await deleted(listed, "twice");
const s1 = branchAt(listed, "same-back", "s.txt", "s one");
await deleted(listed, "same-back");
raw(listed, ["branch", "--no-track", "same-back", s1]);
const v1 = branchAt(listed, "moved", "v.txt", "v one");
await deleted(listed, "moved");
raw(listed, ["branch", "--no-track", "moved", lm2]);
const ended = Math.floor(Date.now() / 1000);

{
  const r = await readDeletedBranches(git, listed);
  assert.equal(r.ok, true, r.err);
  for (const b of r.branches) assert.ok(b.time >= started && b.time <= ended, `${b.name}: deleted between ${started} and ${ended}, not ${b.time}`);
  const free = { restorable: true, reason: "" };
  assert.deepEqual(r.branches.map(({ time, ...b }) => b), [
    { name: "moved", hash: v1, subject: "v one", upstream: null, restorable: false, reason: "a branch of this name exists now at another commit", msg: { key: "branches.nameTaken", args: { name: "moved" } } },
    { name: "twice", hash: tw1, subject: "t one", upstream: null, ...free },
    { name: "-f", hash: f1b, subject: "f one", upstream: null, ...free },
    { name: "fix/50%", hash: p1, subject: "p one", upstream: { remote: ".", merge: "refs/heads/main" }, ...free },
    { name: "feat/a", hash: a1, subject: "a one", upstream: { remote: "origin", merge: "refs/heads/main" }, ...free },
    { name: "at-root-3", hash: b1, subject: "b1", upstream: null, ...free },
    { name: "at-root-2", hash: b1, subject: "b1", upstream: null, ...free },
    { name: "at-root", hash: b1, subject: "b1", upstream: null, ...free },
  ]);
  assert.equal(translator("ko")("branches.nameTaken", { name: "moved" }), "같은 이름의 브랜치가 지금 다른 커밋에 있습니다");
  // Still nothing of theirs in `log --all`.
  for (const hash of [a1, p1, f1b, tw1, v1]) assert.equal(logAll(listed).includes(hash), false);
}

// Never deleted anything: an empty list. Not a repository: an error.
{
  const r = await readDeletedBranches(git, placed("none-deleted"));
  assert.deepEqual([r.ok, r.branches], [true, []]);
  const plain = `${tmp}/plain-deleted`;
  mkdirSync(plain);
  const bad = await readDeletedBranches(git, plain);
  assert.equal(bad.ok, false);
  assert.ok(bad.err);
  assert.deepEqual(bad.branches, []);
}

// A linked worktree reads the same list, and a branch deleted there joins it.
{
  const wt = `${tmp}/listed-wt`;
  raw(listed, ["worktree", "add", "-q", "--detach", wt, "main"]);
  const before = await readDeletedBranches(git, listed);
  assert.deepEqual(await readDeletedBranches(git, wt), before);
  const w1 = branchAt(listed, "from-wt", "w.txt", "w one");
  await deleted(wt, "from-wt");
  const after = await readDeletedBranches(git, listed);
  assert.deepEqual(after.branches.map((b) => [b.name, b.hash]), [["from-wt", w1], ...before.branches.map((b) => [b.name, b.hash])]);
  assert.deepEqual(await readDeletedBranches(git, wt), after);
}

// The newest 50 only.
{
  const dir = lone("many");
  const base = raw(dir, ["rev-parse", "HEAD"]);
  const order = [];
  for (let i = 1; i <= 55; i++) {
    const name = `old/${String(i).padStart(2, "0")}`;
    raw(dir, ["branch", "--no-track", name, base]);
    await deleted(dir, name);
    order.unshift(name);
  }
  const r = await readDeletedBranches(git, dir);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.branches.map((b) => b.name), order.slice(0, 50));
}

// ---- how long a deleted branch is kept: git's own reflog expiry, default settings

// A git runner whose commands run `days` ago: the records it writes carry that time.
const gitDaysAgo = (days) => makeGit((cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  const env = { ...process.env, GIT_COMMITTER_DATE: `@${Math.floor(Date.now() / 1000) - days * 86400} +0000` };
  execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
}), null);

// A record 29 days old outlives a default gc; one 31 days old goes with its commit. The
// commit is made without touching HEAD, so no other reflog keeps it.
for (const [days, kept] of [[29, true], [31, false]]) {
  const dir = lone(`aged-${days}`);
  const tip = raw(dir, ["commit-tree", "-m", `aged ${days}`, "-p", "HEAD", "HEAD^{tree}"]);
  raw(dir, ["update-ref", "refs/heads/aged", tip]);
  const del = await deleteBranch(gitDaysAgo(days), dir, "aged", { confirmed: true });
  assert.equal(del.ok, true, del.err);
  const listedAt = (await readDeletedBranches(git, dir)).branches[0].time;
  assert.ok(Math.abs(listedAt - (Date.now() / 1000 - days * 86400)) < 120, `deleted ${days} days ago`);
  // gc expires reflog entries by the default settings, then drops what nothing keeps.
  raw(dir, ["gc", "-q", "--prune=now"]);
  assert.equal(alive(dir, tip), kept, `${days} days`);
  assert.deepEqual((await readDeletedBranches(git, dir)).branches.map((b) => b.hash), kept ? [tip] : []);
}

console.log("ok");
