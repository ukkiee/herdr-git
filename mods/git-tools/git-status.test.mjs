// node git-status.test.mjs: readStatus against throwaway repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readStatus } from "./git-status.js";
import { translator } from "./i18n.js";

// The person's own git settings stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-status-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
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
  return repo;
};

// Modified, deleted, newly added and untracked files land in the two groups with the
// right status. Names with spaces and Korean come back as they are on disk.
{
  const repo = init("mixed");
  mkdirSync(`${repo}/src/app`, { recursive: true });
  mkdirSync(`${repo}/docs`);
  sh(repo, `echo 1 > keep.txt && echo 1 > src/app/a.ts && echo 1 > src/app/gone.ts && echo 1 > "docs/my notes.md" && echo 1 > "docs/한글 문서.md" && echo 1 > staged-gone.txt
git add -A && git commit -q -m first`);
  writeFileSync(`${repo}/src/app/a.ts`, "2\n"); // modified, not staged
  sh(repo, `rm src/app/gone.ts && git rm -q staged-gone.txt`); // deleted: in the work tree, and staged
  sh(repo, `echo 2 > "docs/my notes.md" && git add "docs/my notes.md"`); // modified, staged
  writeFileSync(`${repo}/docs/한글 문서.md`, "2\n");
  sh(repo, `echo new > src/app/added.ts && git add src/app/added.ts`); // newly added (staged)
  sh(repo, `echo new > later.ts && git add --intent-to-add later.ts`); // known to git, nothing staged
  mkdirSync(`${repo}/새 폴더`);
  writeFileSync(`${repo}/새 폴더/새 파일.txt`, "x\n"); // untracked
  writeFileSync(`${repo}/scratch file.txt`, "x\n"); // untracked
  writeFileSync(`${repo}/.gitignore`, "*.log\n"); // untracked itself
  writeFileSync(`${repo}/debug.log`, "x\n"); // ignored: in neither group

  const r = await readStatus(git, repo);
  assert.equal(r.ok, true);
  assert.equal(r.err, "");
  assert.equal(r.hasHead, true);
  const byPath = (a, b) => (a.path < b.path ? -1 : 1);
  assert.deepEqual([...r.changes].sort(byPath), [
    { path: "docs/my notes.md", status: "modified", xy: "M." },
    { path: "docs/한글 문서.md", status: "modified", xy: ".M" },
    { path: "later.ts", status: "added", xy: ".A" },
    { path: "src/app/a.ts", status: "modified", xy: ".M" },
    { path: "src/app/added.ts", status: "added", xy: "A." },
    { path: "src/app/gone.ts", status: "deleted", xy: ".D" },
    { path: "staged-gone.txt", status: "deleted", xy: "D." },
  ]);
  assert.deepEqual([...r.unversioned].sort(byPath), [
    { path: ".gitignore", status: "unversioned" },
    { path: "scratch file.txt", status: "unversioned" },
    { path: "새 폴더/새 파일.txt", status: "unversioned" },
  ]);
}

// A repository without commits still reads: staged files are "added", the rest unversioned.
{
  const repo = init("empty");
  let r = await readStatus(git, repo);
  assert.deepEqual(r, { ok: true, err: "", hasHead: false, detached: false, changes: [], unversioned: [] });
  sh(repo, "echo 1 > first.txt && git add first.txt && echo 1 > other.txt");
  r = await readStatus(git, repo);
  assert.equal(r.ok, true);
  assert.equal(r.hasHead, false);
  assert.deepEqual(r.changes, [{ path: "first.txt", status: "added", xy: "A." }]);
  assert.deepEqual(r.unversioned, [{ path: "other.txt", status: "unversioned" }]);
}

// A clean repository: both groups empty.
{
  const repo = init("clean");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  assert.deepEqual(await readStatus(git, repo), { ok: true, err: "", hasHead: true, detached: false, changes: [], unversioned: [] });
}

// A file both sides changed is a conflict, once (git lists it once, however many stages).
{
  const repo = init("conflict");
  sh(repo, `echo base > "both sides.txt" && git add -A && git commit -q -m base
git checkout -q -b other && echo theirs > "both sides.txt" && git commit -q -am theirs
git checkout -q main && echo ours > "both sides.txt" && git commit -q -am ours
git merge other >/dev/null 2>&1 || true`);
  const r = await readStatus(git, repo);
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, [{ path: "both sides.txt", status: "conflict", xy: "UU" }]);
}

