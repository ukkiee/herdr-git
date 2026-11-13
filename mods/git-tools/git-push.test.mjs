// node git-push.test.mjs: readPushPlan, readPushFiles and push against throwaway
// repositories whose remote is a local bare repository (no app, no network). Every check
// reads the repositories back with git. The one exception is the safety rule at the end:
// it looks at the arguments every call ran with, because "never a bare --force" can't be
// told from the outcome.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { PROTECTED, readPushPlan, readPushFiles, push } from "./git-push.js";
import { translator } from "./i18n.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-push-`));
// The person's own git config stays out (credential helpers, askpass, signing, hooks):
// the tests must behave the same on every machine.
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "", SSH_ASKPASS: "" };
delete env.GIT_TERMINAL_PROMPT;
// Every program the module starts, as [cmd, ...args].
const ran = [];
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  ran.push([cmd, ...args]);
  execFile(cmd, args, { cwd, env }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env });
const git = makeGit(exec, null);
// The calls that were a `git push`, of the ones made since `from`.
const pushes = (from = 0) => ran.slice(from).filter((call) => call.includes("push"));

// A repository on `branch` with one commit, and a bare copy of it as `origin` that the
// branch tracks. → { repo, remote }
const setup = (name, branch = "feat/one") => {
  const repo = `${base}/${name}`, remote = `${base}/${name}-remote.git`;
  mkdirSync(`${repo}/src/app`, { recursive: true });
  sh(repo, `git init -q -b ${branch} && git config user.email t@t && git config user.name "Test Person"
echo 1 > src/app/a.ts && echo 1 > old.txt && git add -A && git commit -q -m first
git clone -q --bare . ${remote} && git remote add origin ${remote} && git fetch -q origin && git branch -q --set-upstream-to=origin/${branch}`);
  return { repo, remote };
};
const commitAll = (repo, message) => { sh(repo, `git add -A && git commit -q -m "${message}"`); return rev(repo, "HEAD"); };
const rev = (repo, name) => sh(repo, `git rev-parse ${name}`).trim();
// What a branch of the bare remote points at, or "" when it has no such branch.
const remoteRef = (remote, branch) => sh(remote, `git rev-parse --verify --quiet refs/heads/${branch} || true`).trim();
const upstream = (repo) => sh(repo, "git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true").trim();
// A sentence this module words comes with msg: its key is in the tables, and the English
// sentence made from it is the err itself.
const en = translator("en"), ko = translator("ko");
const worded = (r, key) => {
  assert.equal(r.msg?.key, key, r.err);
  assert.equal(en(r.msg.key, r.msg.args), r.err);
  assert.notEqual(ko(r.msg.key, r.msg.args), r.msg.key, `${key} has Korean`);
};
const byPath = (files) => [...files].sort((a, b) => (a.path < b.path ? -1 : 1));

assert.deepEqual(PROTECTED, ["main", "master"]);

// The plan: where the branch goes, the commits the remote doesn't have (newest first)
// and the files they change, as a whole and one commit at a time.
{
  const { repo } = setup("plan");
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  writeFileSync(`${repo}/src/app/c.ts`, "new\n");
  const second = commitAll(repo, "feat: add c");
  sh(repo, "rm old.txt");
  writeFileSync(`${repo}/src/app/c.ts`, "newer\n");
  const third = commitAll(repo, "fix: tweak c, drop old");

  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.equal(plan.branch, "feat/one");
  assert.equal(plan.remote, "origin");
  assert.equal(plan.target, "feat/one");
  assert.equal(plan.tracked, true);
  assert.equal(plan.protected, false);
  assert.deepEqual(plan.commits.map((c) => [c.hash, c.subject, c.author]), [
    [third, "fix: tweak c, drop old", "Test Person"],
    [second, "feat: add c", "Test Person"],
  ]);
  assert.equal(plan.commits[0].time, Number(sh(repo, "git log -1 --format=%ct").trim()));

  // The whole range: c.ts was added and then changed, which from the remote's side is "added".
  const all = await readPushFiles(git, repo);
  assert.equal(all.ok, true, all.err);
  assert.deepEqual(byPath(all.files), [
    { path: "old.txt", status: "deleted" },
    { path: "src/app/a.ts", status: "modified" },
    { path: "src/app/c.ts", status: "added" },
  ]);
  // One commit: what it changed against its parent.
  const one = await readPushFiles(git, repo, { from: plan.commits[0].parent, to: plan.commits[0].hash });
  assert.equal(one.ok, true, one.err);
  assert.deepEqual(byPath(one.files), [
    { path: "old.txt", status: "deleted" },
    { path: "src/app/c.ts", status: "modified" },
  ]);
  assert.equal(plan.commits[0].parent, second);
}

