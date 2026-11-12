// node git-snapshot.test.mjs: Rollback snapshots listed and restored, against throwaway
// repositories (no app needed). Snapshots are made the way the app makes them, by rolling
// back; each case then reads the repository again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { rollback } from "./git-rollback.js";
import { listSnapshots, restore as restoreAs, wordRestore } from "./git-snapshot.js";
import { translator } from "./i18n.js";
import { readLog } from "./git-log.js";
import { readBranches } from "./git-branch.js";
import { readPushPlan } from "./git-push.js";
import { en } from "./messages-restore.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-snapshot-`));
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
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const entries = (repo) => sh(repo, "git ls-files -s -z");
// The entries of an index (entries' answer) but those of `paths`, one per item.
const without = (index, ...paths) => index.split("\0").filter((line) => line && !paths.some((path) => line.endsWith(`\t${path}`)));
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");
const files = (list) => list.map(([path, status]) => ({ path, status }));
// The id of the copy of git-tools that rolls back and restores (its scratch index's name).
const COPY = "0123456789abcdef";
const restore = (run, repo, options) => restoreAs(run, repo, { copy: COPY, ...options });
const back = async (repo, list, options = {}) => {
  const r = await rollback(git, repo, { files: files(list), copy: COPY, ...options });
  assert.equal(r.ok, true, r.err);
  return r.snapshot;
};
// What is at `path` on disk: a file's content, a link's target, a folder's entries, or nothing.
const onDisk = (repo, path) => {
  const full = `${repo}/${path}`;
  let stat;
  try { stat = lstatSync(full); } catch { return null; }
  if (stat.isSymbolicLink()) return { link: readlinkSync(full) };
  if (stat.isDirectory()) return { folder: readdirSync(full).sort().map((name) => [name, onDisk(repo, `${path}/${name}`)]) };
  return { file: readFileSync(full, "utf8") };
};

// Listed newest first, each with its time, its hash and its files' change against the
// HEAD it was made on. Nothing listed in a repository that never rolled back.
{
  const repo = init("list");
  sh(repo, "echo head > a && echo head > b && echo head > c && git add -A && git commit -q -m first");
  const none = await listSnapshots(git, repo);
  assert.equal(none.ok, true, none.err);
  assert.deepEqual(none.snapshots, []);

  writeFileSync(`${repo}/a`, "one\n");
  const first = await back(repo, [["a", "modified"]]);
  sh(repo, "rm b && echo new > -n && git add -- -n && echo two > c");
  const before = Math.floor(Date.now() / 1000);
  const second = await back(repo, [["b", "deleted"], ["-n", "added"], ["c", "modified"]], { deleteAdded: true });

  const r = await listSnapshots(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.snapshots.map((s) => s.hash), [second, first]);
  assert.deepEqual(r.snapshots[0].files, [
    { path: "-n", status: "added" },
    { path: "b", status: "deleted" },
    { path: "c", status: "modified" },
  ]);
  assert.deepEqual(r.snapshots[1].files, [{ path: "a", status: "modified" }]);
  assert.ok(Math.abs(r.snapshots[0].time - before) < 60, String(r.snapshots[0].time));
}

