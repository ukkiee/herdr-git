// node git-smart.test.mjs: Smart operation against throwaway repositories (no app
// needed). Each case reads the repository again with git itself: HEAD, the stash list,
// the index and the working tree, and the mark in the repository's settings.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { blockedBy } from "./git-smart.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-smart-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

// Five lines each, so a change at the top and one at the bottom of the same file merge.
const lines = (word) => ["1", "2", "3", "4", "5"].map((n) => `${word}${n}`).join("\n") + "\n";
const write = (repo, path, text) => writeFileSync(`${repo}/${path}`, text);
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");
const edit = (repo, path, at, word) => {
  const all = text(repo, path).split("\n");
  all[at] = word;
  write(repo, path, all.join("\n"));
};

// main: a.txt, b.txt, c.txt, d.txt. side (from main): changes a.txt (bottom line) and
// adds s.txt.
const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  for (const f of ["a", "b", "c", "d"]) write(repo, `${f}.txt`, lines(f));
  sh(repo, "git add -A && git commit -q -m first");
  sh(repo, "git checkout -q -b side");
  edit(repo, "a.txt", 4, "side-a5");
  write(repo, "s.txt", "s\n");
  sh(repo, "git add -A && git commit -q -m side && git checkout -q main");
  return repo;
};
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const head = (repo) => sh(repo, "git rev-parse HEAD").trim();
const branch = (repo) => sh(repo, "git symbolic-ref -q --short HEAD || true").trim();
const stashes = (repo) => sh(repo, "git stash list --format=%H").split("\n").filter(Boolean);
const sorted = (paths) => [...paths].sort();

// ---- the files in the way, by request

// Checkout: the local changes to files that differ between HEAD and the branch. A change
// to a file both have the same, and an untracked file, are not in the way.
{
  const repo = init("blocked-checkout");
  edit(repo, "a.txt", 0, "mine-a1");
  edit(repo, "b.txt", 0, "mine-b1");
  write(repo, "u.txt", "u\n");
  const r = await blockedBy(git, repo, { type: "checkout", name: "side" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.paths, ["a.txt"]);
  const remote = await blockedBy(git, repo, { type: "checkout", name: "nowhere/side", remote: true });
  assert.deepEqual(remote.paths, [], "a branch that is not there blocks nothing");
}

// Merge, cherry-pick, revert: the local changes to files the request changes, and every
// staged change as soon as one is staged (git refuses those whatever they touch).
{
  const repo = init("blocked-merge");
  edit(repo, "a.txt", 0, "mine-a1");
  edit(repo, "b.txt", 0, "mine-b1");
  assert.deepEqual((await blockedBy(git, repo, { type: "merge", target: "side" })).paths, ["a.txt"]);
  assert.deepEqual((await blockedBy(git, repo, { type: "cherry-pick", commits: ["side"] })).paths, ["a.txt"]);
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "revert", commits: [head(repo)] })).paths), ["a.txt", "b.txt"], "reverting the first commit removes every file");
  sh(repo, "git add c.txt && echo staged >> c.txt && git add c.txt");
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "merge", target: "side" })).paths), ["a.txt", "c.txt"]);
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "pull", target: "side" })).paths), ["a.txt", "c.txt"]);
}

// Rebase, a pull that rebases, checkout and rebase: every tracked change.
{
  const repo = init("blocked-rebase");
  edit(repo, "b.txt", 0, "mine-b1");
  write(repo, "u.txt", "u\n");
  sh(repo, "echo staged >> c.txt && git add c.txt");
  for (const type of ["rebase", "checkout-rebase"]) assert.deepEqual(sorted((await blockedBy(git, repo, { type, target: "side" })).paths), ["b.txt", "c.txt"], type);
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "pull", rebase: true })).paths), ["b.txt", "c.txt"]);
  assert.deepEqual((await blockedBy(git, repo, { type: "continue" })).paths, [], "Continue, Abort and Skip have none");
}

console.log("ok");