// Push puts the remote's branch where HEAD is; after it there is nothing left to push.
{
  const { repo, remote } = setup("push");
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  const head = commitAll(repo, "second");
  const r = await push(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "feat/one"), head);
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual(plan.commits, []);
  assert.equal(plan.isNew, false);
}

// A branch without an upstream goes to origin under its own name, and tracks it afterwards.
{
  const { repo, remote } = setup("untracked");
  sh(repo, "git checkout -q -b topic/new");
  writeFileSync(`${repo}/src/app/b.ts`, "b\n");
  const head = commitAll(repo, "on topic");
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual([plan.branch, plan.remote, plan.target, plan.tracked, plan.isNew], ["topic/new", "origin", "topic/new", false, true]);
  assert.deepEqual(plan.commits.map((c) => c.hash), [head]);
  assert.equal(upstream(repo), "");

  const r = await push(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "topic/new"), head);
  assert.equal(upstream(repo), "origin/topic/new");
  assert.equal((await readPushPlan(git, repo)).tracked, true);
}

// After the pushed commit is rewritten (Amend), a plain push is refused and changes
// nothing; Force Push puts the rewritten commit on the remote.
{
  const { repo, remote } = setup("rewritten");
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  const pushed = commitAll(repo, "second");
  assert.equal((await push(git, repo)).ok, true);
  sh(repo, "git commit -q --amend -m 'second, reworded'");
  const amended = rev(repo, "HEAD");
  assert.notEqual(amended, pushed);

  const plain = await push(git, repo);
  assert.equal(plain.ok, false);
  assert.match(plain.err, /rejected|non-fast-forward/);
  assert.equal(remoteRef(remote, "feat/one"), pushed, "a refused push leaves the remote as it was");
  assert.equal(rev(repo, "HEAD"), amended, "and the local commit too");

  const forced = await push(git, repo, { force: true });
  assert.equal(forced.ok, true, forced.err);
  assert.equal(remoteRef(remote, "feat/one"), amended);
}

// Force Push only overwrites what this repository last saw. When someone else pushed in
// between, it is refused and their commit stays.
{
  const { repo, remote } = setup("lease");
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  commitAll(repo, "second");
  assert.equal((await push(git, repo)).ok, true);
  sh(repo, "git commit -q --amend -m 'second, reworded'");
  const other = `${base}/lease-other`;
  sh(base, `git clone -q ${remote} ${other}`);
  sh(other, "git config user.email o@o && git config user.name Other && echo theirs > theirs.txt && git add -A && git commit -q -m theirs && git push -q origin feat/one");
  const theirs = rev(other, "HEAD");

  const forced = await push(git, repo, { force: true });
  assert.equal(forced.ok, false);
  assert.match(forced.err, /stale info|rejected/);
  assert.equal(remoteRef(remote, "feat/one"), theirs, "the other person's commit is still there");
}

// Force Push on a Protected branch is refused before any `git push` runs, also when the
// module is called directly. A branch that pushes to a protected one counts too.
for (const branch of PROTECTED) {
  const { repo, remote } = setup(`protected-${branch}`, branch);
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  const pushed = commitAll(repo, "second");
  assert.equal((await push(git, repo)).ok, true, "a plain push to a protected branch is fine");
  sh(repo, "git commit -q --amend -m rewritten");
  assert.equal((await readPushPlan(git, repo)).protected, true);

  let before = ran.length;
  const forced = await push(git, repo, { force: true });
  assert.equal(forced.ok, false);
  assert.match(forced.err, new RegExp(`protected branch.*${branch}`, "i"));
  worded(forced, "dialogs.push.protected");
  assert.deepEqual(pushes(before), [], "git push never started");
  assert.equal(remoteRef(remote, branch), pushed);

  // `work` tracks origin/<protected>: forcing it would overwrite the protected branch.
  sh(repo, `git checkout -q -b work && git branch -q --set-upstream-to=origin/${branch}`);
  sh(repo, "git commit -q --amend -m 'rewritten on work'");
  const plan = await readPushPlan(git, repo);
  assert.deepEqual([plan.branch, plan.target, plan.protected], ["work", branch, true]);
  before = ran.length;
  assert.equal((await push(git, repo, { force: true })).ok, false);
  assert.deepEqual(pushes(before), []);
  assert.equal(remoteRef(remote, branch), pushed);
}

