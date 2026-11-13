// node git-rewrite.test.mjs: undoing, rewording, dropping and squashing commits, against
// throwaway repositories (no app needed). Each case reads the history again with git
// itself: messages, trees, authors, branches, and what is left uncommitted.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readEditFacts, readMessages, undoCommit, editMessage, dropCommits, squashCommits } from "./git-rewrite.js";
import { en } from "./messages-rewrite.js";

// The user's own git settings stay out of every git these tests start. An editor or a
// sequence editor left in the environment would be the person's: none may be waited on.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_SEQUENCE_EDITOR = "false";
process.env.GIT_EDITOR = "false";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-rewrite-`));
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
  // Whatever editor git would start fails: a rewrite that waits for one, or uses it, fails.
  sh(repo, "git config core.editor false && git config sequence.editor false");
  return repo;
};
// Four commits, each adding a file named after it; returns their hashes, oldest first.
const fourCommits = (name) => {
  const repo = init(name);
  const hashes = [];
  for (const n of ["one", "two", "three", "four"]) {
    writeFileSync(`${repo}/${n}.txt`, `${n}\n`);
    sh(repo, `git add ${n}.txt && GIT_AUTHOR_NAME=author-${n} GIT_AUTHOR_EMAIL=${n}@t git commit -q -m ${n}`);
    hashes.push(run(repo, ["rev-parse", "HEAD"]).trim());
  }
  return { repo, hashes };
};
const head = (repo) => run(repo, ["rev-parse", "HEAD"]).trim();
// The history from HEAD, oldest first: [{ message, author, files }].
const history = (repo, ref = "HEAD") => run(repo, ["log", "--reverse", "-z", "--format=%B%x1f%an%x1f%T", ref]).split("\0").filter(Boolean).map((rec) => {
  const [message, author, tree] = rec.replace(/^\n/, "").split("\x1f");
  return { message: message.replace(/\n+$/, ""), author, files: run(repo, ["ls-tree", "--name-only", tree]).trim().split("\n").filter(Boolean) };
});
const status = (repo) => run(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean).sort();
const inProgress = (repo) => sh(repo, "test -d \"$(git rev-parse --git-path rebase-merge)\" && echo yes || echo no").trim() === "yes";
const checkMsg = (r) => { if (r.msg) assert.ok(Object.prototype.hasOwnProperty.call(en, r.msg.key) || r.msg.key.startsWith("commit.") || r.msg.key.startsWith("log."), r.msg.key); };

// A tricky message: quotes of both kinds, a blank line, `$`, a backtick, a backslash, a
// line starting with "#" (an issue number, kept).
const TRICKY = "it's \"quoted\"\n\n#12 costs $HOME `x` \\ end";

// ---- Undo Commit

// The last commit goes; what it held stays as changes not committed, a new file as added.
{
  const { repo, hashes } = fourCommits("undo");
  writeFileSync(`${repo}/two.txt`, "two, changed\n");
  sh(repo, "git commit -q -am five");
  writeFileSync(`${repo}/new.txt`, "new\n");
  sh(repo, "git add new.txt && git commit -q -m six");
  const r = await undoCommit(git, repo, { commit: head(repo) });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  assert.equal(history(repo).at(-1).message, "five");
  assert.deepEqual(status(repo), ["A  new.txt"]);
  // A commit that isn't the last one is refused, and nothing changes.
  const before = head(repo);
  const no = await undoCommit(git, repo, { commit: hashes[1] });
  assert.equal(no.ok, false);
  assert.equal(no.outcome, "refused");
  assert.equal(no.msg.key, "rewrite.notLast");
  assert.equal(head(repo), before);
  assert.deepEqual(status(repo), ["A  new.txt"]);
}

// ---- Edit Commit Message

// The last commit: only its message changes (nothing staged goes in), the parent stays.
{
  const { repo, hashes } = fourCommits("reword-head");
  writeFileSync(`${repo}/staged.txt`, "staged\n");
  sh(repo, "git add staged.txt");
  const r = await editMessage(git, repo, { commit: hashes[3], message: TRICKY });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  const h = history(repo);
  assert.equal(h.length, 4);
  assert.equal(h[3].message, TRICKY);
  assert.equal(h[3].author, "author-four");
  assert.deepEqual(h[3].files, ["four.txt", "one.txt", "three.txt", "two.txt"]);
  assert.equal(run(repo, ["rev-parse", "HEAD~1"]).trim(), hashes[2]);
  assert.deepEqual(status(repo), ["A  staged.txt"]);
}

// An older commit: replayed with the new message; every other commit keeps its message,
// author and files, and the files left out of the commits stay.
{
  const { repo, hashes } = fourCommits("reword-old");
  writeFileSync(`${repo}/local.txt`, "local\n");
  const r = await editMessage(git, repo, { commit: hashes[1], message: TRICKY });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  assert.equal(inProgress(repo), false);
  const h = history(repo);
  assert.deepEqual(h.map((c) => c.message), ["one", TRICKY, "three", "four"]);
  assert.deepEqual(h.map((c) => c.author), ["author-one", "author-two", "author-three", "author-four"]);
  assert.deepEqual(h[2].files, ["one.txt", "three.txt", "two.txt"]);
  assert.equal(run(repo, ["rev-parse", "HEAD~3"]).trim(), hashes[0]);
  // An untracked file doesn't stand in the way and stays.
  assert.deepEqual(status(repo), ["?? local.txt"]);
  assert.equal(run(repo, ["symbolic-ref", "--short", "HEAD"]).trim(), "main");
}

// Changes to tracked files (in the working tree or staged): a replay doesn't start. The
// refusal names every changed tracked file, and nothing changes: history, files, index.
{
  const { repo, hashes } = fourCommits("replay-local");
  writeFileSync(`${repo}/local.txt`, "local\n");
  writeFileSync(`${repo}/one.txt`, "one, changed\n");
  sh(repo, "echo staged >> four.txt && git add four.txt && git rm -q --cached three.txt");
  const before = status(repo);
  for (const r of [
    await editMessage(git, repo, { commit: hashes[1], message: "x" }),
    await dropCommits(git, repo, { commits: [hashes[1]] }),
    await squashCommits(git, repo, { commits: [hashes[2], hashes[1]], message: "x" }),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "refused");
    assert.deepEqual(r.blocked, ["four.txt", "one.txt", "three.txt"]);
    assert.equal(r.msg.key, "rewrite.localChanges");
    assert.equal(r.err, en["rewrite.localChanges"].replace("{files}", "four.txt, one.txt, three.txt"));
    assert.equal(r.changed, false);
  }
  assert.equal(head(repo), hashes[3]);
  assert.deepEqual(status(repo), before);
  assert.equal(sh(repo, "cat one.txt"), "one, changed\n");
  // The last commit's message needs no replay: local changes don't stop it, and nothing
  // staged goes in.
  const amend = await editMessage(git, repo, { commit: hashes[3], message: "four, again" });
  assert.equal(amend.ok, true, amend.err);
  assert.equal(history(repo).at(-1).message, "four, again");
  assert.deepEqual(status(repo), before);
}

// The first commit of the history can be reworded too (after the screen asked).
{
  const { repo, hashes } = fourCommits("reword-root");
  const r = await editMessage(git, repo, { commit: hashes[0], message: "first" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(history(repo).map((c) => c.message), ["first", "two", "three", "four"]);
}

// An empty message is refused before anything runs.
{
  const { repo, hashes } = fourCommits("reword-empty");
  const r = await editMessage(git, repo, { commit: hashes[1], message: " \n" });
  assert.equal(r.ok, false);
  assert.equal(r.msg.key, "commit.noMessage");
  assert.equal(head(repo), hashes[3]);
}

// ---- Drop Commits

// One commit, and several at once: they go, the others stay as they were.
{
  const { repo, hashes } = fourCommits("drop-one");
  const r = await dropCommits(git, repo, { commits: [hashes[1]] });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  const h = history(repo);
  assert.deepEqual(h.map((c) => c.message), ["one", "three", "four"]);
  assert.deepEqual(h[2].files, ["four.txt", "one.txt", "three.txt"]);
}
{
  const { repo, hashes } = fourCommits("drop-many");
  const r = await dropCommits(git, repo, { commits: [hashes[3], hashes[1]] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(history(repo).map((c) => c.message), ["one", "three"]);
  assert.deepEqual(status(repo), []);
}

// Dropping a commit the next one builds on: the rebase stops on the conflict, in progress
// (the screen opens the Conflicts dialog).
{
  const repo = init("drop-conflict");
  sh(repo, "echo a > f.txt && git add f.txt && git commit -q -m base && echo b > f.txt && git commit -q -am mid && echo c > f.txt && git commit -q -am top");
  const mid = run(repo, ["rev-parse", "HEAD~1"]).trim();
  const r = await dropCommits(git, repo, { commits: [mid] });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "stopped");
  assert.equal(r.operation.kind, "rebase");
  assert.deepEqual(r.operation.conflicts.map((c) => c.path), ["f.txt"]);
  sh(repo, "git rebase --abort");
}

// ---- Squash Commits

// Two neighbors and one further up: one commit with the message given, where the oldest
// was; the commits between keep their place after it; the last tree is the same.
{
  const { repo, hashes } = fourCommits("squash");
  const tree = run(repo, ["rev-parse", "HEAD^{tree}"]).trim();
  const r = await squashCommits(git, repo, { commits: [hashes[3], hashes[1], hashes[0]], message: TRICKY });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  const h = history(repo);
  assert.deepEqual(h.map((c) => c.message), [TRICKY, "three"]);
  assert.deepEqual(h[0].files, ["four.txt", "one.txt", "two.txt"]);
  assert.equal(h[0].author, "author-one");
  assert.equal(run(repo, ["rev-parse", "HEAD^{tree}"]).trim(), tree);
}

// One commit is not a squash.
{
  const { repo, hashes } = fourCommits("squash-one");
  const r = await squashCommits(git, repo, { commits: [hashes[2]], message: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.msg.key, "rewrite.selectTwo");
  assert.equal(head(repo), hashes[3]);
}

// ---- other branches on the rewritten commits (the person's rebase.updateRefs)

{
  const { repo, hashes } = fourCommits("update-refs");
  sh(repo, `git branch side ${hashes[2]} && git config rebase.updateRefs true`);
  const r = await editMessage(git, repo, { commit: hashes[1], message: "two, again" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(history(repo, "side").map((c) => c.message), ["one", "two, again", "three"]);
}
{
  const { repo, hashes } = fourCommits("no-update-refs");
  sh(repo, `git branch side ${hashes[2]}`);
  const r = await editMessage(git, repo, { commit: hashes[1], message: "two, again" });
  assert.equal(r.ok, true, r.err);
  assert.equal(run(repo, ["rev-parse", "side"]).trim(), hashes[2]);
}

// ---- the facts the edit check reads, and the refusals they bring

// A pushed main: every commit on origin/main is protected, the commit after it is not;
// the rewrite of a pushed commit needs a force push.
{
  const { repo, hashes } = fourCommits("facts-protected");
  const remote = `${base}/facts-protected.git`;
  sh(base, `git init -q --bare ${remote}`);
  sh(repo, `git remote add origin ${remote} && git push -q -u origin main`);
  writeFileSync(`${repo}/five.txt`, "five\n");
  sh(repo, "git add five.txt && git commit -q -m five");
  const f = await readEditFacts(git, repo, [hashes[3]]);
  assert.equal(f.ok, true, f.err);
  assert.equal(f.protected, "origin/main");
  assert.equal(f.commits[0].pushedProtected, true);
  assert.equal(f.pushed, true);
  const after = await readEditFacts(git, repo, [head(repo)]);
  assert.equal(after.commits[0].pushedProtected, false);
  assert.equal(after.pushed, false);
  assert.equal(after.head, head(repo));
  // Refused before anything runs: the history stays.
  const before = head(repo);
  const r = await dropCommits(git, repo, { commits: [hashes[3]] });
  assert.equal(r.outcome, "refused");
  assert.deepEqual(r.msg, { key: "rewrite.pushedProtected", args: { branch: "origin/main" } });
  assert.equal(head(repo), before);
  // A branch that tracks a branch nobody protects: pushed, but not protected.
  sh(repo, "git checkout -q -b work && git push -q -u origin work");
  const work = await readEditFacts(git, repo, [head(repo)]);
  assert.equal(work.protected, null);
  assert.equal(work.commits[0].pushedProtected, false);
  assert.equal(work.pushed, true);
}

// A merge commit (its parents), a commit off the current branch, a merge above the
// commit, the first commit (no parents), and an operation in progress.
{
  const repo = init("facts-shape");
  sh(repo, "echo a > a && git add a && git commit -q -m root && git checkout -q -b side && echo s > s && git add s && git commit -q -m side-only && git checkout -q main && echo m > m && git add m && git commit -q -m main-only && git merge -q --no-edit side && echo t > t && git add t && git commit -q -m top");
  const merge = run(repo, ["rev-parse", "HEAD~1"]).trim(), root = run(repo, ["rev-list", "--max-parents=0", "HEAD"]).trim();
  const f = await readEditFacts(git, repo, [merge, root, head(repo)]);
  assert.equal(f.ok, true, f.err);
  assert.deepEqual(f.commits.map((c) => c.parents), [2, 0, 1]);
  assert.ok(f.commits.every((c) => c.onBranch));
  sh(repo, "git checkout -q side && echo x > x && git add x && git commit -q -m side-more && git checkout -q main");
  const off = await readEditFacts(git, repo, [run(repo, ["rev-parse", "side"]).trim()]);
  assert.equal(off.commits[0].onBranch, false);
  const below = await readEditFacts(git, repo, [run(repo, ["rev-parse", "HEAD~2"]).trim()]);
  assert.equal(below.mergeAbove, true);
  const top = await readEditFacts(git, repo, [head(repo)]);
  assert.equal(top.mergeAbove, false);
  assert.equal(top.operation, null);
  sh(repo, "git checkout -q -b clash HEAD~1 && echo 1 > t && git add t && git commit -q -m clash && (git merge -q main >/dev/null 2>&1 || true)");
  const during = await readEditFacts(git, repo, [head(repo)]);
  assert.equal(during.operation, "merge");
  const r = await undoCommit(git, repo, { commit: head(repo) });
  assert.equal(r.outcome, "refused");
  assert.equal(r.msg.key, "rewrite.duringMerge");
}

// The messages the dialogs start from, whole, by hash; `joined`, the squash dialog's: the
// messages of the commits given newest first (as the Commit list picks them), oldest
// first, a blank line between.
{
  const { repo, hashes } = fourCommits("messages");
  sh(repo, `git commit -q --allow-empty -m 'subject' -m 'body $x'`);
  const five = head(repo);
  const r = await readMessages(git, repo, [five, hashes[2], hashes[0]]);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.messages, { [five]: "subject\n\nbody $x", [hashes[2]]: "three", [hashes[0]]: "one" });
  assert.equal(r.joined, "one\n\nthree\n\nsubject\n\nbody $x");
  const no = await readMessages(git, repo, ["0".repeat(40)]);
  assert.equal(no.ok, false);
}

// A commit that isn't there.
{
  const { repo } = fourCommits("facts-unknown");
  const f = await readEditFacts(git, repo, ["0".repeat(40)]);
  assert.equal(f.ok, false);
  assert.equal(f.msg.key, "rewrite.unknownCommit");
  checkMsg(f);
}

console.log("ok");
