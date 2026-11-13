// node git-patch.test.mjs: patches of local changes, reading a patch's files, and applying
// the checked files of a patch, against throwaway repositories (no app needed). Each case
// reads the repository again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { createPatch } from "./git-revision.js";
import { changesCommit } from "./git-patch.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8" });
const run = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const git = makeGit(exec, null, { record: () => {} });
const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-patch-`));

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const write = (repo, path, text) => { mkdirSync(`${repo}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(`${repo}/${path}`, text); };
const commit = (repo, message) => { sh(repo, `git add -A && git commit -q -m "${message}"`); return sh(repo, "git rev-parse HEAD").trim(); };
const status = (repo) => run(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
const headers = (text) => text.split("\n").filter((line) => line.startsWith("diff --git "));

// ---- Create Patch from local changes: only the chosen files, the repository untouched
{
  const repo = init("local");
  write(repo, "a.txt", "1\n2\n3\n"); write(repo, "b.txt", "b\n"); write(repo, "gone.txt", "bye\n");
  write(repo, "old.txt", "a long enough line\nanother line\nthird line\n"); write(repo, "[x] *.txt", "x\n");
  const head = commit(repo, "base");
  write(repo, "a.txt", "1\n2 changed\n3\n"); write(repo, "b.txt", "b changed\n");
  sh(repo, "rm gone.txt && mv old.txt new.txt");
  write(repo, "add.txt", "new\n"); writeFileSync(`${repo}/bin.dat`, Buffer.from([0, 1, 2, 255]));
  write(repo, "[x] *.txt", "y\n");
  // A staged change goes in as the working tree has it.
  run(repo, ["add", "a.txt"]);
  write(repo, "a.txt", "1\n2 changed again\n3\n");
  const before = status(repo), index = run(repo, ["ls-files", "-s"]);

  const paths = ["a.txt", "gone.txt", "old.txt", "new.txt", "add.txt", "bin.dat", "[x] *.txt"];
  const r = await changesCommit(git, repo, { paths, message: "My change\n\nbody" });
  assert.equal(r.ok, true, r.err);
  assert.match(r.hash, /^[0-9a-f]{40}$/);
  // The commit sits on HEAD, holds the message, and no ref names it.
  assert.equal(run(repo, ["rev-parse", `${r.hash}^`]).trim(), head);
  assert.equal(run(repo, ["log", "-1", "--format=%B", r.hash]).trim(), "My change\n\nbody");
  assert.equal(run(repo, ["for-each-ref", "--points-at", r.hash]), "");
  assert.equal(run(repo, ["rev-parse", "HEAD"]).trim(), head);
  // Index and working tree as they were.
  assert.equal(status(repo), before);
  assert.equal(run(repo, ["ls-files", "-s"]), index);

  // The patch of that commit (the Patch File Settings dialog's way) has the chosen files only.
  const p = await createPatch(git, repo, { commits: [r.hash], paths });
  assert.equal(p.ok, true, p.err);
  assert.deepEqual(headers(p.text), [
    "diff --git a/[x] *.txt b/[x] *.txt",
    "diff --git a/a.txt b/a.txt",
    "diff --git a/add.txt b/add.txt",
    "diff --git a/bin.dat b/bin.dat",
    "diff --git a/gone.txt b/gone.txt",
    "diff --git a/old.txt b/new.txt",
  ]);
  assert.match(p.text, /\+2 changed again/);
  assert.match(p.text, /GIT binary patch/);
  assert.match(p.text, /rename from old\.txt\nrename to new\.txt/);
  assert.match(p.text, /deleted file mode/);
  assert.doesNotMatch(p.text, /b\.txt/);

  // The patch applied to HEAD in a clone gives the chosen files as they are here.
  const other = `${base}/local-clone`;
  run(base, ["clone", "-q", repo, other]);
  writeFileSync(`${base}/local.patch`, p.text);
  run(other, ["apply", `${base}/local.patch`]);
  assert.equal(readFileSync(`${other}/a.txt`, "utf8"), "1\n2 changed again\n3\n");
  assert.deepEqual([...readFileSync(`${other}/bin.dat`)], [0, 1, 2, 255]);
  assert.equal(existsSync(`${other}/gone.txt`), false);
  assert.equal(readFileSync(`${other}/new.txt`, "utf8"), "a long enough line\nanother line\nthird line\n");
  assert.equal(readFileSync(`${other}/b.txt`, "utf8"), "b\n");

  // Nothing chosen: refused with the mod's sentence.
  const none = await changesCommit(git, repo, { paths: [], message: "" });
  assert.equal(none.ok, false);
  assert.equal(none.msg.key, "patch.noFiles");
}

// ---- A repository without a commit yet: the changes start from nothing.
{
  const repo = init("unborn");
  write(repo, "first.txt", "hello\n"); write(repo, "other.txt", "o\n");
  const r = await changesCommit(git, repo, { paths: ["first.txt"], message: "" });
  assert.equal(r.ok, true, r.err);
  const p = await createPatch(git, repo, { commits: [r.hash], paths: ["first.txt"] });
  assert.equal(p.ok, true, p.err);
  assert.deepEqual(headers(p.text), ["diff --git a/first.txt b/first.txt"]);
  assert.match(p.text, /new file mode/);
  assert.equal(status(repo), "?? first.txt\0?? other.txt\0");
}

console.log("ok");
