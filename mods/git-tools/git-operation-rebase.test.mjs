// node git-operation-rebase.test.mjs: a rebase started through runOperation ({ type:
// "rebase" } and { type: "checkout-rebase" }) against throwaway repositories: onto a branch
// and onto a commit, each option, another branch, a conflict, local changes in the way,
// a repository with rebase.updateRefs on. Every check reads the repository back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { runOperation } from "./git-operation.js";

// The person's own git settings (an editor, gpgSign, hooks path) stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-rebase-`));
const exec = (cmd, args = [], { cwd, env } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);
const lines = (text) => text.split("\n").filter(Boolean);
const head = (repo) => sh(repo, "git rev-parse HEAD").trim();
const hash = (repo, rev) => sh(repo, `git rev-parse ${rev}`).trim();
const branch = (repo) => sh(repo, "git symbolic-ref -q --short HEAD || echo DETACHED").trim();
const status = (repo) => lines(sh(repo, "git status --porcelain --untracked-files=all"));
const subjects = (repo, rev = "HEAD") => lines(sh(repo, `git log --format=%s ${rev}`));
const states = (repo) => lines(sh(repo, "for n in MERGE_HEAD rebase-merge rebase-apply; do p=$(git rev-parse --git-path $n); [ -e \"$p\" ] && echo $n; done; true"));
const rebase = (repo, args) => runOperation(git, repo, { type: "rebase", ...args });
const checkoutRebase = (repo, args) => runOperation(git, repo, { type: "checkout-rebase", ...args });

// main: base → m1 (m.txt, f.txt "main"). side, from base: s1 (s.txt) → s2 (t.txt).
// clash, from base: c1 (f.txt "clash"). feature, from base: e1 (e.txt).
let n = 0;
const init = () => {
  const repo = `${base}/r${n++}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo base > f.txt && git add -A && git commit -q -m base
git checkout -q -b side && echo s > s.txt && git add -A && git commit -q -m s1 && echo t > t.txt && git add -A && git commit -q -m s2
git checkout -q -b clash main && echo clash > f.txt && git commit -q -am c1
git checkout -q -b feature main && echo e > e.txt && git add -A && git commit -q -m e1
git checkout -q main && echo m > m.txt && echo main > f.txt && git add -A && git commit -q -m m1`);
  return repo;
};