// A snapshot as one with a single parent is made (HEAD, no index held): `paths` recorded
// from the working tree, then rolled back by git itself. → its hash
const oldSnapshot = (repo, paths) => {
  const dir = sh(repo, "git rev-parse --absolute-git-dir").trim();
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}/old-snapshot-index` };
  const run = (args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  run(["read-tree", "HEAD"]);
  run(["update-index", "--add", "--remove", "--", ...paths]);
  const message = `Rollback: ${paths.length} ${paths.length === 1 ? "file" : "files"}`;
  const hash = run(["commit-tree", run(["write-tree"]), "-p", "HEAD", "-m", message]);
  sh(repo, `git update-ref --create-reflog -m "${message}" refs/git-tools/rollback ${hash}`);
  execFileSync("git", ["checkout", "-q", "HEAD", "--", ...paths], { cwd: repo });
  return hash;
};

// Snapshots with one parent and with two, mixed, are listed alike: the same times, files
// and statuses, the change against the first parent.
{
  const repo = init("list-mixed");
  sh(repo, "echo head > a && echo head > b && echo head > c && git add -A && git commit -q -m first");
  sh(repo, "echo old > a && rm b");
  const old = oldSnapshot(repo, ["a", "b"]);
  sh(repo, "echo staged > a && git add a && echo work > a && echo work > c");
  const fresh = await back(repo, [["a", "modified"], ["c", "modified"]]);
  sh(repo, "echo again > b");
  const older = oldSnapshot(repo, ["b"]);
  assert.equal(sh(repo, `git rev-list --parents -n 1 ${fresh}`).trim().split(" ").length, 3);

  const r = await listSnapshots(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.snapshots.map((s) => s.hash), [older, fresh, old]);
  assert.deepEqual(r.snapshots.map((s) => s.files), [
    [{ path: "b", status: "modified" }],
    [{ path: "a", status: "modified" }, { path: "c", status: "modified" }],
    [{ path: "a", status: "modified" }, { path: "b", status: "deleted" }],
  ]);
  for (const s of r.snapshots) assert.ok(Number.isInteger(s.time) && s.time > 0);
}

// A file name holding the bytes the list is read with (\x01, a tab, a line break) is one
// path of one snapshot.
{
  const repo = init("list-odd-names");
  const names = ["a\x01b", "t\tb", "n\nl"];
  for (const name of names) writeFileSync(`${repo}/${name}`, "head\n");
  sh(repo, "git add -A && git commit -q -m first");
  for (const name of names) writeFileSync(`${repo}/${name}`, "work\n");
  const snapshot = await back(repo, names.map((name) => [name, "modified"]));
  const r = await listSnapshots(git, repo);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.snapshots.map((s) => s.hash), [snapshot]);
  assert.deepEqual(r.snapshots[0].files, [...names].sort().map((path) => ({ path, status: "modified" })));
  assert.ok(Number.isInteger(r.snapshots[0].time) && r.snapshots[0].time > 0);
}

// Every rollback adds a snapshot, even one in the same second as the one before it with
// the same content (rolled back, restored, rolled back again). The message's first line
// stays "Rollback: N files".
{
  const repo = init("list-same-second");
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo work > a");
  const date = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_COMMITTER_DATE = "2026-01-02T03:04:05Z";
  try {
    const first = await back(repo, [["a", "modified"]]);
    assert.equal((await restore(git, repo, { snapshot: first, paths: ["a"] })).ok, true);
    const second = await back(repo, [["a", "modified"]]);
    const r = await listSnapshots(git, repo);
    assert.equal(r.snapshots.length, 2);
    assert.deepEqual(r.snapshots.map((s) => s.hash), [second, first]);
    assert.equal(sh(repo, "git reflog show --format=%H refs/git-tools/rollback").trim().split("\n").length, 2);
    assert.equal(sh(repo, `git log -1 --format=%s ${second}`).trim(), "Rollback: 1 file");
  } finally {
    if (date === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = date;
  }
}

// At most the newest 50 are listed.
{
  const repo = init("list-50");
  sh(repo, "echo head > a && git add -A && git commit -q -m first");
  const made = [];
  for (let i = 0; i < 52; i++) {
    writeFileSync(`${repo}/a`, `work ${i}\n`);
    made.push(await back(repo, [["a", "modified"]]));
  }
  const r = await listSnapshots(git, repo);
  assert.equal(r.snapshots.length, 50);
  assert.equal(r.snapshots[0].hash, made[51]);
  assert.equal(r.snapshots[49].hash, made[2]);
}

// Snapshots stay out of everything else: the Commit list read, the branch list, the tag
// list, and what a push would send.
{
  const repo = init("hidden");
  const remote = `${base}/hidden-remote.git`;
  sh(base, `git init -q --bare "${remote}"`);
  sh(repo, `echo head > a && git add -A && git commit -q -m first && git remote add origin "${remote}" && git push -q -u origin main`);
  sh(repo, "echo second > a && git commit -q -am second && echo work > a");
  const snapshot = await back(repo, [["a", "modified"]]);

  const log = await readLog(git, repo);
  assert.equal(log.ok, true, log.err);
  assert.equal(log.commits.length, 2);
  assert.ok(!log.commits.some((c) => c.hash === snapshot));
  const quick = await readLog(git, repo, { tags: false });
  assert.ok(!quick.commits.some((c) => c.hash === snapshot));
  const branches = await readBranches(git, repo);
  assert.deepEqual(branches.local.map((b) => b.name), ["main"]);
  assert.deepEqual(branches.remote.map((b) => b.name), ["origin/main"]);
  assert.equal(sh(repo, "git tag --list"), "");
  const plan = await readPushPlan(git, repo);
  assert.deepEqual(plan.commits.map((c) => c.subject), ["second"]);
}

// ---- Restore

// Each kind comes back as it was just before the rollback, in the working tree and in the
// index: a modified file's content and what was staged of it, a deleted file gone again,
// an added file back with its staged entry. Paths not chosen stay as they are. The
// snapshot is still there afterwards and Restore adds none.
{
  const repo = init("restore-kinds");
  mkdirSync(`${repo}/src`);
  sh(repo, "echo head > src/a && echo head > b && echo head > c && echo head > d && git add -A && git commit -q -m first");
  sh(repo, "echo staged > src/a && git add src/a && echo work > src/a && rm b && mkdir -p new && echo fresh > new/-n && git add new && echo work > c && echo work > d");
  const index = entries(repo);
  const snapshot = await back(repo, [["src/a", "modified"], ["b", "deleted"], ["new/-n", "added"], ["c", "modified"], ["d", "modified"]], { deleteAdded: true });

  const r = await restore(git, repo, { snapshot, paths: ["src/a", "b", "new/-n", "c"] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.restored.sort(), ["b", "c", "new/-n", "src/a"]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.stagingSkipped, []);
  assert.equal(text(repo, "src/a"), "work\n");
  assert.equal(text(repo, "c"), "work\n");
  assert.equal(existsSync(`${repo}/b`), false);
  assert.equal(text(repo, "new/-n"), "fresh\n");
  assert.equal(text(repo, "d"), "head\n");
  assert.equal(entries(repo), index);
  assert.deepEqual(status(repo), [" D b", " M c", "A  new/-n", "MM src/a"]);
  const list = await listSnapshots(git, repo);
  assert.deepEqual(list.snapshots.map((s) => s.hash), [snapshot]);
}

// Staging comes back for each kind: a staged change, a partly staged file, an added file,
// a staged deletion, and a file with nothing staged; `git status` and the index entries are
// what they were just before the rollback. A rolled-back path not chosen keeps HEAD's
// entry, and a path staged but not rolled back keeps what is staged.
{
  const repo = init("restore-staging");
  sh(repo, "for f in staged partly gone plain left other; do echo head > $f; done; git add -A && git commit -q -m first");
  sh(repo, `echo index > staged && git add staged && echo work > staged
