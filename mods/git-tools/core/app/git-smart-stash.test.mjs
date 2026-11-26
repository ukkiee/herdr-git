// node git-smart-stash.test.mjs: smartRunWith with a request given as `run` against
// throwaway repositories, and that git-smart.js hands out this module's functions
// themselves. The rest is tested through git-smart.js (git-smart.test.mjs).
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "../../adapters/out/git.js";
import { smartRunWith, SMART_MARK, smartMessage, readSmartMark, settleSmartStash } from "./git-smart-stash.js";
import * as smart from "./git-smart.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-smart-stash-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

// main: a.txt. side (from main): changes a.txt.
const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  writeFileSync(`${repo}/a.txt`, "a\n");
  sh(repo, "git add -A && git commit -q -m first && git checkout -q -b side");
  writeFileSync(`${repo}/a.txt`, "side\n");
  sh(repo, "git commit -q -am side && git checkout -q main");
  return repo;
};

assert.equal(smart.SMART_MARK, SMART_MARK);
assert.equal(smart.smartMessage, smartMessage);
assert.equal(smart.readSmartMark, readSmartMark);
assert.equal(smart.settleSmartStash, settleSmartStash);
const stashes = (repo) => sh(repo, "git stash list --format=%H").split("\n").filter(Boolean);

// The request runs on a clean tree, and the change and its staging come back after it.
{
  const repo = init("run");
  writeFileSync(`${repo}/a.txt`, "mine\n");
  sh(repo, "git add a.txt");
  let seen = null;
  const r = await smartRunWith(git, repo, {
    request: { type: "checkout" },
    run: async (g, root) => { seen = sh(root, "git status --porcelain"); return g(root, ["checkout", "-q", "-b", "other"]); },
    now: new Date(2026, 10, 13, 10, 30),
  });
  assert.equal(seen, "");
  assert.equal(r.outcome, "done", r.err);
  assert.equal(sh(repo, "git symbolic-ref --short HEAD").trim(), "other");
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "mine\n");
  assert.equal(sh(repo, "git status --porcelain"), "M  a.txt\n");
  assert.deepEqual(stashes(repo), []);
}

// A request that throws counts as failed, and the changes still come back.
{
  const repo = init("throws");
  writeFileSync(`${repo}/a.txt`, "mine\n");
  const r = await smartRunWith(git, repo, { request: { type: "merge" }, run: async () => { throw new Error("boom"); } });
  assert.equal(r.outcome, "failed");
  assert.equal(r.err, "boom");
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "mine\n");
  assert.deepEqual(stashes(repo), []);
}

console.log("git-smart-stash: ok");
