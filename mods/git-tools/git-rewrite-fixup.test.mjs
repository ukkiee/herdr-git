// node git-rewrite-fixup.test.mjs: Fixup and Squash Into (the checked changes go into an
// older commit), and Commit details' Extract and Drop Selected Changes, against throwaway
// repositories (no app needed). Each case reads the history again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readEditFacts, fixupInto, extractChanges, dropChanges } from "./git-rewrite.js";
import { en } from "./messages-rewrite.js";

// The user's own git settings stay out of every git these tests start. An editor or a
// sequence editor left in the environment would be the person's: none may be waited on.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_SEQUENCE_EDITOR = "false";
process.env.GIT_EDITOR = "false";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-fixup-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  sh(repo, "git config core.editor false && git config sequence.editor false");
  return repo;
};
// Commits from `files`: [{ message, author, write: { path: content | null } }] (null
// deletes). Returns their hashes, oldest first.
const commits = (repo, list) => list.map(({ message, author = "t", write }) => {
  for (const [path, content] of Object.entries(write)) {
    if (content === null) run(repo, ["rm", "-q", "--", path]);
    else { writeFileSync(`${repo}/${path}`, content); run(repo, ["add", "--", path]); }
  }
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@t` } });
  return run(repo, ["rev-parse", "HEAD"]).trim();
});
const fourCommits = (name) => {
  const repo = init(name);
  const hashes = commits(repo, ["one", "two", "three", "four"].map((n) => ({ message: n, author: `author-${n}`, write: { [`${n}.txt`]: `${n}\n` } })));
  return { repo, hashes };
};
const head = (repo) => run(repo, ["rev-parse", "HEAD"]).trim();
// The history from HEAD, oldest first: [{ message, author, files (changed by it) }].
const history = (repo) => run(repo, ["log", "--reverse", "-z", "--format=%H%x1f%B%x1f%an", "HEAD"]).split("\0").filter(Boolean).map((rec) => {
  const [hash, message, author] = rec.replace(/^\n/, "").split("\x1f");
  const files = run(repo, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "--name-only", "-z", hash]).split("\0").filter(Boolean).sort();
  return { message: message.replace(/\n+$/, ""), author, files };
});
const show = (repo, rev, path) => run(repo, ["show", `${rev}:${path}`]);
const tree = (repo) => run(repo, ["rev-parse", "HEAD^{tree}"]).trim();
const status = (repo) => run(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean).sort();
const inProgress = (repo) => sh(repo, "test -d \"$(git rev-parse --git-path rebase-merge)\" && echo yes || echo no").trim() === "yes";
const knownKey = (r) => { if (r.msg) assert.ok(Object.prototype.hasOwnProperty.call(en, r.msg.key) || r.msg.key.startsWith("commit."), r.msg.key); };

const TRICKY = "it's \"quoted\"\n\n#12 costs $HOME `x` \\ end";

// ---- the edit facts: local changes, for Fixup and Squash Into

{
  const { repo, hashes } = fourCommits("facts");
  assert.equal((await readEditFacts(git, repo, [hashes[1]])).localChanges, false);
  writeFileSync(`${repo}/new.txt`, "new\n");
  assert.equal((await readEditFacts(git, repo, [hashes[1]])).localChanges, true);
  sh(repo, "rm new.txt");
  writeFileSync(`${repo}/two.txt`, "changed\n");
  assert.equal((await readEditFacts(git, repo, [hashes[1]])).localChanges, true);
}

// ---- Fixup

// Only the checked changes go into the older commit; its message stays, the commits after
// it keep theirs, and the unchecked untracked file stays as it was.
{
  const { repo, hashes } = fourCommits("fixup");
  writeFileSync(`${repo}/two.txt`, "two, fixed\n");
  writeFileSync(`${repo}/added.txt`, "added\n");
  writeFileSync(`${repo}/left.txt`, "left out\n");
  const r = await fixupInto(git, repo, { commit: hashes[1], files: [{ path: "two.txt", status: "modified" }, { path: "added.txt", status: "unversioned" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  const h = history(repo);
  assert.deepEqual(h.map((c) => c.message), ["one", "two", "three", "four"]);
  assert.deepEqual(h[1].files, ["added.txt", "two.txt"]);
  assert.equal(h[1].author, "author-two");
  assert.deepEqual(h.slice(2).map((c) => c.files), [["three.txt"], ["four.txt"]]);
  assert.equal(show(repo, "HEAD~2", "two.txt"), "two, fixed\n");
  assert.deepEqual(status(repo), ["?? left.txt"]);
  assert.equal(inProgress(repo), false);
}

// Into the first commit and into HEAD.
{
  const { repo, hashes } = fourCommits("fixup-ends");
  writeFileSync(`${repo}/one.txt`, "one, fixed\n");
  let r = await fixupInto(git, repo, { commit: hashes[0], files: [{ path: "one.txt", status: "modified" }] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(history(repo).map((c) => c.message), ["one", "two", "three", "four"]);
  assert.equal(show(repo, "HEAD~3", "one.txt"), "one, fixed\n");
  writeFileSync(`${repo}/four.txt`, "four, fixed\n");
  r = await fixupInto(git, repo, { commit: head(repo), files: [{ path: "four.txt", status: "modified" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(history(repo).length, 4);
  assert.equal(show(repo, "HEAD", "four.txt"), "four, fixed\n");
  assert.deepEqual(status(repo), []);
}

// ---- Squash Into: the message given becomes the commit's

{
  const { repo, hashes } = fourCommits("squash-into");
  writeFileSync(`${repo}/three.txt`, "three, squashed\n");
  const r = await fixupInto(git, repo, { commit: hashes[2], squash: true, message: TRICKY, files: [{ path: "three.txt", status: "modified" }] });
  assert.equal(r.ok, true, r.err);
  const h = history(repo);
  assert.deepEqual(h.map((c) => c.message), ["one", "two", TRICKY, "four"]);
  assert.equal(h[2].author, "author-three");
  assert.equal(show(repo, "HEAD~1", "three.txt"), "three, squashed\n");
  // Squash Into needs a message.
  writeFileSync(`${repo}/two.txt`, "x\n");
  const no = await fixupInto(git, repo, { commit: hashes[1], squash: true, message: " ", files: [{ path: "two.txt", status: "modified" }] });
  assert.equal(no.ok, false);
  assert.equal(no.outcome, "refused");
}

// ---- refusals: nothing is committed and the history stays

// Unchecked changes to tracked files would stop the replay: refused before the fixup
// commit is made, naming them.
{
  const { repo, hashes } = fourCommits("fixup-left");
  writeFileSync(`${repo}/two.txt`, "checked\n");
  writeFileSync(`${repo}/three.txt`, "not checked\n");
  const before = head(repo), was = status(repo);
  const r = await fixupInto(git, repo, { commit: hashes[1], files: [{ path: "two.txt", status: "modified" }] });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "refused");
  assert.equal(r.msg.key, "rewrite.localChanges");
  assert.deepEqual(r.blocked, ["three.txt"]);
  assert.equal(head(repo), before);
  assert.deepEqual(status(repo), was);
  knownKey(r);
}

// Nothing checked; a commit off the current branch; a merge commit.
{
  const { repo, hashes } = fourCommits("fixup-off");
  writeFileSync(`${repo}/two.txt`, "x\n");
  let r = await fixupInto(git, repo, { commit: hashes[1], files: [] });
  assert.equal(r.ok, false);
  assert.equal(r.msg.key, "rewrite.nothingToCommit");
  sh(repo, "git stash -q && git checkout -q -b side HEAD~2 && echo s > s.txt && git add s.txt && git commit -q -m side && git checkout -q main && git stash pop -q");
  const side = run(repo, ["rev-parse", "side"]).trim();
  r = await fixupInto(git, repo, { commit: side, files: [{ path: "two.txt", status: "modified" }] });
  assert.equal(r.ok, false);
  assert.equal(r.msg.key, "rewrite.notInBranch");
  assert.equal(history(repo).length, 4);
  knownKey(r);
}

// ---- Extract Selected Changes to Separate Commit

// The commit splits in two: first without the picked files (its message and author), then
// a new commit of them with the message given (the same author). The tree at the end is
// the same, and so are the commits after it.
{
  const repo = init("extract");
  const [, mixed] = commits(repo, [
    { message: "base", write: { "a.txt": "a\n", "gone.txt": "g\n" } },
    { message: "mixed", author: "writer", write: { "a.txt": "a2\n", "b.txt": "b\n", "*.txt": "star\n", "gone.txt": null } },
    { message: "after", write: { "c.txt": "c\n" } },
  ]);
  const end = tree(repo);
  const r = await extractChanges(git, repo, { commit: mixed, paths: ["*.txt", "gone.txt"], message: TRICKY });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  const h = history(repo);
  assert.deepEqual(h.map((c) => c.message), ["base", "mixed", TRICKY, "after"]);
  assert.deepEqual(h[1].files, ["a.txt", "b.txt"]);
  assert.deepEqual(h[2].files, ["*.txt", "gone.txt"]);
  assert.deepEqual([h[1].author, h[2].author], ["writer", "writer"]);
  assert.deepEqual(h[3].files, ["c.txt"]);
  assert.equal(tree(repo), end);
  assert.deepEqual(status(repo), []);
}

// From the first commit of the history.
{
  const repo = init("extract-root");
  commits(repo, [{ message: "first", write: { "a.txt": "a\n", "b.txt": "b\n" } }, { message: "second", write: { "c.txt": "c\n" } }]);
  const first = run(repo, ["rev-list", "--max-parents=0", "HEAD"]).trim();
  const end = tree(repo);
  const r = await extractChanges(git, repo, { commit: first, paths: ["b.txt"], message: "b alone" });
  assert.equal(r.ok, true, r.err);
  const h = history(repo);
  assert.deepEqual(h.map((c) => [c.message, c.files]), [["first", ["a.txt"]], ["b alone", ["b.txt"]], ["second", ["c.txt"]]]);
  assert.equal(tree(repo), end);
}

// ---- Drop Selected Changes

// Only the picked files leave the commit (back to how its parent had them); the commits
// after it keep their own changes. A literal path: `*.txt` is that file only.
{
  const repo = init("drop");
  const [, mixed] = commits(repo, [
    { message: "base", write: { "a.txt": "a\n", "gone.txt": "g\n" } },
    { message: "mixed", write: { "a.txt": "a2\n", "b.txt": "b\n", "*.txt": "star\n", "gone.txt": null } },
    { message: "after", write: { "c.txt": "c\n", "b.txt": "b, later\n" } },
  ]);
  const r = await dropChanges(git, repo, { commit: mixed, paths: ["*.txt", "gone.txt", "a.txt"] });
  assert.equal(r.ok, true, r.err);
  const h = history(repo);
  assert.deepEqual(h.map((c) => [c.message, c.files]), [["base", ["a.txt", "gone.txt"]], ["mixed", ["b.txt"]], ["after", ["b.txt", "c.txt"]]]);
  assert.equal(show(repo, "HEAD", "a.txt"), "a\n");
  assert.equal(show(repo, "HEAD", "gone.txt"), "g\n");
  assert.equal(show(repo, "HEAD", "b.txt"), "b, later\n");
  assert.deepEqual(status(repo), []);
}

// Every file of the commit picked: refused, nothing changes. Local changes: refused.
{
  const repo = init("drop-all");
  const [, two] = commits(repo, [{ message: "one", write: { "a.txt": "a\n" } }, { message: "two", write: { "b.txt": "b\n", "c.txt": "c\n" } }]);
  const before = head(repo);
  let r = await dropChanges(git, repo, { commit: two, paths: ["b.txt", "c.txt"] });
  assert.equal(r.ok, false);
  assert.equal(r.msg.key, "rewrite.dropAllChanges");
  r = await extractChanges(git, repo, { commit: two, paths: ["c.txt", "b.txt"], message: "m" });
  assert.equal(r.msg.key, "rewrite.extractAllChanges");
  r = await dropChanges(git, repo, { commit: two, paths: ["nothere.txt"] });
  assert.equal(r.msg.key, "rewrite.selectFiles");
  writeFileSync(`${repo}/a.txt`, "local\n");
  r = await dropChanges(git, repo, { commit: two, paths: ["b.txt"] });
  assert.equal(r.outcome, "refused");
  assert.deepEqual(r.blocked, ["a.txt"]);
  assert.equal(head(repo), before);
  knownKey(r);
}

// A later commit that needs the dropped change stops on a conflict: a rebase in progress.
{
  const repo = init("drop-conflict");
  const [, two] = commits(repo, [
    { message: "one", write: { "a.txt": "a\n" } },
    { message: "two", write: { "a.txt": "a2\n", "b.txt": "b\n" } },
    { message: "three", write: { "a.txt": "a3\n" } },
  ]);
  const r = await dropChanges(git, repo, { commit: two, paths: ["a.txt"] });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "stopped");
  assert.equal(r.operation?.kind, "rebase");
  assert.equal(inProgress(repo), true);
}

console.log("ok");
