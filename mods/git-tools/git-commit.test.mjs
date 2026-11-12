// node git-commit.test.mjs: commit, lastMessage and headIsPushed against throwaway
// repositories (no app needed). Every check reads the repository back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { commit, lastMessage, headIsPushed } from "./git-commit.js";
import { translator } from "./i18n.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-commit-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const lines = (text) => text.split("\n").filter(Boolean);
// What the last commit changed: ["M\tpath", "A\tpath", "D\tpath"], by path.
const lastCommitFiles = (repo) => lines(sh(repo, "git -c core.quotePath=false show --format= --name-status --no-renames HEAD")).sort((a, b) => (a.slice(2) < b.slice(2) ? -1 : 1));
const count = (repo) => Number(sh(repo, "git rev-list --count HEAD").trim());
const head = (repo) => sh(repo, "git rev-parse HEAD").trim();
// "XY path" per file, as git sees the index and the work tree now.
const status = (repo) => lines(sh(repo, "git -c core.quotePath=false status --porcelain --no-renames --untracked-files=all"));
// The message as stored in the commit object: everything after the header's blank line.
const message = (repo) => { const raw = sh(repo, "git cat-file commit HEAD"); return raw.slice(raw.indexOf("\n\n") + 2); };

// A modified, a deleted and an untracked file each land in the commit when Included.
// A file that isn't Included stays out even though it was staged with `git add`, and it
// is still staged afterwards, exactly as it was. Unstaged and untracked ones stay too.
{
  const repo = init("only-included");
  mkdirSync(`${repo}/src`);
  sh(repo, `echo 1 > src/a.ts && echo 1 > gone.txt && echo 1 > staged.txt && echo 1 > staged-gone.txt && echo 1 > loose.txt
git add -A && git commit -q -m first`);
  writeFileSync(`${repo}/src/a.ts`, "2\n");
  sh(repo, "rm gone.txt");
  writeFileSync(`${repo}/new.txt`, "new\n");
  sh(repo, "echo 2 > staged.txt && git add staged.txt && git rm -q staged-gone.txt && echo new > staged-new.txt && git add staged-new.txt");
  writeFileSync(`${repo}/loose.txt`, "2\n");
  writeFileSync(`${repo}/other-new.txt`, "x\n");
  const stagedBefore = sh(repo, "git diff --cached --no-renames");

  const r = await commit(git, repo, {
    files: [{ path: "src/a.ts", status: "modified" }, { path: "gone.txt", status: "deleted" }, { path: "new.txt", status: "unversioned" }],
    message: "second",
  });
  assert.equal(r.ok, true, r.err);
  assert.equal(count(repo), 2);
  assert.deepEqual(lastCommitFiles(repo), ["D\tgone.txt", "A\tnew.txt", "M\tsrc/a.ts"]);
  assert.equal(sh(repo, "git show HEAD:src/a.ts"), "2\n");
  assert.equal(sh(repo, "git show HEAD:new.txt"), "new\n");
  assert.equal(sh(repo, "git diff --cached --no-renames"), stagedBefore, "what was staged is still staged, byte for byte");
  assert.deepEqual(status(repo), [" M loose.txt", "D  staged-gone.txt", "A  staged-new.txt", "M  staged.txt", "?? other-new.txt"]);
}

// A message of several lines is recorded as typed: blank lines, indentation, a line
// starting with "#" (an issue number, not a comment) and one starting with "-".
{
  const repo = init("message");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  writeFileSync(`${repo}/a.txt`, "2\n");
  const typed = "feat: 제목 줄\n\n- first point\n  indented detail\n\n#42 is fixed\n-m not a flag";
  const r = await commit(git, repo, { files: [{ path: "a.txt", status: "modified" }], message: typed });
  assert.equal(r.ok, true, r.err);
  assert.equal(message(repo), `${typed}\n`);
  assert.deepEqual(status(repo), []);
}