// Force Push of a branch the remote never had: allowed, and it creates the branch.
{
  const { repo, remote } = setup("force-new");
  sh(repo, "git checkout -q -b fresh");
  writeFileSync(`${repo}/src/app/b.ts`, "b\n");
  const head = commitAll(repo, "fresh work");
  const forced = await push(git, repo, { force: true });
  assert.equal(forced.ok, true, forced.err);
  assert.equal(remoteRef(remote, "fresh"), head);
  assert.equal(upstream(repo), "origin/fresh");
}

// A remote that can't be reached: the push fails with git's words and comes back (it
// doesn't wait). The commit is still there, and so is the work to push.
{
  const { repo, remote } = setup("unreachable");
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  const head = commitAll(repo, "second");
  rmSync(remote, { recursive: true });
  const r = await push(git, repo);
  assert.equal(r.ok, false);
  assert.match(r.err, /does not appear to be a git repository|Could not read from remote/);
  assert.equal(rev(repo, "HEAD"), head);
  assert.deepEqual((await readPushPlan(git, repo)).commits.map((c) => c.hash), [head]);
}

// A remote that asks for a user name and password: git is told not to ask at the
// terminal, so the push fails at once instead of waiting for someone to type.
{
  const { repo } = setup("credentials");
  writeFileSync(`${repo}/src/app/a.ts`, "2\n");
  const head = commitAll(repo, "second");
  const server = createServer((_req, res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' }); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  sh(repo, `git remote set-url origin http://127.0.0.1:${server.address().port}/repo.git && git config http.proxy ""`);
  const started = Date.now();
  const r = await push(git, repo);
  server.close();
  server.closeAllConnections();
  assert.equal(r.ok, false);
  assert.match(r.err, /terminal prompts disabled/);
  assert.ok(Date.now() - started < 20000, "it did not wait for input");
  assert.equal(rev(repo, "HEAD"), head, "the commit is still there");
}

// No remote at all: the plan says so, and push starts nothing.
{
  const repo = `${base}/no-remote`;
  mkdirSync(repo);
  sh(repo, "git init -q -b work && git config user.email t@t && git config user.name t && echo 1 > a.txt && git add -A && git commit -q -m first");
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, false);
  assert.match(plan.err, /no remote/i);
  worded(plan, "dialogs.push.noRemote");
  assert.equal(plan.branch, "work");
  const before = ran.length;
  const r = await push(git, repo);
  assert.equal(r.ok, false);
  assert.match(r.err, /no remote/i);
  worded(r, "dialogs.push.noRemote");
  assert.deepEqual(pushes(before), []);
}

// A detached HEAD has no branch to push.
{
  const { repo } = setup("detached");
  sh(repo, "git checkout -q --detach");
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, false);
  assert.match(plan.err, /detached/i);
  worded(plan, "dialogs.push.detached");
  const before = ran.length;
  const r = await push(git, repo);
  assert.equal(r.ok, false);
  worded(r, "dialogs.push.detached");
  assert.deepEqual(pushes(before), []);
}

// Nowhere to push: no "origin" for a branch without an upstream, or an upstream remote
// that isn't defined. Both name the branch and the remote.
{
  const { repo } = setup("no-origin");
  sh(repo, "git remote rename origin backup && git checkout -q -b lone");
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, false);
  assert.equal(plan.err, 'lone has no upstream branch and there is no remote named "origin".');
  worded(plan, "dialogs.push.noOrigin");
  assert.equal(plan.msg.args.branch, "lone");
  sh(repo, "git config branch.lone.remote gone && git config branch.lone.merge refs/heads/lone");
  const before = ran.length;
  const r = await push(git, repo);
  assert.equal(r.ok, false);
  assert.equal(r.err, 'The upstream remote "gone" of lone is not defined.');
  worded(r, "dialogs.push.upstreamUndefined");
  assert.deepEqual(r.msg.args, { remote: "gone", branch: "lone" });
  assert.deepEqual(pushes(before), []);
}

