// node git-compare.test.mjs: comparing branches, the working tree and versions, and
// taking a file from a revision, against throwaway repositories (no app needed). Each
// case reads the repository again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { listSnapshots } from "./git-snapshot.js";
import { branchCommits, workingTreeFiles, swapState, versionFiles, getFromRevision, fileParent, fileParents, parentDiffs, readFileDiff, readRevisionFile } from "./git-compare.js";
import { en, ko } from "./messages-compare.js";
import { filterArgs } from "./git-log-filter.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8" });
const git = makeGit(exec, null, { record: () => {} });
const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-compare-`));
const COPY = "0123456789abcdef";

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const write = (repo, path, text) => { mkdirSync(`${repo}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(`${repo}/${path}`, text); };
const commit = (repo, message) => { sh(repo, `git add -A && git commit -q -m "${message}"`); return sh(repo, "git rev-parse HEAD").trim(); };
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");
const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.state ?? f.status]));
const worded = (r) => {
  assert.ok(r.msg?.key?.startsWith("compare."), JSON.stringify(r));
  assert.ok(Object.hasOwn(en, r.msg.key) && Object.hasOwn(ko, r.msg.key), r.msg.key);
};

// ---- branch compare: the commits on each side only
{
  const repo = init("branches");
  write(repo, "a.txt", "1\n"); commit(repo, "root");
  sh(repo, "git switch -q -c topic");
  write(repo, "t.txt", "t\n"); const t1 = commit(repo, "topic one");
  write(repo, "u.txt", "u\n"); const t2 = commit(repo, "topic two");
  sh(repo, "git switch -q main");
  write(repo, "m.txt", "m\n"); const m1 = commit(repo, "main one");
  const r = await branchCommits(git, repo, { a: "topic", b: "main" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.onlyA.map((c) => c.hash), [t2, t1], "newest first, topic's own");
  assert.deepEqual(r.onlyB.map((c) => c.hash), [m1]);
  assert.equal(r.onlyA[0].subject, "topic two");
  assert.equal(r.onlyA[0].author, "t");
  assert.ok(r.onlyA[0].time > 0);
  // A filter (git-log-filter.js arguments) narrows both lists the same way.
  const path = await branchCommits(git, repo, { a: "topic", b: "main", filterArgs: ["--", "u.txt"] });
  assert.deepEqual(path.onlyA.map((c) => c.hash), [t2]);
  assert.deepEqual(path.onlyB, []);
  // As the compare tab builds them: a path taken literally, a user.
  const built = await branchCommits(git, repo, { a: "topic", b: "main", filterArgs: filterArgs({ paths: ["t.txt"], user: "t" }) });
  assert.deepEqual(built.onlyA.map((c) => c.hash), [t1]);
  const nobody = await branchCommits(git, repo, { a: "topic", b: "main", filterArgs: filterArgs({ user: "someone else" }) });
  assert.deepEqual([nobody.onlyA, nobody.onlyB], [[], []]);
  // A branch that doesn't exist: git's words and a msg, no lists.
  const gone = await branchCommits(git, repo, { a: "nope", b: "main" });
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.onlyA, []);
  // Same branch both sides: nothing either way.
  const same = await branchCommits(git, repo, { a: "main", b: "main" });
  assert.deepEqual([same.onlyA, same.onlyB], [[], []]);
  // A name that looks like an option is read as a revision, never a flag.
  const flag = await branchCommits(git, repo, { a: "--all", b: "main" });
  assert.equal(flag.ok, false);
}

