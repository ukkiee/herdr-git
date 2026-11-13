// node git-refs.test.mjs: new tag, branch rename, remote edit and remove, tag push,
// against throwaway repositories whose remote is a local bare repository (no app, no
// network). Every check reads the repositories back with git.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { createTag, renameBranch, readRemotes, readRemote, editRemote, fetchRemote, removeRemote, pushTag } from "./git-refs.js";
import { translator } from "./i18n.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_TERMINAL_PROMPT;

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-refs-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);
const rev = (repo, name) => sh(repo, `git rev-parse --verify --quiet ${name} || true`).trim();
const lines = (repo, cmd) => sh(repo, cmd).split("\n").filter(Boolean);
// A sentence this module words comes with msg: its key is in both tables, and the English
// sentence made from it is the err itself.
const en = translator("en"), ko = translator("ko");
const worded = (r, key) => {
  assert.equal(r.ok, false);
  assert.equal(r.msg?.key, key, r.err);
  assert.equal(en(r.msg.key, r.msg.args), r.err);
  assert.notEqual(ko(r.msg.key, r.msg.args), r.msg.key, `${key} has Korean`);
};

// A repository on main with two commits, its bare copy as `origin` that main tracks, and
// a branch `feature` one commit ahead. → { repo, remote }
const setup = (name) => {
  const repo = `${base}/${name}`, remote = `${base}/${name}-remote.git`;
  mkdirSync(repo, { recursive: true });
  sh(repo, `git init -q -b main && git config user.email t@t && git config user.name t
echo 1 > a && git add a && git commit -q -m one && echo 2 > a && git commit -q -am two
git clone -q --bare . ${remote} && git remote add origin ${remote} && git fetch -q origin && git branch -q --set-upstream-to=origin/main
git branch -q feature && git checkout -q feature && echo 3 > a && git commit -q -am three && git checkout -q main`);
  return { repo, remote };
};

// New tag: a lightweight tag on the commit asked for. A taken name and a name git won't
// take are refused with git's words, and no tag moves.
{
  const { repo } = setup("tag");
  const first = rev(repo, "main~1");
  const r = await createTag(git, repo, { name: "v1", commit: first });
  assert.equal(r.ok, true, r.err);
  assert.equal(rev(repo, "refs/tags/v1"), first);
  assert.equal(sh(repo, "git cat-file -t refs/tags/v1").trim(), "commit", "lightweight: the tag is the commit itself");

  const taken = await createTag(git, repo, { name: "v1", commit: rev(repo, "main") });
  assert.equal(taken.ok, false);
  assert.match(taken.err, /v1/);
  assert.equal(rev(repo, "refs/tags/v1"), first);

  for (const bad of ["bad name", "a..b", "-f", ""]) {
    const r = await createTag(git, repo, { name: bad, commit: first });
    assert.equal(r.ok, false, `"${bad}" is refused`);
    assert.ok(r.err, `"${bad}": git's words`);
  }
  assert.deepEqual(lines(repo, "git tag -l"), ["v1"]);
}

// Rename: another branch and the current one. The tracking setting goes with the name,
// HEAD follows a renamed current branch, the remote branch keeps its name. A taken name
// and a malformed one are refused and nothing moves.
{
  const { repo, remote } = setup("rename");
  sh(repo, "git branch -q --set-upstream-to=origin/main feature");
  const tip = rev(repo, "feature");
  const r = await renameBranch(git, repo, { from: "feature", to: "topic" });
  assert.equal(r.ok, true, r.err);
  assert.equal(rev(repo, "refs/heads/feature"), "");
  assert.equal(rev(repo, "refs/heads/topic"), tip);
  assert.equal(sh(repo, "git rev-parse --abbrev-ref topic@{u}").trim(), "origin/main");

  const current = await renameBranch(git, repo, { from: "main", to: "trunk" });
  assert.equal(current.ok, true, current.err);
  assert.equal(sh(repo, "git symbolic-ref HEAD").trim(), "refs/heads/trunk");
  assert.equal(sh(repo, "git rev-parse --abbrev-ref trunk@{u}").trim(), "origin/main");
  assert.deepEqual(lines(remote, "git for-each-ref --format='%(refname)' refs/heads"), ["refs/heads/main"]);

  const taken = await renameBranch(git, repo, { from: "topic", to: "trunk" });
  assert.equal(taken.ok, false);
  assert.match(taken.err, /trunk/);
  const bad = await renameBranch(git, repo, { from: "topic", to: "bad..name" });
  assert.equal(bad.ok, false);
  assert.ok(bad.err);
  assert.deepEqual(lines(repo, "git for-each-ref --format='%(refname:short)' refs/heads"), ["topic", "trunk"]);
  assert.equal(rev(repo, "refs/heads/topic"), tip);
}