printf 'head\\nindex\\n' > partly && git add partly && printf 'head\\nindex\\nwork\\n' > partly
git rm -q gone && echo plain-work > plain && echo new > fresh && git add fresh
echo left > left && git add left && echo staged-other > other && git add other`);
  const before = { index: entries(repo), status: status(repo) };
  const chosen = ["staged", "partly", "gone", "plain", "fresh"];
  const snapshot = await back(repo, [...chosen.map((path) => [path, path === "gone" ? "deleted" : path === "fresh" ? "added" : "modified"]), ["left", "modified"]], { deleteAdded: true });

  const r = await restore(git, repo, { snapshot, paths: chosen });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.restored.sort(), [...chosen].sort());
  assert.deepEqual(r.stagingSkipped, []);
  assert.deepEqual(status(repo), before.status.filter((line) => !line.endsWith(" left")));
  assert.deepEqual(without(entries(repo), "left"), without(before.index, "left"));
  assert.equal(sh(repo, "git ls-files -s -- left"), sh(repo, "git ls-tree HEAD -- left").replace(" blob ", " ").replace("\t", " 0\t"));
  assert.equal(text(repo, "left"), "head\n");
  assert.equal(sh(repo, "git show :partly"), "head\nindex\n");
  assert.equal(text(repo, "partly"), "head\nindex\nwork\n");
}

// The same snapshot can be restored again once its paths are back to HEAD.
{
  const repo = init("restore-twice");
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo work > a");
  const snapshot = await back(repo, [["a", "modified"]]);
  assert.equal((await restore(git, repo, { snapshot, paths: ["a"] })).ok, true);
  await back(repo, [["a", "modified"]]);
  const again = await restore(git, repo, { snapshot, paths: ["a"] });
  assert.equal(again.ok, true, again.err);
  assert.equal(text(repo, "a"), "work\n");
}

// In a repository without a commit, an added file comes back untracked.
{
  const repo = init("restore-unborn");
  sh(repo, "echo new > a && git add a");
  const snapshot = await back(repo, [["a", "added"]], { deleteAdded: true });
  assert.equal(existsSync(`${repo}/a`), false);
  const r = await restore(git, repo, { snapshot, paths: ["a"] });
  assert.equal(r.ok, true, r.err);
  assert.equal(text(repo, "a"), "new\n");
  assert.deepEqual(status(repo), ["?? a"]);
}

// Each skipped path comes back with its reason in English and its message key, which the
// Restore dialog's table has.
const skips = (r) => Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
const checkKeys = (r) => { for (const s of r.skipped) assert.ok(en[s.msg?.key], `${s.path}: ${s.msg?.key}`); };

// Added links come back as links, whatever they point at: a folder, a file, nothing, and
// staged as they were. Another copy of git-tools (another id) filling its own scratch index
// while this one writes changes nothing here, and neither does an index named without an id.
{
  const repo = init("restore-links");
  sh(repo, "echo head > a && git add -A && git commit -q -m first && mkdir folder && echo payload > file");
  sh(repo, "ln -s folder to-folder && ln -s file to-file && ln -s nowhere to-nothing && git add to-folder to-file to-nothing");
  const index = entries(repo);
  const snapshot = await back(repo, [["to-folder", "added"], ["to-file", "added"], ["to-nothing", "added"]], { deleteAdded: true });
  const dir = sh(repo, "git rev-parse --absolute-git-dir").trim();
  const wrong = sh(repo, "printf 'wrong\\n' | git hash-object -w --stdin").trim();
  const meddle = (name) => execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${wrong},to-file`], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: `${dir}/${name}` } });
  const run = async (cwd, args, options) => {
    if (options?.env?.GIT_INDEX_FILE && args[0] === "checkout-index") {
      meddle("git-tools-rollback-index-fedcba9876543210");
      meddle("git-tools-rollback-index");
    }
    return git(cwd, args, options);
  };
  run.read = git.read;

  const r = await restore(run, repo, { snapshot, paths: ["to-folder", "to-file", "to-nothing"] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.restored.sort(), ["to-file", "to-folder", "to-nothing"]);
  assert.equal(r.changed, true);
  assert.deepEqual(onDisk(repo, "to-folder"), { link: "folder" });
  assert.deepEqual(onDisk(repo, "to-file"), { link: "file" });
  assert.deepEqual(onDisk(repo, "to-nothing"), { link: "nowhere" });
  assert.equal(entries(repo), index);
  assert.equal(sh(repo, `GIT_INDEX_FILE="${dir}/git-tools-rollback-index-${COPY}" git ls-files`), "");
}