// File names are names, not patterns or options: spaces, Korean, glob characters and a
// leading dash commit that file and nothing it would match as a pattern.
{
  const repo = init("names");
  mkdirSync(`${repo}/새 폴더`);
  sh(repo, `echo 1 > "my notes.md" && echo 1 > "새 폴더/한글 문서.md" && echo 1 > a1.txt && echo 1 > b.txt && git add -A && git commit -q -m first`);
  writeFileSync(`${repo}/my notes.md`, "2\n");
  writeFileSync(`${repo}/새 폴더/한글 문서.md`, "2\n");
  writeFileSync(`${repo}/a1.txt`, "2\n"); // "a[12].txt" matches this as a pattern
  writeFileSync(`${repo}/b.txt`, "2\n"); // "*.txt" matches this as a pattern
  writeFileSync(`${repo}/a[12].txt`, "x\n");
  writeFileSync(`${repo}/*.txt`, "x\n");
  writeFileSync(`${repo}/-n.txt`, "x\n");
  writeFileSync(`${repo}/:top.txt`, "x\n");
  const r = await commit(git, repo, {
    files: [
      { path: "my notes.md", status: "modified" }, { path: "새 폴더/한글 문서.md", status: "modified" },
      { path: "a[12].txt", status: "unversioned" }, { path: "*.txt", status: "unversioned" },
      { path: "-n.txt", status: "unversioned" }, { path: ":top.txt", status: "unversioned" },
    ],
    message: "names",
  });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(lastCommitFiles(repo), ["A\t*.txt", "A\t-n.txt", "A\t:top.txt", "A\ta[12].txt", "M\tmy notes.md", "M\t새 폴더/한글 문서.md"]);
  assert.deepEqual(status(repo), [" M a1.txt", " M b.txt"]);
}

// Newly added files ("added": staged, or only registered with --intent-to-add) commit
// with what is on disk now, and a file with staged and unstaged edits commits whole.
{
  const repo = init("added");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  sh(repo, "echo staged > new.txt && git add new.txt && echo disk > new.txt");
  sh(repo, "echo x > later.txt && git add --intent-to-add later.txt");
  sh(repo, "echo 2 > a.txt && git add a.txt && echo 3 > a.txt");
  const r = await commit(git, repo, {
    files: [{ path: "new.txt", status: "added" }, { path: "later.txt", status: "added" }, { path: "a.txt", status: "modified" }],
    message: "added",
  });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(lastCommitFiles(repo), ["M\ta.txt", "A\tlater.txt", "A\tnew.txt"]);
  assert.equal(sh(repo, "git show HEAD:new.txt"), "disk\n");
  assert.equal(sh(repo, "git show HEAD:a.txt"), "3\n");
  assert.deepEqual(status(repo), []);
}

// The first commit of a repository: only the Included file, the other staged one waits.
{
  const repo = init("first");
  sh(repo, "echo 1 > a.txt && echo 1 > b.txt && git add b.txt");
  const r = await commit(git, repo, { files: [{ path: "a.txt", status: "unversioned" }], message: "first" });
  assert.equal(r.ok, true, r.err);
  assert.equal(count(repo), 1);
  assert.deepEqual(lastCommitFiles(repo), ["A\ta.txt"]);
  assert.deepEqual(status(repo), ["A  b.txt"]);
}

// A failing pre-commit hook: no commit, the hook's words come back, and the repository
// is as it was. The Included untracked file is untracked again, not left half added.
{
  const repo = init("hook");
  sh(repo, "echo 1 > a.txt && echo 1 > staged.txt && git add -A && git commit -q -m first");
  writeFileSync(`${repo}/.git/hooks/pre-commit`, "#!/bin/sh\necho 'lint: 2 problems found'\necho 'fix them first' >&2\nexit 1\n");
  chmodSync(`${repo}/.git/hooks/pre-commit`, 0o755);
  writeFileSync(`${repo}/a.txt`, "2\n");
  writeFileSync(`${repo}/new.txt`, "new\n");
  sh(repo, "echo 2 > staged.txt && git add staged.txt");
  const before = { head: head(repo), status: status(repo) };
  assert.deepEqual(before.status, [" M a.txt", "M  staged.txt", "?? new.txt"]);

  const r = await commit(git, repo, { files: [{ path: "a.txt", status: "modified" }, { path: "new.txt", status: "unversioned" }], message: "blocked" });
  assert.equal(r.ok, false);
  assert.match(r.err, /lint: 2 problems found/);
  assert.match(r.err, /fix them first/);
  // The hook's own words: shown as git gave them, never worded again.
  assert.equal(r.msg, undefined);
  assert.deepEqual({ head: head(repo), status: status(repo) }, before);
}

// A list read before the files were staged or committed still calls them Unversioned.
// When the commit is then refused, only what this call registered is taken back: a file
// staged meanwhile keeps its staged content, and a file committed meanwhile stays tracked.
{
  const repo = init("stale-list");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  sh(repo, "echo committed > committed-since.txt && git add committed-since.txt && git commit -q -m second");
  sh(repo, "echo staged > staged-since.txt && git add staged-since.txt");
  writeFileSync(`${repo}/really-new.txt`, "new\n");
  writeFileSync(`${repo}/.git/hooks/pre-commit`, "#!/bin/sh\nexit 1\n");
  chmodSync(`${repo}/.git/hooks/pre-commit`, 0o755);
  const before = { head: head(repo), index: sh(repo, "git ls-files -s"), status: status(repo) };

  const unversioned = ["staged-since.txt", "committed-since.txt", "really-new.txt"].map((path) => ({ path, status: "unversioned" }));
  const r = await commit(git, repo, { files: unversioned, message: "blocked" });
  assert.equal(r.ok, false);
  assert.deepEqual({ head: head(repo), index: sh(repo, "git ls-files -s"), status: status(repo) }, before);
}