// Remotes: the list and one remote's URL, as the Define Remote dialog starts from them.
{
  const { repo, remote } = setup("remotes-read");
  sh(repo, "git remote add -- -odd /nowhere");
  const list = await readRemotes(git, repo);
  assert.equal(list.ok, true, list.err);
  assert.deepEqual(list.remotes, ["-odd", "origin"]);
  const one = await readRemote(git, repo, "origin");
  assert.equal(one.ok, true, one.err);
  assert.deepEqual({ name: one.name, url: one.url }, { name: "origin", url: remote });
  assert.equal((await readRemote(git, repo, "-odd")).url, "/nowhere");
  const none = await readRemote(git, repo, "nope");
  assert.equal(none.ok, false);
  worded(none, "refs.noSuchRemote");
}

// Edit: a new name moves the remote branches and every branch that tracked it; a new URL
// is what the next fetch uses. Unchanged values are left alone; an empty name or URL and
// a taken name are refused before anything changes.
{
  const { repo, remote } = setup("remote-edit");
  const other = `${base}/remote-edit-other.git`;
  sh(base, `git clone -q --bare ${remote} ${other}`);
  const r = await editRemote(git, repo, { name: "origin", to: "up", url: other });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(lines(repo, "git remote"), ["up"]);
  assert.equal(sh(repo, "git remote get-url up").trim(), other);
  assert.equal(sh(repo, "git rev-parse --abbrev-ref main@{u}").trim(), "up/main");
  assert.ok(rev(repo, "refs/remotes/up/main"));
  assert.equal(rev(repo, "refs/remotes/origin/main"), "");

  const same = await editRemote(git, repo, { name: "up", to: "up", url: other });
  assert.equal(same.ok, true, same.err);
  const urlOnly = await editRemote(git, repo, { name: "up", to: "up", url: remote });
  assert.equal(urlOnly.ok, true, urlOnly.err);
  assert.equal(sh(repo, "git remote get-url up").trim(), remote);

  sh(repo, `git remote add second ${other}`);
  const taken = await editRemote(git, repo, { name: "up", to: "second", url: other });
  assert.equal(taken.ok, false);
  assert.ok(taken.err);
  worded(await editRemote(git, repo, { name: "up", to: " ", url: remote }), "refs.remoteNameEmpty");
  worded(await editRemote(git, repo, { name: "up", to: "up", url: "" }), "refs.remoteUrlEmpty");
  assert.deepEqual(lines(repo, "git remote"), ["second", "up"]);
  assert.equal(sh(repo, "git remote get-url up").trim(), remote);
}

// Fetch from the remote just defined: its branches arrive.
{
  const { repo, remote } = setup("remote-fetch");
  sh(base, `git -C ${remote} branch -q extra main`);
  const r = await fetchRemote(git, repo, "origin");
  assert.equal(r.ok, true, r.err);
  assert.ok(rev(repo, "refs/remotes/origin/extra"));
}

// Remove: the remote, its remote branches and the tracking settings that named it go.
{
  const { repo } = setup("remote-remove");
  const r = await removeRemote(git, repo, "origin");
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(lines(repo, "git remote"), []);
  assert.deepEqual(lines(repo, "git for-each-ref refs/remotes"), []);
  assert.equal(sh(repo, "git config --get branch.main.remote || true").trim(), "");
  assert.equal((await removeRemote(git, repo, "origin")).ok, false);
}

// Tag push: the tag lands on that remote as a tag; pushing it again changes nothing.
{
  const { repo, remote } = setup("tag-push");
  sh(repo, "git tag v1 main~1");
  const r = await pushTag(git, repo, { tag: "v1", remote: "origin" });
  assert.equal(r.ok, true, r.err);
  assert.equal(rev(remote, "refs/tags/v1"), rev(repo, "main~1"));
  assert.deepEqual(lines(remote, "git for-each-ref --format='%(refname)' refs/heads"), ["refs/heads/main"]);
  assert.equal((await pushTag(git, repo, { tag: "v1", remote: "origin" })).ok, true);
  assert.equal((await pushTag(git, repo, { tag: "nope", remote: "origin" })).ok, false);
}

console.log("ok");
