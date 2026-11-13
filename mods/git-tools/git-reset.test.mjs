// node git-reset.test.mjs: resetting the current branch, against throwaway repositories
// (no app needed). Each case reads the repository again with git itself: HEAD, the index
// and the working tree, and the snapshot a hard reset records first.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { resetTo, checkCommit, currentBranch, RESET_MODES } from "./git-reset.js";
import { listSnapshots, restore, SNAPSHOTS } from "./git-snapshot.js";
import { en } from "./messages-reset.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-reset-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);
const COPY = "0123456789abcdef";

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const head = (repo) => sh(repo, "git rev-parse HEAD").trim();
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");

// Two commits: a.txt one → two; the reset goes back to the first.
const twoCommits = (name) => {
  const repo = init(name);
  sh(repo, "echo one > a.txt && echo keep > k.txt && git add -A && git commit -q -m first");
  const first = head(repo);
  sh(repo, "echo two > a.txt && git commit -q -am second");
  return { repo, first, second: head(repo) };
};

assert.deepEqual(RESET_MODES, ["soft", "mixed", "hard", "keep"]);

// Soft: HEAD moves, the index and the files stay, so the difference is staged.
{
  const { repo, first } = twoCommits("soft");
  const r = await resetTo(git, repo, { commit: first, mode: "soft", copy: COPY });
  assert.equal(r.ok, true, r.err);
  assert.equal(head(repo), first);
  assert.deepEqual(status(repo), ["M  a.txt"]);
  assert.equal(text(repo, "a.txt"), "two\n");
  assert.equal(r.snapshot, null);
}

// Mixed: HEAD and the index move, the files stay: the difference is unstaged.
{
  const { repo, first } = twoCommits("mixed");
  const r = await resetTo(git, repo, { commit: first, mode: "mixed", copy: COPY });
  assert.equal(r.ok, true, r.err);
  assert.equal(head(repo), first);
  assert.deepEqual(status(repo), [" M a.txt"]);
  assert.equal(text(repo, "a.txt"), "two\n");
}

// Hard with nothing local: everything moves, no snapshot is made.
{
  const { repo, first } = twoCommits("hard-clean");
  const r = await resetTo(git, repo, { commit: first, mode: "hard", copy: COPY });
  assert.equal(r.ok, true, r.err);
  assert.equal(head(repo), first);
  assert.deepEqual(status(repo), []);
  assert.equal(text(repo, "a.txt"), "one\n");
  assert.equal(r.snapshot, null);
  assert.equal(sh(repo, `git rev-parse -q --verify ${SNAPSHOTS} || true`), "");
}

// Keep: HEAD and files move, a local change to a file the commits don't touch stays.
{
  const { repo, first } = twoCommits("keep");
  sh(repo, "echo mine > k.txt");
  const r = await resetTo(git, repo, { commit: first, mode: "keep", copy: COPY });
  assert.equal(r.ok, true, r.err);
  assert.equal(head(repo), first);
  assert.equal(text(repo, "a.txt"), "one\n");
  assert.equal(text(repo, "k.txt"), "mine\n");
  assert.deepEqual(status(repo), [" M k.txt"]);
}

// Keep refused: a local change to a file the two commits differ in. Nothing moves, and
// git's words come back.
{
  const { repo, first, second } = twoCommits("keep-refused");
  sh(repo, "echo mine > a.txt && echo staged > k.txt && git add k.txt");
  const before = status(repo);
  const r = await resetTo(git, repo, { commit: first, mode: "keep", copy: COPY });
  assert.equal(r.ok, false);
  assert.notEqual(r.err, "");
  assert.equal(head(repo), second);
  assert.deepEqual(status(repo), before);
  assert.equal(text(repo, "a.txt"), "mine\n");
  assert.equal(r.changed, false);
}

// A mode or a commit the module doesn't know: nothing runs.
{
  const { repo, first, second } = twoCommits("bad-input");
  for (const args of [{ commit: first, mode: "merge" }, { commit: "--hard", mode: "mixed" }, { commit: "nope", mode: "mixed" }]) {
    const r = await resetTo(git, repo, { ...args, copy: COPY });
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.ok(en[r.msg?.key], `${JSON.stringify(args)}: ${r.msg?.key}`);
    assert.equal(head(repo), second);
  }
}

// The commit field of Reset HEAD: an expression is checked against the repository and
// becomes the commit's hash; anything else is refused with the module's sentence.
{
  const { repo, first, second } = twoCommits("check");
  assert.deepEqual(await checkCommit(git, repo, "HEAD"), { ok: true, code: 0, out: "", err: "", hash: second });
  assert.equal((await checkCommit(git, repo, " HEAD~1 ")).hash, first);
  assert.equal((await checkCommit(git, repo, first.slice(0, 8))).hash, first);
  sh(repo, "git tag v1 HEAD~1");
  assert.equal((await checkCommit(git, repo, "v1")).hash, first);
  for (const bad of ["", "HEAD~5", "nope", "-q", "--all", "HEAD^{tree}"]) {
    const r = await checkCommit(git, repo, bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.msg?.key, "reset.invalidCommit", bad);
    assert.equal(r.hash, null);
  }
}

