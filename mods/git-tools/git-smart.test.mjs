// node git-smart.test.mjs: Smart operation against throwaway repositories (no app
// needed). Each case reads the repository again with git itself: HEAD, the stash list,
// the index and the working tree, and the mark in the repository's settings.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { blockedBy, checkoutBranch, smartRun, settleSmartStash, readSmartMark, forceCheckout } from "./git-smart.js";
import { listSnapshots } from "./git-snapshot.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-smart-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

// Five lines each, so a change at the top and one at the bottom of the same file merge.
const lines = (word) => ["1", "2", "3", "4", "5"].map((n) => `${word}${n}`).join("\n") + "\n";
const write = (repo, path, text) => writeFileSync(`${repo}/${path}`, text);
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");
const edit = (repo, path, at, word) => {
  const all = text(repo, path).split("\n");
  all[at] = word;
  write(repo, path, all.join("\n"));
};

// main: a.txt, b.txt, c.txt, d.txt. side (from main): changes a.txt (bottom line) and
// adds s.txt.
const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  for (const f of ["a", "b", "c", "d"]) write(repo, `${f}.txt`, lines(f));
  sh(repo, "git add -A && git commit -q -m first");
  sh(repo, "git checkout -q -b side");
  edit(repo, "a.txt", 4, "side-a5");
  write(repo, "s.txt", "s\n");
  sh(repo, "git add -A && git commit -q -m side && git checkout -q main");
  return repo;
};
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const head = (repo) => sh(repo, "git rev-parse HEAD").trim();
const branch = (repo) => sh(repo, "git symbolic-ref -q --short HEAD || true").trim();
const stashes = (repo) => sh(repo, "git stash list --format=%H").split("\n").filter(Boolean);
const sorted = (paths) => [...paths].sort();

// ---- the files in the way, by request

// Checkout: the local changes to files that differ between HEAD and the branch. A change
// to a file both have the same, and an untracked file, are not in the way.
{
  const repo = init("blocked-checkout");
  edit(repo, "a.txt", 0, "mine-a1");
  edit(repo, "b.txt", 0, "mine-b1");
  write(repo, "u.txt", "u\n");
  const r = await blockedBy(git, repo, { type: "checkout", name: "side" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.paths, ["a.txt"]);
  const remote = await blockedBy(git, repo, { type: "checkout", name: "nowhere/side", remote: true });
  assert.deepEqual(remote.paths, [], "a branch that is not there blocks nothing");
}

// Merge, cherry-pick, revert: the local changes to files the request changes, and every
// staged change as soon as one is staged (git refuses those whatever they touch).
{
  const repo = init("blocked-merge");
  edit(repo, "a.txt", 0, "mine-a1");
  edit(repo, "b.txt", 0, "mine-b1");
  assert.deepEqual((await blockedBy(git, repo, { type: "merge", target: "side" })).paths, ["a.txt"]);
  assert.deepEqual((await blockedBy(git, repo, { type: "cherry-pick", commits: ["side"] })).paths, ["a.txt"]);
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "revert", commits: [head(repo)] })).paths), ["a.txt", "b.txt"], "reverting the first commit removes every file");
  sh(repo, "git add c.txt && echo staged >> c.txt && git add c.txt");
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "merge", target: "side" })).paths), ["a.txt", "c.txt"]);
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "pull", target: "side" })).paths), ["a.txt", "c.txt"]);
}

// Rebase, a pull that rebases, checkout and rebase: every tracked change.
{
  const repo = init("blocked-rebase");
  edit(repo, "b.txt", 0, "mine-b1");
  write(repo, "u.txt", "u\n");
  sh(repo, "echo staged >> c.txt && git add c.txt");
  for (const type of ["rebase", "checkout-rebase"]) assert.deepEqual(sorted((await blockedBy(git, repo, { type, target: "side" })).paths), ["b.txt", "c.txt"], type);
  assert.deepEqual(sorted((await blockedBy(git, repo, { type: "pull", rebase: true })).paths), ["b.txt", "c.txt"]);
  assert.deepEqual((await blockedBy(git, repo, { type: "continue" })).paths, [], "Continue, Abort and Skip have none");
}

// ---- checkout