// ---- working tree against a branch or a commit: three states
{
  const repo = init("worktree");
  write(repo, "same.txt", "s\n"); write(repo, "both.txt", "1\n"); write(repo, "theirs.txt", "x\n");
  commit(repo, "root");
  sh(repo, "git switch -q -c topic");
  write(repo, "both.txt", "topic\n"); write(repo, "dir/only-topic.txt", "o\n");
  commit(repo, "topic");
  sh(repo, "git switch -q main");
  write(repo, "mine.txt", "m\n"); commit(repo, "main");
  // An uncommitted change counts: it is the working tree that is compared.
  write(repo, "same.txt", "local edit\n");
  const r = await workingTreeFiles(git, repo, "topic");
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(byPath(r.files), {
    "both.txt": "changed",
    "same.txt": "changed",
    "dir/only-topic.txt": "only-ref",
    "mine.txt": "only-local",
  });
  // Swap branches: the sides trade places, a difference stays one.
  assert.equal(swapState("only-ref"), "only-local");
  assert.equal(swapState("only-local"), "only-ref");
  assert.equal(swapState("changed"), "changed");
  // A commit works the same way (Compare with Local).
  const root = sh(repo, "git rev-list --max-parents=0 HEAD").trim();
  const local = await workingTreeFiles(git, repo, root);
  assert.deepEqual(byPath(local.files), { "same.txt": "changed", "mine.txt": "only-local" });
  // Nothing different: no files.
  sh(repo, "git checkout -q -- same.txt");
  const head = await workingTreeFiles(git, repo, "HEAD");
  assert.deepEqual(head.files, []);
  const bad = await workingTreeFiles(git, repo, "no-such-branch");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.files, []);
}

// ---- Compare Versions: the files changed between two commits
{
  const repo = init("versions");
  write(repo, "a.txt", "1\n"); write(repo, "old.txt", "keep this line\nand this one\nand more\n");
  const c1 = commit(repo, "one");
  write(repo, "a.txt", "2\n"); write(repo, "b.txt", "b\n");
  commit(repo, "two");
  sh(repo, "git mv old.txt new.txt && git rm -q a.txt");
  const c3 = commit(repo, "three");
  const r = await versionFiles(git, repo, c1, c3);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(byPath(r.files), { "a.txt": "deleted", "b.txt": "added", "new.txt": "renamed" });
  assert.equal(r.files.find((f) => f.path === "new.txt").from, "old.txt");
  // The other way round, the same files with the opposite changes.
  const back = await versionFiles(git, repo, c3, c1);
  assert.deepEqual(byPath(back.files), { "a.txt": "added", "b.txt": "deleted", "old.txt": "renamed" });
}

// ---- Get from Revision / Get from Branch: the file as that revision has it
{
  const repo = init("get");
  write(repo, "f.txt", "one\n"); write(repo, "g.txt", "g1\n");
  const c1 = commit(repo, "one");
  write(repo, "f.txt", "two\n"); write(repo, "new.txt", "n\n");
  commit(repo, "two");
  // No local change: the file is set, in the working tree and the index; no snapshot.
  const clean = await getFromRevision(git, repo, { rev: c1, paths: ["f.txt"], copy: COPY });
  assert.equal(clean.ok, true, clean.err);
  assert.equal(clean.snapshot, null);
  assert.equal(text(repo, "f.txt"), "one\n");
  assert.deepEqual(status(repo), ["M  f.txt"]);
  assert.equal((await listSnapshots(git, repo)).snapshots?.length ?? 0, 0);
  sh(repo, "git reset -q --hard");
  // A local change is recorded first, then replaced. The snapshot holds what was there.
  write(repo, "g.txt", "my work\n");
  const dirty = await getFromRevision(git, repo, { rev: "HEAD~1", paths: ["g.txt", "f.txt"], copy: COPY });
  assert.equal(dirty.ok, true, dirty.err);
  assert.match(dirty.snapshot ?? "", /^[0-9a-f]{40}$/);
  assert.equal(sh(repo, `git show ${dirty.snapshot}:g.txt`), "my work\n");
  assert.equal(text(repo, "g.txt"), "g1\n");
  assert.equal(text(repo, "f.txt"), "one\n");
  assert.deepEqual(status(repo), ["M  f.txt"]);
  sh(repo, "git reset -q --hard");
  // A file the revision doesn't have: gone from the index and the working tree.
  write(repo, "new.txt", "edited\n");
  const absent = await getFromRevision(git, repo, { rev: c1, paths: ["new.txt"], copy: COPY });
  assert.equal(absent.ok, true, absent.err);
  assert.equal(existsSync(`${repo}/new.txt`), false);
  assert.deepEqual(status(repo), ["D  new.txt"]);
  assert.equal(sh(repo, `git show ${absent.snapshot}:new.txt`), "edited\n");
  sh(repo, "git reset -q --hard");
  // No snapshot can be made (no copy id): nothing changes.
  write(repo, "f.txt", "keep me\n");
  const refused = await getFromRevision(git, repo, { rev: c1, paths: ["f.txt"], copy: "" });
  assert.equal(refused.ok, false);
  worded(refused);
  assert.equal(text(repo, "f.txt"), "keep me\n");
  assert.deepEqual(status(repo), [" M f.txt"]);
  // A path is a path: "*.txt" names that file only.
  sh(repo, "git checkout -q -- f.txt");
  write(repo, "*.txt", "star\n"); commit(repo, "star");
  write(repo, "*.txt", "star edited\n"); commit(repo, "star two");
  const literal = await getFromRevision(git, repo, { rev: "HEAD~1", paths: ["*.txt"], copy: COPY });
  assert.equal(literal.ok, true, literal.err);
  assert.equal(text(repo, "*.txt"), "star\n");
  assert.deepEqual(status(repo), ["M  *.txt"]);
  // A revision that isn't there: git's words, nothing changed.
  sh(repo, "git reset -q --hard");
  const bad = await getFromRevision(git, repo, { rev: "no-such", paths: ["f.txt"], copy: COPY });
  assert.equal(bad.ok, false);
  assert.deepEqual(status(repo), []);
}

