// node git-heads.test.mjs: what the VCS widget and its popup read (the current branch,
// commits to pull and to push, recent branches, tags) against throwaway repositories with
// a local bare remote (no app needed). Each case moves the repository with plain git, the
// way a terminal would, then reads it.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readHeads } from "./git-heads.js";

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
  assert.deepEqual(r.current, { name: "main", upstream: "origin/main", ahead: 1, behind: 2 });
  assert.deepEqual(r.head, { branch: "main", hash: raw(repo, ["rev-parse", "HEAD"]), detached: false });
  assert.deepEqual(r.remote.map((b) => b.name), ["origin/main"]);
}

// A branch that tracks nothing: no upstream, nothing to pull or push.
{
  raw(repo, ["checkout", "-q", "-b", "topic"]);
  const r = await readHeads(git, repo);
  assert.deepEqual(r.current, { name: "topic", upstream: null, ahead: 0, behind: 0 });
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
  assert.deepEqual(f.current, { name: "main", upstream: null, ahead: 0, behind: 0 });
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

console.log("git-heads: ok");
