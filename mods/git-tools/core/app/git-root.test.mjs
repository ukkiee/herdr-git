// node git-root.test.mjs: finding a folder's repository against throwaway repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "../../adapters/out/git.js";
import { repoRoot } from "./git-root.js";

const root = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
// The same exec on a computer set to Korean: git's own words come in Korean when it has them.
const korean = () => {
  const env = { ...process.env, LANG: "ko_KR.UTF-8" };
  for (const k of ["LC_ALL", "LC_MESSAGES", "LANGUAGE"]) delete env[k];
  return env;
};
const inKorean = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env: korean() }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});

const repo = `${root}/repo`;
mkdirSync(`${repo}/src/deep`, { recursive: true });
sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo one > a.txt && git add -A && git commit -q -m first`);
const outside = `${root}/plain`;
mkdirSync(outside);

const git = makeGit(exec, null);

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

// git says "not a git repository" in the person's language. Outside a repository with a
// Korean locale is still "not a repository", not a failure: with a git that has its
// translations, as here (no LC_ALL, LANG=ko_KR.UTF-8), and with one that answers in
// Korean unless asked in the C locale, for a git without them.
{
  const r = await repoRoot(makeGit(inKorean, null), outside);
  assert.deepEqual([r.ok, r.notRepo], [false, true]);
  const translated = async (cmd, args) => {
    const c = cmd === "env" && args.includes("LC_ALL=C");
    return { code: 128, stdout: "", stderr: c ? "fatal: not a git repository (or any of the parent directories): .git\n" : "fatal: (현재 폴더 또는 상위 폴더 중 일부가) 깃 저장소가 아닙니다: .git\n" };
  };
  const t = await repoRoot(makeGit(translated, null), "/somewhere");
  assert.deepEqual([t.ok, t.notRepo], [false, true]);
}

// A clock the test rings by hand (git.test.mjs has the same): wait(ms, ring) → stop.
const handClock = () => {
  const alarms = [];
  const wait = (ms, ring) => {
    const alarm = { ms, ring };
    alarms.push(alarm);
    return () => { const at = alarms.indexOf(alarm); if (at >= 0) alarms.splice(at, 1); };
  };
  return { wait, ring: () => alarms.shift().ring() };
};
// An exec whose answer never comes (herdr's has been seen to lose one).
const losing = () => ({ exec: () => new Promise(() => {}) });
const settle = () => new Promise((go) => setImmediate(go));

// repoRoot on a machine whose answer never comes: a failure that is not "not a repository",
// so the screen shows git's words and asks again later.
{
  const clock = handClock(), x = losing();
  const found = repoRoot(makeGit(x.exec, "far", { wait: clock.wait }), "/somewhere");
  await settle(); clock.ring(); await settle(); clock.ring();
  const r = await found;
  assert.deepEqual([r.ok, r.notRepo], [false, false]);
  assert.match(r.err, /did not answer/);
}

console.log("ok");