// Refused by a local change: "refused" with the files, and nothing moved.
{
  const repo = init("checkout-refused");
  edit(repo, "a.txt", 0, "mine-a1");
  const before = status(repo), at = head(repo);
  const r = await checkoutBranch(git, repo, { name: "side" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "refused");
  assert.deepEqual(r.blocked, ["a.txt"]);
  assert.deepEqual(status(repo), before);
  assert.equal(head(repo), at);
  // Nothing in the way: it just checks out.
  const clean = init("checkout-clean");
  const done = await checkoutBranch(git, clean, { name: "side" });
  assert.equal(done.outcome, "done", done.err);
  assert.equal(branch(clean), "side");
  // Another failure (no such branch): "failed" with git's words, no files.
  const gone = await checkoutBranch(git, repo, { name: "nowhere" });
  assert.equal(gone.outcome, "failed");
  assert.deepEqual(gone.blocked ?? [], []);
}

// Smart Checkout: the changes and their staging come back as they were, on the other
// branch, and the stash it used is gone.
{
  const repo = init("checkout-smart");
  edit(repo, "a.txt", 0, "mine-a1"); // in the way, merges with side's change
  sh(repo, "git add a.txt");
  edit(repo, "a.txt", 1, "mine-a2"); // staged and unstaged in the same file
  edit(repo, "b.txt", 0, "mine-b1");
  sh(repo, "echo new > n.txt && git add n.txt");
  write(repo, "u.txt", "u\n");
  const before = status(repo);
  const staged = sh(repo, "git diff --cached");
  const r = await smartRun(git, repo, { request: { type: "checkout", name: "side" } });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  assert.equal(branch(repo), "side");
  assert.deepEqual(status(repo), before);
  assert.match(text(repo, "a.txt"), /^mine-a1\nmine-a2\n.*side-a5\n$/s);
  const noIndexLine = (diff) => diff.replace(/^index .*\n/gm, "");
  assert.equal(noIndexLine(sh(repo, "git diff --cached")), noIndexLine(staged), "the staging comes back");
  assert.deepEqual(stashes(repo), []);
}

// Smart around every other request: it finishes and the changes and their staging come
// back as they were. The requests run as git commands here (`run`); their own modules
// name them by type.
const NO_EDITOR = { GIT_EDITOR: "true" };
const asGit = (args) => (g, root) => g(root, args, { env: NO_EDITOR });
const marks = (repo) => sh(repo, "git config --local --get-all gittools.smart-stash || true").split("\n").filter(Boolean);
{
  const kinds = [
    ["merge", ["merge", "side"], (repo) => sh(repo, "git log -1 --format=%P").trim().split(" ").length === 2],
    ["pull", ["pull", "--no-rebase", ".", "side"], (repo) => sh(repo, "git log -1 --format=%P").trim().split(" ").length === 2],
    ["pull", ["pull", "--rebase", ".", "side"], (repo) => text(repo, "s.txt") === "s\n"],
    ["rebase", ["rebase", "side"], (repo) => text(repo, "s.txt") === "s\n"],
    ["cherry-pick", ["cherry-pick", "side"], (repo) => text(repo, "s.txt") === "s\n"],
    ["revert", ["revert", "--no-edit", "HEAD"], (repo) => sh(repo, "git log -1 --format=%s").startsWith("Revert")],
  ];
  let n = 0;
  for (const [type, args, went] of kinds) {
    const repo = init(`each-${n++}`);
    // Something of main's own to rebase and revert: c.txt's last line.
    edit(repo, "c.txt", 4, "main-c5");
    sh(repo, "git commit -q -am main");
    edit(repo, "a.txt", 0, "mine-a1");
    sh(repo, "git add a.txt");
    edit(repo, "b.txt", 0, "mine-b1");
    const before = status(repo);
    const r = await smartRun(git, repo, { request: { type }, run: asGit(args) });
    assert.equal(r.outcome, "done", `${args.join(" ")}: ${r.err}`);
    assert.ok(went(repo), `${args.join(" ")} ran`);
    assert.deepEqual(status(repo), before, args.join(" "));
    assert.deepEqual(stashes(repo), []);
    assert.deepEqual(marks(repo), []);
  }
}

// main and side both change a.txt's last line: merging them stops on it.
const diverge = (name) => {
  const repo = init(name);
  edit(repo, "a.txt", 4, "main-a5");
  sh(repo, "git commit -q -am main-a5");
  return repo;
};
const resolve = (repo, last) => { edit(repo, "a.txt", 4, last); sh(repo, "git add a.txt && GIT_EDITOR=true git commit -q --no-edit"); };

// The request stops: the stash stays and the mark names it. While it is in progress the
// read leaves it; once it was finished in a terminal, the read brings the changes back
// and the mark goes.
{
  const repo = diverge("stopped-continue");
  edit(repo, "a.txt", 0, "mine-a1");
  edit(repo, "b.txt", 0, "mine-b1");
  sh(repo, "git add b.txt");
  const before = status(repo);
  const r = await smartRun(git, repo, { request: { type: "merge", target: "side" }, run: asGit(["merge", "side"]) });
  assert.equal(r.outcome, "stopped", r.err);
  assert.equal(r.operation.kind, "merge");
  assert.equal(r.kept, true);
  assert.deepEqual(stashes(repo), [r.stash.hash]);
  assert.equal(r.stash.ref, "stash@{0}");
  assert.match(sh(repo, "git stash list --format=%gs"), /^On main: Uncommitted changes before Merge at \d{4}-\d\d-\d\d \d\d:\d\d\n$/);
  assert.equal((await readSmartMark(git, repo)).hash, r.stash.hash);
  const waiting = await settleSmartStash(git, repo);
  assert.equal(waiting.outcome, "waiting");
  assert.deepEqual(stashes(repo), [r.stash.hash]);
  resolve(repo, "both-a5");
  const back = await settleSmartStash(git, repo);
  assert.equal(back.outcome, "done", back.err);
  assert.deepEqual(status(repo), before);
  assert.equal(text(repo, "a.txt").split("\n")[0], "mine-a1");
  assert.deepEqual(stashes(repo), []);
  assert.deepEqual(marks(repo), []);
  assert.equal((await settleSmartStash(git, repo)).outcome, "none", "once only");
}

// Aborted in a terminal: the same.
{
  const repo = diverge("stopped-abort");
  edit(repo, "a.txt", 0, "mine-a1");
  const before = status(repo), at = head(repo);
  const r = await smartRun(git, repo, { request: { type: "merge", target: "side" }, run: asGit(["merge", "side"]) });
  assert.equal(r.outcome, "stopped");
  sh(repo, "git merge --abort");
  const back = await settleSmartStash(git, repo);
  assert.equal(back.outcome, "done", back.err);
  assert.equal(head(repo), at);
  assert.deepEqual(status(repo), before);
  assert.deepEqual(marks(repo), []);
}

// The stash was dropped meanwhile: only the mark goes.
{
  const repo = diverge("stopped-gone");
  edit(repo, "a.txt", 0, "mine-a1");
  await smartRun(git, repo, { request: { type: "merge", target: "side" }, run: asGit(["merge", "side"]) });
  sh(repo, "git merge --abort && git stash drop -q");
  const r = await settleSmartStash(git, repo);
  assert.equal(r.outcome, "gone");
  assert.deepEqual(marks(repo), []);
  assert.deepEqual(status(repo), []);
}

// Bringing the changes back conflicts: the stash stays, its files are in conflict, the
// mark goes. Right after a finished request (a checkout) the same, with no mark at all.
{
  const repo = diverge("back-conflict");
  edit(repo, "a.txt", 4, "mine-a5");
  const r = await smartRun(git, repo, { request: { type: "merge", target: "side" }, run: asGit(["merge", "side"]) });
  assert.equal(r.outcome, "stopped");
  resolve(repo, "both-a5");
  const back = await settleSmartStash(git, repo);
  assert.equal(back.outcome, "stopped", back.err);
  assert.deepEqual(back.operation.conflicts.map((c) => c.path), ["a.txt"]);
  assert.equal(back.operation.kind, null);
  assert.deepEqual(stashes(repo), [r.stash.hash]);
  assert.equal(back.stash.ref, "stash@{0}");
  assert.deepEqual(marks(repo), []);

  const now = init("checkout-back-conflict");
  edit(now, "a.txt", 4, "mine-a5");
  const c = await smartRun(git, now, { request: { type: "checkout", name: "side" } });
  assert.equal(c.outcome, "stopped", c.err);
  assert.equal(branch(now), "side");
  assert.deepEqual(c.operation.conflicts.map((x) => x.path), ["a.txt"]);
  assert.equal(stashes(now).length, 1);
  assert.equal(c.kept, true);
  assert.deepEqual(marks(now), []);
}

// The stash can't be made (files in conflict): the request doesn't run.
{
  const repo = diverge("no-stash");
  sh(repo, "git merge side || true");
  let ran = false;
  const r = await smartRun(git, repo, { request: { type: "merge" }, run: async () => { ran = true; return { ok: true }; } });
  assert.equal(r.outcome, "failed");
  assert.equal(ran, false);
}

// Another worktree's mark is left alone.
{
  const repo = init("other-worktree");
  sh(repo, "git config --local --add gittools.smart-stash \"$(git rev-parse HEAD) /somewhere/else/.git\"");
  assert.equal((await readSmartMark(git, repo)).hash, null);
  assert.equal((await settleSmartStash(git, repo)).outcome, "none");
  assert.equal(marks(repo).length, 1);
}

// ---- Force Checkout: every tracked change is recorded as a "Checkout" snapshot first,
// then thrown away. Without the record, nothing is checked out.
{
  const repo = init("force");
  edit(repo, "a.txt", 0, "mine-a1");
  edit(repo, "b.txt", 0, "mine-b1");
  sh(repo, "echo new > n.txt && git add n.txt");
  write(repo, "u.txt", "u\n");
  const before = status(repo);
  const refused = await forceCheckout(git, repo, { name: "side", copy: "not an id" });
  assert.equal(refused.ok, false);
  assert.equal(branch(repo), "main");
  assert.deepEqual(status(repo), before);
  const r = await forceCheckout(git, repo, { name: "side", copy: "0123456789abcdef" });
  assert.equal(r.ok, true, r.err);
  assert.equal(branch(repo), "side");
  assert.deepEqual(status(repo), ["?? u.txt"]);
  const list = await listSnapshots(git, repo);
  assert.equal(list.snapshots[0].hash, r.snapshot);
  assert.equal(list.snapshots[0].action, "Checkout");
  assert.deepEqual(list.snapshots[0].files.map((f) => f.path), ["a.txt", "b.txt", "n.txt"]);
}

console.log("ok");
