// node git-revision.test.mjs: a commit's files, the history up to a commit, patches, finding
// a commit by what was typed, and a commit's parents and children, against throwaway
// repositories (no app needed). Each case reads the repository again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readRevisionFile } from "./git-compare.js";
import { revisionTree, historyUpTo, createPatch, patchFileName, findCommit, relatives } from "./git-revision.js";

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

// ---- Create Patch: the commits' changes as text or into a file
{
  const repo = init("patch");
  write(repo, "a.txt", "1\n"); write(repo, "sub/b.txt", "b\n");
  const c1 = commit(repo, "root");
  write(repo, "a.txt", "2\n"); write(repo, "sub/b.txt", "b2\n");
  const c2 = commit(repo, "second");
  write(repo, "c.txt", "c\n");
  const c3 = commit(repo, "third");
  const applies = (text, { reverse = false, at = repo, args = [] } = {}) => {
    writeFileSync(`${base}/check.patch`, text);
    sh(at, `git apply --check ${reverse ? "-R " : ""}${args.join(" ")} "${base}/check.patch"`);
  };

  // One commit as text (To Clipboard): what it changed and nothing else.
  const one = await createPatch(git, repo, { commits: [c2] });
  assert.equal(one.ok, true, one.err);
  assert.match(one.text, /^diff --git a\/a.txt b\/a.txt$/m);
  assert.match(one.text, /^\+b2$/m);
  assert.doesNotMatch(one.text, /c\.txt/);
  // It undoes cleanly on the commit it came from.
  applies(one.text, { reverse: true });

  // Several commits, newest first as the Log hands them: from before the oldest to the newest.
  const two = await createPatch(git, repo, { commits: [c3, c2] });
  assert.match(two.text, /^\+b2$/m);
  assert.match(two.text, /^\+c$/m);

  // Reverse patch: undoes the commit when applied.
  const back = await createPatch(git, repo, { commits: [c3], reverse: true });
  assert.match(back.text, /^deleted file mode/m);
  applies(back.text);

  // The first commit has nothing before it: every file is new.
  const first = await createPatch(git, repo, { commits: [c1] });
  assert.equal(first.ok, true, first.err);
  assert.match(first.text, /^new file mode/m);
  assert.match(first.text, /^\+\+\+ b\/sub\/b.txt$/m);

  // Only some files (Commit details' file rows).
  const only = await createPatch(git, repo, { commits: [c2], paths: ["sub/b.txt"] });
  assert.doesNotMatch(only.text, /a\.txt/);
  assert.match(only.text, /^\+\+\+ b\/sub\/b.txt$/m);

  // Base path below the root: paths start there, files outside it are left out.
  const below = await createPatch(git, repo, { commits: [c2], base: `${repo}/sub` });
  assert.equal(below.ok, true, below.err);
  assert.match(below.text, /^\+\+\+ b\/b.txt$/m);
  assert.doesNotMatch(below.text, /a\.txt/);
  applies(below.text, { reverse: true, at: `${repo}/sub` });
  // Base path above the root: paths carry the folders between.
  const above = await createPatch(git, repo, { commits: [c2], base: base });
  assert.match(above.text, /^\+\+\+ b\/patch\/a.txt$/m);
  // A base that holds neither: refused, worded.
  const apart = await createPatch(git, repo, { commits: [c2], base: `${base}/elsewhere` });
  assert.equal(apart.ok, false);
  assert.equal(apart.msg.key, "revision.baseOutside");

  // Into a file on the repository's machine: git writes it; text stays empty.
  const target = `${base}/out/second.patch`;
  mkdirSync(`${base}/out`, { recursive: true });
  const file = await createPatch(git, repo, { commits: [c2], file: target });
  assert.equal(file.ok, true, file.err);
  assert.equal(file.text, "");
  assert.equal(readFileSync(target, "utf8"), one.text);
  // A folder that isn't there: git's refusal, nothing written.
  const nowhere = await createPatch(git, repo, { commits: [c2], file: `${base}/missing/x.patch` });
  assert.equal(nowhere.ok, false);
  assert.ok(nowhere.err);
  assert.equal(existsSync(`${base}/missing`), false);
  const none = await createPatch(git, repo, { commits: [] });
  assert.equal(none.ok, false);
  assert.equal(none.msg.key, "revision.noCommits");
}

