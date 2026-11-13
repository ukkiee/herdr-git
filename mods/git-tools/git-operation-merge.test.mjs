// node git-operation-merge.test.mjs: a merge started through runOperation ({ type: "merge" })
// against throwaway repositories: each option, a branch and a hash, a conflict, local changes
// in the way. Every check reads the repository back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { runOperation, requestProblem } from "./git-operation.js";

// The person's own git settings (an editor, gpgSign, hooks path) stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-merge-`));
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
const status = (repo) => lines(sh(repo, "git status --porcelain --untracked-files=all"));
const parents = (repo) => sh(repo, "git log -1 --format=%P").trim().split(" ").filter(Boolean).length;
const subject = (repo) => sh(repo, "git log -1 --format=%s").trim();
const states = (repo) => lines(sh(repo, "for n in MERGE_HEAD SQUASH_MSG rebase-merge; do p=$(git rev-parse --git-path $n); [ -e \"$p\" ] && echo $n; done; true"));
const merge = (repo, args) => runOperation(git, repo, { type: "merge", ...args });

// main: base → m1 (m.txt). side, from base: s1 (s.txt). clash, from base: c1 (f.txt "clash").
// ahead, from m1: a1 (a.txt), so main fast-forwards to it.
let n = 0;
const init = () => {
  const repo = `${base}/r${n++}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo base > f.txt && git add -A && git commit -q -m base
git checkout -q -b side && echo s > s.txt && git add -A && git commit -q -m s1
git checkout -q -b clash main && echo clash > f.txt && git commit -q -am c1
git checkout -q main && echo m > m.txt && echo main > f.txt && git add -A && git commit -q -m m1
git checkout -q -b ahead && echo a > a.txt && git add -A && git commit -q -m a1 && git checkout -q main`);
  return repo;
};

// A branch: one merge commit with git's message, both parents.
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "side" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(r.ok, true);
  assert.equal(parents(repo), 2);
  assert.equal(hash(repo, "HEAD^1"), main);
  assert.equal(hash(repo, "HEAD^2"), hash(repo, "side"));
  assert.equal(subject(repo), "Merge branch 'side'");
  assert.deepEqual(status(repo), []);
  assert.equal(r.operation.kind, null);
}

// A hash merges that commit.
{
  const repo = init();
  const r = await merge(repo, { target: hash(repo, "side") });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(hash(repo, "HEAD^2"), hash(repo, "side"));
}

// --ff-only: moves when it can, fails with git's words and changes nothing when it can't.
{
  const repo = init();
  const r = await merge(repo, { target: "ahead", options: ["--ff-only"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(repo), hash(repo, "ahead"));
}
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "side", options: ["--ff-only"] });
  assert.equal(r.outcome, "failed");
  assert.equal(r.ok, false);
  assert.ok(r.err.trim(), "git's words");
  assert.equal(r.msg, undefined, "git's own words, not the mod's");
  assert.equal(head(repo), main);
  assert.deepEqual([status(repo), states(repo)], [[], []]);
}

// --no-ff: a merge commit even when main could fast-forward.
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "ahead", options: ["--no-ff"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(parents(repo), 2);
  assert.equal(hash(repo, "HEAD^1"), main);
}

// --squash: no commit, the changes staged, nothing in progress.
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "side", options: ["--squash"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(repo), main);
  assert.deepEqual(status(repo), ["A  s.txt"]);
  assert.equal(r.operation.kind, null);
}

// -m: the message given; without one nothing runs.
{
  const repo = init();
  const r = await merge(repo, { target: "side", options: ["-m"], message: "Bring in side\n\nwith $HOME and \"quotes\"" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(sh(repo, "git log -1 --format=%B").trim(), "Bring in side\n\nwith $HOME and \"quotes\"");
}
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "side", options: ["-m"], message: "  " });
  assert.equal(r.outcome, "refused");
  assert.equal(r.msg.key, "commit.noMessage");
  assert.equal(head(repo), main);
}

// --no-commit: merged and stopped before the commit; the merge is in progress.
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "side", options: ["--no-commit"] });
  assert.equal(r.outcome, "stopped", r.err);
  assert.equal(r.operation.kind, "merge");
  assert.deepEqual(r.operation.conflicts, []);
  assert.equal(r.operation.canContinue, true);
  assert.equal(head(repo), main);
  assert.deepEqual(status(repo), ["A  s.txt"]);
}

