// node git-operation.test.mjs: reading the operation in progress, Continue, Abort and Skip
// against throwaway repositories (no app needed). Each operation is started with plain git,
// the way a terminal would, and every check reads the repository back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readOperation, continueOperation, abortOperation, skipOperation, operationName } from "./git-operation.js";
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
  assert.equal(there.branch, "linked");
  assert.equal(here.branch, "main");
}

// What a merge merges in is named as the person chose it, and what a rebase goes onto by
// its local branch first, even when a remote branch and a tag sit on the same commit.
{
  const twins = (name) => {
    const repo = init(name);
    sh(repo, "git update-ref refs/remotes/origin/side side && git tag aa-side side && git update-ref refs/remotes/origin/main main && git tag aa-main main");
    return repo;
  };
  const local = twins("target-local");
  start(local, "git merge side");
  assert.equal((await quietly(local)).target, "side");
  const remote = twins("target-remote");
  start(remote, "git merge origin/side");
  assert.equal((await quietly(remote)).target, "origin/side");
  const tag = twins("target-tag");
  start(tag, "git merge aa-side");
  assert.equal((await quietly(tag)).target, "aa-side");
  // Merged by its hash: the commit's local branch.
  const byHash = twins("target-hash");
  start(byHash, `git merge ${hash(byHash, "side")}`);
  assert.equal((await quietly(byHash)).target, "side");
  const rebase = twins("target-rebase");
  start(rebase, "git checkout -q side && git rebase main");
  assert.equal((await quietly(rebase)).target, "main");
}

// The name the VCS widget and the Commit panel give an operation in progress: the branch
// it happens on (a rebase: the branch it rewrites), in both languages.
{
  const en = translator("en"), ko = translator("ko");
  const says = (op, opts) => { const n = operationName(op, opts); return [en(n.key, n.args), ko(n.key, n.args)]; };

  const merge = init("name-merge");
  start(merge, "git merge side");
  let r = await quietly(merge);
  assert.equal(r.branch, "main");
  assert.deepEqual(says(r), ["Merging main", "main 병합 중"]);

  const rebase = init("name-rebase");
  start(rebase, "git checkout -q side && git rebase main");
  r = await quietly(rebase);
  assert.equal(r.branch, null, "a rebase runs on a detached HEAD");
  assert.deepEqual(says(r), ["Rebasing side", "side 리베이스 중"]);
  assert.deepEqual(says(r, { step: true }), ["Rebasing side (1/2)", "side 리베이스 중 (1/2)"]);

  const pick = init("name-pick");
  start(pick, "git cherry-pick side~1");
  assert.deepEqual(says(await quietly(pick)), ["Cherry-picking in main", "main에서 체리픽 중"]);

  const revert = init("name-revert");
  start(revert, "printf 'two\\n' > f.txt && git commit -q -am two && git revert --no-edit HEAD~1");
  assert.deepEqual(says(await quietly(revert)), ["Reverting in main", "main에서 되돌리는 중"]);

  // Started on a detached HEAD: the commit it started on, short.
  const loose = init("name-detached");
  const at = hash(loose, "main").slice(0, 7);
  start(loose, "git checkout -q --detach main && git merge side");
  assert.deepEqual(says(await quietly(loose)), [`Merging ${at}`, `${at} 병합 중`]);
  assert.equal(operationName({ kind: null }), null);
}

// ---- Continue, Abort, Skip

const where = (repo) => ({ head: head(repo), branch: branch(repo), states: states(repo), status: status(repo) });
const parents = (repo) => sh(repo, "git rev-list --parents -n 1 HEAD").trim().split(" ").length - 1;
const body = (repo) => { const raw = sh(repo, "git cat-file commit HEAD"); return raw.slice(raw.indexOf("\n\n") + 2); };
const resolve = (repo, text = "done") => sh(repo, `printf '${text}\\n' > f.txt && git add f.txt`);