// ---- Go to Hash/Branch/Tag: the commit what was typed names
{
  const repo = init("find");
  write(repo, "a.txt", "1\n"); const c1 = commit(repo, "one");
  write(repo, "a.txt", "2\n"); const c2 = commit(repo, "two");
  sh(repo, `git branch topic ${c1} && git tag v1 ${c1} && git tag -a -m note v2 ${c2}`);
  sh(repo, `git update-ref refs/remotes/origin/main ${c1}`);
  const found = async (text) => (await findCommit(git, repo, text)).hash;
  assert.equal(await found(c1), c1, "a full hash");
  assert.equal(await found(c1.slice(0, 7)), c1, "a short hash");
  assert.equal(await found(` ${c1.slice(0, 7)}\n`), c1, "space around it is not part of it");
  assert.equal(await found("topic"), c1, "a branch");
  assert.equal(await found("origin/main"), c1, "a remote branch");
  assert.equal(await found("v1"), c1, "a tag");
  assert.equal(await found("v2"), c2, "an annotated tag: its commit");
  assert.equal(await found("HEAD"), c2);
  const none = await findCommit(git, repo, "nothing-here");
  assert.equal(none.ok, false);
  assert.equal(none.hash, null);
  assert.equal(none.msg.key, "revision.notFound");
  assert.equal(none.msg.args.text, "nothing-here");
  // An option is not read as one.
  const flag = await findCommit(git, repo, "--all");
  assert.equal(flag.ok, false);
  const empty = await findCommit(git, repo, "  ");
  assert.equal(empty.ok, false);
}

// ---- Go to Parent / Child Commit: the commits next to one in the graph
{
  const repo = init("relatives");
  write(repo, "a.txt", "1\n"); const root = commit(repo, "root");
  write(repo, "a.txt", "2\n"); const m1 = commit(repo, "main one");
  sh(repo, "git switch -q -c topic " + root);
  write(repo, "t.txt", "t\n"); const t1 = commit(repo, "topic one");
  sh(repo, "git switch -q main");
  sh(repo, "git merge -q --no-ff -m merged topic");
  const merge = sh(repo, "git rev-parse HEAD").trim();
  sh(repo, "git switch -q -c later " + t1);
  write(repo, "l.txt", "l\n"); const l1 = commit(repo, "later one");
  sh(repo, "git switch -q main");
  // A stash's commits sit on HEAD, but the Log doesn't show them: not a child.
  write(repo, "a.txt", "stashed\n"); sh(repo, "git stash -q");

  const r = await relatives(git, repo, root);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.parents, []);
  assert.deepEqual(r.children.map((c) => c.hash).sort(), [m1, t1].sort(), "both children, on every branch");
  assert.equal(r.children.find((c) => c.hash === m1).subject, "main one");

  const m = await relatives(git, repo, merge);
  assert.deepEqual(m.parents.map((c) => c.hash), [m1, t1], "a merge's parents, first parent first");
  assert.equal(m.parents[1].subject, "topic one");
  assert.deepEqual(m.children, []);

  // A commit a merge and a branch both grew from.
  const t = await relatives(git, repo, t1);
  assert.deepEqual(t.children.map((c) => c.hash).sort(), [merge, l1].sort());
  // Only the branches the Log shows: children elsewhere are not offered.
  const onMain = await relatives(git, repo, t1, { branch: "refs/heads/main" });
  assert.deepEqual(onMain.children.map((c) => c.hash), [merge]);

  const none = await relatives(git, repo, "nope");
  assert.equal(none.ok, false);
  assert.deepEqual(none.children, []);
}

// ---- the patch file's suggested name
{
  assert.equal(patchFileName("feature", "alpha line two"), "feature__alpha_line_two.patch");
  assert.equal(patchFileName("feat/login", "Fix: crash on start!"), "feat_login__Fix_crash_on_start.patch");
  assert.equal(patchFileName(null, "x"), "x.patch", "a detached HEAD has no branch to name");
  assert.equal(patchFileName("main", "한글 제목"), "main__한글_제목.patch");
  assert.equal(patchFileName("main", ""), "main.patch");
  assert.ok(patchFileName("main", "x".repeat(300)).length <= 120);
}

console.log("ok");
