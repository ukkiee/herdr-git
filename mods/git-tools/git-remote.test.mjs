// node git-remote.test.mjs: pull, branch update, project update and the Update Info range
// against throwaway repositories with a local bare remote (no app needed). Each case reads
// the repositories again with git itself: HEAD, branch positions, remote branches, the
// working tree, and what the commits hold.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { pull, readPullTargets, pullDefault, togglePullOption, splitRemoteBranch, readTracking, updateBranch, updateBranches, checkoutAndUpdate, updateProject, resetToRemote, readUpdate, failureText, branchesFailureText, cannotReach, remoteFailure } from "./git-remote.js";
import { push as pushBranch } from "./git-push.js";
import { pushTag, fetchRemote } from "./git-refs.js";
import { fetchAll } from "./git-branch.js";
import { smartRun } from "./git-smart.js";
import { translator } from "./i18n.js";
import { listSnapshots } from "./git-snapshot.js";

// The user's own git settings stay out of every git these tests start.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// A prompt would wait for a terminal these tests don't have.
process.env.GIT_ASKPASS = "";
process.env.SSH_ASKPASS = "";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-remote-`));
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

const lines = (word) => ["1", "2", "3", "4", "5"].map((n) => `${word}${n}`).join("\n") + "\n";
const write = (repo, path, text) => writeFileSync(`${repo}/${path}`, text);
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");
const edit = (repo, path, at, word) => {
  const all = text(repo, path).split("\n");
  all[at] = word;
  write(repo, path, all.join("\n"));
};
const rev = (repo, ref) => sh(repo, `git rev-parse --verify -q ${ref} || true`).trim();
const head = (repo) => rev(repo, "HEAD");
const branch = (repo) => sh(repo, "git symbolic-ref -q --short HEAD || true").trim();
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const subjects = (repo, range) => sh(repo, `git log --format=%s ${range}`).split("\n").filter(Boolean);
const parents = (repo, ref) => sh(repo, `git rev-list --parents -n 1 ${ref}`).trim().split(" ").length - 1;

// A bare remote, a clone "mine" on main tracking origin/main, and "theirs" that pushes.
// main: a.txt … d.txt. Also on the remote: feature (from main, adds f.txt).
let n = 0;
const setup = () => {
  const dir = `${base}/${++n}`;
  mkdirSync(dir, { recursive: true });
  sh(dir, "git init -q --bare -b main remote.git && git init -q -b main theirs");
  const theirs = `${dir}/theirs`, mine = `${dir}/mine`;
  sh(theirs, "git config user.email t@t && git config user.name them && git remote add origin ../remote.git");
  for (const f of ["a", "b", "c", "d"]) write(theirs, `${f}.txt`, lines(f));
  sh(theirs, "git add -A && git commit -q -m first && git push -q origin main 2>&1");
  sh(theirs, "git checkout -q -b feature && echo f > f.txt && git add f.txt && git commit -q -m feature && git push -q origin feature 2>&1 && git checkout -q main");
  sh(dir, "git clone -q remote.git mine 2>&1");
  sh(mine, "git config user.email m@m && git config user.name me");
  return { dir, mine, theirs };
};
// theirs commits a change to `path` (line `at`) on main and pushes it.
const push = (theirs, path, at, word, { to = "main" } = {}) => {
  sh(theirs, `git checkout -q ${to}`);
  edit(theirs, path, at, word);
  sh(theirs, `git commit -q -am ${word} && git push -q origin ${to} 2>&1`);
};
const commitMine = (mine, path, at, word) => { edit(mine, path, at, word); sh(mine, `git commit -q -am ${word}`); };

// ---- pull

// Pull with each option against the tracked remote branch: the commits and HEAD it
// leaves. The remote branch moves even when the merge step then fails.
{
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  const before = head(mine);
  const r = await pull(git, mine, { remote: "origin", branch: "main", options: ["--ff-only"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(r.ok, true);
  assert.equal(head(mine), rev(theirs, "main"), "fast-forwarded");
  assert.deepEqual(r.updated, { from: before, to: head(mine) });
  assert.equal(r.changed, true);

  // Diverged: --ff-only fails and changes nothing but the remote branch.
  push(theirs, "a.txt", 4, "their-a5");
  commitMine(mine, "b.txt", 0, "my-b1");
  const mineBefore = head(mine);
  const ff = await pull(git, mine, { remote: "origin", branch: "main", options: ["--ff-only"] });
  assert.equal(ff.outcome, "failed");
  assert.equal(ff.ok, false);
  assert.ok(ff.err, "git's words");
  assert.equal(head(mine), mineBefore);
  assert.equal(rev(mine, "origin/main"), rev(theirs, "main"), "fetched all the same");
  assert.equal(ff.changed, true);
  assert.equal(ff.updated, null);

  // --no-ff merges with a merge commit; --rebase replays mine on top.
  const merged = await pull(git, mine, { remote: "origin", branch: "main", options: ["--no-ff"] });
  assert.equal(merged.outcome, "done", merged.err);
  assert.equal(parents(mine, "HEAD"), 2);
  assert.deepEqual(subjects(mine, `${mineBefore}..HEAD`).slice(1), ["their-a5"]);
}
{
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  const r = await pull(git, mine, { remote: "origin", branch: "main", options: ["--rebase"] });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(mine, "HEAD"), ["my-b1", "their-a1", "first"]);
  assert.equal(rev(mine, "HEAD~1"), rev(theirs, "main"));
  // The Update Info range: what came in, not my replayed commit.
  const info = await readUpdate(git, mine, r.updated);
  assert.equal(info.ok, true, info.err);
  assert.deepEqual(info.commits.map((c) => c.subject), ["their-a1"]);
  assert.equal(info.files, 1);
}
{
  // --squash leaves the change staged, uncommitted. (On diverged branches git first wants
  // to be told how to reconcile them, as it does for a pull without options.)
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  const before = head(mine);
  const r = await pull(git, mine, { remote: "origin", branch: "main", options: ["--squash"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(mine), before);
  assert.deepEqual(status(mine), ["M  a.txt"]);
}
{
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  sh(mine, "printf '#!/bin/sh\\nexit 1\\n' > .git/hooks/pre-merge-commit && chmod +x .git/hooks/pre-merge-commit");
  const hooked = await pull(git, mine, { remote: "origin", branch: "main", options: ["--no-rebase"] });
  // The hook refused the merge commit: the merge waits in progress, as after a conflict.
  assert.equal(hooked.outcome, "stopped");
  assert.equal(hooked.operation.kind, "merge");
  sh(mine, "git merge --abort");
  const r = await pull(git, mine, { remote: "origin", branch: "main", options: ["--no-rebase", "--no-verify"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(parents(mine, "HEAD"), 2);
}
{
  // Another branch of the remote than the tracked one, and an option that isn't a pull
  // option is never passed on.
  const { mine } = setup();
  const r = await pull(git, mine, { remote: "origin", branch: "feature", options: ["--ff-only", "--exec=touch x"] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(mine), rev(mine, "origin/feature"));
  assert.equal(branch(mine), "main");
}
{
  // A conflict stops with the operation in progress; local changes in the way refuse it
  // with the files, and the repository stays as it was.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "a.txt", 0, "my-a1");
  const stopped = await pull(git, mine, { remote: "origin", branch: "main", options: ["--no-rebase"] });
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.operation.kind, "merge");
  assert.equal(stopped.ok, true);
  sh(mine, "git merge --abort");

  const { mine: m2, theirs: t2 } = setup();
  push(t2, "a.txt", 0, "their-a1");
  edit(m2, "a.txt", 4, "local-a5");
  edit(m2, "b.txt", 4, "local-b5");
  const before = status(m2);
  const refused = await pull(git, m2, { remote: "origin", branch: "main", options: [] });
  assert.equal(refused.outcome, "refused");
  assert.deepEqual(refused.blocked, ["a.txt"]);
  assert.deepEqual(status(m2), before);
  assert.deepEqual(refused.request, { type: "pull", remote: "origin", branch: "main", options: [], rebase: false, target: "origin/main" });

  // Smart runs the same request with the changes put away and brought back.
  const smart = await smartRun(git, m2, { request: refused.request });
  assert.equal(smart.outcome, "done", smart.err);
  assert.equal(rev(m2, "HEAD"), rev(t2, "main"));
  assert.deepEqual(status(m2), before);
  assert.equal(text(m2, "a.txt").split("\n")[0], "their-a1");
}
{
  // A repository set to pull by rebasing (pull.rebase, or the branch's own rebase setting)
  // and a pull without --rebase or --no-rebase: it rebases, so any tracked change is in
  // the way, and Smart can run it. --no-rebase still merges by the merge rule.
  for (const key of ["pull.rebase", "branch.main.rebase"]) {
    const { mine, theirs } = setup();
    push(theirs, "a.txt", 0, "their-a1");
    commitMine(mine, "c.txt", 0, "my-c1");
    sh(mine, `git config ${key} true`);
    edit(mine, "b.txt", 4, "local-b5");
    const before = status(mine);
    const refused = await pull(git, mine, { remote: "origin", branch: "main", options: [] });
    assert.equal(refused.outcome, "refused", `${key}: ${refused.err}`);
    assert.deepEqual(refused.blocked, ["b.txt"]);
    assert.equal(refused.request.rebase, true);
    assert.deepEqual(status(mine), before);
    const smart = await smartRun(git, mine, { request: refused.request });
    assert.equal(smart.outcome, "done", smart.err);
    // Rebased: my commit sits on theirs, no merge commit.
    assert.equal(rev(mine, "HEAD~1"), rev(theirs, "main"));
    assert.deepEqual(status(mine), before);
  }
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  sh(mine, "git config pull.rebase true");
  edit(mine, "b.txt", 4, "local-b5");
  // Where the repository stashes by itself (rebase.autoStash, merge.autoStash), git's own
  // stash stays out: the pull is refused the same way and no stash is left.
  for (const [config, options] of [["rebase.autoStash", ["--rebase"]], ["merge.autoStash", ["--no-rebase"]]]) {
    const { mine: m, theirs: t } = setup();
    push(t, "a.txt", 0, "their-a1");
    sh(m, `git config ${config} true`);
    edit(m, "a.txt", 4, "local-a5");
    const r = await pull(git, m, { remote: "origin", branch: "main", options });
    assert.equal(r.outcome, "refused", `${config}: ${r.err}`);
    assert.deepEqual([status(m), sh(m, "git stash list")], [[" M a.txt"], ""], config);
  }
  const merged = await pull(git, mine, { remote: "origin", branch: "main", options: ["--no-rebase"] });
  assert.equal(merged.outcome, "done", merged.err);
  assert.equal(merged.request?.rebase ?? false, false);
}
{
  // No tracked branch: the pull dialog's own pick still works; a bare pull fails with git's
  // words.
  const { mine } = setup();
  sh(mine, "git checkout -q -b lonely");
  const r = await pull(git, mine, { remote: "origin", branch: "feature", options: [] });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(mine), rev(mine, "origin/feature"));
  const t = await readPullTargets(git, mine);
  assert.equal(t.ok, true, t.err);
  assert.equal(t.branch, "lonely");
  assert.equal(t.upstream, null);
  assert.deepEqual(t.remotes, [{ name: "origin", branches: ["feature", "main"] }]);
}

// The pull dialog's targets and the default branch: a remembered one while it exists,
// else the tracked one, else the remote's branch of the same name, else the first.
{
  const { mine } = setup();
  const t = await readPullTargets(git, mine);
  assert.equal(t.branch, "main");
  assert.deepEqual(t.upstream, { remote: "origin", branch: "main" });
  assert.deepEqual(pullDefault(t, null), { remote: "origin", branch: "main" });
  assert.deepEqual(pullDefault(t, "origin/feature"), { remote: "origin", branch: "feature" });
  assert.deepEqual(pullDefault(t, "origin/gone"), { remote: "origin", branch: "main" });
  const lonely = { ...t, branch: "feature", upstream: null };
  assert.deepEqual(pullDefault(lonely, null), { remote: "origin", branch: "feature" });
  assert.deepEqual(pullDefault({ ...t, branch: "x", upstream: null }, null), { remote: "origin", branch: "feature" });
  assert.equal(pullDefault({ ok: true, branch: "x", upstream: null, remotes: [] }, null), null);
  // A remote whose name holds a slash: the longest remote that fits.
  sh(mine, "git remote add up/stream ../remote.git && git fetch -q up/stream 2>&1");
  assert.deepEqual(await splitRemoteBranch(git, mine, "up/stream/feature"), { remote: "up/stream", branch: "feature" });
  assert.deepEqual(await splitRemoteBranch(git, mine, "origin/feature"), { remote: "origin", branch: "feature" });
  assert.equal(await splitRemoteBranch(git, mine, "nowhere/feature"), null);
}

// The pull dialog's options: picking one takes off the ones it can't go with.
{
  assert.deepEqual(togglePullOption([], "--no-verify"), ["--no-verify"]);
  assert.deepEqual(togglePullOption(["--ff-only", "--no-verify"], "--rebase"), ["--rebase", "--no-verify"]);
  assert.deepEqual(togglePullOption(["--rebase"], "--squash"), ["--squash"]);
  assert.deepEqual(togglePullOption(["--squash", "--no-commit"], "--no-ff"), ["--no-ff", "--no-commit"]);
  assert.deepEqual(togglePullOption(["--no-ff"], "--no-ff"), []);
  assert.deepEqual(togglePullOption(["--no-ff", "--exec=x"], "--exec=y"), ["--no-ff"]);
}

// A remote that asks for a password fails at once instead of waiting, with the remote
// branch untouched and the credential hint flag.
{
  const server = createServer((_req, res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/repo.git`;
  const { mine } = setup();
  sh(mine, `git remote add asking ${url}`);
  const started = Date.now();
  const r = await pull(git, mine, { remote: "asking", branch: "main", options: [] });
  assert.equal(r.outcome, "failed");
  assert.equal(r.fetchFailed, true);
  assert.ok(r.err, "git's words");
  assert.ok(Date.now() - started < 20000, "did not wait");
  sh(mine, `git remote set-url origin ${url}`);
  const p = await updateProject(git, mine, { method: "merge" });
  assert.equal(p.outcome, "failed");
  assert.equal(p.fetchFailed, true);
  server.close();
}

