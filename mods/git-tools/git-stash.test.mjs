// node git-stash.test.mjs: the stash module against throwaway repositories (no app
// needed). Each case reads the repository again with git itself: the stash list, the
// index and the working tree.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { createStash, listStashes, stashFiles, applyStash, dropStash, clearStashes } from "./git-stash.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-stash-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  sh(repo, "echo one > a.txt && echo keep > k.txt && git add -A && git commit -q -m first");
  return repo;
};
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const stashes = (repo) => sh(repo, "git stash list --format=%H").split("\n").filter(Boolean);
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");

// Create with a message: the tracked change goes in, the tree is clean, the untracked file
// stays; the list shows it on top with its message, branch, hash and time.
{
  const repo = init("create");
  sh(repo, "echo two > a.txt && echo u > u.txt");
  const r = await createStash(git, repo, { message: "my work" });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.hash, stashes(repo)[0]);
  assert.deepEqual(status(repo), ["?? u.txt"]);
  const list = await listStashes(git, repo);
  assert.equal(list.ok, true, list.err);
  assert.equal(list.stashes.length, 1);
  const [s] = list.stashes;
  assert.equal(s.ref, "stash@{0}");
  assert.equal(s.hash, r.hash);
  assert.equal(s.message, "my work");
  assert.equal(s.branch, "main");
  assert.equal(s.untracked, false);
  assert.ok(Math.abs(s.time - Date.now() / 1000) < 600, `time ${s.time}`);
}

// Nothing to put away: git says yes and makes nothing; the module says so.
{
  const repo = init("nothing");
  sh(repo, "echo u > u.txt");
  const r = await createStash(git, repo, { message: "empty" });
  assert.equal(r.ok, false);
  assert.equal(r.msg.key, "stash.nothing");
  assert.equal(r.hash, null);
  assert.equal(r.changed, false);
  assert.deepEqual(stashes(repo), []);
  assert.deepEqual(status(repo), ["?? u.txt"]);
}

// Keep index: the staged change stays staged, the unstaged one goes.
{
  const repo = init("keep-index");
  sh(repo, "echo staged > a.txt && git add a.txt && echo work > k.txt");
  const r = await createStash(git, repo, { keepIndex: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), ["M  a.txt"]);
  assert.equal(text(repo, "k.txt"), "keep\n");
}

// Include untracked: the untracked file goes in too, and the list says so.
{
  const repo = init("untracked");
  sh(repo, "echo two > a.txt && echo u > u.txt");
  const r = await createStash(git, repo, { message: "with u", untracked: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), []);
  const list = await listStashes(git, repo);
  assert.equal(list.stashes[0].untracked, true);
}

// No message: git names it after the commit it was made on; a detached HEAD has no branch.
// Newest first, each with its own number.
{
  const repo = init("names");
  sh(repo, "echo two > a.txt");
  assert.equal((await createStash(git, repo, {})).ok, true);
  sh(repo, "git checkout -q --detach && echo three > a.txt");
  assert.equal((await createStash(git, repo, { message: "detached: yes" })).ok, true);
  const list = await listStashes(git, repo);
  assert.deepEqual(list.stashes.map((s) => [s.ref, s.branch, s.message]), [
    ["stash@{0}", null, "detached: yes"],
    ["stash@{1}", "main", `${sh(repo, "git rev-parse --short HEAD").trim()} first`],
  ]);
}

// Empty list: no stash yet.
{
  const repo = init("empty-list");
  const list = await listStashes(git, repo);
  assert.equal(list.ok, true, list.err);
  assert.deepEqual(list.stashes, []);
}

// Files: the tracked changes against the commit it was made on, and the untracked files
// from the stash's own commit for them (each with the commit its Diff tab opens).
{
  const repo = init("files");
  sh(repo, "echo two > a.txt && git rm -q k.txt && mkdir d && echo n > d/new.txt && git add d/new.txt && echo u > u.txt");
  const made = await createStash(git, repo, { untracked: true });
  const r = await stashFiles(git, repo, made.hash);
  assert.equal(r.ok, true, r.err);
  const third = sh(repo, `git rev-parse ${made.hash}^3`).trim();
  assert.deepEqual(r.files.map((f) => [f.path, f.status, f.commit]), [
    ["a.txt", "modified", made.hash],
    ["d/new.txt", "added", made.hash],
    ["k.txt", "deleted", made.hash],
    ["u.txt", "unversioned", third],
  ]);
}

// A linked worktree reads and writes the same list.
{
  const repo = init("linked");
  const other = `${base}/linked-wt`;
  sh(repo, `git worktree add -q -b side ${JSON.stringify(other)}`);
  sh(other, "echo side > a.txt");
  const made = await createStash(git, other, { message: "from the worktree" });
  assert.equal(made.ok, true, made.err);
  const here = await listStashes(git, repo), there = await listStashes(git, other);
  assert.deepEqual(here.stashes, there.stashes);
  assert.equal(here.stashes[0].branch, "side");
  assert.equal(here.stashes[0].hash, made.hash);
}