// Continue while a file is still in conflict changes nothing and says why.
for (const [name, cmd] of [["merge", "git merge side"], ["rebase", "git checkout -q side && git rebase main"], ["pick", "git cherry-pick side~1"]]) {
  const repo = init(`continue-early-${name}`);
  start(repo, cmd);
  const before = where(repo);
  const r = await continueOperation(git, repo, { message: "x" });
  assert.equal(r.ok, false, name);
  assert.equal(r.outcome, "refused", name);
  assert.deepEqual(r.msg, { key: "ops.conflictsLeft", args: { n: 1 } }, name);
  assert.equal(translator("en")(r.msg.key, r.msg.args), r.err);
  assert.deepEqual(where(repo), before, name);
}

// Continue a merge: one commit with both parents and the given message. A change the
// merge never touched stays in the work tree; a checked one goes into the commit.
{
  const repo = init("continue-merge");
  sh(repo, "echo mine > g.txt && echo new > u.txt");
  start(repo, "git merge side");
  resolve(repo);
  const r = await continueOperation(git, repo, { message: "merged by hand\n\n#42 stays", files: [{ path: "u.txt", status: "unversioned" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "done");
  assert.equal(r.operation.kind, null);
  assert.equal(parents(repo), 2);
  assert.equal(body(repo), "merged by hand\n\n#42 stays\n");
  assert.deepEqual(lines(sh(repo, "git show --format= --name-only HEAD --first-parent")).sort(), ["f.txt", "h.txt", "u.txt"]);
  assert.deepEqual(where(repo).states, []);
  assert.deepEqual(status(repo), [" M g.txt"]);
}

// Without a message of its own, Continue commits the operation's (here a cherry-pick's
// original message), and a sequence goes on to the end.
{
  const repo = init("continue-pick-several");
  start(repo, "git cherry-pick side side~1");
  resolve(repo);
  const r = await continueOperation(git, repo, {});
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["s1", "s2", "m", "base"]);
  assert.deepEqual(states(repo), []);
}
{
  const repo = init("continue-revert-several");
  start(repo, "echo k > k.txt && git add k.txt && git commit -q -m n && printf 'two\\n' > f.txt && git commit -q -am two && git revert --no-edit HEAD~1 HEAD~2");
  resolve(repo);
  const r = await continueOperation(git, repo, {});
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ['Revert "m"', 'Revert "n"', "two", "n", "m", "base"]);
  assert.deepEqual(states(repo), []);
}

// A rebase goes on to the end, on its branch, each commit with its own message; one
// changed in the box is the one recorded.
{
  const repo = init("continue-rebase");
  start(repo, "git checkout -q side && git rebase main");
  resolve(repo);
  const r = await continueOperation(git, repo, { message: "s1" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual([branch(repo), subjects(repo), states(repo)], ["side", ["s2", "s1", "m", "base"], []]);

  const again = init("continue-rebase-message");
  start(again, "git checkout -q side && git rebase main");
  resolve(again);
  const said = await continueOperation(git, again, { message: "s1, fixed\n\n#42 and \"quotes\" $HOME" });
  assert.equal(said.outcome, "done", said.err);
  assert.equal(sh(again, "git log -1 --format=%B side~1"), "s1, fixed\n\n#42 and \"quotes\" $HOME\n\n");
  assert.deepEqual(subjects(again), ["s2", "s1, fixed", "m", "base"]);

  // A repository set to strip comment lines keeps the "#" line too, for a cherry-pick's
  // commit as for the rebase's.
  const strip = init("continue-pick-strip");
  sh(strip, "git config commit.cleanup strip");
  start(strip, "git cherry-pick side~1");
  resolve(strip);
  const picked = await continueOperation(git, strip, { message: "s1 here\n\n#42" });
  assert.equal(picked.outcome, "done", picked.err);
  assert.equal(sh(strip, "git log -1 --format=%B"), "s1 here\n\n#42\n\n");
}

// A message changed at a stopped pick is that commit's alone: a squash later in the plan
// still gets its own message added. At a stopped squash, the changed message is the
// combined commit's, and the plan's commits stay one commit.
{
  const plan = (repo, edit) => start(repo, `git checkout -q side && printf 'x\\n' > x.txt && git add x.txt && git commit -q -m 'x message' && GIT_SEQUENCE_EDITOR="sed -i.bak -e '${edit}'" git rebase -i main`);
  const picked = init("continue-rebase-then-squash");
  // [pick s1 (stops), pick s2, squash x]
  plan(picked, "3s/^pick/squash/");
  resolve(picked);
  const r = await continueOperation(git, picked, { message: "s1 edited" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(picked), ["s2", "s1 edited", "m", "base"]);
  assert.equal(sh(picked, "git log -1 --format=%B side"), "s2\n\nx message\n\n");

  const squashed = init("continue-rebase-squash-stop");
  // [pick x, squash s1 (stops), pick s2]
  writeFileSync(`${squashed}/.git/reorder.sh`, "t=$(grep -v '^#' \"$1\")\n{ echo \"$t\" | sed -n 3p; echo \"$t\" | sed -n 1p | sed 's/^pick/squash/'; echo \"$t\" | sed -n 2p; } > \"$1\"\n");
  start(squashed, "git checkout -q side && printf 'x\\n' > x.txt && git add x.txt && git commit -q -m 'x message' && GIT_SEQUENCE_EDITOR='sh .git/reorder.sh' git rebase -i main");
  assert.equal(sh(squashed, "git rev-parse -q --verify REBASE_HEAD >/dev/null && echo stopped || true").trim(), "stopped");
  resolve(squashed);
  const s = await continueOperation(git, squashed, { message: "together" });
  assert.equal(s.outcome, "done", s.err);
  assert.deepEqual(subjects(squashed), ["s2", "together", "m", "base"]);
}

// A message changed at a stopped pick keeps the commit's author and author date: someone
// else's commit stays theirs.
{
  const repo = init("continue-rebase-author");
  start(repo, `git checkout -q -b al main~1 && printf 'al\\n' > f.txt && GIT_AUTHOR_NAME="Al'ice" GIT_AUTHOR_EMAIL=a@x GIT_AUTHOR_DATE="@1600000000 +0200" git commit -q -am al && git rebase main`);
  assert.equal(sh(repo, "git rev-parse -q --verify REBASE_HEAD >/dev/null && echo stopped || true").trim(), "stopped");
  resolve(repo);
  const r = await continueOperation(git, repo, { message: "al edited" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["al edited", "m", "base"]);
  assert.equal(sh(repo, "git log -1 --format='%an|%ae|%ad' --date=raw").trim(), "Al'ice|a@x|1600000000 +0200");
}

// At an edit stop the changed message goes to the stopped commit itself (amended, with
// what is staged), so the plan keeps its number of commits; nothing staged still goes on.
for (const staged of [true, false]) {
  const repo = init(`continue-rebase-edit-${staged ? "staged" : "bare"}`);
  start(repo, `git checkout -q -b ed main && echo c > c.txt && git add c.txt && git commit -q -m C && GIT_SEQUENCE_EDITOR="sed -i.bak -e '1s/^pick/edit/'" git rebase -i main~1`);
  assert.equal(sh(repo, "git log -1 --format=%s").trim(), "m");
  if (staged) sh(repo, "printf 'more\\n' > f.txt && git add f.txt");
  const r = await continueOperation(git, repo, { message: "m edited" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual([subjects(repo), states(repo), status(repo)], [["C", "m edited", "base"], [], []]);
  assert.equal(sh(repo, "git show HEAD~1:f.txt"), staged ? "more\n" : "main\n");
}

// A rebase that stops again at the next commit: stopped, with where it is now.
{
  const repo = init("continue-rebase-stops");
  sh(repo, "git checkout -q side && printf 'side again\\n' > f.txt && git commit -q -am s3 && git checkout -q main");
  start(repo, "git checkout -q side && git rebase main");
  resolve(repo);
  const r = await continueOperation(git, repo, {});
  assert.equal(r.ok, true, r.err);
  assert.equal(r.outcome, "stopped");
  assert.equal(r.operation.kind, "rebase");
  assert.equal(r.operation.current.subject, "s3");
  assert.deepEqual(r.operation.step, { n: 3, total: 3 });
}

// A cherry-pick resolved to what HEAD already has: nothing to commit, so it is skipped and
// nothing stays in progress.
{
  const repo = init("continue-empty");
  start(repo, "git cherry-pick side~1");
  resolve(repo, "main");
  const r = await continueOperation(git, repo, {});
  assert.equal(r.outcome, "empty", r.err);
  assert.deepEqual([subjects(repo), states(repo), status(repo)], [["m", "base"], [], []]);
}

// Continue never waits for an editor, even where the repository's editor and GIT_EDITOR
// are a command that fails.
{
  const saved = process.env.GIT_EDITOR;
  process.env.GIT_EDITOR = "false";
  try {
    for (const [name, cmd] of [["merge", "git merge side"], ["rebase", "git checkout -q side && git rebase main"], ["revert", "printf 'two\\n' > f.txt && git commit -q -am two && git revert --no-edit HEAD~1"]]) {
      const repo = init(`editor-${name}`);
      sh(repo, "git config core.editor false");
      start(repo, cmd);
      resolve(repo);
      const r = await continueOperation(git, repo, {});
      assert.equal(r.outcome, "done", `${name}: ${r.err}`);
      assert.deepEqual(states(repo), [], name);
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_EDITOR;
    else process.env.GIT_EDITOR = saved;
  }
}

// Abort goes back to where the operation started: HEAD and branch. A change the merge
// never touched stays.
{
  const repo = init("abort-merge");
  sh(repo, "echo mine > g.txt");
  const before = { head: head(repo), branch: branch(repo) };
  start(repo, "git merge side");
  const r = await abortOperation(git, repo);
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual({ head: head(repo), branch: branch(repo) }, before);
  assert.deepEqual([states(repo), status(repo)], [[], [" M g.txt"]]);

  const rebase = init("abort-rebase");
  sh(rebase, "git checkout -q side");
  const was = head(rebase);
  start(rebase, "git rebase main");
  assert.equal((await abortOperation(git, rebase)).outcome, "done");
  assert.deepEqual([head(rebase), branch(rebase), states(rebase)], [was, "side", []]);

  // Several cherry-picks: the one already made is taken back too.
  const picks = init("abort-picks");
  const at = head(picks);
  start(picks, "git cherry-pick side side~1");
  assert.notEqual(head(picks), at);
  assert.equal((await abortOperation(git, picks)).outcome, "done");
  assert.deepEqual([head(picks), states(picks), status(picks)], [at, [], []]);

  const none = init("abort-none");
  const no = await abortOperation(git, none);
  assert.deepEqual([no.ok, no.outcome, no.msg], [false, "refused", { key: "ops.nothingToAbort" }]);
}

// Skip leaves out the stopped commit only: the rest of the rebase or the sequence goes on.
{
  const repo = init("skip-rebase");
  start(repo, "git checkout -q side && git rebase main");
  const r = await skipOperation(git, repo);
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual([branch(repo), subjects(repo), states(repo)], ["side", ["s2", "m", "base"], []]);

  const picks = init("skip-picks");
  start(picks, "git cherry-pick side~1 side");
  assert.equal((await skipOperation(git, picks)).outcome, "done");
  assert.deepEqual([subjects(picks), states(picks)], [["s2", "m", "base"], []]);

  const reverts = init("skip-reverts");
  start(reverts, "echo k > k.txt && git add k.txt && git commit -q -m n && printf 'two\\n' > f.txt && git commit -q -am two && git revert --no-edit HEAD~2 HEAD~1");
  assert.equal((await skipOperation(git, reverts)).outcome, "done");
  assert.deepEqual([subjects(reverts), states(reverts)], [['Revert "n"', "two", "n", "m", "base"], []]);

  // One cherry-pick has nothing after it to go on to: Skip isn't offered.
  const one = init("skip-one");
  start(one, "git cherry-pick side~1");
  const before = where(one);
  const no = await skipOperation(git, one);
  assert.deepEqual([no.ok, no.outcome, no.msg], [false, "refused", { key: "ops.nothingToSkip" }]);
  assert.deepEqual(where(one), before);
}

// git can't be reached: a result with the reason, not an exception.
{
  const down = await readOperation(makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps"), "/repo");
  assert.equal(down.ok, false);
  assert.match(down.err, /unreachable/);
}

console.log("ok");
