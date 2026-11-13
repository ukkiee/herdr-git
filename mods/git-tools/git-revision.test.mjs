// node git-revision.test.mjs: a commit's files, the history up to a commit, patches, finding
// a commit by what was typed, and a commit's parents and children, against throwaway
// repositories (no app needed). Each case reads the repository again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readRevisionFile } from "./git-compare.js";
import { revisionTree, historyUpTo } from "./git-revision.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8" });
const git = makeGit(exec, null, { record: () => {} });
const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-revision-`));

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const write = (repo, path, text) => { mkdirSync(`${repo}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(`${repo}/${path}`, text); };
const commit = (repo, message) => { sh(repo, `git add -A && git commit -q -m "${message}"`); return sh(repo, "git rev-parse HEAD").trim(); };

// ---- Show Repository at Revision: the commit's files, not today's
{
  const repo = init("tree");
  write(repo, "a.txt", "1\n"); write(repo, "src/[id]/page.tsx", "p\n"); write(repo, "src/lib/x.js", "x\n");
  const c1 = commit(repo, "one");
  sh(repo, "git rm -q a.txt"); write(repo, "b.txt", "b\n"); write(repo, "src/lib/x.js", "x2\n");
  commit(repo, "two");
  write(repo, "local.txt", "not committed\n");
  // Read from a folder below the root: still the whole commit.
  const r = await revisionTree(git, `${repo}/src`, c1);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.hash, c1);
  assert.deepEqual(r.files.map((f) => f.path), ["a.txt", "src/[id]/page.tsx", "src/lib/x.js"]);
  assert.ok(r.files.every((f) => f.kind === "file"));
  // A file's content as that commit has it (the preview reads it this way).
  const x = await readRevisionFile(git, repo, { rev: c1, path: "src/lib/x.js" });
  assert.equal(x.text, "x\n");
  const page = await readRevisionFile(git, repo, { rev: c1, path: "src/[id]/page.tsx" });
  assert.equal(page.text, "p\n");
  const short = await revisionTree(git, repo, c1.slice(0, 7));
  assert.equal(short.hash, c1, "a short hash is read as the commit");
  const none = await revisionTree(git, repo, "no-such-rev");
  assert.equal(none.ok, false);
  assert.deepEqual(none.files, []);
  // A symbolic link is a link, not its target's content.
  sh(repo, "ln -s b.txt link && git add link && git commit -q -m link");
  const linked = await revisionTree(git, repo, "HEAD");
  assert.equal(linked.files.find((f) => f.path === "link").kind, "link");
}

// ---- History up to Here: the commits up to one, of a file when one is given
{
  const repo = init("history");
  write(repo, "a.txt", "1\n"); const c1 = commit(repo, "one");
  write(repo, "b.txt", "b\n"); const c2 = commit(repo, "two");
  write(repo, "a.txt", "2\n"); const c3 = commit(repo, "three");
  sh(repo, "git mv a.txt moved.txt"); const c4 = commit(repo, "four");
  write(repo, "moved.txt", "3\n"); const c5 = commit(repo, "five");
  sh(repo, "git switch -q -c side " + c2);
  write(repo, "s.txt", "s\n"); commit(repo, "side");
  sh(repo, "git switch -q main");

  const all = await historyUpTo(git, repo, { rev: c3 });
  assert.equal(all.ok, true, all.err);
  assert.deepEqual(all.commits.map((c) => c.hash), [c3, c2, c1], "newest first, nothing after it, no other branch");
  assert.equal(all.commits[0].subject, "three");
  assert.deepEqual(all.commits[0].parents, [c2]);
  assert.equal(all.more, false);

  // A file's history follows it back over a rename.
  const file = await historyUpTo(git, repo, { rev: c5, path: "moved.txt" });
  assert.equal(file.ok, true, file.err);
  assert.deepEqual(file.commits.map((c) => c.hash), [c5, c4, c3, c1]);

  // In pages: `max` at a time, `more` while there are others.
  const first = await historyUpTo(git, repo, { rev: c5, max: 2 });
  assert.deepEqual(first.commits.map((c) => c.hash), [c5, c4]);
  assert.equal(first.more, true);
  const next = await historyUpTo(git, repo, { rev: c5, max: 2, skip: 2 });
  assert.deepEqual(next.commits.map((c) => c.hash), [c3, c2]);
  const last = await historyUpTo(git, repo, { rev: c5, max: 2, skip: 4 });
  assert.deepEqual(last.commits.map((c) => c.hash), [c1]);
  assert.equal(last.more, false);

  const gone = await historyUpTo(git, repo, { rev: "nope" });
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.commits, []);
}

console.log("ok");