// A git call failing after an added file was written: the file is there, so the result
// says the repository changed, and names it restored. The later call here is the next
// file's write, the emptying of the scratch index, or any read of the repository.
for (const step of ["second", "empty", "read"]) {
  const repo = init(`restore-fails-after-${step}`);
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo one > n1 && echo two > n2 && git add n1 n2");
  const snapshot = await back(repo, [["n1", "added"], ["n2", "added"]], { deleteAdded: true });
  let writes = 0;
  const run = async (cwd, args, options) => {
    if (args[0] === "checkout-index" && ++writes === 2 && step === "second") return { ok: false, code: -1, out: "", err: "injected failure" };
    if (args[0] === "read-tree" && writes && step === "empty") return { ok: false, code: -1, out: "", err: "injected failure" };
    return git(cwd, args, options);
  };
  run.read = async (cwd, args, options) => (writes && step === "read" ? { ok: false, code: -1, out: "", err: "injected failure" } : git.read(cwd, args, options));
  const r = await restore(run, repo, { snapshot, paths: ["n1", "n2"] });
  assert.equal(r.changed, true, step);
  assert.equal(text(repo, "n1"), "one\n", step);
  assert.ok(r.restored.includes("n1"), step);
  if (step === "second") {
    assert.equal(r.ok, false);
    assert.equal(existsSync(`${repo}/n2`), false);
  }
}