// Onto a branch: main's own commit goes on top of side's.
{
  const repo = init();
  const r = await rebase(repo, { target: "side" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(r.ok, true);
  assert.equal(branch(repo), "main");
  assert.deepEqual(subjects(repo), ["m1", "s2", "s1", "base"]);
  assert.equal(hash(repo, "HEAD~1"), hash(repo, "side"));
  assert.deepEqual([status(repo), states(repo)], [[], []]);
}

// Onto a commit picked in the Commit list (a hash): main goes on top of that commit.
{
  const repo = init();
  const s1 = hash(repo, "side~1");
  const r = await rebase(repo, { target: s1 });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(branch(repo), "main");
  assert.deepEqual(subjects(repo), ["m1", "s1", "base"]);
}

// New base and old base (--onto): only what is past the old base moves.
{
  const repo = init();
  sh(repo, "echo m2 > m2.txt && git add -A && git commit -q -m m2");
  const r = await rebase(repo, { target: "main~1", onto: "side" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["m2", "s2", "s1", "base"]);
}

// --root: every commit of the branch, here onto side (base is already there, so git
// leaves it out).
{
  const repo = init();
  const r = await rebase(repo, { options: ["--root"], onto: "side" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["m1", "s2", "s1", "base"]);
  assert.equal(hash(repo, "HEAD~1"), hash(repo, "side"));
}

// --keep-empty keeps a commit that changes nothing.
{
  const repo = init();
  sh(repo, "git commit -q --allow-empty -m empty");
  const r = await rebase(repo, { target: "side", options: ["--keep-empty"] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["empty", "m1", "s2", "s1", "base"]);
}

// --rebase-merges keeps a merge commit a merge.
{
  const repo = init();
  sh(repo, "git merge -q --no-ff -m 'bring feature' feature");
  const r = await rebase(repo, { target: "side", options: ["--rebase-merges"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(sh(repo, "git log -1 --format=%P").trim().split(" ").length, 2);
  assert.equal(sh(repo, "git log -1 --format=%s").trim(), "bring feature");
  assert.equal(sh(repo, "git merge-base --is-ancestor side HEAD && echo yes").trim(), "yes");
}

// Another branch (Select another branch to rebase): that branch goes onto the target and
// is checked out, wherever HEAD was.
{
  const repo = init();
  const r = await rebase(repo, { target: "main", branch: "feature" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(branch(repo), "feature");
  assert.deepEqual(subjects(repo), ["e1", "m1", "base"]);
}

// rebase.updateRefs on in the repository: git moves the branches inside the range, as it
// would in a terminal. --update-refs does the same where the setting is off.
{
  const repo = init();
  sh(repo, "git checkout -q -b part side~1 && git checkout -q -b top side && echo u > u.txt && git add -A && git commit -q -m u1 && git config rebase.updateRefs true");
  const r = await rebase(repo, { target: "main" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["u1", "s2", "s1", "m1", "base"]);
  assert.equal(hash(repo, "part"), hash(repo, "HEAD~2"), "part moved with the rebase");
}
{
  const repo = init();
  sh(repo, "git checkout -q -b part side~1 && git checkout -q -b top side && echo u > u.txt && git add -A && git commit -q -m u1");
  const r = await rebase(repo, { target: "main", options: ["--update-refs"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(hash(repo, "part"), hash(repo, "HEAD~2"));
  const plain = init();
  sh(plain, "git checkout -q -b part side~1 && git checkout -q -b top side");
  const old = hash(plain, "part");
  assert.equal((await rebase(plain, { target: "main" })).outcome, "done");
  assert.equal(hash(plain, "part"), old, "without it the other branch stays");
}

// A conflict stops with the rebase in progress.
{
  const repo = init();
  const r = await rebase(repo, { target: "clash" });
  assert.equal(r.outcome, "stopped");
  assert.equal(r.ok, true);
  assert.equal(r.operation.kind, "rebase");
  assert.equal(r.operation.rebasing, "main");
  assert.deepEqual(r.operation.conflicts.map((c) => c.path), ["f.txt"]);
}

// Local changes: refused with every tracked change, nothing changed. A change git
// wouldn't touch stops it too; an untracked file doesn't.
{
  const repo = init(), main = head(repo);
  sh(repo, "echo mine > m.txt && echo new > n.txt && git add n.txt && echo u > untracked.txt");
  const r = await rebase(repo, { target: "side" });
  assert.equal(r.outcome, "refused", r.err);
  assert.deepEqual([...r.blocked].sort(), ["m.txt", "n.txt"]);
  assert.equal(head(repo), main);
  assert.deepEqual([status(repo), states(repo)], [[" M m.txt", "A  n.txt", "?? untracked.txt"], []]);
}

// An editor that fails, in the repository and in the environment: nothing waits for it.
{
  const repo = init();
  sh(repo, "git config core.editor false && git config sequence.editor false");
  const saved = process.env.GIT_EDITOR;
  process.env.GIT_EDITOR = "false";
  try {
    const r = await rebase(repo, { target: "side", options: ["--rebase-merges"] });
    assert.equal(r.outcome, "done", r.err);
  } finally {
    if (saved === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = saved;
  }
}

// Refused before anything runs: no target (and no --root), an option the dialog doesn't have.
{
  const repo = init(), main = head(repo);
  const none = await rebase(repo, { target: "" });
  assert.equal(none.outcome, "refused");
  assert.equal(none.msg.key, "merge.noTarget");
  const odd = await rebase(repo, { target: "side", options: ["--exec=true"] });
  assert.equal(odd.outcome, "refused");
  assert.equal(odd.msg.key, "merge.badOption");
  assert.equal(head(repo), main);
}

// ---- Checkout and Rebase onto the current branch

// A local branch: checked out and put on top of the current one.
{
  const repo = init();
  const r = await checkoutRebase(repo, { name: "feature", onto: "main" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(branch(repo), "feature");
  assert.deepEqual(subjects(repo), ["e1", "m1", "base"]);
  assert.deepEqual(subjects(repo, "main"), ["m1", "base"], "main stays");
}

// A remote branch with no local one: a local branch tracking it is made first.
{
  const repo = init();
  const remote = `${base}/remote${n}.git`;
  sh(base, `git init -q --bare ${remote}`);
  sh(repo, `git remote add origin ${remote} && git push -q origin feature && git branch -q -D feature`);
  const r = await checkoutRebase(repo, { name: "origin/feature", remote: true, onto: "main" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(branch(repo), "feature");
  assert.deepEqual(subjects(repo), ["e1", "m1", "base"]);
  assert.equal(sh(repo, "git rev-parse --abbrev-ref feature@{upstream}").trim(), "origin/feature");
}

// A remote branch whose local one exists: that one is rebased.
{
  const repo = init();
  const remote = `${base}/remote${n}.git`;
  sh(base, `git init -q --bare ${remote}`);
  sh(repo, `git remote add origin ${remote} && git push -q -u origin feature`);
  const r = await checkoutRebase(repo, { name: "origin/feature", remote: true, onto: "main" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(branch(repo), "feature");
  assert.deepEqual(subjects(repo), ["e1", "m1", "base"]);
}

// Local changes: refused with every tracked change; no branch made, HEAD where it was.
{
  const repo = init(), main = head(repo);
  const remote = `${base}/remote${n}.git`;
  sh(base, `git init -q --bare ${remote}`);
  sh(repo, `git remote add origin ${remote} && git push -q origin feature && git branch -q -D feature && echo mine > m.txt`);
  const r = await checkoutRebase(repo, { name: "origin/feature", remote: true, onto: "main" });
  assert.equal(r.outcome, "refused", r.err);
  assert.deepEqual(r.blocked, ["m.txt"]);
  assert.equal(branch(repo), "main");
  assert.equal(head(repo), main);
  assert.equal(sh(repo, "git branch --list feature").trim(), "", "no branch made");
  const local = init();
  sh(local, "echo mine > m.txt");
  const l = await checkoutRebase(local, { name: "feature", onto: "main" });
  assert.equal(l.outcome, "refused", l.err);
  assert.deepEqual(l.blocked, ["m.txt"]);
  assert.equal(branch(local), "main");
}

// A conflict stops with the checked-out branch's rebase in progress.
{
  const repo = init();
  const r = await checkoutRebase(repo, { name: "clash", onto: "main" });
  assert.equal(r.outcome, "stopped");
  assert.equal(r.operation.kind, "rebase");
  assert.equal(r.operation.rebasing, "clash");
}

// Refused before anything runs: no branch, nothing to rebase onto, a remote name that isn't one.
{
  const repo = init();
  assert.equal((await checkoutRebase(repo, { name: "", onto: "main" })).msg.key, "merge.noTarget");
  assert.equal((await checkoutRebase(repo, { name: "feature", onto: "" })).msg.key, "merge.noTarget");
  const odd = await checkoutRebase(repo, { name: "nowhere/feature", remote: true, onto: "main" });
  assert.equal(odd.outcome, "failed");
  assert.equal(odd.msg.key, "log.notRemoteBranch");
  assert.equal(branch(repo), "main");
}

console.log("ok");
