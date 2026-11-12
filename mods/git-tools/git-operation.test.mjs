// node git-operation.test.mjs: reading the operation in progress, Continue, Abort and Skip
// against throwaway repositories (no app needed). Each operation is started with plain git,
// the way a terminal would, and every check reads the repository back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readOperation, continueOperation, abortOperation, skipOperation } from "./git-operation.js";
import { translator } from "./i18n.js";

// The person's own git settings (an editor, gpgSign, hooks path) stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-operation-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
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
const subjects = (repo, range = "HEAD") => lines(sh(repo, `git log --format=%s ${range}`));
const states = (repo) => lines(sh(repo, "for n in MERGE_HEAD REVERT_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply sequencer; do p=$(git rev-parse --git-path $n); [ -e \"$p\" ] && echo $n; done; true"));

// main: base → m (f.txt "main") → n (adds k.txt) → two (f.txt "two").
// side, from base: s1 (f.txt "side") → s2 (adds h.txt).
// Each case starts from a fresh copy, on main at m unless it moves.
const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
printf 'base\\n' > f.txt && echo g > g.txt && git add -A && git commit -q -m base
git checkout -q -b side && printf 'side\\n' > f.txt && git commit -q -am s1 && echo h > h.txt && git add h.txt && git commit -q -m s2
git checkout -q main && printf 'main\\n' > f.txt && git commit -q -am m`);
  return repo;
};
const start = (repo, cmd) => sh(repo, `${cmd} >/dev/null 2>&1 || true`);

// Every file under the git folder, with its bytes and modification time.
const snapshot = (dir) => {
  const out = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const p = `${at}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p).toString("base64")}`;
    }
  };
  walk(dir);
  return out;
};
// Reading changes nothing under .git, in any state.
const quietly = async (repo, root = repo) => {
  const dir = sh(repo, "git rev-parse --git-common-dir").trim();
  const before = snapshot(dir.startsWith("/") ? dir : `${repo}/${dir}`);
  const r = await readOperation(git, root);
  assert.deepEqual(snapshot(dir.startsWith("/") ? dir : `${repo}/${dir}`), before, "reading writes nothing under .git");
  return r;
};

const UU = { path: "f.txt", xy: "UU", ours: "modified", theirs: "modified" };

// ---- reading

// Nothing in progress.
{
  const repo = init("none");
  const r = await quietly(repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.kind, null);
  assert.deepEqual([r.conflicts, r.canContinue, r.canSkip], [[], false, false]);
}

// A merge stopped by a conflict: what it merges, the file in conflict, the file it brought
// in (staged), and the message without git's comment lines.
{
  const repo = init("merge");
  start(repo, "git merge side");
  const r = await quietly(repo);
  assert.equal(r.kind, "merge");
  assert.equal(r.target, "side");
  assert.deepEqual(r.current, { hash: hash(repo, "side"), subject: "s2", author: "t" });
  assert.deepEqual(r.conflicts, [UU]);
  assert.deepEqual(r.staged, ["h.txt"]);
  assert.equal(r.message, "Merge branch 'side'");
  assert.deepEqual([r.sequence, r.step, r.canContinue, r.canSkip], [false, null, false, false]);
  // Resolved: Continue can run.
  sh(repo, "echo done > f.txt && git add f.txt");
  const resolved = await quietly(repo);
  assert.deepEqual([resolved.conflicts, resolved.canContinue], [[], true]);
  assert.deepEqual(resolved.staged, ["f.txt", "h.txt"]);
}

// A rebase stopped by a conflict, both backends: the branch being rebased, what it goes
// onto, the commit being replayed, and how far it got.
for (const backend of ["merge", "apply"]) {
  const repo = init(`rebase-${backend}`);
  start(repo, `git checkout -q side && git rebase ${backend === "apply" ? "--apply " : ""}main`);
  const r = await quietly(repo);
  assert.equal(r.kind, "rebase", backend);
  assert.equal(r.target, "main", backend);
  assert.equal(r.rebasing, "side", backend);
  assert.deepEqual(r.current, { hash: hash(repo, "side~1"), subject: "s1", author: "t" }, backend);
  assert.deepEqual(r.step, { n: 1, total: 2 }, backend);
  assert.deepEqual(r.conflicts, [UU], backend);
  assert.equal(r.message, "s1", backend);
  assert.deepEqual([r.canContinue, r.canSkip], [false, true], backend);
}

// Cherry-pick, one commit and several: the several ones say so (Skip goes on to the rest).
{
  const one = init("pick-one");
  start(one, "git cherry-pick side~1");
  let r = await quietly(one);
  assert.equal(r.kind, "cherry-pick");
  assert.deepEqual(r.current, { hash: hash(one, "side~1"), subject: "s1", author: "t" });
  assert.deepEqual(r.conflicts, [UU]);
  assert.equal(r.message, "s1");
  assert.deepEqual([r.sequence, r.canSkip], [false, false]);

  const several = init("pick-several");
  start(several, "git cherry-pick side side~1");
  r = await quietly(several);
  assert.equal(r.kind, "cherry-pick");
  assert.equal(r.current.subject, "s1");
  assert.deepEqual([r.sequence, r.canSkip], [true, true]);
}

// Revert, one commit and several.
{
  const one = init("revert-one");
  start(one, "printf 'two\\n' > f.txt && git commit -q -am two && git revert --no-edit HEAD~1");
  let r = await quietly(one);
  assert.equal(r.kind, "revert");
  assert.deepEqual(r.current, { hash: hash(one, "HEAD~1"), subject: "m", author: "t" });
  assert.deepEqual(r.conflicts, [UU]);
  assert.equal(r.message, `Revert "m"\n\nThis reverts commit ${hash(one, "HEAD~1")}.`);
  assert.deepEqual([r.sequence, r.canSkip], [false, false]);

  const several = init("revert-several");
  start(several, "echo k > k.txt && git add k.txt && git commit -q -m n && printf 'two\\n' > f.txt && git commit -q -am two && git revert --no-edit HEAD~1 HEAD~2");
  r = await quietly(several);
  assert.equal(r.kind, "revert");
  assert.equal(r.current.subject, "m");
  assert.deepEqual([r.sequence, r.canSkip], [true, true]);
}

// The sides of a conflict: deleted by us, deleted by them, added by both.
{
  const repo = init("sides");
  sh(repo, `git checkout -q -b other main && echo o > ours-gone.txt && echo t > theirs-gone.txt && git add -A && git commit -q -m add
