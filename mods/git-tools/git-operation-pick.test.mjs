// node git-operation-pick.test.mjs: Cherry-Pick and Revert Commit as git-operation.js
// requests, against throwaway repositories (no app needed). Every check reads the
// repository back with git: the commits made, their messages and authors, what is left in
// progress.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { runOperation, skipOperation } from "./git-operation.js";
import { readEditFacts } from "./git-rewrite.js";
import { menuItems } from "./log-menus.js";

// The person's own git settings (an editor, gpgSign, hooks path) stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-pick-`));
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
const status = (repo) => lines(sh(repo, "git status --porcelain --untracked-files=all"));
const subjects = (repo, range = "HEAD") => lines(sh(repo, `git log --format=%s ${range}`));
const states = (repo) => lines(sh(repo, "for n in MERGE_HEAD REVERT_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply sequencer; do p=$(git rev-parse --git-path $n); [ -e \"$p\" ] && echo $n; done; true"));
const message = (repo, rev = "HEAD") => sh(repo, `git log -1 --format=%B ${rev}`).replace(/\s+$/, "");
const author = (repo, rev = "HEAD") => sh(repo, `git log -1 --format='%an <%ae>' ${rev}`).trim();
const text = (repo, path) => sh(repo, `cat ${path}`);

// main: base (f.txt, g.txt) → m (f.txt "main").
// side, from base, by Ann: s1 (adds a.txt, with a body) → s2 (adds b.txt) → s3 (f.txt
// "side", which meets main's f.txt).
// The repository's own user is Tom, so a commit made by the request is told from one
// that kept its author.
const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email tom@t && git config user.name Tom
printf 'base\\n' > f.txt && echo g > g.txt && git add -A && git commit -q -m base
git checkout -q -b side
export GIT_AUTHOR_NAME=Ann GIT_AUTHOR_EMAIL=ann@t
echo a > a.txt && git add a.txt && git commit -q -m s1 -m 'the body of s1'
echo b > b.txt && git add b.txt && git commit -q -m s2
printf 'side\\n' > f.txt && git commit -q -am s3
git checkout -q main && printf 'main\\n' > f.txt && git commit -q -am m`);
  return repo;
};

// ---- Cherry-Pick

// One commit: committed at once with its own message and author, no "cherry picked
// from" line.
{
  const repo = init("pick-one");
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side~2")] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(r.ok, true);
  assert.deepEqual(subjects(repo), ["s1", "m", "base"]);
  assert.equal(message(repo), "s1\n\nthe body of s1");
  assert.equal(author(repo), "Ann <ann@t>");
  assert.equal(text(repo, "a.txt"), "a\n");
  assert.deepEqual(states(repo), []);
  assert.deepEqual(status(repo), []);
}

// Several, picked newest first as the Commit list picks them: applied oldest first, a
// commit for each.
{
  const repo = init("pick-several");
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side~1"), hash(repo, "side~2")] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo), ["s2", "s1", "m", "base"]);
  assert.equal(author(repo, "HEAD~1"), "Ann <ann@t>");
  assert.deepEqual(states(repo), []);
}

// The last of three meets main's f.txt: the first two are committed and the pick stops
// on it. Skip drops it and nothing is left in progress.
{
  const repo = init("pick-stops");
  // side, side~1, side~2 newest first: s1, s2, s3 in that order; s3 stops.
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side"), hash(repo, "side~1"), hash(repo, "side~2")] });
  assert.equal(r.outcome, "stopped", r.err);
  assert.equal(r.operation.kind, "cherry-pick");
  assert.equal(r.operation.current.hash, hash(repo, "side"));
  assert.deepEqual(r.operation.conflicts.map((c) => c.path), ["f.txt"]);
  assert.deepEqual(subjects(repo), ["s2", "s1", "m", "base"]);
  const skipped = await skipOperation(git, repo);
  assert.equal(skipped.outcome, "done", skipped.err);
  assert.deepEqual(states(repo), []);
  assert.equal(text(repo, "f.txt"), "main\n");
}

// The commit that stops is in the middle: Skip goes on with the rest.
{
  const repo = init("pick-skip-middle");
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side~1"), hash(repo, "side"), hash(repo, "side~2")] });
  // Given s2, s3, s1: applied s1, s3 (stops), s2.
  assert.equal(r.outcome, "stopped", r.err);
  assert.equal(r.operation.sequence, true);
  const skipped = await skipOperation(git, repo);
  assert.equal(skipped.outcome, "done", skipped.err);
  assert.deepEqual(subjects(repo), ["s2", "s1", "m", "base"]);
  assert.deepEqual(states(repo), []);
}

// A commit whose changes are already in: nothing is committed and nothing is left in
// progress; the result says which commit it was.
{
  const repo = init("pick-empty");
  sh(repo, "echo a > a.txt && git add a.txt && git commit -q -m 'a here'");
  const before = head(repo);
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side~2")] });
  assert.equal(r.outcome, "empty", r.err);
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped, [hash(repo, "side~2")]);
  assert.equal(head(repo), before);
  assert.deepEqual(states(repo), []);
  assert.deepEqual(status(repo), []);
}

// An empty one among others: skipped, the others committed.
{
  const repo = init("pick-empty-among");
  sh(repo, "echo a > a.txt && git add a.txt && git commit -q -m 'a here'");
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side~1"), hash(repo, "side~2")] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(r.skipped, [hash(repo, "side~2")]);
  assert.deepEqual(subjects(repo), ["s2", "a here", "m", "base"]);
  assert.deepEqual(states(repo), []);
}

// A local change to a file the commit changes: refused, the file named, nothing moved.
{
  const repo = init("pick-refused");
  sh(repo, "echo mine > f.txt");
  const before = head(repo);
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side")] });
  assert.equal(r.outcome, "refused", r.err);
  assert.deepEqual(r.blocked, ["f.txt"]);
  assert.equal(head(repo), before);
  assert.equal(text(repo, "f.txt"), "mine\n");
  assert.deepEqual(states(repo), []);
}

// Something already in progress: refused before git runs, with the mod's words.
{
  const repo = init("pick-busy");
  sh(repo, "git merge side >/dev/null 2>&1 || true");
  const r = await runOperation(git, repo, { type: "cherry-pick", commits: [hash(repo, "side~2")] });
  assert.equal(r.outcome, "refused");
  assert.equal(r.msg.key, "pick.busy");
  assert.deepEqual(states(repo), ["MERGE_HEAD"]);
}

// No commit, or one that isn't a hash: refused.
{
  const repo = init("pick-none");
  for (const commits of [[], ["-x"], undefined]) {
    const r = await runOperation(git, repo, { type: "cherry-pick", commits });
    assert.equal(r.outcome, "refused");
    assert.equal(r.msg.key, "pick.noCommits");
  }
}

// ---- Revert Commit

// One commit: committed at once with git's message, by the person.
{
  const repo = init("revert-one");
  sh(repo, "git merge -q --no-edit side~1");
  const s1 = hash(repo, "side~2");
  const r = await runOperation(git, repo, { type: "revert", commits: [s1] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(message(repo), `Revert "s1"\n\nThis reverts commit ${s1}.`);
  assert.equal(author(repo), "Tom <tom@t>");
  assert.equal(sh(repo, "test -e a.txt && echo yes || echo no").trim(), "no");
  assert.deepEqual(states(repo), []);
}

// Several: newest first, a commit for each.
{
  const repo = init("revert-several");
  sh(repo, "git merge -q --no-edit side~1");
  const r = await runOperation(git, repo, { type: "revert", commits: [hash(repo, "side~1"), hash(repo, "side~2")] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(repo, "-2 HEAD"), ['Revert "s1"', 'Revert "s2"']);
}

// One that meets a later change stops, in progress, the file in conflict.
{
  const repo = init("revert-stops");
  sh(repo, "printf 'later\\n' > f.txt && git commit -q -am later");
  const r = await runOperation(git, repo, { type: "revert", commits: [hash(repo, "HEAD~1")] });
  assert.equal(r.outcome, "stopped", r.err);
  assert.equal(r.operation.kind, "revert");
  assert.deepEqual(r.operation.conflicts.map((c) => c.path), ["f.txt"]);
}

// ---- the menu items: on or off from the edit facts of the commits picked

// item(id, hashes) → the commit menu's item for the commits, with the facts git reads.
const item = async (repo, id, hashes, extra = {}) => {
  const facts = await readEditFacts(git, repo, hashes);
  assert.equal(facts.ok, true, facts.err);
  return menuItems("commit", new Set([id]), { count: hashes.length, edit: facts, ...extra })[0];
};
{
  const repo = init("menu");
  sh(repo, "git checkout -q -b merged side~2 && git merge -q --no-ff --no-edit side~1 && git checkout -q main");
  const s1 = hash(repo, "side~2"), m = hash(repo, "main"), merge = hash(repo, "merged");
  // Another branch's commit: both on.
  assert.equal((await item(repo, "commit.cherryPick", [s1])).disabled, false);
  assert.equal((await item(repo, "commit.revert", [s1])).disabled, false);
  // The current branch's own commit: Cherry-Pick off, Revert on.
  const own = await item(repo, "commit.cherryPick", [m]);
  assert.deepEqual([own.disabled, own.why], [true, { key: "pick.inBranch", args: { hash: m.slice(0, 8) } }]);
  assert.equal((await item(repo, "commit.cherryPick", [s1, m])).disabled, true, "one of several already in");
  assert.equal((await item(repo, "commit.revert", [m])).disabled, false);
  // A merge commit: both off.
  for (const id of ["commit.cherryPick", "commit.revert"]) {
    const it = await item(repo, id, [merge]);
    assert.deepEqual([it.disabled, it.why], [true, { key: "pick.mergeCommit" }], id);
  }
  // A write running: off with its words.
  assert.deepEqual((await item(repo, "commit.cherryPick", [s1], { writing: "Committing…" })).why, { text: "Committing…" });
  // Without facts (too many picked to read first): on; git decides.
  assert.equal(menuItems("commit", new Set(["commit.cherryPick"]), { count: 30 })[0].disabled, false);
  // The Log toolbar's button: off with nothing picked.
  assert.equal(menuItems("logTools", new Set(["log.cherryPick"]), { picked: 0 })[0].disabled, true);
  assert.equal(menuItems("logTools", new Set(["log.cherryPick"]), { picked: 2 })[0].disabled, false);
}

console.log("ok");
