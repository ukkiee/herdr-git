// node git-log.test.mjs: reading commits for the Commit list, against throwaway
// repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readLog, readNotPicked, readRefsState, readGitDir, refsChanged, resolveCommit, labelRefs, shortenMiddle, formatCommitTime } from "./git-log.js";

const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-log-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const git = makeGit(exec, null);

const T = 1700000000;
const raw = (cwd, args, at, who = "Ann Lee <ann@example.com>") => {
  const [, name, email] = /^(.*) <(.*)>$/.exec(who);
  const date = at === undefined ? {} : { GIT_AUTHOR_DATE: `${T + at} +0000`, GIT_COMMITTER_DATE: `${T + at} +0000` };
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...date, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: "c@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
};
const commit = (cwd, file, subject, at, who) => {
  writeFileSync(`${cwd}/${file}`, `${subject}\n`);
  raw(cwd, ["add", "-A"]);
  raw(cwd, ["commit", "-q", "-m", subject], at, who);
  return raw(cwd, ["rev-parse", "HEAD"]);
};

// main:    c1 - c2 (tag v1.0) - c4 (topic) --- m - c6 (HEAD, origin/main)
// feature:        \- f1 (Bob) ------- f2 ----/
const repo = `${tmp}/repo`;
mkdirSync(repo);
raw(repo, ["init", "-q", "-b", "main"]);
const tricky = "fix: \"quotes\" 'single' | pipes, 한글 제목 %s %H \u001f\tend";
const c1 = commit(repo, "a.txt", "first", 0);
const c2 = commit(repo, "a.txt", tricky, 10);
raw(repo, ["tag", "-a", "v1.0", "-m", "release"], 10);
raw(repo, ["checkout", "-q", "-b", "feature"]);
const f1 = commit(repo, "feature.txt", "feature one", 20, "Bob Stone <bob@example.com>");
raw(repo, ["checkout", "-q", "main"]);
const c4 = commit(repo, "a.txt", "main moves on", 30);
raw(repo, ["branch", "topic"]);
raw(repo, ["checkout", "-q", "feature"]);
const f2 = commit(repo, "feature.txt", "feature two", 40);
raw(repo, ["checkout", "-q", "main"]);
raw(repo, ["merge", "-q", "--no-ff", "-m", "Merge branch 'feature'", "feature"], 50);
const m = raw(repo, ["rev-parse", "HEAD"]);
const c6 = commit(repo, "a.txt", "after the merge", 60);
raw(tmp, ["init", "-q", "--bare", "origin.git"]);
raw(repo, ["remote", "add", "origin", `${tmp}/origin.git`]);
raw(repo, ["push", "-q", "origin", "main"]);
raw(repo, ["remote", "set-head", "origin", "main"]);

const names = (refs) => refs.map((r) => `${r.kind}:${r.name}`).sort();

// Every branch, newest commit date first, with what the list shows on a row.
const all = await readLog(git, repo);
{
  assert.equal(all.ok, true, all.err);
  assert.deepEqual(all.commits.map((c) => c.hash), [c6, m, f2, c4, f1, c2, c1]);
  assert.deepEqual(all.commits.map((c) => c.parents), [[m], [c4, f2], [f1], [c2], [c2], [c1], []]);
  assert.deepEqual(all.commits.map((c) => c.time), [60, 50, 40, 30, 20, 10, 0].map((n) => T + n));
  const second = all.commits[5];
  assert.equal(second.subject, tricky, "quotes, separators, Korean and control characters survive");
  assert.equal(all.commits[1].subject, "Merge branch 'feature'");
  assert.deepEqual([second.author, second.email], ["Ann Lee", "ann@example.com"]);
  assert.deepEqual([all.commits[4].author, all.commits[4].email], ["Bob Stone", "bob@example.com"]);
}

// Refs: HEAD and its branch, remote branches (not origin/HEAD), other branches, tags.
{
  const [tip, , feature, topic, , tagged, first] = all.commits;
  assert.deepEqual(names(tip.refs), ["head:HEAD", "local:main", "remote:origin/main"]);
  assert.equal(tip.refs.find((r) => r.name === "main").current, true, "the branch HEAD is on is marked");
  assert.deepEqual(names(feature.refs), ["local:feature"]);
  assert.ok(!feature.refs[0].current);
  assert.deepEqual(names(topic.refs), ["local:topic"]);
  assert.deepEqual(names(tagged.refs), ["tag:v1.0"]);
  assert.deepEqual(first.refs, []);
}

