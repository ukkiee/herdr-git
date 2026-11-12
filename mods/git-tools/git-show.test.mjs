// node git-show.test.mjs: readCommit and readContaining against throwaway repositories
// (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readCommit, readContaining, readLastCommit } from "./git-show.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-show-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd, env = {}) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const git = makeGit(exec, null);

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email ada@example.com && git config user.name 'Ada Author'");
  return repo;
};
const write = (repo, path, text) => {
  const dir = path.includes("/") ? `${repo}/${path.slice(0, path.lastIndexOf("/"))}` : repo;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${repo}/${path}`, text);
};
const head = (repo, rev = "HEAD") => sh(repo, `git rev-parse ${rev}`).trim();
const byPath = (files) => [...files].sort((a, b) => (a.path < b.path ? -1 : 1));

// A commit in the middle of a history: who wrote it and when, who committed it and when,
// the whole message (several lines, Korean), and its files against its parent, each with
// what happened to it. A file in a folder with a Korean name comes back as it is named.
{
  const repo = init("plain");
  write(repo, "keep.txt", "one\n");
  write(repo, "gone.txt", "bye\n");
  write(repo, "src/old-name.js", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  sh(repo, "git add -A && git commit -q -m first");
  const first = head(repo);

  write(repo, "keep.txt", "one\ntwo\n");
  write(repo, "문서/새 파일.md", "# 안녕\n");
  sh(repo, "git rm -q gone.txt && git mv src/old-name.js src/new-name.js && git add -A");
  const message = "로그인 흐름을 고친다\n\n- 토큰 갱신 순서를 바꾼다\n- second line stays\n\nRefs: #12";
  writeFileSync(`${base}/message.txt`, message);
  sh(repo, `git commit -q -F ${base}/message.txt`, {
    GIT_AUTHOR_NAME: "Ada Author", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_AUTHOR_DATE: "1700000000 +0900",
    GIT_COMMITTER_NAME: "Cy Committer", GIT_COMMITTER_EMAIL: "cy@example.com", GIT_COMMITTER_DATE: "1700003600 +0000",
  });
  const hash = head(repo);

  const r = await readCommit(git, repo, hash);
  assert.equal(r.ok, true);
  assert.equal(r.err, "");
  assert.equal(r.hash, hash);
  assert.deepEqual(r.parents, [first]);
  assert.equal(r.message, message);
  assert.deepEqual([r.author, r.email, r.authorTime], ["Ada Author", "ada@example.com", 1700000000]);
  assert.deepEqual([r.committer, r.committerEmail, r.commitTime], ["Cy Committer", "cy@example.com", 1700003600]);
  assert.deepEqual(byPath(r.files), [
    { path: "gone.txt", status: "deleted", from: null },
    { path: "keep.txt", status: "modified", from: null },
    { path: "src/new-name.js", status: "renamed", from: "src/old-name.js" },
    { path: "문서/새 파일.md", status: "added", from: null },
  ]);

  // A short hash names the same commit; the full one comes back.
  const short = await readCommit(git, repo, hash.slice(0, 8));
  assert.equal(short.ok, true);
  assert.equal(short.hash, hash);
  assert.equal(short.files.length, 4);
}

// The first commit has no parent: every file in it is listed as added.
{
  const repo = init("root");
  write(repo, "a.txt", "a\n");
  write(repo, "lib/b.txt", "b\n");
  sh(repo, "git add -A && git commit -q -m 'the very first'");
  const hash = head(repo);
  write(repo, "a.txt", "a2\n");
  sh(repo, "git commit -q -am second");

  const r = await readCommit(git, repo, hash);
  assert.equal(r.ok, true);
  assert.deepEqual(r.parents, []);
  assert.equal(r.message, "the very first");
  assert.deepEqual(byPath(r.files), [
    { path: "a.txt", status: "added", from: null },
    { path: "lib/b.txt", status: "added", from: null },
  ]);
}

// A merge commit lists what it brought into the branch it was made on (the difference
// from its first parent), not what the merged branch was missing.
{
  const repo = init("merge");
  write(repo, "base.txt", "base\n");
  sh(repo, "git add -A && git commit -q -m base");
  sh(repo, "git checkout -q -b topic");
  write(repo, "topic.txt", "from topic\n");
  sh(repo, "git add -A && git commit -q -m 'topic work'");
  const topic = head(repo);
  sh(repo, "git checkout -q main");
  write(repo, "main-only.txt", "from main\n");
  sh(repo, "git add -A && git commit -q -m 'main work'");
  const main = head(repo);
  sh(repo, "git merge -q --no-ff -m 'Merge topic' topic");
  const hash = head(repo);

  const r = await readCommit(git, repo, hash);
  assert.equal(r.ok, true);
  assert.deepEqual(r.parents, [main, topic]);
  assert.equal(r.message, "Merge topic");
  assert.deepEqual(r.files, [{ path: "topic.txt", status: "added", from: null }]);
}

// What isn't a commit is an error with git's words, never a throw; text that looks like
// an option is not run as one.
{
  const repo = init("missing");
  write(repo, "a.txt", "a\n");
  sh(repo, "git add -A && git commit -q -m only");

  const none = await readCommit(git, repo, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(none.ok, false);
  assert.notEqual(none.err, "");
  assert.deepEqual([none.hash, none.files, none.parents], [null, [], []]);

  const flag = await readCommit(git, repo, "--output=leak.txt");
  assert.equal(flag.ok, false);
  assert.equal(sh(repo, "git status --porcelain").trim(), "");

  const elsewhere = await readCommit(git, `${base}/nowhere`, "HEAD");
  assert.equal(elsewhere.ok, false);
  assert.notEqual(elsewhere.err, "");
}

// The branches that contain a commit: local ones and the remote's, by name, each said
// which it is. A branch that forked before the commit doesn't have it. The remote's HEAD
// pointer (origin/HEAD) is not a branch.
{
  const repo = init("containing");
  write(repo, "a.txt", "1\n");
  sh(repo, "git add -A && git commit -q -m one");
  const one = head(repo);
  sh(repo, "git branch old-fork");
  write(repo, "a.txt", "2\n");
  sh(repo, "git commit -q -am two");
  const two = head(repo);
  sh(repo, "git branch feature/login");
  // A remote that has main and a branch of its own, both holding `two`.
  sh(repo, `git clone -q --bare . ${base}/containing-remote.git`);
  sh(`${base}/containing-remote.git`, "git branch release/1.0 main");
  sh(repo, `git remote add origin ${base}/containing-remote.git && git fetch -q origin && git remote set-head origin main`);
  write(repo, "a.txt", "3\n");
  sh(repo, "git commit -q -am three");
  const three = head(repo);

  const r = await readContaining(git, repo, two);
  assert.equal(r.ok, true);
  assert.equal(r.err, "");
  assert.deepEqual(r.branches, [
    { name: "feature/login", kind: "local" },
    { name: "main", kind: "local" },
    { name: "origin/feature/login", kind: "remote" },
    { name: "origin/main", kind: "remote" },
    { name: "origin/release/1.0", kind: "remote" },
  ]);

  // The newest commit is on main only: nothing was pushed, no other branch reached it.
  assert.deepEqual((await readContaining(git, repo, three)).branches, [{ name: "main", kind: "local" }]);
  // The oldest one is everywhere, the early fork included.
  assert.deepEqual((await readContaining(git, repo, one)).branches.map((b) => b.name),
    ["feature/login", "main", "old-fork", "origin/feature/login", "origin/main", "origin/old-fork", "origin/release/1.0"]);

  // A commit no branch has (HEAD moved off it): an empty list, not an error.
  sh(repo, "git checkout -q --detach && git commit -q --allow-empty -m loose");
  const loose = head(repo);
  sh(repo, "git checkout -q main");
  const none = await readContaining(git, repo, loose);
  assert.deepEqual([none.ok, none.branches], [true, []]);

  const missing = await readContaining(git, repo, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(missing.ok, false);
  assert.notEqual(missing.err, "");
  assert.deepEqual(missing.branches, []);
}

// A repository with a .mailmap: the author and the committer come mapped, name and email.
// Without one (the repositories above) they read as written.
{
  const repo = init("mailmap");
  write(repo, ".mailmap", "Ada Lovelace <ada@lovelace.example> <ada@example.com>\nCed Committer <ced@example.com> <old.ced@example.com>\n");
  write(repo, "a.txt", "one\n");
  sh(repo, "git add -A && git commit -q -m first", { GIT_COMMITTER_NAME: "ced", GIT_COMMITTER_EMAIL: "old.ced@example.com" });
  const c = await readCommit(git, repo, head(repo));
  assert.equal(c.ok, true, c.err);
  assert.deepEqual([c.author, c.email, c.committer, c.committerEmail], ["Ada Lovelace", "ada@lovelace.example", "Ced Committer", "ced@example.com"]);
}

// The last commit, for the Commit panel's Last commit group while Amend is on: its hash,
// its subject (the message's first line) and its files against its parent, a renamed
// file with its old path.
{
  const repo = init("last-plain");
  write(repo, "keep.txt", "one\n");
  write(repo, "src/old-name.js", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  sh(repo, "git add -A && git commit -q -m first");
  write(repo, "keep.txt", "one\ntwo\n");
  write(repo, "new.txt", "new\n");
  sh(repo, "git mv src/old-name.js src/new-name.js && git add -A");
  writeFileSync(`${base}/last-message.txt`, "로그인 흐름을 고친다\n\n본문 줄\n");
  sh(repo, `git commit -q -F ${base}/last-message.txt`);

  const r = await readLastCommit(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.err, "");
  assert.equal(r.hash, head(repo));
  assert.equal(r.subject, "로그인 흐름을 고친다");
  assert.deepEqual(byPath(r.files), [
    { path: "keep.txt", status: "modified", from: null },
    { path: "new.txt", status: "added", from: null },
    { path: "src/new-name.js", status: "renamed", from: "src/old-name.js" },
  ]);
}

// HEAD on a merge commit: what the merge brought into the branch (against the first
// parent), not what the merged branch was missing.
{
  const repo = init("last-merge");
  write(repo, "base.txt", "base\n");
  sh(repo, "git add -A && git commit -q -m base");
  sh(repo, "git checkout -q -b topic");
  write(repo, "topic.txt", "from topic\n");
  write(repo, "base.txt", "base\nchanged on topic\n");
  sh(repo, "git add -A && git commit -q -m 'topic work'");
  sh(repo, "git checkout -q main");
  write(repo, "main-only.txt", "from main\n");
  sh(repo, "git add -A && git commit -q -m 'main work'");
  sh(repo, "git merge -q --no-ff -m 'Merge topic' topic");

  const r = await readLastCommit(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.hash, head(repo));
  assert.equal(r.subject, "Merge topic");
  assert.deepEqual(byPath(r.files), [
    { path: "base.txt", status: "modified", from: null },
    { path: "topic.txt", status: "added", from: null },
  ]);
}

// HEAD on the first commit (no parent): every file in it, added.
{
  const repo = init("last-root");
  write(repo, "a.txt", "a\n");
  write(repo, "lib/b.txt", "b\n");
  sh(repo, "git add -A && git commit -q -m 'the very first'");

  const r = await readLastCommit(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.subject, "the very first");
  assert.deepEqual(byPath(r.files), [
    { path: "a.txt", status: "added", from: null },
    { path: "lib/b.txt", status: "added", from: null },
  ]);
}

// No commit yet: no last commit, and that is not an error. Outside a repository it is.
{
  const repo = init("last-unborn");
  write(repo, "a.txt", "a\n");
  sh(repo, "git add -A");
  const r = await readLastCommit(git, repo);
  assert.deepEqual(r, { ok: true, err: "", hash: null, subject: "", files: [], same: false });

  const elsewhere = await readLastCommit(git, `${base}/nowhere`);
  assert.equal(elsewhere.ok, false);
  assert.notEqual(elsewhere.err, "");
  assert.equal(elsewhere.hash, null);
}

// Asked again with the hash read before: while HEAD stays there it says so and reads
// nothing more; once HEAD moves (a commit, an amend) the new commit comes back whole.
{
  const repo = init("last-known");
  write(repo, "a.txt", "1\n");
  sh(repo, "git add -A && git commit -q -m one");
  const first = await readLastCommit(git, repo);

  const again = await readLastCommit(git, repo, { known: first.hash });
  assert.deepEqual([again.ok, again.hash, again.same], [true, first.hash, true]);

  write(repo, "b.txt", "2\n");
  sh(repo, "git add -A && git commit -q --amend -m 'one, amended'");
  const amended = await readLastCommit(git, repo, { known: first.hash });
  assert.equal(amended.ok, true, amended.err);
  assert.equal(amended.same, false);
  assert.equal(amended.hash, head(repo));
  assert.notEqual(amended.hash, first.hash);
  assert.equal(amended.subject, "one, amended");
  assert.deepEqual(byPath(amended.files), [
    { path: "a.txt", status: "added", from: null },
    { path: "b.txt", status: "added", from: null },
  ]);
}

console.log("ok");