// An added file's write that ends without a result (timed out: code -1) may have written
// the file all the same: the result says the repository changed, for the first file's
// write and for the second's. Before the second, the first was refused (something else
// is at its place), so no file is known to be restored when the second's result is lost.
for (const which of [1, 2]) {
  const repo = init(`restore-unknown-${which}`);
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo one > n1 && echo two > n2 && git add n1 n2");
  const snapshot = await back(repo, [["n1", "added"], ["n2", "added"]], { deleteAdded: true });
  if (which === 2) writeFileSync(`${repo}/n1`, "mine\n");
  let writes = 0;
  const run = async (cwd, args, options) => {
    if (args[0] === "checkout-index" && ++writes === which) {
      await git(cwd, args, options);
      return { ok: false, code: -1, out: "", err: "request timed out" };
    }
    return git(cwd, args, options);
  };
  run.read = git.read;
  const r = await restore(run, repo, { snapshot, paths: ["n1", "n2"] });
  assert.equal(r.ok, false, `write ${which}`);
  assert.equal(r.changed, true, `write ${which}`);
  assert.equal(existsSync(`${repo}/n${which}`), true, `write ${which}`);
}

// Without its copy's id, or with one that isn't lower-case hex, nothing is restored.
{
  const repo = init("restore-no-copy");
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo work > a && echo new > n && git add n");
  const snapshot = await back(repo, [["a", "modified"], ["n", "added"]], { deleteAdded: true });
  for (const copy of [undefined, "", "ABCDEF", "../x"]) {
    const r = await restoreAs(git, repo, { snapshot, paths: ["a", "n"], copy });
    assert.equal(r.ok, false, String(copy));
    assert.equal(r.changed, false, String(copy));
    assert.deepEqual(r.restored, [], String(copy));
    assert.equal(r.msg?.key, "restore.noCopy", String(copy));
    assert.ok(en[r.msg.key], String(copy));
    assert.equal(text(repo, "a"), "head\n", String(copy));
    assert.equal(existsSync(`${repo}/n`), false, String(copy));
  }
}

// git fails partway through a batch (a required smudge filter of "b" fails after "a" is
// written): what the disk now holds is said, not what the call promised. "a" is restored;
// "b", which git removed and couldn't write, is listed with its reason; the result says
// the repository changed. A path skipped before (changed after the rollback) is listed
// beside git's words, all of it worded again in a screen's language.
{
  const repo = init("restore-partial");
  sh(repo, "echo head > a && echo head > b && echo head > c && git add -A && git commit -q -m first && echo saved > a && echo saved > b && echo saved > c");
  const snapshot = await back(repo, [["a", "modified"], ["b", "modified"], ["c", "modified"]]);
  sh(repo, "echo edited > c && echo 'b filter=blocked' > .git/info/attributes && git config filter.blocked.clean cat && git config filter.blocked.smudge false && git config filter.blocked.required true");
  const index = entries(repo);

  const r = await restore(git, repo, { snapshot, paths: ["a", "b", "c"] });
  assert.equal(r.ok, false);
  assert.equal(r.changed, true);
  assert.deepEqual(r.restored, ["a"]);
  assert.deepEqual(skips(r), { b: "git failed while writing it: it is neither as HEAD has it nor as it was before the rollback", c: "it was changed after the rollback" });
  checkKeys(r);
  assert.equal(text(repo, "a"), "saved\n");
  assert.equal(existsSync(`${repo}/b`), false);
  assert.equal(text(repo, "c"), "edited\n");
  assert.equal(entries(repo), index);
  assert.match(r.err, /\nNot restored, to keep what is there now:\nc: it was changed after the rollback\nb: git failed while writing it[^\n]*$/);
  assert.equal(r.msg?.key, "restore.failedNotAll");
  const worded = (lang) => { const t = translator(lang), msg = wordRestore(t, r); return t(msg.key, msg.args); };
  assert.equal(worded("en"), r.err);
  assert.doesNotMatch(worded("ko"), /Not restored|git failed while|changed after/);
  assert.ok(worded("ko").startsWith(r.err.split("\nNot restored")[0]), "git's own words stay as they are");
}