// ---- a file's parent version: Compare Before with Local, Show Changes to Parents
{
  const repo = init("parents");
  write(repo, "a.txt", "1\n2\n3\n"); write(repo, "keep.txt", "line one\nline two\nline three\nline four\n");
  const c1 = commit(repo, "one");
  write(repo, "a.txt", "1\ntwo\n3\n");
  const c2 = commit(repo, "two");
  sh(repo, "git mv keep.txt moved.txt");
  write(repo, "a.txt", "1\ntwo\nthree\n");
  const c3 = commit(repo, "three");
  // The commit's first parent, and the path the file had there.
  const p = await fileParent(git, repo, { commit: c3, path: "moved.txt", from: "keep.txt" });
  assert.equal(p.ok, true, p.err);
  assert.deepEqual([p.parent, p.path], [c2, "keep.txt"]);
  const plain = await fileParent(git, repo, { commit: c2, path: "a.txt" });
  assert.deepEqual([plain.parent, plain.path], [c1, "a.txt"]);
  // The first commit has no parent.
  const first = await fileParent(git, repo, { commit: c1, path: "a.txt" });
  assert.equal(first.ok, true);
  assert.equal(first.parent, null);
  // Show Changes to Parents: the picked commit's file against its parent, read as the
  // compare Diff tab reads it (parentDiffs → readFileDiff).
  const of3 = await fileParents(git, repo, { commit: c3 });
  assert.deepEqual(of3.parents, [c2]);
  const [to2] = parentDiffs({ commit: c3, parents: of3.parents, path: "a.txt" });
  const change = await readFileDiff(git, repo, to2);
  assert.deepEqual(change.rows.filter((r) => r.kind === "add" || r.kind === "del").map((r) => `${r.kind} ${r.text}`), ["del 3", "add three"]);
  // A file the commit added: all of it is new against the parent (an empty diff before).
  write(repo, "x1.txt", "x\n");
  const c4 = commit(repo, "four");
  const [added] = parentDiffs({ commit: c4, parents: (await fileParents(git, repo, { commit: c4 })).parents, path: "x1.txt" });
  const made = await readFileDiff(git, repo, added);
  assert.equal(made.ok, true, made.err);
  assert.deepEqual(made.rows.filter((r) => r.kind === "add" || r.kind === "del").map((r) => `${r.kind} ${r.text}`), ["add x"]);
  sh(repo, "git reset -q --hard HEAD~1");
  // Compare Before with Local: the parent's version against the working file.
  write(repo, "a.txt", "1\ntwo\nthree\nfour\n");
  const lines = (d) => d.rows.filter((r) => r.kind === "add" || r.kind === "del").map((r) => `${r.kind} ${r.text}`);
  const local = await readFileDiff(git, repo, { from: c2, path: "a.txt" });
  assert.equal(local.ok, true, local.err);
  assert.deepEqual(lines(local), ["del 3", "add three", "add four"]);
  assert.deepEqual([local.from, local.to], [c2.slice(0, 7), ""]);
  // Swapped: the working file against the revision.
  const back = await readFileDiff(git, repo, { from: c2, path: "a.txt", reverse: true });
  assert.deepEqual(lines(back), ["del three", "del four", "add 3"]);
  assert.deepEqual([back.from, back.to], ["", c2.slice(0, 7)]);
  // Two commits (Compare Versions).
  const versions = await readFileDiff(git, repo, { from: c1, to: c3, path: "a.txt" });
  assert.deepEqual(lines(versions), ["del 2", "del 3", "add two", "add three"]);
  assert.deepEqual([versions.from, versions.to], [c1.slice(0, 7), c3.slice(0, 7)]);
  // Renamed since: the parent's file under its old name against the working file.
  write(repo, "moved.txt", "line one\nline two\nline three\nline 4\n");
  const renamed = await readFileDiff(git, repo, { from: c2, path: "moved.txt", oldPath: "keep.txt" });
  assert.equal(renamed.ok, true, renamed.err);
  assert.deepEqual(lines(renamed), ["del line four", "add line 4"]);
  // Open Repository Version: the file as the commit has it.
  const v = await readRevisionFile(git, repo, { rev: c1, path: "a.txt" });
  assert.deepEqual([v.ok, v.text, v.binary], [true, "1\n2\n3\n", false]);
  const missing = await readRevisionFile(git, repo, { rev: c1, path: "moved.txt" });
  assert.equal(missing.ok, false);
}

