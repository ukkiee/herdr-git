// node git.test.mjs: the git runner against throwaway repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit, repoRoot, chunks, READ, recordWith } from "./git.js";

const root = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });

const repo = `${root}/repo`;
mkdirSync(`${repo}/src/deep`, { recursive: true });
sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo one > a.txt && echo two > "src/deep/b c.txt" && git add -A && git commit -q -m first`);
const outside = `${root}/plain`;
mkdirSync(outside);

const git = makeGit(exec, null);

// A command that works: the output comes back as git wrote it.
{
  writeFileSync(`${repo}/a.txt`, "changed\n");
  const r = await git(repo, ["status", "--porcelain=v1", "-z"]);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.out, " M a.txt\0", "leading spaces and NULs survive");
  sh(repo, "git checkout -q -- a.txt");
}

// A command git refuses: a result, not an exception.
{
  const r = await git(repo, ["rev-parse", "--verify", "no-such-branch"]);
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Needed a single revision/);
}

// A program that can't start at all (no such folder, an unreachable machine): also a result.
{
  const r = await git(`${root}/gone`, ["status"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.ok(r.err.length > 0);
  const down = makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps");
  const d = await down(repo, ["status"]);
  assert.deepEqual({ ok: d.ok, code: d.code, out: d.out }, { ok: false, code: -1, out: "" });
  assert.match(d.err, /unreachable/);
}

// Where the command runs is handed on to exec: the folder, the machine, the time limit.
{
  const seen = [];
  const spy = makeGit((cmd, args, options) => { seen.push({ cmd, args, options }); return Promise.resolve({ code: 0, stdout: "", stderr: "" }); }, "vps");
  await spy("/repo", ["commit", "-m", "x"], { timeout: 600000 });
  assert.deepEqual(seen[0].options, { cwd: "/repo", on: "vps", timeout: 600000 });
}

// Environment variables reach git (herdr's exec has no env option).
{
  const r = await git(repo, ["config", "--get", "user.name"], { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "From Env" } });
  assert.equal(r.out, "From Env\n");
  const plain = await git(repo, ["config", "--get", "user.name"]);
  assert.equal(plain.out, "t\n");
}

// git.read leaves .git alone. A file whose timestamp changed but whose content didn't
// makes a plain `git status` rewrite the index; the panel's folder watch would see that
// and refresh forever.
{
  const index = `${repo}/.git/index`;
  const snapshot = () => ({ bytes: readFileSync(index).toString("hex"), mtime: statSync(index).mtimeMs });
  const later = new Date(Date.now() + 5000);
  utimesSync(`${repo}/a.txt`, later, later);
  const before = snapshot();
  const r = await git.read(repo, ["status", "--porcelain=v1", "-z"]);
  assert.equal(r.ok, true);
  assert.equal(r.out, "");
  assert.deepEqual(snapshot(), before, "a read does not rewrite the index");
  // The same status without the read flags does rewrite it, so the check above means something.
  await git(repo, ["status", "--porcelain=v1", "-z"]);
  assert.notEqual(snapshot().bytes, before.bytes);
}

// The repository a folder belongs to.
{
  const deep = await repoRoot(git, `${repo}/src/deep`);
  assert.deepEqual(deep, { ok: true, root: repo });
  assert.deepEqual(await repoRoot(git, repo), { ok: true, root: repo });
}

// A folder outside any repository says so, apart from other failures.
{
  const r = await repoRoot(git, outside);
  assert.equal(r.ok, false);
  assert.equal(r.notRepo, true);
  assert.equal(r.root, undefined);
  const gone = await repoRoot(git, `${root}/gone`);
  assert.equal(gone.ok, false);
  assert.equal(gone.notRepo, false, "a folder that can't be reached is an error, not 'not a repository'");
  assert.ok(gone.err.length > 0);
}

// A long list of paths is split so each part fits one command: at most 1,000 paths and
// 60,000 bytes (three bytes a character, the most UTF-8 takes for these, plus one between),
// in order, nothing lost. A cost says what else a caller puts around each path.
{
  assert.deepEqual(chunks([]), []);
  assert.deepEqual(chunks(["a", "b"]), [["a", "b"]]);
  const many = Array.from({ length: 2500 }, (_, i) => `f${i}`);
  const parts = chunks(many);
  assert.deepEqual(parts.map((part) => part.length), [1000, 1000, 500]);
  assert.deepEqual(parts.flat(), many);
  // 100 characters cost 301 bytes: 199 fit in 60,000.
  const long = Array.from({ length: 400 }, (_, i) => String(i).padStart(100, "x"));
  assert.deepEqual(chunks(long).map((part) => part.length), [199, 199, 2]);
  assert.deepEqual(chunks(long).flat(), long);
  // A path too long for the limit by itself still goes, alone.
  const huge = "h".repeat(30000);
  assert.deepEqual(chunks(["a", huge, "b"]), [["a"], [huge], ["b"]]);
  assert.deepEqual(chunks(many.slice(0, 600), () => 200).map((part) => part.length), [300, 300]);
}

// Every command that may write is handed to the recorder (the Git console), with where it
// ran and what came of it; reads (git.read, the READ flags) never are.
{
  const calls = [];
  const logged = makeGit(exec, null, { record: (call) => { calls.push(call); } });
  const before = Date.now();
  const made = await logged(repo, ["branch", "console-made"]);
  assert.equal(made.ok, true);
  const refused = await logged(repo, ["branch", "console-made"]);
  assert.equal(refused.ok, false);
  await logged.read(repo, ["status", "--porcelain=v1"]);
  await logged(repo, [...READ, "rev-parse", "HEAD"]);
  await logged(repo, ["commit", "--allow-empty", "-q", "-m", "from env"], { env: { GIT_AUTHOR_NAME: "Env" } });
  assert.deepEqual(calls.map((c) => c.args), [["branch", "console-made"], ["branch", "console-made"], ["commit", "--allow-empty", "-q", "-m", "from env"]]);
  const [first, second] = calls;
  assert.equal(first.cwd, repo);
  assert.equal(first.on, null);
  assert.equal(first.code, 0);
  assert.ok(first.at >= before && first.at <= Date.now());
  assert.equal(second.code, 128);
  assert.match(second.stderr, /already exists/);
  assert.equal(execFileSync("git", ["log", "-1", "--format=%an"], { cwd: repo, encoding: "utf8" }), "Env\n", "the env still reaches git");
  // A command that couldn't start is recorded too, as code -1 with the reason.
  const down = [];
  const gone = makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps", { record: (c) => { down.push(c); } });
  await gone("/r", ["push"]);
  assert.equal(down.length, 1);
  assert.deepEqual({ on: down[0].on, code: down[0].code }, { on: "vps", code: -1 });
  assert.match(down[0].stderr, /unreachable/);
  // A recorder that fails never fails git.
  const broken = makeGit(exec, null, { record: () => { throw new Error("disk full"); } });
  assert.equal((await broken(repo, ["branch", "-D", "console-made"])).ok, true);
  const rejecting = makeGit(exec, null, { record: () => Promise.reject(new Error("disk full")) });
  assert.equal((await rejecting(repo, ["branch", "console-two"])).ok, true);
  sh(repo, "git branch -D console-two && git reset -q --hard HEAD~1");
}

// Without a recorder of its own, a runner hands writes to the one installed for every
// runner (main.js installs the Git console's); none installed, nothing is recorded.
{
  const calls = [];
  recordWith((call) => { calls.push(call); });
  try {
    await makeGit(exec, null)(repo, ["branch", "console-installed"]);
    await makeGit(exec, null).read(repo, ["status"]);
  } finally { recordWith(null); }
  await makeGit(exec, null)(repo, ["branch", "-D", "console-installed"]);
  assert.deepEqual(calls.map((c) => c.args), [["branch", "console-installed"]]);
}

console.log("ok");