// What changed after the rollback is never overwritten: a file changed again in the
// working tree (modified or deleted ones, also one deleted or edited since), a file whose
// HEAD version changed (a later commit), and a file flagged assume-unchanged or
// skip-worktree. Their disk and index stay as they are; the other paths are restored.
{
  const repo = init("restore-changed");
  sh(repo, `for f in edited gone-edited gone-again committed flagged plain; do echo head > $f; done
git add -A && git commit -q -m first`);
  sh(repo, "for f in edited committed flagged plain; do echo work > $f; done; rm gone-edited gone-again");
  const snapshot = await back(repo, [["edited", "modified"], ["gone-edited", "deleted"], ["gone-again", "modified"], ["committed", "modified"], ["flagged", "modified"], ["plain", "modified"]]);
  sh(repo, "echo mine > edited && echo mine > gone-edited && rm gone-again");
  sh(repo, "echo later > committed && git commit -q -m later -- committed");
  sh(repo, "git update-index --assume-unchanged flagged");
  const disk = () => ["edited", "gone-edited", "gone-again", "committed", "flagged"].map((path) => onDisk(repo, path));
  const before = { disk: disk(), index: entries(repo) };

  const r = await restore(git, repo, { snapshot, paths: ["edited", "gone-edited", "gone-again", "committed", "flagged", "plain"] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.restored, ["plain"]);
  assert.deepEqual(skips(r), {
    edited: "it was changed after the rollback",
    "gone-edited": "it was changed after the rollback",
    "gone-again": "it was changed after the rollback",
    committed: "HEAD has another version of it now",
    flagged: "git is told not to watch this file (assume-unchanged or skip-worktree); clear that flag to restore it",
  });
  checkKeys(r);
  assert.match(r.err, /^edited: it was changed after the rollback$/m);
  assert.equal(r.msg?.key, "restore.notAll");
  assert.ok(en["restore.notAll"]);
  assert.deepEqual(disk(), before.disk);
  assert.equal(entries(repo), before.index);
  assert.equal(text(repo, "plain"), "work\n");
}

// An added file comes back only where nothing is: a file, a folder, an empty folder, a
// link, or a file where a folder above it should be stays as it is, and so does a file git
// tracks there now. A file HEAD has by now (a later commit added it) is skipped too.
{
  const repo = init("restore-taken");
  sh(repo, "echo head > keep && git add -A && git commit -q -m first");
  const names = ["file", "folder", "empty", "link", "above/x", "linked/x", "tracked", "committed", "free"];
  for (const name of names) { mkdirSync(`${repo}/${name.split("/").slice(0, -1).join("/") || "."}`, { recursive: true }); writeFileSync(`${repo}/${name}`, `fresh ${name}\n`); }
  sh(repo, "git add -A");
  const snapshot = await back(repo, names.map((name) => [name, "added"]), { deleteAdded: true });
  sh(repo, `echo mine > file && mkdir folder && echo mine > folder/inside && mkdir empty
mkdir -p outside && echo mine > outside/x && ln -s outside link && rm -rf above linked && echo mine > above && ln -s outside linked
echo mine > committed && git add committed && git commit -q -m later -- committed && rm committed && echo mine > tracked && git add tracked`);
  const at = ["file", "folder", "empty", "link", "above", "linked", "outside", "tracked", "committed"];
  const disk = () => at.map((path) => onDisk(repo, path));
  const before = { disk: disk(), index: entries(repo) };

  const r = await restore(git, repo, { snapshot, paths: names });
  assert.equal(r.ok, false);
  assert.deepEqual(r.restored, ["free"]);
  const taken = "something is there on disk now";
  assert.deepEqual(skips(r), {
    file: taken, folder: taken, empty: taken, link: taken, "above/x": taken, "linked/x": taken,
    tracked: "git tracks a file at this path now",
    committed: "HEAD has another version of it now",
  });
  checkKeys(r);
  assert.deepEqual(disk(), before.disk);
  assert.deepEqual(without(entries(repo), "free"), without(before.index, "free"));
  assert.equal(text(repo, "free"), "fresh free\n");
  assert.equal(sh(repo, "git show :free"), "fresh free\n");
}

// An added file still on disk as the rollback recorded it (rolled back without deleting
// added files) counts as restored and is left untouched. "Same" is git's: a file whose
// line endings git converts when it records it is the same. A file with other content,
// one that differs only in its executable bit, and a link to a file with the recorded
// content stay skipped. The ones counted as restored are staged as they were; the index of
// the skipped ones is as it was.
{
  const repo = init("restore-same");
  sh(repo, `printf '*.crlf text eol=crlf\\n' > .gitattributes && echo head > keep && git add -A && git commit -q -m first
echo same > same && printf 'one\\r\\ntwo\\r\\n' > lines.crlf && echo other > other && echo mode > mode && echo target > linked && git add -A`);
  const names = ["same", "lines.crlf", "other", "mode", "linked"];
  const staged = entries(repo);
  const snapshot = await back(repo, names.map((name) => [name, "added"]));
  sh(repo, `echo changed > other && chmod +x mode && echo target > target && rm linked && ln -s target linked`);
  const stat = (path) => { const s = lstatSync(`${repo}/${path}`); return [s.ino, s.mtimeMs, s.mode]; };
  const before = { same: stat("same"), lines: stat("lines.crlf"), disk: ["other", "mode", "linked"].map((path) => onDisk(repo, path)), index: entries(repo) };

  const r = await restore(git, repo, { snapshot, paths: names });
  const taken = "something is there on disk now";
  assert.deepEqual(r.restored.slice().sort(), ["lines.crlf", "same"]);
  assert.deepEqual(skips(r), { other: taken, mode: taken, linked: taken });
  assert.equal(r.ok, false);
  assert.deepEqual(stat("same"), before.same);
  assert.deepEqual(stat("lines.crlf"), before.lines);
  assert.deepEqual(["other", "mode", "linked"].map((path) => onDisk(repo, path)), before.disk);
  assert.deepEqual(without(entries(repo), "same", "lines.crlf"), without(before.index));
  assert.deepEqual(without(entries(repo), "other", "mode", "linked"), without(staged, "other", "mode", "linked"));

  // All of them the same: nothing skipped, so ok.
  sh(repo, "git rm -q --cached same lines.crlf");
  const only = await restore(git, repo, { snapshot, paths: ["same", "lines.crlf"] });
  assert.equal(only.ok, true, only.err);
  assert.deepEqual(only.skipped, []);
}

// Another spelling the disk takes as the same name holds an added file's place: it stays.
if ((() => { const dir = mkdtempSync(`${base}/fold-`); writeFileSync(`${dir}/F`, ""); return existsSync(`${dir}/f`); })()) {
  const repo = init("restore-spelling");
  sh(repo, "echo head > keep && git add -A && git commit -q -m first && echo fresh > new && git add new");
  const snapshot = await back(repo, [["new", "added"]], { deleteAdded: true });
  writeFileSync(`${repo}/NEW`, "mine\n");
  const r = await restore(git, repo, { snapshot, paths: ["new"] });
  assert.deepEqual(skips(r), { new: "something is there on disk now" });
  assert.deepEqual(readdirSync(repo).filter((name) => name !== ".git").sort(), ["NEW", "keep"]);
  assert.equal(text(repo, "NEW"), "mine\n");
  // Also with the recorded content: it is another name, not the file restored.
  writeFileSync(`${repo}/NEW`, "fresh\n");
  const same = await restore(git, repo, { snapshot, paths: ["new"] });
  assert.deepEqual(skips(same), { new: "something is there on disk now" });
  assert.deepEqual(readdirSync(repo).filter((name) => name !== ".git").sort(), ["NEW", "keep"]);
}
// A folder spelled otherwise on disk holds the file too, even with the recorded content:
// "Dir/new.txt" is not back while the disk has "dir/new.txt". Two paths asked at once
// under one such folder stay as well. Under the folder spelled as recorded, the same
// content counts as restored, and is staged again (unstaged here after each round).
if ((() => { const dir = mkdtempSync(`${base}/fold-`); writeFileSync(`${dir}/F`, ""); return existsSync(`${dir}/f`); })()) {
  const repo = init("restore-folder-spelling");
  sh(repo, "echo head > keep && git add -A && git commit -q -m first && mkdir Dir Sub Same && echo fresh > Dir/new.txt && echo a > Sub/a && echo b > Sub/b && echo same > Same/x && git add -A");
  const snapshot = await back(repo, [["Dir/new.txt", "added"], ["Sub/a", "added"], ["Sub/b", "added"], ["Same/x", "added"]], { deleteAdded: true });
  sh(repo, "rmdir Dir Sub 2>/dev/null; mkdir -p dir sub Same && echo fresh > dir/new.txt && echo a > sub/a && echo b > sub/b && echo same > Same/x");
  const index = entries(repo);
  const taken = "something is there on disk now";
  for (const [paths, skipped, restored] of [
    [["Dir/new.txt"], ["Dir/new.txt"], []],
    [["Sub/a", "Sub/b"], ["Sub/a", "Sub/b"], []],
    [["Same/x"], [], ["Same/x"]],
    [["Dir/new.txt", "Sub/a", "Sub/b", "Same/x"], ["Dir/new.txt", "Sub/a", "Sub/b"], ["Same/x"]],
  ]) {
    const r = await restore(git, repo, { snapshot, paths });
    assert.deepEqual(skips(r), Object.fromEntries(skipped.map((path) => [path, taken])), paths.join());
    assert.deepEqual(r.restored, restored, paths.join());
    // Only the index changed, when Same/x was staged again.
    assert.equal(r.changed, restored.length > 0, paths.join());
    assert.deepEqual(readdirSync(repo).filter((name) => name !== ".git").sort(), ["Same", "dir", "keep", "sub"]);
    assert.equal(text(repo, "dir/new.txt"), "fresh\n");
    assert.deepEqual(without(entries(repo), "Same/x"), without(index));
    if (restored.length) {
      assert.equal(sh(repo, "git show :Same/x"), "same\n", paths.join());
      sh(repo, "git rm -q --cached Same/x");
    }
  }
} else console.log("skipped: the disk under the temporary folder tells F and f apart");

// A path the snapshot doesn't hold a change of is skipped; one that isn't a hash is refused.
{
  const repo = init("restore-not-in");
  sh(repo, "echo head > a && echo head > b && git add -A && git commit -q -m first && echo work > a");
  const snapshot = await back(repo, [["a", "modified"]]);
  const r = await restore(git, repo, { snapshot, paths: ["b", "nope"] });
  assert.deepEqual(skips(r), { b: "it isn't in this rollback", nope: "it isn't in this rollback" });
  checkKeys(r);
  const bad = await restore(git, repo, { snapshot: "--force", paths: ["a"] });
  assert.equal(bad.ok, false);
  assert.equal(bad.msg?.key, "restore.noSnapshot");
  assert.equal(text(repo, "a"), "head\n");
}

console.log("ok");
