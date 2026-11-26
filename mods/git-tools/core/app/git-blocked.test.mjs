// node git-blocked.test.mjs: where a checkout goes (checkoutTarget) against throwaway
// repositories, and that git-smart.js hands out this module's functions themselves.
// blockedBy and the checkouts are tested through git-smart.js (git-smart.test.mjs).
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "../../adapters/out/git.js";
import { checkoutTarget, blockedBy, checkoutBranch, checkoutRevisionOf } from "./git-blocked.js";
import * as smart from "./git-smart.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-blocked-`));
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

assert.equal(smart.blockedBy, blockedBy);
assert.equal(smart.checkoutBranch, checkoutBranch);
assert.equal(smart.checkoutRevisionOf, checkoutRevisionOf);

// A local branch; a remote branch with no local one yet (a remote's name may hold
// slashes); a remote branch whose local one exists; nothing.
{
  const repo = init("target");
  sh(repo, "git remote add up/stream /nowhere && git update-ref refs/remotes/up/stream/feature side");
  sh(repo, "git update-ref refs/remotes/up/stream/side side");
  assert.deepEqual(await checkoutTarget(git, repo, { name: "side" }), { local: "side", ref: "refs/heads/side", exists: true });
  assert.deepEqual(await checkoutTarget(git, repo, { name: "up/stream/feature", remote: true }), { local: "feature", ref: "refs/remotes/up/stream/feature", exists: false });
  assert.deepEqual(await checkoutTarget(git, repo, { name: "up/stream/side", remote: true }), { local: "side", ref: "refs/heads/side", exists: true });
  assert.equal(await checkoutTarget(git, repo, { name: "gone" }), null);
  assert.equal(await checkoutTarget(git, repo, { name: "nowhere/side", remote: true }), null);
  assert.equal(await checkoutTarget(git, repo, { name: "" }), null);
}

console.log("git-blocked: ok");