// The words a failed pull or update is shown with, wherever it shows (the Pull dialog,
// the Commit panel's strip, a notification): the credential hint once when the fetch
// itself failed, first, then git's; git's alone when a later step failed.
{
  const en = translator("en"), ko = translator("ko");
  const { mine, theirs } = setup();
  sh(mine, `git remote add gone ${base}/no-such-remote.git`);
  const r = await pull(git, mine, { remote: "gone", branch: "main", options: [] });
  assert.equal(r.fetchFailed, true);
  const words = failureText(en, r);
  assert.equal(words, `${en("remote.credentialHint")}\n\n${r.err.trim()}`);
  assert.equal(failureText(ko, r), `${ko("remote.credentialHint")}\n\n${r.err.trim()}`);
  // git's words can run long: the dialog keeps only their first 4000 characters, and
  // a notification its first lines. The hint is in those either way.
  const long = failureText(en, { ...r, err: "x".repeat(5000) });
  assert.ok(long.startsWith(en("remote.credentialHint")), long.slice(0, 200));

  // Put aside by Smart and run again: still the fetch that failed.
  edit(mine, "a.txt", 0, "local-a1");
  const again = await smartRun(git, mine, { request: { type: "pull", remote: "gone", branch: "main", options: [], rebase: false, target: "gone/main" } });
  assert.equal(again.outcome, "failed");
  assert.ok(failureText(en, again).startsWith(en("remote.credentialHint")), failureText(en, again));

  // The merge step failed (diverged, --ff-only): git's words alone.
  sh(mine, "git checkout -q -- a.txt");
  push(theirs, "a.txt", 4, "their-a5");
  commitMine(mine, "b.txt", 0, "my-b1");
  const ff = await pull(git, mine, { remote: "origin", branch: "main", options: ["--ff-only"] });
  assert.equal(ff.outcome, "failed");
  assert.equal(failureText(en, ff), ff.err.trim());
  // A sentence of the module's own, in the screen's language.
  const picked = await pull(git, mine, { remote: "", branch: "", options: [] });
  assert.equal(failureText(ko, picked), ko("remote.pickBranch"));
  assert.equal(failureText(en, { ok: false, err: "" }), en("ui.gitFailed"));
}