// --no-verify: a pre-merge-commit hook that says no stops the merge without it.
{
  const repo = init(), main = head(repo);
  writeFileSync(`${repo}/.git/hooks/pre-merge-commit`, "#!/bin/sh\nexit 1\n");
  chmodSync(`${repo}/.git/hooks/pre-merge-commit`, 0o755);
  const no = await merge(repo, { target: "side" });
  assert.notEqual(no.outcome, "done");
  assert.equal(head(repo), main);
  sh(repo, "git merge --abort 2>/dev/null; git reset -q --hard");
  const r = await merge(repo, { target: "side", options: ["--no-verify"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(parents(repo), 2);
}

// --allow-unrelated-histories: a branch with no commit in common.
{
  const repo = init(), main = head(repo);
  sh(repo, "git checkout -q --orphan other && git rm -rq --cached . && echo o > o.txt && git add o.txt && git commit -q -m o1 && git clean -fdq && git checkout -q main");
  const no = await merge(repo, { target: "other" });
  assert.equal(no.outcome, "failed");
  assert.equal(head(repo), main);
  const r = await merge(repo, { target: "other", options: ["--allow-unrelated-histories"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(hash(repo, "HEAD^2"), hash(repo, "other"));
}

// A conflict stops with the merge in progress and the file in conflict.
{
  const repo = init();
  const r = await merge(repo, { target: "clash" });
  assert.equal(r.outcome, "stopped");
  assert.equal(r.ok, true);
  assert.equal(r.operation.kind, "merge");
  assert.equal(r.operation.target, "clash");
  assert.deepEqual(r.operation.conflicts.map((c) => c.path), ["f.txt"]);
}

// Local changes in the way: refused with the file, nothing changed.
{
  const repo = init(), main = head(repo);
  sh(repo, "echo mine > f.txt");
  const r = await merge(repo, { target: "clash" });
  assert.equal(r.outcome, "refused", r.err);
  assert.deepEqual(r.blocked, ["f.txt"]);
  assert.equal(head(repo), main);
  assert.deepEqual([status(repo), states(repo)], [[" M f.txt"], []]);
}
// The same where the repository stashes by itself (merge.autoStash): no stash is left.
{
  const repo = init(), main = head(repo);
  sh(repo, "git config merge.autoStash true && echo mine > f.txt");
  const r = await merge(repo, { target: "clash" });
  assert.equal(r.outcome, "refused", r.err);
  assert.equal(head(repo), main);
  assert.deepEqual([status(repo), states(repo), sh(repo, "git stash list")], [[" M f.txt"], [], ""]);
}

// An editor that fails, set in the repository: the merge doesn't wait for it.
{
  const repo = init();
  sh(repo, "git config core.editor false");
  const r = await merge(repo, { target: "side", options: ["--no-ff"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(subject(repo), "Merge branch 'side'");
}

// Refused before anything runs: no branch, an option the dialog doesn't have.
{
  const repo = init(), main = head(repo);
  const none = await merge(repo, { target: " " });
  assert.equal(none.outcome, "refused");
  assert.equal(none.msg.key, "merge.noTarget");
  const odd = await merge(repo, { target: "side", options: ["--strategy=ours"] });
  assert.equal(odd.outcome, "refused");
  assert.equal(odd.msg.key, "merge.badOption");
  assert.equal(head(repo), main);
}

// What the dialogs turn their button off by: the same refusals, without a repository.
{
  assert.equal(requestProblem({ type: "merge", target: "side" }), null);
  assert.equal(requestProblem({ type: "merge", target: "" }).msg.key, "merge.noTarget");
  assert.equal(requestProblem({ type: "merge", target: "side", options: ["-m"] }).msg.key, "commit.noMessage");
  assert.equal(requestProblem({ type: "rebase", target: "" }).msg.key, "merge.noTarget");
  assert.equal(requestProblem({ type: "rebase", target: "", options: ["--root"] }), null);
  assert.equal(requestProblem({ type: "rebase", target: "main", options: ["--interactive"] }).msg.key, "merge.badOption");
  assert.equal(requestProblem({ type: "continue" }).msg.key, "ops.unknownRequest");
}

// A name that looks like an option is taken as a name.
{
  const repo = init(), main = head(repo);
  const r = await merge(repo, { target: "--no-ff" });
  assert.equal(r.outcome, "failed");
  assert.equal(head(repo), main);
}

console.log("ok");