// Show Changes to Parents on a merge commit: one diff per parent, in git's parent order.
// The renamed-from name (Commit details reads it against the first parent) goes with the
// first parent only.
{
  const repo = init("merge-parents");
  write(repo, "m.txt", "1\n2\n3\n");
  const root = commit(repo, "root");
  sh(repo, "git checkout -q -b side");
  write(repo, "m.txt", "1\n2\nside\n");
  const side = commit(repo, "side");
  sh(repo, "git checkout -q -");
  write(repo, "m.txt", "main\n2\n3\n");
  const main = commit(repo, "main");
  sh(repo, "git merge -q --no-edit side");
  const merge = sh(repo, "git rev-parse HEAD").trim();
  const ps = await fileParents(git, repo, { commit: merge });
  assert.equal(ps.ok, true, ps.err);
  assert.deepEqual(ps.parents, [main, side]);
  const diffs = parentDiffs({ commit: merge, parents: ps.parents, path: "m.txt", from: "old.txt" });
  assert.deepEqual(diffs, [
    { from: main, to: merge, path: "m.txt", oldPath: "old.txt" },
    { from: side, to: merge, path: "m.txt", oldPath: null },
  ]);
  const lines = (d) => d.rows.filter((r) => r.kind === "add" || r.kind === "del").map((r) => `${r.kind} ${r.text}`);
  const [toMain, toSide] = await Promise.all(parentDiffs({ commit: merge, parents: ps.parents, path: "m.txt" }).map((d) => readFileDiff(git, repo, d)));
  assert.deepEqual(lines(toMain), ["del 3", "add side"]);
  assert.deepEqual(lines(toSide), ["del 1", "add main"]);
  // The first commit has no parent: nothing to show.
  assert.deepEqual((await fileParents(git, repo, { commit: root })).parents, []);
  assert.deepEqual(parentDiffs({ commit: root, parents: [], path: "m.txt" }), []);
}

console.log("ok");
