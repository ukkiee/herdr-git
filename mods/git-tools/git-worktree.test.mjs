// node git-worktree.test.mjs: New Worktree (an existing branch, a new branch, a branch
// another worktree has checked out, the location) and Checkout Tag or Revision, against
// throwaway repositories whose remote is a local bare repository (no app, no network).
// Every check reads the repositories back with git.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { createWorktree, worktreeSources, worktreePath, checkoutRef } from "./git-worktree.js";
import { translator } from "./i18n.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-worktree-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);
const rev = (repo, name) => sh(repo, `git rev-parse --verify --quiet ${name} || true`).trim();
const branchAt = (dir) => sh(dir, "git symbolic-ref --quiet --short HEAD || true").trim();
const worktrees = (repo) => sh(repo, "git worktree list --porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
const en = translator("en"), ko = translator("ko");
const worded = (r, key) => {
  assert.equal(r.ok, false);
  assert.equal(r.msg?.key, key, r.err);
  assert.equal(en(r.msg.key, r.msg.args), r.err);
  assert.notEqual(ko(r.msg.key, r.msg.args), r.msg.key, `${key} has Korean`);
};

// A repository on main with two commits, its bare copy as `origin`, a local branch
// `feature` one commit ahead, a tag v1 on the first commit, and origin/feature.
const setup = (name) => {
  const repo = `${base}/${name}`, remote = `${base}/${name}-remote.git`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo 1 > a && git add a && git commit -q -m one && git tag v1 && echo 2 > a && git commit -q -am two
git clone -q --bare . ${remote} && git remote add origin ${remote}
git branch -q feature && git checkout -q feature && echo 3 > a && git commit -q -am three && git checkout -q main
git push -q origin feature && git fetch -q origin && git remote set-head origin main`);
  return { repo, remote };
};

// An existing branch: the new folder is a worktree on that branch.
{
  const { repo } = setup("existing");
  const path = `${base}/existing-feature`;
  const r = await createWorktree(git, repo, { source: { name: "feature", scope: "local" }, path });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.path, path);
  assert.equal(branchAt(path), "feature");
  assert.ok(worktrees(repo).includes(path));
  assert.equal(branchAt(repo), "main", "the repository's own worktree stays where it was");
}

// A new branch: made at the source's commit and checked out in the new folder, even from
// the branch this worktree has checked out. A taken name is refused with git's words.
{
  const { repo } = setup("new-branch");
  const path = `${base}/new-branch-topic`;
  const r = await createWorktree(git, repo, { source: { name: "main", scope: "local" }, newBranch: "topic", path });
  assert.equal(r.ok, true, r.err);
  assert.equal(branchAt(path), "topic");
  assert.equal(rev(repo, "refs/heads/topic"), rev(repo, "main"));

  const fromRemote = `${base}/new-branch-remote`;
  const rr = await createWorktree(git, repo, { source: { name: "origin/feature", scope: "remote" }, newBranch: "from-remote", path: fromRemote });
  assert.equal(rr.ok, true, rr.err);
  assert.equal(branchAt(fromRemote), "from-remote");
  assert.equal(rev(repo, "refs/heads/from-remote"), rev(repo, "refs/remotes/origin/feature"));

  const taken = await createWorktree(git, repo, { source: { name: "main", scope: "local" }, newBranch: "feature", path: `${base}/new-branch-taken` });
  assert.equal(taken.ok, false);
  assert.match(taken.err, /feature/);
  assert.equal(existsSync(`${base}/new-branch-taken`), false);
  assert.equal(rev(repo, "refs/heads/feature"), rev(repo, "feature"));
}

// A branch another worktree has checked out, with no new branch: git refuses, its words
// come back, and no worktree or folder is made.
{
  const { repo } = setup("taken");
  const before = worktrees(repo);
  const path = `${base}/taken-main`;
  const r = await createWorktree(git, repo, { source: { name: "main", scope: "local" }, path });
  assert.equal(r.ok, false);
  assert.equal(r.code, 128);
  assert.match(r.err, /main/);
  assert.match(r.err, new RegExp(repo));
  assert.deepEqual(worktrees(repo), before);
  assert.equal(existsSync(path), false);
}

// A remote branch with no new branch: a worktree on a detached HEAD at its commit.
{
  const { repo } = setup("remote-detached");
  const path = `${base}/remote-detached-wt`;
  const r = await createWorktree(git, repo, { source: { name: "origin/feature", scope: "remote" }, path });
  assert.equal(r.ok, true, r.err);
  assert.equal(branchAt(path), "");
  assert.equal(rev(path, "HEAD"), rev(repo, "refs/remotes/origin/feature"));
  assert.equal(rev(repo, "refs/heads/origin/feature"), "", "no local branch is made");
}

// The location: what is asked for must be a full path; an existing folder with files is
// refused by git.
{
  const { repo } = setup("location");
  worded(await createWorktree(git, repo, { source: { name: "feature", scope: "local" }, path: "" }), "worktree.needPath");
  worded(await createWorktree(git, repo, { source: { name: "feature", scope: "local" }, path: "relative/dir" }), "worktree.pathNotFull");
  worded(await createWorktree(git, repo, { source: { name: "feature", scope: "local" }, path: "~/wt" }), "worktree.pathNotFull");
  worded(await createWorktree(git, repo, { source: { name: "feature", scope: "local" }, newBranch: "bad name", path: `${base}/location-bad` }), "log.invalidBranchName");
  assert.equal(existsSync(`${base}/location-bad`), false);
  worded(await createWorktree(git, repo, { source: null, path: `${base}/location-none` }), "worktree.needSource");
  const full = `${base}/location-full`;
  mkdirSync(full);
  sh(full, "echo x > keep");
  const r = await createWorktree(git, repo, { source: { name: "feature", scope: "local" }, path: full });
  assert.equal(r.ok, false);
  assert.ok(r.err);
  assert.equal(sh(full, "ls").trim(), "keep");
}

// The suggested location: a folder beside the repository named after it and the branch.
assert.equal(worktreePath("/work/app", "feature"), "/work/app-feature");
assert.equal(worktreePath("/work/app/", "feature/login"), "/work/app-feature-login");
assert.equal(worktreePath("/work/app", "origin/feature"), "/work/app-origin-feature");
assert.equal(worktreePath("C:\\work\\app", "fix"), "C:\\work\\app-fix");
assert.equal(worktreePath("/app", "x"), "/app-x");

// The source list: local branches, then remote ones (no remote HEAD), each with the
// worktree that has it checked out.
{
  const { repo } = setup("sources");
  sh(repo, `git worktree add -q ${base}/sources-feature feature`);
  const r = await worktreeSources(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.branches, [
    { name: "feature", scope: "local", checkedOut: `${base}/sources-feature` },
    { name: "main", scope: "local", checkedOut: repo },
    { name: "origin/feature", scope: "remote", checkedOut: null },
    { name: "origin/main", scope: "remote", checkedOut: null },
  ]);
  assert.equal(r.current, "main");
  sh(repo, "git checkout -q --detach");
  assert.equal((await worktreeSources(git, repo)).current, null);
}

// Checkout Tag or Revision: a tag, a branch or a hash leaves HEAD detached at that
// commit; a name nothing has is refused and HEAD stays.
{
  const { repo } = setup("checkout-ref");
  let r = await checkoutRef(git, repo, "v1");
  assert.equal(r.ok, true, r.err);
  assert.equal(branchAt(repo), "");
  assert.equal(rev(repo, "HEAD"), rev(repo, "v1^{commit}"));

  r = await checkoutRef(git, repo, " feature ");
  assert.equal(r.ok, true, r.err);
  assert.equal(branchAt(repo), "", "a branch name detaches too");
  assert.equal(rev(repo, "HEAD"), rev(repo, "feature"));

  r = await checkoutRef(git, repo, rev(repo, "main").slice(0, 8));
  assert.equal(r.ok, true, r.err);
  assert.equal(rev(repo, "HEAD"), rev(repo, "main"));

  const at = rev(repo, "HEAD");
  worded(await checkoutRef(git, repo, "nope"), "worktree.unknownRef");
  worded(await checkoutRef(git, repo, "--force"), "worktree.unknownRef");
  worded(await checkoutRef(git, repo, ""), "worktree.enterRef");
  assert.equal(rev(repo, "HEAD"), at);
}

console.log("ok");
