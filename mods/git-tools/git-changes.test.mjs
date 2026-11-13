// node git-changes.test.mjs: Revert Selected Changes and Cherry-Pick Selected Changes
// (some files of a commit) against throwaway repositories (no app needed). Every check
// reads the repository back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { revertChanges, cherryPickChanges } from "./git-changes.js";

// The person's own git settings (an editor, gpgSign, hooks path) stay out of every repository here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-changes-`));
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
const states = (repo) => lines(sh(repo, "for n in MERGE_HEAD REVERT_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply sequencer; do p=$(git rev-parse --git-path $n); [ -e \"$p\" ] && echo $n; done; true"));
const message = (repo, rev = "HEAD") => sh(repo, `git log -1 --format=%B ${rev}`).replace(/\s+$/, "");
const author = (repo, rev = "HEAD") => sh(repo, `git log -1 --format='%an <%ae>' ${rev}`).trim();
const inCommit = (repo, rev = "HEAD") => lines(sh(repo, `git diff-tree --no-commit-id --name-status -r ${rev}`));
const text = (repo, path) => sh(repo, `cat ${path} 2>/dev/null || echo '(none)'`);

// main: base (a.txt, b.txt, c.txt, d.txt) → two, by Ann: changes a.txt and b.txt, adds
// n.txt, deletes d.txt.
// side, from base: s (changes a.txt and b.txt the same way as two, and adds s.txt).
// The repository's own user is Tom.
const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email tom@t && git config user.name Tom
for f in a b c d; do echo "$f" > $f.txt; done && git add -A && git commit -q -m base
git checkout -q -b side && echo a2 > a.txt && echo b2 > b.txt && echo s > s.txt && git add -A && git commit -q -m s
git checkout -q main
echo a2 > a.txt && echo b2 > b.txt && echo n > n.txt && git rm -q d.txt && git add -A
GIT_AUTHOR_NAME=Ann GIT_AUTHOR_EMAIL=ann@t git commit -q -m two -m 'the body of two'`);
  return repo;
};

// ---- Revert Selected Changes

// One file of the last commit: a new commit by the person puts that file back, the
// commit's other changes stay.
{
  const repo = init("revert-one");
  const two = head(repo);
  const r = await revertChanges(git, repo, { commit: two, paths: ["a.txt"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(r.ok, true);
  assert.equal(hash(repo, "HEAD~1"), two);
  assert.deepEqual(inCommit(repo), ["M\ta.txt"]);
  assert.equal(text(repo, "a.txt"), "a\n");
  assert.equal(text(repo, "b.txt"), "b2\n");
  assert.equal(author(repo), "Tom <tom@t>");
  assert.equal(message(repo), `Revert "two"\n\nThis reverts the changes to a.txt in commit ${two}.`);
  assert.deepEqual(status(repo), []);
  assert.deepEqual(states(repo), []);
}

// A file the commit added goes, one it deleted comes back; the person's other changes,
// staged or not, stay out of the commit and stay as they were.
{
  const repo = init("revert-add-delete");
  const two = head(repo);
  sh(repo, "echo mine > c.txt && git add c.txt && echo also > b.txt");
  const before = status(repo);
  const r = await revertChanges(git, repo, { commit: two, paths: ["n.txt", "d.txt"] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(inCommit(repo).sort(), ["A\td.txt", "D\tn.txt"]);
  assert.equal(text(repo, "d.txt"), "d\n");
  assert.equal(text(repo, "n.txt"), "(none)\n");
  assert.deepEqual(status(repo), before);
  assert.match(message(repo), /This reverts the changes to n\.txt, d\.txt in commit /);
}

// An older commit whose file was changed again since: the file is left in conflict,
// nothing is committed and no operation is in progress.
{
  const repo = init("revert-conflict");
  const two = head(repo);
  sh(repo, "echo a3 > a.txt && git commit -q -am three");
  const before = head(repo);
  const r = await revertChanges(git, repo, { commit: two, paths: ["a.txt", "b.txt"] });
  assert.equal(r.outcome, "stopped", r.err);
  assert.equal(r.ok, true);
  assert.deepEqual(r.conflicts, ["a.txt"]);
  assert.deepEqual(r.operation.conflicts.map((c) => c.path), ["a.txt"]);
  assert.equal(r.operation.kind, null);
  assert.equal(head(repo), before);
  assert.deepEqual(states(repo), []);
  assert.deepEqual(status(repo), ["UU a.txt", "M  b.txt"]);
}

// A local change to the file: refused, the file named, nothing changed.
{
  const repo = init("revert-refused");
  const two = head(repo);
  sh(repo, "echo mine > a.txt");
  const r = await revertChanges(git, repo, { commit: two, paths: ["a.txt"] });
  assert.equal(r.outcome, "refused", r.err);
  assert.deepEqual(r.blocked, ["a.txt"]);
  assert.equal(head(repo), two);
  assert.deepEqual(status(repo), [" M a.txt"]);
}

// A staged change to the file, even on another line: git would apply over it and the
// commit would take it in, so it is refused, the file named, nothing changed.
{
  const repo = init("revert-staged");
  const two = head(repo);
  sh(repo, "echo mine >> a.txt && git add a.txt");
  const r = await revertChanges(git, repo, { commit: two, paths: ["a.txt", "b.txt"] });
  assert.equal(r.outcome, "refused", r.err);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked, ["a.txt"]);
  assert.equal(r.msg?.key, "pick.stagedInWay");
  assert.equal(head(repo), two);
  assert.deepEqual(status(repo), ["M  a.txt"]);
}

// Files the commit didn't change, or already put back: nothing to do.
{
  const repo = init("revert-empty");
  const two = head(repo);
  const r = await revertChanges(git, repo, { commit: two, paths: ["c.txt"] });
  assert.equal(r.outcome, "empty", r.err);
  sh(repo, "echo a > a.txt && git commit -q -am back");
  const again = await revertChanges(git, repo, { commit: two, paths: ["a.txt"] });
  assert.equal(again.outcome, "empty", again.err);
  assert.equal(message(repo), "back");
  assert.deepEqual(status(repo), []);
}

// A file of the first commit (no parent): it goes.
{
  const repo = init("revert-first");
  const r = await revertChanges(git, repo, { commit: hash(repo, "main~1"), paths: ["c.txt"] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(inCommit(repo), ["D\tc.txt"]);
}

// Nothing asked: refused with the mod's words.
{
  const repo = init("revert-none");
  assert.equal((await revertChanges(git, repo, { commit: head(repo), paths: [] })).msg.key, "pick.noFiles");
  assert.equal((await revertChanges(git, repo, { commit: "-x", paths: ["a.txt"] })).msg.key, "pick.noCommits");
}

// ---- Cherry-Pick Selected Changes

// One file of another branch's commit: in the working tree and the index, not committed;
// the commit's other files stay out.
{
  const repo = init("pick-one");
  const before = head(repo);
  const r = await cherryPickChanges(git, repo, { commit: hash(repo, "side"), paths: ["s.txt"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(repo), before);
  assert.equal(text(repo, "s.txt"), "s\n");
  assert.deepEqual(status(repo), ["A  s.txt"]);
  assert.deepEqual(states(repo), []);
}

// The person's other changes stay as they were.
{
  const repo = init("pick-beside");
  sh(repo, "echo mine > c.txt && git add c.txt && echo also > b.txt");
  const r = await cherryPickChanges(git, repo, { commit: hash(repo, "side"), paths: ["s.txt"] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(status(repo), [" M b.txt", "M  c.txt", "A  s.txt"]);
}

// A file changed since: left in conflict, no operation in progress.
{
  const repo = init("pick-conflict");
  sh(repo, "echo a3 > a.txt && git commit -q -am three");
  const before = head(repo);
  const r = await cherryPickChanges(git, repo, { commit: hash(repo, "main~1"), paths: ["a.txt"] });
  assert.equal(r.outcome, "stopped", r.err);
  assert.deepEqual(r.conflicts, ["a.txt"]);
  assert.equal(r.operation.kind, null);
  assert.equal(head(repo), before);
  assert.deepEqual(states(repo), []);
}

// A local change to the file: refused, nothing changed.
{
  const repo = init("pick-refused");
  sh(repo, "git checkout -q -b other main~1 && echo mine > a.txt");
  const r = await cherryPickChanges(git, repo, { commit: hash(repo, "side"), paths: ["a.txt"] });
  assert.equal(r.outcome, "refused", r.err);
  assert.deepEqual(r.blocked, ["a.txt"]);
  assert.deepEqual(status(repo), [" M a.txt"]);
}

// Changes already in: nothing to do, nothing left.
{
  const repo = init("pick-empty");
  const r = await cherryPickChanges(git, repo, { commit: hash(repo, "side"), paths: ["a.txt", "b.txt"] });
  assert.equal(r.outcome, "empty", r.err);
  assert.deepEqual(status(repo), []);
}

// A rename picked as its two paths: the file moves.
{
  const repo = init("pick-rename");
  sh(repo, "git checkout -q -b mv main~1 && git mv c.txt e.txt && git commit -q -m mv && git checkout -q main");
  const r = await cherryPickChanges(git, repo, { commit: hash(repo, "mv"), paths: ["e.txt", "c.txt"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(text(repo, "e.txt"), "c\n");
  assert.equal(text(repo, "c.txt"), "(none)\n");
}

console.log("ok");