// A first push to an empty remote: every commit goes, and every file is new to it.
{
  const repo = `${base}/first`, remote = `${base}/first-remote.git`;
  mkdirSync(`${repo}/src`, { recursive: true });
  sh(repo, `git init -q -b work && git config user.email t@t && git config user.name t
echo 1 > src/a.ts && git add -A && git commit -q -m first && echo 2 > b.txt && git add -A && git commit -q -m second
git init -q --bare ${remote} && git remote add origin ${remote}`);
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual(plan.commits.map((c) => c.subject), ["second", "first"]);
  assert.equal(plan.commits[1].parent, null);
  assert.equal(plan.isNew, true);
  assert.deepEqual(byPath((await readPushFiles(git, repo)).files), [{ path: "b.txt", status: "added" }, { path: "src/a.ts", status: "added" }]);
  // The root commit alone: its own files.
  const root = await readPushFiles(git, repo, { from: plan.commits[1].parent, to: plan.commits[1].hash });
  assert.deepEqual(root.files, [{ path: "src/a.ts", status: "added" }]);
  assert.equal((await push(git, repo)).ok, true);
  assert.equal(remoteRef(remote, "work"), rev(repo, "HEAD"));
}

// A repository without commits has nothing to push.
{
  const repo = `${base}/unborn`, remote = `${base}/unborn-remote.git`;
  mkdirSync(repo);
  sh(repo, `git init -q -b work && git init -q --bare ${remote} && git remote add origin ${remote}`);
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual(plan.commits, []);
}