// What the dialogs show above the choice: the current branch, or null on a detached HEAD.
{
  const { repo, first } = twoCommits("current");
  assert.deepEqual(await currentBranch(git, repo), { ok: true, code: 0, out: "", err: "", branch: "main" });
  sh(repo, `git checkout -q ${first}`);
  assert.equal((await currentBranch(git, repo)).branch, null);
}

// Hard with local changes: first a snapshot of all of them, working tree and staging,
// named "Reset: N files"; an untracked file at a path the commit lacks is left out (a hard
// reset leaves it).
{
  const { repo, first } = twoCommits("hard-recorded");
  sh(repo, "echo staged > k.txt && git add k.txt && echo worktree > k.txt && echo mine > a.txt && echo new > n.txt && git add n.txt && echo loose > u.txt");
  const r = await resetTo(git, repo, { commit: first, mode: "hard", copy: COPY });
  assert.equal(r.ok, true, r.err);
  assert.equal(head(repo), first);
  assert.deepEqual(status(repo), ["?? u.txt"]);
  assert.match(r.snapshot, /^[0-9a-f]{40}$/);
  assert.equal(sh(repo, `git log -1 --format=%s ${r.snapshot}`).trim(), "Reset: 3 files");
  const list = await listSnapshots(git, repo);
  assert.equal(list.snapshots[0].hash, r.snapshot);
  assert.equal(list.snapshots[0].action, "Reset");
  assert.deepEqual(list.snapshots[0].files, [
    { path: "a.txt", status: "modified" },
    { path: "k.txt", status: "modified" },
    { path: "n.txt", status: "added" },
  ]);
  // The working tree and the staging are both in it.
  assert.equal(sh(repo, `git show ${r.snapshot}:k.txt`), "worktree\n");
  assert.equal(sh(repo, `git show ${r.snapshot}^2:k.txt`), "staged\n");
}

// Hard onto a commit that tracks a path an untracked file holds: the reset writes over that
// file, so it is recorded too, and Restore brings it back once HEAD is where it was. Other
// untracked files stay out of the snapshot (the reset leaves them).
{
  const repo = init("hard-untracked");
  sh(repo, "echo one > a.txt && git add -A && git commit -q -m first");
  const first = head(repo);
  sh(repo, "git checkout -q -b theirs && echo theirs > new.txt && mkdir d && echo deep > d/x.txt && git add -A && git commit -q -m theirs");
  const theirs = head(repo);
  sh(repo, "git checkout -q main && echo 'MY UNTRACKED' > new.txt && mkdir d && echo mine > d/x.txt && echo loose > u.txt");
  const r = await resetTo(git, repo, { commit: theirs, mode: "hard", copy: COPY });
  assert.equal(r.ok, true, r.err);
  assert.equal(text(repo, "new.txt"), "theirs\n");
  assert.match(r.snapshot ?? "", /^[0-9a-f]{40}$/);
  const list = await listSnapshots(git, repo);
  assert.deepEqual(list.snapshots[0].files, [
    { path: "d/x.txt", status: "added" },
    { path: "new.txt", status: "added" },
  ]);
  assert.equal(sh(repo, `git show ${r.snapshot}:new.txt`), "MY UNTRACKED\n");

  const back = await resetTo(git, repo, { commit: first, mode: "hard", copy: COPY });
  assert.equal(back.ok, true, back.err);
  const restored = await restore(git, repo, { snapshot: r.snapshot, paths: ["new.txt", "d/x.txt"], copy: COPY });
  assert.equal(restored.ok, true, restored.err);
  assert.equal(text(repo, "new.txt"), "MY UNTRACKED\n");
  assert.equal(text(repo, "d/x.txt"), "mine\n");
}

// Hard that can't be recorded: nothing is reset, nothing is lost.
{
  const { repo, first, second } = twoCommits("hard-unrecorded");
  sh(repo, "echo mine > a.txt");
  const noCopy = await resetTo(git, repo, { commit: first, mode: "hard", copy: "" });
  assert.equal(noCopy.ok, false);
  assert.equal(noCopy.msg?.key, "reset.notRecorded");
  assert.equal(head(repo), second);
  assert.equal(text(repo, "a.txt"), "mine\n");

  // git can't write the snapshot's objects: the object store is read-only.
  chmodSync(`${repo}/.git/objects`, 0o555);
  for (const dir of sh(repo, "ls .git/objects").split("\n").filter(Boolean)) chmodSync(`${repo}/.git/objects/${dir}`, 0o555);
  const r = await resetTo(git, repo, { commit: first, mode: "hard", copy: COPY });
  sh(repo, "chmod -R u+w .git/objects");
  assert.equal(r.ok, false);
  assert.equal(r.msg?.key, "reset.notRecorded");
  assert.equal(r.changed, false);
  assert.equal(head(repo), second);
  assert.equal(text(repo, "a.txt"), "mine\n");
  assert.deepEqual(status(repo), [" M a.txt"]);
}

console.log("ok");