// Read in batches (count and skip), the pieces are the whole.
{
  const pieces = [];
  for (let skip = 0; ; skip += 3) {
    const r = await readLog(git, repo, { skip, count: 3 });
    assert.equal(r.ok, true);
    assert.ok(r.commits.length <= 3);
    if (!r.commits.length) break;
    pieces.push(...r.commits);
  }
  assert.deepEqual(pieces, all.commits);
  assert.equal((await readLog(git, repo, { count: 2 })).commits.length, 2);
}

// Limited to a branch: only what that ref reaches.
{
  const r = await readLog(git, repo, { branch: "feature" });
  assert.deepEqual(r.commits.map((c) => c.hash), [f2, f1, c2, c1]);
  const remote = await readLog(git, repo, { branch: "origin/main", count: 1 });
  assert.deepEqual(remote.commits.map((c) => c.hash), [c6]);
  const gone = await readLog(git, repo, { branch: "no-such-branch" });
  assert.equal(gone.ok, false);
  assert.ok(gone.err.length > 0);
  assert.deepEqual(gone.commits, []);
  // A name that looks like an option is still a name, not an option.
  const dashed = await readLog(git, repo, { branch: "--all" });
  assert.equal(dashed.ok, false);
}

// Extra arguments from the filter row: options, paths, and together with a branch.
{
  const byBob = await readLog(git, repo, { extra: ["--author=Bob"] });
  assert.deepEqual(byBob.commits.map((c) => c.hash), [f1]);
  const byPath = await readLog(git, repo, { extra: ["--", "feature.txt"] });
  assert.deepEqual(byPath.commits.map((c) => c.hash), [f2, f1]);
  const both = await readLog(git, repo, { extra: ["--author=Ann", "--", "feature.txt"] });
  assert.deepEqual(both.commits.map((c) => c.hash), [f2]);
  const onMain = await readLog(git, repo, { branch: "main", extra: ["--author=Bob"] });
  assert.deepEqual(onMain.commits.map((c) => c.hash), [f1]);
  const onTopic = await readLog(git, repo, { branch: "topic", extra: ["--author=Bob"] });
  assert.deepEqual(onTopic, { ok: true, err: "", commits: [] });
  const pathOnTopic = await readLog(git, repo, { branch: "topic", extra: ["--", "a.txt"] });
  assert.deepEqual(pathOnTopic.commits.map((c) => c.hash), [c4, c2, c1]);
}

// Graph options. Topologically: a merged branch's commits come right under the merge,
// before the first parent's older ones (by date f2, c4, f1 interleave).
{
  const topo = await readLog(git, repo, { order: "topo" });
  assert.equal(topo.ok, true, topo.err);
  assert.deepEqual(topo.commits.map((c) => c.hash), [c6, m, f2, f1, c4, c2, c1]);
  const byDate = await readLog(git, repo, { order: "date" });
  assert.deepEqual(byDate.commits.map((c) => c.hash), all.commits.map((c) => c.hash));
}

// First parent: from a branch, only its own line; a merge is still listed with both
// parents (graph.js follows the first one).
{
  const r = await readLog(git, repo, { branch: "main", firstParent: true });
  assert.deepEqual(r.commits.map((c) => c.hash), [c6, m, c4, c2, c1]);
  assert.deepEqual(r.commits[1].parents, [c4, f2]);
}