// Each conflict keeps git's two letters, so a screen can say which side changed or
// deleted the file: both modified (UU), both added (AA), deleted by us (DU), deleted by
// them (UD). A file the merge brought in without a conflict is staged (X is not ".").
{
  const repo = init("conflict-kinds");
  sh(repo, `echo base > both.txt && echo base > ours-gone.txt && echo base > theirs-gone.txt && git add -A && git commit -q -m base
git checkout -q -b other && echo theirs > both.txt && echo theirs > ours-gone.txt && git rm -q theirs-gone.txt && echo theirs > added.txt && echo new > brought.txt && git add -A && git commit -q -m theirs
git checkout -q main && echo ours > both.txt && git rm -q ours-gone.txt && echo ours > theirs-gone.txt && echo ours > added.txt && git add -A && git commit -q -m ours
git merge other >/dev/null 2>&1 || true`);
  const r = await readStatus(git, repo);
  // git lists ordinary entries before conflicts.
  assert.deepEqual(r.changes, [
    { path: "brought.txt", status: "added", xy: "A." },
    { path: "added.txt", status: "conflict", xy: "AA" },
    { path: "both.txt", status: "conflict", xy: "UU" },
    { path: "ours-gone.txt", status: "conflict", xy: "DU" },
    { path: "theirs-gone.txt", status: "conflict", xy: "UD" },
  ]);
}

// Reading leaves .git/index alone, bytes and modification time. A file whose timestamp
// changed but whose content didn't makes a plain `git status` rewrite the index; the
// panel's folder watch would see that write and read again, forever.
{
  const repo = init("quiet");
  sh(repo, "echo 1 > a.txt && echo 1 > b.txt && git add -A && git commit -q -m first");
  const index = `${repo}/.git/index`;
  const snapshot = () => ({ bytes: readFileSync(index).toString("hex"), mtime: statSync(index).mtimeMs });
  const later = new Date(Date.now() + 5000);
  utimesSync(`${repo}/a.txt`, later, later);
  writeFileSync(`${repo}/b.txt`, "2\n");
  const before = snapshot();
  const r = await readStatus(git, repo);
  assert.deepEqual(r.changes, [{ path: "b.txt", status: "modified", xy: ".M" }]);
  assert.deepEqual(snapshot(), before, "reading the status does not rewrite the index");
  // The same question asked without the read flags does rewrite it, so the check above means something.
  sh(repo, "git status --porcelain >/dev/null");
  assert.notEqual(snapshot().bytes, before.bytes);
}

// git can't answer (no repository here, a machine that can't be reached): a result with
// git's words, not an exception.
{
  const plain = `${base}/plain`;
  mkdirSync(plain);
  const r = await readStatus(git, plain);
  assert.equal(r.ok, false);
  assert.match(r.err, /not a git repository/i);
  // git's own words are shown as they came: nothing to word again.
  assert.equal(r.msg, undefined);
  assert.deepEqual([r.changes, r.unversioned], [[], []]);
  const down = await readStatus(makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps"), "/repo");
  assert.equal(down.ok, false);
  assert.match(down.err, /unreachable/);
  // git failing without a word: the mod's own sentence, with its key.
  const mute = await readStatus(makeGit(async () => ({ code: 1, stdout: "", stderr: "" }), null), "/repo");
  assert.equal(mute.ok, false);
  assert.equal(mute.err, "git status failed");
  assert.deepEqual(mute.msg, { key: "commit.statusFailed" });
  assert.equal(translator("en")(mute.msg.key), mute.err);
}

// A detached HEAD is told apart from a branch (the Commit panel warns there): after
// checking out a commit, and not on a branch or in a repository without commits.
{
  const repo = init("detached");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m one && echo 2 > a.txt && git commit -q -am two");
  assert.equal((await readStatus(git, repo)).detached, false);
  sh(repo, "git checkout -q --detach HEAD~1");
  const r = await readStatus(git, repo);
  assert.deepEqual([r.ok, r.hasHead, r.detached], [true, true, true]);
  sh(repo, "git checkout -q main");
  assert.equal((await readStatus(git, repo)).detached, false);
  assert.equal((await readStatus(git, init("unborn"))).detached, false);
}

console.log("ok");