// A stash with a staged and an unstaged change, made on main.
const staged = (name) => {
  const repo = init(name);
  sh(repo, "echo staged > a.txt && git add a.txt && echo work > k.txt");
  return { repo, made: sh(repo, "git stash push -q -m mine && git rev-parse refs/stash").trim() };
};

// Apply without the index: everything comes back unstaged; the stash stays.
{
  const { repo, made } = staged("apply");
  const r = await applyStash(git, repo, { hash: made });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  assert.deepEqual(status(repo), [" M a.txt", " M k.txt"]);
  assert.deepEqual(stashes(repo), [made]);
}

// Apply with the index (Reinstate index): the staging comes back too.
{
  const { repo, made } = staged("apply-index");
  const r = await applyStash(git, repo, { hash: made, index: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), [" M k.txt", "M  a.txt"]);
}

// Pop by hash after the numbers moved: that stash comes back and leaves the list; the
// newer one stays.
{
  const { repo, made } = staged("pop");
  sh(repo, "echo newer > k.txt && git stash push -q -m newer");
  const newer = stashes(repo)[0];
  const r = await applyStash(git, repo, { hash: made, pop: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(stashes(repo), [newer]);
  assert.equal(text(repo, "a.txt"), "staged\n");
}

// As a new branch: the branch starts where the stash was made, with the stash's staging,
// and the stash leaves the list.
{
  const { repo, made } = staged("branch");
  sh(repo, "echo later > k.txt && git commit -q -am later");
  const r = await applyStash(git, repo, { hash: made, branch: "from-stash" });
  assert.equal(r.ok, true, r.err);
  assert.equal(sh(repo, "git symbolic-ref --short HEAD").trim(), "from-stash");
  assert.equal(sh(repo, "git rev-parse HEAD").trim(), sh(repo, "git rev-parse main~1").trim());
  assert.deepEqual(status(repo), [" M k.txt", "M  a.txt"]);
  assert.deepEqual(stashes(repo), []);
}

// A conflicting apply: the files are left in conflict with no operation, the stash stays
// (pop too), and the result says it stopped there.
{
  const { repo, made } = staged("conflict");
  sh(repo, "echo theirs > a.txt && git commit -q -am theirs");
  const r = await applyStash(git, repo, { hash: made, pop: true });
  assert.equal(r.outcome, "stopped");
  assert.equal(r.operation.kind, null);
  assert.deepEqual(r.operation.conflicts.map((c) => c.path ?? c), ["a.txt"]);
  assert.equal(r.changed, true);
  assert.deepEqual(stashes(repo), [made]);
}

// Refused (a local change in the same file): nothing changes, git's words come back.
{
  const { repo, made } = staged("refused");
  sh(repo, "echo mine > a.txt");
  const r = await applyStash(git, repo, { hash: made });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "failed");
  assert.ok(r.err.length > 0);
  assert.equal(text(repo, "a.txt"), "mine\n");
  assert.deepEqual(stashes(repo), [made]);
}

// Drop by hash after the numbers moved: only that stash goes.
{
  const { repo, made } = staged("drop");
  sh(repo, "echo newer > k.txt && git stash push -q -m newer");
  const newer = stashes(repo)[0];
  const r = await dropStash(git, repo, { hash: made });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(stashes(repo), [newer]);
  // Gone by now: nothing is dropped, and the reason says so.
  const again = await dropStash(git, repo, { hash: made });
  assert.equal(again.ok, false);
  assert.equal(again.msg.key, "stash.gone");
  assert.deepEqual(stashes(repo), [newer]);
  // Pop of a gone stash: nothing comes back.
  const pop = await applyStash(git, repo, { hash: made, pop: true });
  assert.equal(pop.ok, false);
  assert.equal(pop.msg.key, "stash.gone");
  assert.deepEqual(status(repo), []);
}

// Clear: every stash goes.
{
  const { repo } = staged("clear");
  sh(repo, "echo newer > k.txt && git stash push -q -m newer");
  const r = await clearStashes(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(stashes(repo), []);
}

// What Smart operation does by hash: put away with untracked files, apply with the index,
// then drop.
{
  const repo = init("smart");
  sh(repo, "echo staged > a.txt && git add a.txt && echo u > u.txt");
  const made = await createStash(git, repo, { message: "smart", untracked: true });
  assert.equal(made.ok, true, made.err);
  assert.deepEqual(status(repo), []);
  const back = await applyStash(git, repo, { hash: made.hash, index: true });
  assert.equal(back.ok, true, back.err);
  assert.deepEqual(status(repo), ["?? u.txt", "M  a.txt"]);
  assert.equal((await dropStash(git, repo, { hash: made.hash })).ok, true);
  assert.deepEqual(stashes(repo), []);
}

console.log("ok");