// No merges: merge commits are left out. git does not rewrite the parents of the commits
// under a merge (c6's parent stays m), so the answer says where each merge left out
// leads: its first parent. read: how many commits git gave (the next batch skips them).
{
  const r = await readLog(git, repo, { noMerges: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.commits.map((c) => c.hash), [c6, f2, c4, f1, c2, c1]);
  assert.deepEqual(r.commits[0].parents, [m]);
  assert.deepEqual(r.through, [[m, c4]]);
  assert.equal(r.read, 7);
  // In batches: the merge is still counted, so skip goes on from what git gave.
  const one = await readLog(git, repo, { noMerges: true, count: 2 });
  assert.deepEqual([one.commits.map((c) => c.hash), one.read, one.through], [[c6], 2, [[m, c4]]]);
  const next = await readLog(git, repo, { noMerges: true, skip: one.read, count: 2 });
  assert.deepEqual([next.commits.map((c) => c.hash), next.read, next.through], [[f2, c4], 2, []]);
}

// Author time and commit time: a cherry-pick keeps the author's date and gets a new
// commit date. Non-picked commits: of a branch's commits, the ones whose change the
// current branch has no copy of (git cherry's "+"); every other commit of that branch is
// already on the current branch, by its hash or by an equal change.
{
  const picks = `${tmp}/picks`;
  mkdirSync(picks);
  raw(picks, ["init", "-q", "-b", "main"]);
  const base = commit(picks, "a.txt", "base", 0);
  raw(picks, ["checkout", "-q", "-b", "side"]);
  const same = commit(picks, "s.txt", "picked over", 10);
  const own = commit(picks, "t.txt", "only on side", 20);
  raw(picks, ["checkout", "-q", "main"]);
  raw(picks, ["cherry-pick", same], 30);
  const copy = raw(picks, ["rev-parse", "HEAD"]);
  const r = await readLog(git, picks);
  const byHash = new Map(r.commits.map((c) => [c.hash, c]));
  assert.deepEqual([byHash.get(copy).authorTime, byHash.get(copy).time], [T + 10, T + 30]);
  assert.deepEqual([byHash.get(own).authorTime, byHash.get(own).time], [T + 20, T + 20]);
  const side = await readNotPicked(git, picks, "side");
  assert.deepEqual(side, { ok: true, err: "", notPicked: [own] });
  assert.deepEqual(await readNotPicked(git, picks, "main"), { ok: true, err: "", notPicked: [] });
  const gone = await readNotPicked(git, picks, "no-such");
  assert.equal(gone.ok, false);
  assert.ok(gone.err.length > 0);
  assert.deepEqual(gone.notPicked, []);
  assert.ok(base);
}

// A detached HEAD: the commit carries HEAD and no current branch; commits only HEAD
// reaches are still listed.
{
  const clone = `${tmp}/detached`;
  raw(tmp, ["clone", "-q", repo, clone]);
  raw(clone, ["checkout", "-q", "--detach", c4]);
  const loose = commit(clone, "loose.txt", "on no branch", 70);
  const r = await readLog(git, clone);
  assert.equal(r.commits[0].hash, loose);
  assert.deepEqual(names(r.commits[0].refs), ["head:HEAD"]);
  assert.ok(r.commits.every((c) => c.refs.every((ref) => !ref.current)));
  assert.ok(r.commits.some((c) => c.hash === c6), "the other branches are still there");
}

// A repository without commits, and a folder that isn't one.
{
  const empty = `${tmp}/empty`;
  mkdirSync(empty);
  raw(empty, ["init", "-q", "-b", "main"]);
  assert.deepEqual(await readLog(git, empty), { ok: true, err: "", commits: [] });
  assert.deepEqual(await readLog(git, empty, { branch: null, extra: ["--author=x"] }), { ok: true, err: "", commits: [] });
  const plain = `${tmp}/plain`;
  mkdirSync(plain);
  const r = await readLog(git, plain);
  assert.equal(r.ok, false);
  assert.ok(r.err.length > 0);
}

// The refs' state: the same while nothing moves, different after a commit, a new
// branch or a checkout. The panel reads the log again only when it changes.
{
  const clone = `${tmp}/state`;
  raw(tmp, ["clone", "-q", repo, clone]);
  const before = await readRefsState(git, clone);
  assert.equal(before.ok, true);
  assert.equal((await readRefsState(git, clone)).state, before.state);
  commit(clone, "a.txt", "one more", 80);
  const committed = await readRefsState(git, clone);
  assert.notEqual(committed.state, before.state);
  raw(clone, ["branch", "side"]);
  const branched = await readRefsState(git, clone);
  assert.notEqual(branched.state, committed.state);
  raw(clone, ["checkout", "-q", "side"]);
  assert.notEqual((await readRefsState(git, clone)).state, branched.state, "HEAD moving to a branch at the same commit counts");
  const empty = await readRefsState(git, `${tmp}/empty`);
  assert.equal(empty.ok, true);
}

// The folder to watch for moving refs: the checkout's own .git, and for a linked
// worktree the main checkout's.
{
  assert.deepEqual(await readGitDir(git, repo), { ok: true, err: "", dir: `${repo}/.git` });
  raw(repo, ["worktree", "add", "-q", `${tmp}/linked`, "topic"]);
  assert.deepEqual(await readGitDir(git, `${tmp}/linked`), { ok: true, err: "", dir: `${repo}/.git` });
  raw(repo, ["worktree", "remove", `${tmp}/linked`]);
  const none = await readGitDir(git, `${tmp}/plain`);
  assert.equal(none.ok, false);
  assert.equal(none.dir, null);
  const dir = `${repo}/.git`;
  assert.equal(refsChanged(dir, [`${dir}/refs/heads/main`]), true);
  assert.equal(refsChanged(dir, [`${dir}/index`, `${dir}/HEAD`]), true);
  assert.equal(refsChanged(dir, [`${dir}/worktrees/linked/HEAD`]), true);
  assert.equal(refsChanged(dir, [`${dir}/packed-refs`]), true);
  assert.equal(refsChanged(dir, [dir]), true, "the folder itself: refresh everything");
  assert.equal(refsChanged(dir, [`${dir}/index`, `${dir}/objects/ab/cdef`, `${dir}/COMMIT_EDITMSG`]), false);
  assert.equal(refsChanged(dir, [`${dir}/refs/heads/main.lock`, `${dir}/HEAD.lock`, `${dir}/index.lock`]), false);
  assert.equal(refsChanged(dir, []), false);
}

// A (short) hash to the commit it names.
{
  assert.deepEqual(await resolveCommit(git, repo, f1.slice(0, 8)), { ok: true, err: "", hash: f1 });
  assert.deepEqual(await resolveCommit(git, repo, c6), { ok: true, err: "", hash: c6 });
  const none = await resolveCommit(git, repo, "0123456789abcdef");
  assert.equal(none.ok, false);
  assert.equal(none.hash, null);
  assert.equal(none.err, "No commit 0123456789abcdef");
  assert.deepEqual(none.msg, { key: "log.noCommit", args: { text: "0123456789abcdef" } });
  const tag = await resolveCommit(git, repo, "v1.0");
  assert.deepEqual(tag, { ok: true, err: "", hash: c2 }, "an annotated tag resolves to its commit");
}

// Ref labels: a local branch and its remote twins become one label.
{
  const ref = (name, kind, current) => (current ? { name, kind, current } : { name, kind });
  assert.deepEqual(labelRefs([ref("HEAD", "head"), ref("main", "local", true), ref("origin/main", "remote")]),
    [{ text: "origin & main", kind: "local", current: true }]);
  assert.deepEqual(labelRefs([ref("main", "local"), ref("upstream/main", "remote"), ref("origin/main", "remote")]),
    [{ text: "upstream & origin & main", kind: "local", current: false }]);
  assert.deepEqual(labelRefs([ref("origin/feature/login", "remote"), ref("v1.0", "tag")]),
    [{ text: "origin/feature/login", kind: "remote", current: false }, { text: "v1.0", kind: "tag", current: false }]);
  // A remote branch of another name stays its own label; so does one with a slash in it.
  assert.deepEqual(labelRefs([ref("feature/x", "local"), ref("origin/feature/x", "remote"), ref("origin/other", "remote")]),
    [{ text: "origin & feature/x", kind: "local", current: false }, { text: "origin/other", kind: "remote", current: false }]);
  // Detached: HEAD is a label of its own, first.
  assert.deepEqual(labelRefs([ref("topic", "local"), ref("HEAD", "head")]),
    [{ text: "HEAD", kind: "head", current: true }, { text: "topic", kind: "local", current: false }]);
  assert.deepEqual(labelRefs([]), []);
  // Long names lose their middle.
  assert.equal(shortenMiddle("feature/a-very-long-branch-name-that-goes-on", 24), "feature/a-ve…hat-goes-on");
  assert.equal(shortenMiddle("main", 24), "main");
  assert.equal(shortenMiddle("exactly-twenty-four-char", 24), "exactly-twenty-four-char");
  assert.deepEqual(labelRefs([ref("origin/feature/a-very-long-branch-name-that-goes-on", "remote")], { max: 24 }),
    [{ text: "origin/featu…hat-goes-on", kind: "remote", current: false }]);
}

// Commit times the way the list words them.
{
  const now = new Date(2026, 10, 11, 15, 30, 0);
  const at = (...parts) => Math.floor(new Date(...parts).getTime() / 1000);
  assert.equal(formatCommitTime(at(2026, 10, 11, 15, 29, 40), now), "Moments ago");
  assert.equal(formatCommitTime(at(2026, 10, 11, 15, 29, 0), now), "1 minute ago");
  assert.equal(formatCommitTime(at(2026, 10, 11, 15, 5, 0), now), "25 minutes ago");
  assert.equal(formatCommitTime(at(2026, 10, 11, 14, 31, 0), now), "59 minutes ago");
  assert.equal(formatCommitTime(at(2026, 10, 11, 14, 30, 0), now), "Today 2:30 PM");
  assert.equal(formatCommitTime(at(2026, 10, 11, 0, 5, 0), now), "Today 12:05 AM");
  assert.equal(formatCommitTime(at(2026, 10, 10, 23, 6, 0), now), "Yesterday 11:06 PM");
  assert.equal(formatCommitTime(at(2026, 10, 10, 12, 0, 0), now), "Yesterday 12:00 PM");
  assert.equal(formatCommitTime(at(2026, 10, 9, 9, 5, 0), now), "11/9/26, 9:05 AM");
  assert.equal(formatCommitTime(at(2025, 0, 2, 18, 45, 0), now), "1/2/25, 6:45 PM");
  // Just after midnight, a commit from before it is still minutes old.
  assert.equal(formatCommitTime(at(2026, 10, 10, 23, 50, 0), new Date(2026, 10, 11, 0, 20, 0)), "30 minutes ago");
  // A clock that runs ahead on another machine: no negative minutes.
  assert.equal(formatCommitTime(at(2026, 10, 11, 15, 40, 0), now), "Today 3:40 PM");
}

// Without tags (the Commit list's first look at a view): no tag labels, and a commit that
// only a tag reaches is not there. Everything else is the same read.
{
  const dir = `${tmp}/tags`;
  mkdirSync(dir);
  raw(dir, ["init", "-q", "-b", "main"]);
  const a = commit(dir, "a.txt", "first", 0);
  raw(dir, ["tag", "-a", "v1", "-m", "one"], 0);
  raw(dir, ["checkout", "-q", "-b", "side"]);
  const lone = commit(dir, "lone.txt", "only a tag reaches this", 10);
  raw(dir, ["tag", "-a", "old-release", "-m", "old"], 10);
  raw(dir, ["checkout", "-q", "main"]);
  raw(dir, ["branch", "-q", "-D", "side"]);
  const b = commit(dir, "a.txt", "second", 20);
  raw(dir, ["tag", "light"]);
  raw(dir, ["tag", "release/2.0"]);

  const full = await readLog(git, dir);
  assert.deepEqual(full.commits.map((c) => c.hash), [b, lone, a], "the full read has what only a tag reaches");
  assert.deepEqual(full.commits.map((c) => names(c.refs)), [["head:HEAD", "local:main", "tag:light", "tag:release/2.0"], ["tag:old-release"], ["tag:v1"]]);

  const quick = await readLog(git, dir, { tags: false });
  assert.equal(quick.ok, true, quick.err);
  assert.deepEqual(quick.commits.map((c) => c.hash), [b, a]);
  assert.deepEqual(quick.commits.map((c) => names(c.refs)), [["head:HEAD", "local:main"], []]);
  assert.equal(quick.commits[0].refs.find((r) => r.name === "main").current, true);

  // Limited to a ref, the commits are the same and only the tag labels are missing.
  const limited = await readLog(git, dir, { branch: "old-release", tags: false });
  assert.deepEqual(limited.commits.map((c) => c.hash), [lone, a]);
  assert.deepEqual(limited.commits.map((c) => c.refs), [[], []]);
  // A detached HEAD on a commit only a tag reaches still shows, through HEAD.
  raw(dir, ["checkout", "-q", "--detach", lone]);
  const detached = await readLog(git, dir, { tags: false });
  assert.deepEqual(detached.commits.map((c) => c.hash), [b, lone, a]);
  assert.deepEqual(names(detached.commits[1].refs), ["head:HEAD"]);
}

// A repository with a .mailmap: the author's name and email are the mapped ones, the way
// the User list names people. One the .mailmap doesn't name stays as written. (The repo
// above has no .mailmap and reads the names as written.)
{
  const mapped = `${tmp}/mailmap`;
  mkdirSync(mapped);
  raw(mapped, ["init", "-q", "-b", "main"]);
  writeFileSync(`${mapped}/.mailmap`, "Ann Lee <ann@example.com> <ann.old@example.com>\nBob Stone <bob@example.com> bobby <bob@old.example.com>\n");
  commit(mapped, "a.txt", "by old ann", 0, "ann <ann.old@example.com>");
  commit(mapped, "a.txt", "by old bob", 10, "bobby <bob@old.example.com>");
  commit(mapped, "a.txt", "by carol", 20, "Carol <carol@example.com>");
  const r = await readLog(git, mapped);
  assert.deepEqual(r.commits.map((c) => [c.subject, c.author, c.email]), [
    ["by carol", "Carol", "carol@example.com"],
    ["by old bob", "Bob Stone", "bob@example.com"],
    ["by old ann", "Ann Lee", "ann@example.com"],
  ]);
}

console.log("ok");