git checkout -q -b a && git rm -q ours-gone.txt && echo a > theirs-gone.txt && echo a > both-new.txt && git add -A && git commit -q -m a
git checkout -q other && echo b > ours-gone.txt && git rm -q theirs-gone.txt && echo b > both-new.txt && git add -A && git commit -q -m b
git checkout -q a`);
  start(repo, "git merge other");
  const r = await quietly(repo);
  assert.deepEqual(r.conflicts, [
    { path: "both-new.txt", xy: "AA", ours: "added", theirs: "added" },
    { path: "ours-gone.txt", xy: "DU", ours: "deleted", theirs: "modified" },
    { path: "theirs-gone.txt", xy: "UD", ours: "modified", theirs: "deleted" },
  ]);
}

// A stash pop that conflicts leaves no operation behind: nothing in progress, files in
// conflict, nothing to continue.
{
  const repo = init("unstash");
  start(repo, "printf 'mine\\n' > f.txt && git stash -q && git checkout -q side && git stash pop");
  const r = await quietly(repo);
  assert.equal(r.kind, null);
  assert.deepEqual(r.conflicts, [UU]);
  assert.deepEqual([r.canContinue, r.canSkip], [false, false]);
}

// A linked worktree has its own operation: a merge there shows there, not in the main one.
{
  const repo = init("worktree");
  const linked = `${base}/worktree-linked`;
  sh(repo, `git worktree add -q -b linked "${linked}" main`);
  start(linked, "git merge side");
  const there = await quietly(repo, linked);
  assert.equal(there.kind, "merge");
  assert.equal(there.target, "side");
  assert.deepEqual(there.conflicts, [UU]);
  const here = await quietly(repo);
  assert.equal(here.kind, null);
}

// git can't be reached: a result with the reason, not an exception.
{
  const down = await readOperation(makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps"), "/repo");
  assert.equal(down.ok, false);
  assert.match(down.err, /unreachable/);
}

console.log("ok");