// Nothing to do is refused before git runs: no message, or no files without Amend.
{
  const repo = init("refused");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  writeFileSync(`${repo}/a.txt`, "2\n");
  writeFileSync(`${repo}/new.txt`, "new\n");
  const before = { head: head(repo), status: status(repo) };
  for (const blank of ["", "  \n\t\n"]) {
    const r = await commit(git, repo, { files: [{ path: "a.txt", status: "modified" }, { path: "new.txt", status: "unversioned" }], message: blank });
    assert.equal(r.ok, false);
    assert.match(r.err, /message/i);
    assert.deepEqual(r.msg, { key: "commit.noMessage" });
    assert.equal(translator("en")(r.msg.key), r.err);
  }
  const none = await commit(git, repo, { files: [], message: "nothing" });
  assert.equal(none.ok, false);
  assert.match(none.err, /no files/i);
  assert.deepEqual(none.msg, { key: "commit.noFiles" });
  assert.equal(translator("en")(none.msg.key), none.err);
  assert.deepEqual({ head: head(repo), status: status(repo) }, before);
}

// Amend rewrites the last commit: the same number of commits, a new message, and the
// Included files added to what that commit already held. The commit before it is untouched.
{
  const repo = init("amend");
  sh(repo, "echo 1 > a.txt && echo 1 > b.txt && git add -A && git commit -q -m first");
  sh(repo, "echo 2 > a.txt && git commit -q -am 'second: typo'");
  const first = sh(repo, "git rev-parse HEAD~1").trim(), second = head(repo);
  writeFileSync(`${repo}/b.txt`, "2\n");
  writeFileSync(`${repo}/new.txt`, "new\n");
  sh(repo, "echo x > staged.txt && git add staged.txt");

  const r = await commit(git, repo, { files: [{ path: "b.txt", status: "modified" }, { path: "new.txt", status: "unversioned" }], message: "second\n\nwith b and new", amend: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(count(repo), 2);
  assert.notEqual(head(repo), second);
  assert.equal(sh(repo, "git rev-parse HEAD~1").trim(), first);
  assert.equal(message(repo), "second\n\nwith b and new\n");
  assert.deepEqual(lastCommitFiles(repo), ["M\ta.txt", "M\tb.txt", "A\tnew.txt"]);
  assert.deepEqual(status(repo), ["A  staged.txt"]);
}

// Amend with no files changes the message only: the commit's files are the same, and a
// file staged with `git add` is neither swept in nor unstaged.
{
  const repo = init("amend-message");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  sh(repo, "echo 2 > a.txt && git commit -q -am 'secnod'");
  const tree = sh(repo, "git rev-parse HEAD^{tree}");
  sh(repo, "echo 3 > a.txt && git add a.txt && echo x > staged.txt && git add staged.txt");
  writeFileSync(`${repo}/loose.txt`, "x\n");

  const r = await commit(git, repo, { files: [], message: "second", amend: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(count(repo), 2);
  assert.equal(message(repo), "second\n");
  assert.equal(sh(repo, "git rev-parse HEAD^{tree}"), tree);
  assert.deepEqual(status(repo), ["M  a.txt", "A  staged.txt", "?? loose.txt"]);
}

// A repository without commits has nothing to amend: refused, and the Included
// untracked file is still untracked.
{
  const repo = init("amend-empty");
  writeFileSync(`${repo}/a.txt`, "1\n");
  const r = await commit(git, repo, { files: [{ path: "a.txt", status: "unversioned" }], message: "first", amend: true });
  assert.equal(r.ok, false);
  assert.match(r.err, /nothing to amend/i);
  assert.equal(sh(repo, "git rev-list --all --count").trim(), "0");
  assert.deepEqual(status(repo), ["?? a.txt"]);
}

// lastMessage: the whole message of the last commit, without git's trailing newline.
// A repository without commits has none.
{
  const repo = init("last-message");
  const none = await lastMessage(git, repo);
  assert.equal(none.ok, false);
  assert.equal(none.message, "");
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  assert.deepEqual(await lastMessage(git, repo), { ok: true, err: "", message: "first" });
  writeFileSync(`${repo}/a.txt`, "2\n");
  const typed = "fix: 제목\n\nbody line one\n  indented\n\n#42";
  await commit(git, repo, { files: [{ path: "a.txt", status: "modified" }], message: typed });
  assert.deepEqual(await lastMessage(git, repo), { ok: true, err: "", message: typed });
}

// headIsPushed: true once any branch of a remote holds the last commit, false again
// after a new local commit. No remote, or no commits: not pushed.
{
  const repo = init("pushed");
  assert.equal((await headIsPushed(git, repo)).pushed, false);
  sh(repo, "echo 1 > a.txt && git add -A && git commit -q -m first");
  assert.deepEqual(await headIsPushed(git, repo), { ok: true, err: "", pushed: false });
  sh(base, "git init -q --bare remote.git");
  sh(repo, `git remote add origin "${base}/remote.git"`);
  assert.deepEqual(await headIsPushed(git, repo), { ok: true, err: "", pushed: false });
  sh(repo, "git push -q origin main");
  assert.deepEqual(await headIsPushed(git, repo), { ok: true, err: "", pushed: true });
  sh(repo, "echo 2 > a.txt && git commit -q -am second");
  assert.deepEqual(await headIsPushed(git, repo), { ok: true, err: "", pushed: false });
  // Pushed under another branch name still counts: the commit is out there.
  sh(repo, "git push -q origin main:refs/heads/backup");
  assert.deepEqual(await headIsPushed(git, repo), { ok: true, err: "", pushed: true });
  // Amending it makes a commit the remote doesn't have.
  await commit(git, repo, { files: [], message: "second, reworded", amend: true });
  assert.deepEqual(await headIsPushed(git, repo), { ok: true, err: "", pushed: false });
}

// git can't be reached: results with the reason, not exceptions.
{
  const down = makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps");
  const r = await commit(down, "/repo", { files: [{ path: "a.txt", status: "modified" }], message: "m" });
  assert.equal(r.ok, false);
  assert.match(r.err, /unreachable/);
  assert.match((await lastMessage(down, "/repo")).err, /unreachable/);
  const pushed = await headIsPushed(down, "/repo");
  assert.deepEqual([pushed.ok, pushed.pushed], [false, false]);
  assert.match(pushed.err, /unreachable/);
}

// The mod's own sentences come with their keys; git's words never do. A scripted exec
// stands in for git: these are the answers a real repository can't be made to give
// (git failing without a word, `git rm --cached` failing after a refused commit).
{
  const scripted = (answer) => makeGit(async (_cmd, args) => answer(args.find((a) => ["ls-files", "add", "commit", "rm", "log", "for-each-ref"].includes(a))), null);
  const mute = scripted(() => ({ code: 1, stdout: "", stderr: "" }));
  const last = await lastMessage(mute, "/repo");
  assert.deepEqual([last.ok, last.err, last.msg], [false, "No commits yet.", { key: "commit.noCommitsYet" }]);
  const pushed = await headIsPushed(mute, "/repo");
  assert.deepEqual([pushed.ok, pushed.err, pushed.msg], [false, "git for-each-ref failed", { key: "commit.forEachRefFailed" }]);

  const files = [{ path: "new.txt", status: "unversioned" }, { path: "b c.txt", status: "unversioned" }];
  const stuck = (hook) => scripted((sub) => sub === "commit" ? { code: 1, stdout: "", stderr: hook }
    : sub === "rm" ? { code: 128, stdout: "", stderr: "fatal: index.lock exists" }
    : { code: 0, stdout: "", stderr: "" });
  const said = await commit(stuck("lint failed"), "/repo", { files, message: "m" });
  assert.equal(said.err, "lint failed\n\nThese files are still registered for commit (git rm --cached failed: fatal: index.lock exists): new.txt, b c.txt");
  assert.deepEqual(said.msg, { key: "commit.stillRegisteredAfter", args: { output: "lint failed", reason: "fatal: index.lock exists", files: "new.txt, b c.txt" } });
  const quiet = await commit(stuck(""), "/repo", { files, message: "m" });
  assert.equal(quiet.err, "These files are still registered for commit (git rm --cached failed: fatal: index.lock exists): new.txt, b c.txt");
  assert.deepEqual(quiet.msg, { key: "commit.stillRegistered", args: { reason: "fatal: index.lock exists", files: "new.txt, b c.txt" } });
  // The English table words each one exactly as err says it.
  const english = translator("en");
  for (const r of [last, pushed, said, quiet]) assert.equal(english(r.msg.key, r.msg.args), r.err, r.msg.key);
}

console.log("ok");