// A push, a tag push and a fetch that could not talk to the remote get the credential
// hint once, first; a push the remote or a hook refused gets git's words alone. git
// answers 128 when it could not reach or read the remote, 1 when a push was refused
// (non-fast-forward, a stale lease, a pre-push or pre-receive hook) and when `fetch --all`
// could not fetch one of its remotes.
{
  const en = translator("en"), ko = translator("ko"), hint = en("remote.credentialHint");
  const { mine, theirs } = setup();
  sh(mine, `git remote add gone ${base}/no-such-remote.git`);
  const once = (words) => words.split(hint).length === 2;

  // A branch whose upstream is on a remote that isn't there.
  sh(mine, "git branch away && git config branch.away.remote gone && git config branch.away.merge refs/heads/away");
  const away = await pushBranch(git, mine, { branch: "away" });
  assert.equal(away.code, 128, away.err);
  assert.match(away.err, /does not appear to be a git repository\nfatal: Could not read from remote repository\./);
  assert.equal(cannotReach(away, "push"), true);
  const awayWords = remoteFailure(en, away, "push");
  assert.equal(awayWords.ok, false);
  assert.equal(awayWords.err, `${hint}\n\n${away.err.trim()}`);
  assert.equal(remoteFailure(ko, away, "push").err, `${ko("remote.credentialHint")}\n\n${away.err.trim()}`);

  // A remote that wants a password: nobody can type it here.
  const server = createServer((_req, res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  sh(mine, `git remote add asking http://127.0.0.1:${server.address().port}/repo.git`);
  sh(mine, "git branch locked && git config branch.locked.remote asking && git config branch.locked.merge refs/heads/locked");
  const locked = await pushBranch(git, mine, { branch: "locked" });
  server.close();
  assert.equal(locked.code, 128, locked.err);
  assert.ok(remoteFailure(en, locked, "push").err.startsWith(`${hint}\n\n`));

  // A tag pushed to a remote that isn't there.
  sh(mine, "git tag v1");
  const tag = await pushTag(git, mine, { tag: "v1", remote: "gone" });
  assert.equal(tag.code, 128, tag.err);
  assert.equal(remoteFailure(en, tag, "push").err, `${hint}\n\n${tag.err.trim()}`);

  // The Log panel's Fetch fetches every remote: one it can't reach makes it fail with 1.
  const all = await fetchAll(git, mine);
  assert.equal(all.code, 1, all.err);
  assert.match(all.err, /error: could not fetch gone/);
  assert.equal(cannotReach(all, "fetch"), true);
  assert.equal(remoteFailure(en, all, "fetch").err, `${hint}\n\n${all.err.trim()}`);
  // The fetch after a remote is defined fetches that one.
  const one = await fetchRemote(git, mine, "gone");
  assert.equal(one.code, 128, one.err);
  assert.ok(once(remoteFailure(en, one, "fetch").err));

  // git's words can run long: the dialog keeps their first 4000 characters, a
  // notification its first lines. The hint is in those either way, once.
  const long = remoteFailure(en, { ...away, err: "x".repeat(5000) }, "push").err;
  assert.ok(long.startsWith(hint) && once(long));

  // Refused: theirs moved main since mine last fetched.
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  const unseen = await pushBranch(git, mine, {});
  assert.equal(unseen.code, 1, unseen.err);
  assert.match(unseen.err, /! \[rejected\] +main -> main \(fetch first\)/);
  assert.equal(remoteFailure(en, unseen, "push").err, unseen.err.trim());
  sh(mine, "git fetch -q origin");
  const behind = await pushBranch(git, mine, {});
  assert.equal(behind.code, 1, behind.err);
  assert.match(behind.err, /! \[rejected\] +main -> main \(non-fast-forward\)/);
  assert.equal(cannotReach(behind, "push"), false);
  assert.equal(remoteFailure(en, behind, "push").err, behind.err.trim());

  // Force Push refused: theirs moved feature since mine last saw it.
  sh(mine, "git checkout -q -b feature origin/feature");
  push(theirs, "a.txt", 1, "their-f1", { to: "feature" });
  commitMine(mine, "c.txt", 0, "my-c1");
  const stale = await pushBranch(git, mine, { force: true });
  assert.equal(stale.code, 1, stale.err);
  assert.match(stale.err, /\(stale info\)/);
  assert.equal(remoteFailure(en, stale, "push").err, stale.err.trim());

  // A pre-push hook that says no.
  writeFileSync(`${mine}/.git/hooks/pre-push`, "#!/bin/sh\necho hook says no >&2\nexit 1\n");
  sh(mine, "chmod +x .git/hooks/pre-push && git checkout -q -b fresh");
  const hooked = await pushBranch(git, mine, {});
  assert.equal(hooked.code, 1, hooked.err);
  assert.match(hooked.err, /^hook says no\n/);
  assert.equal(remoteFailure(en, hooked, "push").err, hooked.err.trim());
  sh(mine, "rm .git/hooks/pre-push");

  // A pre-receive hook on the remote that says no.
  writeFileSync(`${theirs}/../remote.git/hooks/pre-receive`, "#!/bin/sh\necho server says no >&2\nexit 1\n");
  sh(theirs, "chmod +x ../remote.git/hooks/pre-receive");
  const declined = await pushBranch(git, mine, {});
  assert.equal(declined.code, 1, declined.err);
  assert.match(declined.err, /\(pre-receive hook declined\)/);
  assert.equal(remoteFailure(en, declined, "push").err, declined.err.trim());

  // Refused before git ran, in the module's own words: no hint.
  sh(mine, "git checkout -q --detach");
  const detached = await pushBranch(git, mine, {});
  assert.equal(cannotReach(detached, "push"), false);
  assert.equal(remoteFailure(ko, detached, "push").err, ko("dialogs.push.detached"));

  // Went well: the result as it was.
  const fine = { ok: true, code: 0, out: "", err: "" };
  assert.equal(remoteFailure(en, fine, "push"), fine);
}

// ---- updating a branch that isn't checked out: fast-forward only

{
  const { mine, theirs } = setup();
  sh(mine, "git branch --track feature origin/feature && git checkout -q -b work");
  push(theirs, "f.txt", 0, "their-f", { to: "feature" });
  const before = rev(mine, "feature"), here = head(mine);
  const r = await updateBranch(git, mine, { name: "feature" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(rev(mine, "feature"), rev(theirs, "feature"));
  assert.equal(branch(mine), "work", "not checked out");
  assert.equal(head(mine), here);
  assert.deepEqual(r.updated, { from: before, to: rev(mine, "feature") });

  // Nothing new: empty. Diverged: refused with the reason, nothing moves.
  assert.equal((await updateBranch(git, mine, { name: "feature" })).outcome, "empty");
  sh(mine, "git checkout -q feature && echo x > x.txt && git add x.txt && git commit -q -m mine-x && git checkout -q work");
  push(theirs, "f.txt", 0, "their-f2", { to: "feature" });
  const mineFeature = rev(mine, "feature");
  const diverged = await updateBranch(git, mine, { name: "feature" });
  assert.equal(diverged.outcome, "refused");
  assert.equal(diverged.msg.key, "remote.diverged");
  assert.equal(rev(mine, "feature"), mineFeature);

  // No tracked branch: refused with the reason.
  const none = await updateBranch(git, mine, { name: "work" });
  assert.equal(none.outcome, "refused");
  assert.equal(none.msg.key, "remote.noTracked");

  // Checked out in another worktree: git refuses, nothing moves.
  sh(mine, "git branch --track side origin/main");
  sh(mine, `git worktree add -q ${mine}-wt side 2>&1`);
  push(theirs, "a.txt", 0, "their-a1");
  const side = rev(mine, "side");
  const elsewhere = await updateBranch(git, mine, { name: "side" });
  assert.equal(elsewhere.outcome, "failed");
  assert.equal(rev(mine, "side"), side);

  // Several at once: each its own result, each remote fetched once.
  sh(mine, "git branch --track main2 origin/main");
  const all = await updateBranches(git, mine, { names: ["feature", "work"] });
  assert.deepEqual(all.results.map((x) => [x.name, x.outcome]), [["feature", "refused"], ["work", "refused"]]);
}
{
  // Several branches on a remote that can't be fetched: one fetch, every one of them
  // failed for it, and the notification's words give the credential hint once, first.
  const en = translator("en");
  const { mine } = setup();
  sh(mine, `git remote add gone ${base}/no-such-remote.git`);
  for (const b of ["b1", "b2"]) sh(mine, `git branch ${b} && git config branch.${b}.remote gone && git config branch.${b}.merge refs/heads/main`);
  let fetches = 0;
  const counting = Object.assign(async (cwd, args, options) => {
    if (args[0] === "fetch" && args.includes("gone")) fetches += 1;
    return git(cwd, args, options);
  }, { read: (cwd, args, options) => git.read(cwd, args, options) });
  const all = await updateBranches(counting, mine, { names: ["b1", "b2"] });
  assert.equal(fetches, 1);
  assert.deepEqual(all.results.map((x) => [x.name, x.outcome, x.fetchFailed]), [["b1", "failed", true], ["b2", "failed", true]]);
  assert.ok(all.results[1].err, "the second branch carries git's words too");
  const words = branchesFailureText(en, all.results);
  assert.ok(words.startsWith(`${en("remote.credentialHint")}\n\n`), words);
  assert.equal(words.split(en("remote.credentialHint")).length, 2, "the hint once");
  assert.ok(words.includes("\nb1: ") && words.includes("\nb2: "), words);
}
{
  // Branches on that remote mixed with branches on one that can be fetched: each remote
  // is fetched once, the failed fetch fails only its own remote's branches, and the others
  // update as usual. The words name only the failed ones.
  const en = translator("en");
  const { mine, theirs } = setup();
  sh(mine, `git remote add gone ${base}/no-such-remote.git`);
  for (const b of ["b1", "b2"]) sh(mine, `git branch ${b} && git config branch.${b}.remote gone && git config branch.${b}.merge refs/heads/main`);
  sh(mine, "git branch --track f1 origin/main && git branch --track f2 origin/feature");
  push(theirs, "f.txt", 0, "their-f", { to: "feature" });
  const fetches = { gone: 0, origin: 0 };
  const counting = Object.assign(async (cwd, args, options) => {
    if (args[0] === "fetch") for (const remote of Object.keys(fetches)) if (args.includes(remote)) fetches[remote] += 1;
    return git(cwd, args, options);
  }, { read: (cwd, args, options) => git.read(cwd, args, options) });
  const all = await updateBranches(counting, mine, { names: ["b1", "f1", "b2", "f2"] });
  assert.deepEqual(fetches, { gone: 1, origin: 1 });
  assert.deepEqual(all.results.map((x) => [x.name, x.outcome, Boolean(x.fetchFailed)]),
    [["b1", "failed", true], ["f1", "empty", false], ["b2", "failed", true], ["f2", "done", false]]);
  assert.equal(rev(mine, "f2"), rev(theirs, "feature"));
  assert.equal(all.ok, false);
  assert.equal(all.changed, true);
  const words = branchesFailureText(en, all.results);
  assert.ok(words.startsWith(`${en("remote.credentialHint")}\n\n`), words);
  assert.equal(words.split(en("remote.credentialHint")).length, 2, "the hint once");
  assert.ok(words.includes("\nb1: ") && words.includes("\nb2: "), words);
  assert.ok(!words.includes("\nf1: ") && !words.includes("\nf2: "), words);
}
{
  // The current branch updates as the project does, with the method given.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  const r = await updateBranch(git, mine, { name: "main", method: "rebase" });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(mine, "HEAD"), ["my-b1", "their-a1", "first"]);
}

// ---- Checkout and Update: the branch fast-forwards to its tracked branch, then is
// checked out. Local changes in the way refuse the checkout with the files.
{
  const { mine, theirs } = setup();
  sh(mine, "git branch --track feature origin/feature");
  push(theirs, "f.txt", 0, "their-f", { to: "feature" });
  const before = rev(mine, "feature");
  const r = await checkoutAndUpdate(git, mine, { name: "feature" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(branch(mine), "feature");
  assert.equal(head(mine), rev(theirs, "feature"));
  assert.deepEqual(r.updated, { from: before, to: head(mine) });

  sh(mine, "git checkout -q main");
  push(theirs, "f.txt", 0, "their-f2", { to: "feature" });
  write(mine, "f.txt", "mine\n");
  sh(mine, "git add f.txt");
  const blocked = await checkoutAndUpdate(git, mine, { name: "feature" });
  assert.equal(blocked.outcome, "refused");
  assert.deepEqual(blocked.blocked, ["f.txt"]);
  assert.deepEqual(blocked.request, { type: "checkout", name: "feature", remote: false });
  assert.equal(branch(mine), "main");
  assert.equal(rev(mine, "feature"), rev(theirs, "feature"), "updated before the checkout");
}

// ---- Update Project

{
  // Merge: the tracked branch merged in; the range is what came in.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  push(theirs, "c.txt", 0, "their-c1");
  commitMine(mine, "b.txt", 0, "my-b1");
  const before = head(mine);
  const r = await updateProject(git, mine, { method: "merge" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(parents(mine, "HEAD"), 2);
  // git's own message for the short name, though the full ref is what is merged.
  assert.equal(sh(mine, "git log -1 --format=%B").trim(), "Merge remote-tracking branch 'origin/main'");
  assert.deepEqual(r.updated, { from: before, to: head(mine) });
  const info = await readUpdate(git, mine, r.updated);
  assert.deepEqual(info.commits.map((c) => c.subject).filter((s) => !s.startsWith("Merge")), ["their-c1", "their-a1"]);
  assert.equal(info.files, 2);
  assert.equal((await updateProject(git, mine, { method: "merge" })).outcome, "empty", "nothing to update");
}
{
  // A local branch named like the tracked one ("origin/main") doesn't take its place.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  sh(mine, "git branch origin/main HEAD~1");
  const r = await updateProject(git, mine, { method: "merge" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(rev(mine, "HEAD^2"), rev(mine, "refs/remotes/origin/main"));
}
{
  // Rebase, with local changes put away and brought back (Smart), staging kept.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  edit(mine, "a.txt", 4, "local-a5");
  edit(mine, "c.txt", 0, "staged-c1");
  sh(mine, "git add c.txt");
  write(mine, "u.txt", "u\n");
  const before = status(mine);
  const r = await updateProject(git, mine, { method: "rebase", now: new Date(2026, 10, 13, 10, 30) });
  assert.equal(r.outcome, "done", r.err);
  assert.deepEqual(subjects(mine, "HEAD"), ["my-b1", "their-a1", "first"]);
  assert.deepEqual(status(mine), before);
  assert.equal(sh(mine, "git stash list").trim(), "", "the stash is dropped");
  const info = await readUpdate(git, mine, r.updated);
  assert.deepEqual(info.commits.map((c) => c.subject), ["their-a1"]);
}
{
  // A conflict stops the update with the operation in progress.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "a.txt", 0, "my-a1");
  const r = await updateProject(git, mine, { method: "rebase" });
  assert.equal(r.outcome, "stopped");
  assert.equal(r.operation.kind, "rebase");
  assert.equal(r.updated, null);
  sh(mine, "git rebase --abort");
}
{
  // No tracked branch, and a detached HEAD: refused with the reason, nothing fetched.
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  const remoteMain = rev(mine, "origin/main");
  sh(mine, "git checkout -q -b lonely");
  const lonely = await updateProject(git, mine, { method: "merge" });
  assert.equal(lonely.outcome, "refused");
  assert.equal(lonely.msg.key, "remote.noTracked");
  assert.equal(rev(mine, "origin/main"), remoteMain);
  sh(mine, "git checkout -q --detach");
  const detached = await updateProject(git, mine, { method: "merge" });
  assert.equal(detached.outcome, "refused");
  assert.equal(detached.msg.key, "remote.detached");
  assert.equal((await resetToRemote(git, mine, { copy: "0123456789abcdef" })).msg.key, "remote.detached");
}
{
  // Reset to the Remote Branch: local commits and changes go, recorded first as "Reset".
  const { mine, theirs } = setup();
  push(theirs, "a.txt", 0, "their-a1");
  commitMine(mine, "b.txt", 0, "my-b1");
  edit(mine, "c.txt", 0, "local-c1");
  const tracking = await readTracking(git, mine);
  assert.deepEqual(tracking, { ok: true, err: "", branch: "main", upstream: { ref: "refs/remotes/origin/main", name: "origin/main", remote: "origin", branch: "main" } });
  const r = await resetToRemote(git, mine, { copy: "0123456789abcdef" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(head(mine), rev(theirs, "main"));
  assert.deepEqual(status(mine), []);
  const list = await listSnapshots(git, mine);
  assert.equal(list.snapshots[0].hash, r.snapshot);
  assert.equal(list.snapshots[0].action, "Reset");
  assert.deepEqual(list.snapshots[0].files.map((f) => f.path), ["c.txt"]);
  // Not recorded: not reset.
  commitMine(mine, "b.txt", 0, "my-b1-again");
  edit(mine, "c.txt", 0, "local-c1");
  const kept = head(mine);
  const refused = await resetToRemote(git, mine, { copy: "not an id" });
  assert.equal(refused.ok, false);
  assert.equal(head(mine), kept);
}
{
  // A file the remote branch gained, untracked here: the reset writes over it, so it is
  // recorded too. An untracked file the remote lacks stays out.
  const { mine, theirs } = setup();
  sh(theirs, "echo theirs > new.txt && git add new.txt && git commit -q -m new && git push -q origin main 2>&1");
  write(mine, "new.txt", "MY UNTRACKED\n");
  write(mine, "loose.txt", "loose\n");
  const r = await resetToRemote(git, mine, { copy: "0123456789abcdef" });
  assert.equal(r.outcome, "done", r.err);
  assert.equal(text(mine, "new.txt"), "theirs\n");
  const list = await listSnapshots(git, mine);
  assert.equal(list.snapshots[0].hash, r.snapshot);
  assert.deepEqual(list.snapshots[0].files.map((f) => f.path), ["new.txt"]);
  assert.equal(sh(mine, `git show ${r.snapshot}:new.txt`), "MY UNTRACKED\n");
}

console.log("ok");