// A tag "main" next to a branch "heads/main", on main: `--short` would call the branch
// "heads/main". The plan, the Protected check and the push all mean main, and main
// tracks origin/main afterwards.
{
  const repo = `${base}/same-tag`, remote = `${base}/same-tag-remote.git`;
  mkdirSync(repo);
  sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo 1 > a.txt && git add -A && git commit -q -m first && git tag main
git update-ref refs/heads/heads/main HEAD && git checkout -q --detach && echo 2 > a.txt && git commit -q -am other
git update-ref refs/heads/heads/main HEAD && git checkout -q main
git init -q --bare ${remote} && git remote add origin ${remote}`);
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual([plan.branch, plan.target, plan.protected], ["main", "main", true]);
  const forced = await push(git, repo, { force: true });
  assert.equal(forced.ok, false);
  assert.match(forced.err, /protected branch "main"/);
  worded(forced, "dialogs.push.protected");
  const r = await push(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "main"), rev(repo, "refs/heads/main"));
  assert.equal(remoteRef(remote, "heads/main"), "");
  assert.equal(upstream(repo), "origin/main");
}

// A remote called "--force" is a remote, never git's --force: the branch goes there with
// an ordinary push.
{
  const { repo } = setup("dash-remote", "work");
  const remote = `${base}/dash-remote-2.git`;
  sh(repo, `git init -q --bare ${remote} && git remote add -- --force ${remote}
git config branch.work.remote --force && echo 2 > old.txt && git commit -q -am second`);
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.equal(plan.remote, "--force");
  const r = await push(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "work"), rev(repo, "HEAD"));
}

// Push All up to Here: the plan stops at the commit picked (newest first from there), its
// files are what reaching it changes, and the push sends that commit and nothing after it.
// A first push of the branch sets its upstream as a plain push does.
{
  const { repo, remote } = setup("up-to", "work");
  sh(repo, "git push -q --set-upstream origin work");
  writeFileSync(`${repo}/b.txt`, "b\n");
  const c1 = commitAll(repo, "c1");
  writeFileSync(`${repo}/c.txt`, "c\n");
  const c2 = commitAll(repo, "c2");
  writeFileSync(`${repo}/d.txt`, "d\n");
  commitAll(repo, "c3");
  const plan = await readPushPlan(git, repo, { upTo: c2.slice(0, 8) });
  assert.equal(plan.ok, true, plan.err);
  assert.equal(plan.upTo, c2);
  assert.deepEqual(plan.commits.map((c) => c.hash), [c2, c1]);
  const files = await readPushFiles(git, repo, { to: plan.upTo });
  assert.deepEqual(byPath(files.files), [{ path: "b.txt", status: "added" }, { path: "c.txt", status: "added" }]);
  const r = await push(git, repo, { upTo: c2 });
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "work"), c2);
  assert.deepEqual((await readPushPlan(git, repo, { upTo: c2 })).commits, []);

  // A new branch: the commit goes there, and the branch tracks it afterwards.
  sh(repo, "git checkout -q -b fresh");
  const p = await readPushPlan(git, repo, { upTo: c1 });
  assert.equal(p.ok, true, p.err);
  assert.equal(p.isNew, true);
  assert.equal(p.tracked, false);
  const first = await push(git, repo, { upTo: c1 });
  assert.equal(first.ok, true, first.err);
  assert.equal(remoteRef(remote, "fresh"), c1);
  assert.equal(upstream(repo), "origin/fresh");
}

// up to a commit that isn't on the current branch: refused, nothing pushed.
{
  const { repo, remote } = setup("up-to-elsewhere", "work");
  sh(repo, "git checkout -q -b side && echo s > s.txt && git add -A && git commit -q -m side");
  const side = rev(repo, "HEAD");
  sh(repo, "git checkout -q work");
  const before = remoteRef(remote, "work");
  const plan = await readPushPlan(git, repo, { upTo: side });
  worded(plan, "refs.notOnBranch");
  worded(await push(git, repo, { upTo: side }), "refs.notOnBranch");
  assert.equal(remoteRef(remote, "side"), "");
  assert.equal(remoteRef(remote, "work"), before);
}

// Force Push up to here: the lease is the same; the remote branch ends at that commit.
{
  const { repo, remote } = setup("up-to-force", "work");
  sh(repo, "git push -q --set-upstream origin work && echo x > x.txt && git add -A && git commit -q -m x && git push -q");
  sh(repo, "git reset -q --hard HEAD~1 && echo y > y.txt && git add -A && git commit -q -m y && echo z > z.txt && git add -A && git commit -q -m z");
  const y = rev(repo, "HEAD~1");
  const r = await push(git, repo, { upTo: y, force: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "work"), y);
}

// Push… on a local branch that isn't checked out: that branch's plan and push.
{
  const { repo, remote } = setup("other-branch", "work");
  sh(repo, "git checkout -q -b other && echo o > o.txt && git add -A && git commit -q -m other && git checkout -q work");
  const tip = rev(repo, "other");
  const plan = await readPushPlan(git, repo, { branch: "other" });
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual({ branch: plan.branch, remote: plan.remote, target: plan.target, tracked: plan.tracked }, { branch: "other", remote: "origin", target: "other", tracked: false });
  assert.deepEqual(plan.commits.map((c) => c.hash), [tip]);
  const files = await readPushFiles(git, repo, { to: tip, branch: "other" });
  assert.deepEqual(files.files, [{ path: "o.txt", status: "added" }]);
  const r = await push(git, repo, { branch: "other" });
  assert.equal(r.ok, true, r.err);
  assert.equal(remoteRef(remote, "other"), tip);
  assert.equal(sh(repo, "git rev-parse --abbrev-ref other@{u}").trim(), "origin/other");
  assert.equal(sh(repo, "git symbolic-ref --short HEAD").trim(), "work");
  const gone = await readPushPlan(git, repo, { branch: "nope" });
  assert.equal(gone.ok, false);
}

// The safety rule, over every program started above: no bare --force, no -f, no
// "+refspec" (the three ways to overwrite a remote branch without a lease). Each push ran
// with terminal prompts off, and each Force Push that reached git carried its lease.
// What follows --end-of-options or "--" is a name (a remote may be called "--force").
{
  const all = pushes();
  assert.ok(all.length >= 10, "the tests above did push");
  for (const call of ran) {
    const end = call.findIndex((arg) => arg === "--end-of-options" || arg === "--");
    for (const arg of end < 0 ? call : call.slice(0, end)) {
      assert.notEqual(arg, "--force", call.join(" "));
      assert.notEqual(arg, "-f", call.join(" "));
      assert.ok(!arg.startsWith("+"), call.join(" "));
      assert.ok(!/^--force(?!-with-lease=refs\/heads\/[^:]+:[0-9a-f]*$)/.test(arg), call.join(" "));
    }
  }
  for (const call of all) assert.deepEqual(call.slice(0, 3), ["env", "GIT_TERMINAL_PROMPT=0", "git"], call.join(" "));
  assert.equal(all.filter((call) => call.some((arg) => arg.startsWith("--force-with-lease="))).length, 4, "rewritten, lease, force-new, up-to-force");
}

// With a .mailmap the plan's commits name their authors as it maps them, the way the
// Commit list does; an author it doesn't name stays as written. (The plan above, in a
// repository without one, reads the names as committed.)
{
  const { repo } = setup("mailmap");
  writeFileSync(`${repo}/.mailmap`, "Test Mapped <mapped@example.com> <t@t>\n");
  const mapped = commitAll(repo, "by test person");
  writeFileSync(`${repo}/b.txt`, "b\n");
  sh(repo, `git add -A && git -c user.name=Other -c user.email=other@example.com commit -q -m "by other"`);
  const other = rev(repo, "HEAD");
  const plan = await readPushPlan(git, repo);
  assert.equal(plan.ok, true, plan.err);
  assert.deepEqual(plan.commits.map((c) => [c.hash, c.author]), [[other, "Other"], [mapped, "Test Mapped"]]);
}

console.log("ok");
