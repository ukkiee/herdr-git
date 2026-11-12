// node git-rollback.test.mjs: rollback against throwaway repositories (no app needed).
// Each case rolls back, then reads the repository again with git itself.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { rollback as rollbackOnly, wordRollback } from "./git-rollback.js";
import { translator } from "./i18n.js";

// Every rollback below is also checked for its words (i18n.js): each skipped path's
// reason comes with a msg whose English is the reason itself, and a result the module
// worded comes with a msg whose English, its values worded again by wordRollback, is the
// err itself. Worded in Korean, none of the English reasons is left in it.
const en = translator("en"), ko = translator("ko");
const ENGLISH_REASON = /is there|git failed|git is told|could not be put back|rolled back, to keep/;
const keysSeen = new Set();
// The id of the copy of git-tools that rolls back (its scratch index is its own).
const COPY = "0123456789abcdef";
async function rollback(run, repo, options = {}) {
  const r = await rollbackOnly(run, repo, { copy: COPY, ...options });
  for (const skip of r.skipped ?? []) {
    assert.ok(skip.msg?.key?.startsWith("dialogs.rollback."), JSON.stringify(skip));
    assert.equal(en(skip.msg.key, skip.msg.args), skip.reason);
    keysSeen.add(skip.msg.key);
  }
  if (r.msg) {
    keysSeen.add(r.msg.key);
    const again = wordRollback(en, r);
    assert.equal(en(again.key, again.args), r.err);
    if (r.msg.key.startsWith("dialogs.rollback.")) {
      const worded = wordRollback(ko, r);
      assert.doesNotMatch(ko(worded.key, worded.args), ENGLISH_REASON, r.err);
    }
  } else if (r.skipped?.length) assert.fail(`skipped paths without msg: ${r.err}`);
  return r;
}

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-rollback-`));
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
// What git says about the whole repository, and about one path's index entry.
// -z: names come back as they are, not quoted.
const status = (repo) => sh(repo, "git status --porcelain=v1 -z --untracked-files=all").split("\0").filter(Boolean).sort();
const staged = (repo, path) => sh(repo, `git ls-files -s -- "${path}"`).trim();
const text = (repo, path) => readFileSync(`${repo}/${path}`, "utf8");

// A chosen modified file goes back to what HEAD has, whether the change was staged or
// not. Files that weren't chosen keep their content and their staging.
{
  const repo = init("modified");
  mkdirSync(`${repo}/src`);
  sh(repo, `echo head > src/a.ts && echo head > b.ts && echo head > other.ts && echo head > other-staged.ts
git add -A && git commit -q -m first`);
  writeFileSync(`${repo}/src/a.ts`, "work\n"); // modified, not staged
  sh(repo, "echo index > b.ts && git add b.ts && echo work > b.ts"); // staged, then changed again
  writeFileSync(`${repo}/other.ts`, "work\n");
  sh(repo, "echo index > other-staged.ts && git add other-staged.ts && echo work > other-staged.ts");
  const before = staged(repo, "other-staged.ts");

  const r = await rollback(git, repo, { files: [{ path: "src/a.ts", status: "modified" }, { path: "b.ts", status: "modified" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(text(repo, "src/a.ts"), "head\n");
  assert.equal(text(repo, "b.ts"), "head\n");
  assert.deepEqual(status(repo), [" M other.ts", "MM other-staged.ts"]);
  assert.equal(text(repo, "other.ts"), "work\n");
  assert.equal(text(repo, "other-staged.ts"), "work\n");
  assert.equal(staged(repo, "other-staged.ts"), before);
}

// A chosen deleted file comes back with HEAD's content, whether it was removed from the
// folder only or with `git rm`. A deleted file that wasn't chosen stays deleted.
{
  const repo = init("deleted");
  mkdirSync(`${repo}/docs`);
  sh(repo, `echo head > docs/gone.md && echo head > staged-gone.txt && echo head > stays-gone.txt
git add -A && git commit -q -m first`);
  sh(repo, "rm docs/gone.md stays-gone.txt && git rm -q staged-gone.txt");

  const r = await rollback(git, repo, { files: [{ path: "docs/gone.md", status: "deleted" }, { path: "staged-gone.txt", status: "deleted" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(text(repo, "docs/gone.md"), "head\n");
  assert.equal(text(repo, "staged-gone.txt"), "head\n");
  assert.deepEqual(status(repo), [" D stays-gone.txt"]);
  assert.equal(existsSync(`${repo}/stays-gone.txt`), false);
}

// A deleted file whose path is a folder now, or holds a file git doesn't track, is not
// rolled back: the folder's files (staged or not) and the untracked file keep their
// content and their index entries, and err names the path. The other chosen files are
// still rolled back.
{
  const repo = init("in-the-way");
  sh(repo, `echo head > dir-now && echo head > staged-dir && echo head > untracked && echo head > back.txt
git add -A && git commit -q -m first`);
  sh(repo, `rm dir-now staged-dir back.txt && mkdir dir-now staged-dir
echo mine > dir-now/inside && echo mine > staged-dir/inside && git add -A staged-dir
git rm -q --cached untracked && echo mine > untracked`);
  const before = status(repo), index = sh(repo, "git ls-files -s");

  const r = await rollback(git, repo, { files: ["dir-now", "staged-dir", "untracked", "back.txt"].map((path) => ({ path, status: "deleted" })) });
  assert.equal(existsSync(`${repo}/dir-now/inside`) && text(repo, "dir-now/inside"), "mine\n");
  assert.equal(existsSync(`${repo}/staged-dir/inside`) && text(repo, "staged-dir/inside"), "mine\n");
  assert.equal(text(repo, "untracked"), "mine\n");
  assert.equal(r.ok, false);
  for (const path of ["dir-now", "staged-dir", "untracked"]) assert.match(r.err, new RegExp(path));
  assert.equal(text(repo, "back.txt"), "head\n");
  assert.deepEqual(status(repo), before.filter((line) => !line.endsWith("back.txt")));
  // back.txt left the folder only, so its index entry was HEAD's all along.
  assert.equal(sh(repo, "git ls-files -s"), index);
}

// Checkout of `a/b` would replace whatever is at `a` with a folder. When something other
// than a folder is at a path above the one rolled back (a file or link git doesn't track,
// or a file git tracks that wasn't chosen), that path is not rolled back: what is there
// keeps its content and its index entry, and the reason names the path above. A path whose
// folders were removed whole, with nothing in their place, still comes back.
{
  const repo = init("above");
  sh(repo, `mkdir -p a link deep/x/y gone/sub staged && echo head > a/b && echo head > link/b && echo head > deep/x/y/z
echo head > gone/sub/c && echo head > staged/b && git add -A && git commit -q -m first`);
  sh(repo, `rm -rf a link deep/x gone staged && git add -u
echo mine > a && mkdir outside && echo mine > outside/b && ln -s outside link
echo mine > deep/x
echo mine > staged && git add staged`);
  const index = sh(repo, "git ls-files -s -- staged"), before = status(repo);

  const r = await rollback(git, repo, { files: ["a/b", "link/b", "deep/x/y/z", "gone/sub/c", "staged/b"].map((path) => ({ path, status: "deleted" })) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.skipped.sort((p, q) => p.path.localeCompare(q.path)).map(({ path, reason }) => ({ path, reason })), [
    { path: "a/b", reason: "a file git doesn't track is there at a" },
    { path: "deep/x/y/z", reason: "a file git doesn't track is there at deep/x" },
    { path: "link/b", reason: "a file git doesn't track is there at link" },
    { path: "staged/b", reason: "a file git tracks is there at staged" },
  ]);
  assert.deepEqual(r.skipped.map((skip) => skip.msg), [
    { key: "dialogs.rollback.skipUntrackedAt", args: { at: "a" } },
    { key: "dialogs.rollback.skipUntrackedAt", args: { at: "deep/x" } },
    { key: "dialogs.rollback.skipUntrackedAt", args: { at: "link" } },
    { key: "dialogs.rollback.skipTrackedAt", args: { at: "staged" } },
  ]);
  assert.equal(r.msg.key, "dialogs.rollback.notRolledBack");
  assert.match(r.err, /^a\/b: a file git doesn't track is there at a$/m);
  assert.equal(text(repo, "a"), "mine\n");
  assert.equal(text(repo, "deep/x"), "mine\n");
  assert.equal(lstatSync(`${repo}/link`).isSymbolicLink(), true);
  assert.equal(text(repo, "outside/b"), "mine\n");
  assert.equal(text(repo, "staged"), "mine\n");
  assert.equal(sh(repo, "git ls-files -s -- staged"), index);
  assert.equal(text(repo, "gone/sub/c"), "head\n");
  assert.deepEqual(status(repo), before.filter((line) => !line.endsWith("gone/sub/c")));
}

// What is at `path` on disk, to compare before and after: a file's content, a link's
// target, a folder's entries (each described the same way), or nothing.
const onDisk = (repo, path) => {
  const full = `${repo}/${path}`;
  let stat;
  try { stat = lstatSync(full); } catch { return null; }
  if (stat.isSymbolicLink()) return { link: readlinkSync(full) };
  if (stat.isDirectory()) return { folder: readdirSync(full).sort().map((name) => [name, onDisk(repo, `${path}/${name}`)]) };
  return { file: readFileSync(full, "utf8") };
};
const index = (repo, path) => sh(repo, `git ls-files -s -z -- ":(literal)${path}"`);

// Every kind of thing that can sit where a deleted file would come back, at the path itself
// or at a folder one or two levels above it, with the deletion staged or not: it keeps its
// content, link or files and its index entry, the path is skipped with a reason, and the
// path's index is as it was before the call. The one path with nothing in its way, in the
// same call, comes back.
{
  // kind → how to put it at `AT`. `self`: the deletions it is an obstacle for at the path
  // itself (a file put where the index still has the path is that file, modified; a staged
  // one is that file either way). `above` false: a folder above is no obstacle.
  const kinds = {
    untracked: { put: "echo mine > AT", self: ["staged"] },
    link: { put: "mkdir -p outside && echo mine > outside/f && ln -s outside AT", self: ["staged"] },
    staged: { put: "echo mine > AT && git add AT", self: [] },
    ignored: { put: "echo /AT >> .gitignore && echo mine > AT", self: ["staged"] },
    folder: { put: "mkdir AT && echo mine > AT/inside", self: ["staged", "unstaged"], above: false },
    empty: { put: "mkdir AT", self: ["staged", "unstaged"], above: false },
  };
  // where → [the path rolled back, where the obstacle sits], for an obstacle called `k`.
  const where = { self: (k) => [k, k], parent: (k) => [`${k}/x`, k], grandparent: (k) => [`${k}/m/x`, k] };
  for (const deletion of ["staged", "unstaged"]) {
    const repo = init(`obstacles-${deletion}`);
    const cases = [];
    for (const [kind, how] of Object.entries(kinds)) for (const [at, place] of Object.entries(where)) {
      if (at === "self" ? !how.self.includes(deletion) : how.above === false) continue;
      const [path, obstacle] = place(`${kind}-${at}`);
      cases.push({ kind, path, obstacle, put: how.put.replaceAll("AT", obstacle) });
    }
    for (const { path } of cases) { mkdirSync(`${repo}/${path.split("/").slice(0, -1).join("/") || "."}`, { recursive: true }); writeFileSync(`${repo}/${path}`, "head\n"); }
    mkdirSync(`${repo}/clean/m`, { recursive: true });
    writeFileSync(`${repo}/clean/m/x`, "head\n");
    sh(repo, "git add -A && git commit -q -m first");
    for (const { path, obstacle } of cases) sh(repo, `rm -rf "${obstacle}"`);
    sh(repo, "rm -rf clean");
    if (deletion === "staged") sh(repo, "git add -u");
    for (const { put } of cases) sh(repo, put);
    const before = Object.fromEntries(cases.map(({ path, obstacle }) => [path, { disk: onDisk(repo, obstacle), index: index(repo, obstacle) }]));
    const statusBefore = status(repo);

    const r = await rollback(git, repo, { files: [...cases.map(({ path }) => path), "clean/m/x"].map((path) => ({ path, status: "deleted" })) });
    assert.equal(r.ok, false, deletion);
    assert.deepEqual(r.skipped.map((skip) => skip.path).sort(), cases.map(({ path }) => path).sort(), deletion);
    for (const skip of r.skipped) assert.match(r.err, new RegExp(`^${skip.path}: ${skip.reason}$`, "m"));
    for (const { path, obstacle, kind } of cases) {
      assert.deepEqual(onDisk(repo, obstacle), before[path].disk, `${deletion} ${kind} ${path}`);
      assert.equal(index(repo, obstacle), before[path].index, `${deletion} ${kind} ${path}`);
    }
    assert.equal(text(repo, "clean/m/x"), "head\n");
    assert.deepEqual(status(repo), statusBefore.filter((line) => !line.endsWith("clean/m/x")), deletion);
  }
}

// A skipped path's index goes back to what it was before the call, whatever that was: a
// staged change of a file deleted since, or a conflict (its three sides). The same states
// with nothing in the way come back as HEAD's, in the index and on disk.
{
  const repo = init("index-states");
  sh(repo, `echo base > c-blocked && echo base > c-back && echo head > m-blocked && echo head > m-back && echo head > keep
git add -A && git commit -q -m base
git checkout -q -b other && echo theirs > c-blocked && echo theirs > c-back && git commit -q -am theirs
git checkout -q main && echo ours > c-blocked && echo ours > c-back && git commit -q -am ours
git merge -q other || true
echo staged > m-blocked && echo staged > m-back && git add m-blocked m-back
rm c-blocked c-back m-blocked m-back && mkdir c-blocked m-blocked`);
  const before = { c: index(repo, "c-blocked"), m: index(repo, "m-blocked") };
  assert.equal(before.c.split("\0").filter(Boolean).length, 3);

  const r = await rollback(git, repo, { files: [{ path: "c-blocked", status: "conflict" }, { path: "c-back", status: "conflict" }, { path: "m-blocked", status: "deleted" }, { path: "m-back", status: "deleted" }] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.skipped.sort((p, q) => p.path.localeCompare(q.path)).map(({ path, reason }) => ({ path, reason })), [
    { path: "c-blocked", reason: "something else is there on disk" },
    { path: "m-blocked", reason: "something else is there on disk" },
  ]);
  for (const skip of r.skipped) assert.equal(skip.msg.key, "dialogs.rollback.skipOnDisk");
  assert.match(r.err, /^c-blocked: something else is there on disk$/m);
  assert.equal(index(repo, "c-blocked"), before.c);
  assert.equal(index(repo, "m-blocked"), before.m);
  assert.deepEqual(onDisk(repo, "c-blocked"), { folder: [] });
  assert.deepEqual(onDisk(repo, "m-blocked"), { folder: [] });
  assert.equal(text(repo, "c-back"), "ours\n");
  assert.equal(text(repo, "m-back"), "head\n");
  assert.deepEqual(status(repo).filter((line) => /-back$/.test(line)), []);
}

// What the disk under the temporary folder treats as one name. These cases mean something
// only where the disk folds the names; elsewhere they are reported as skipped.
const sameFile = (one, other) => {
  const dir = mkdtempSync(`${base}/fold-`);
  writeFileSync(`${dir}/${one}`, "probe\n");
  return existsSync(`${dir}/${other}`);
};
const nfd = (name) => name.normalize("NFD"), nfc = (name) => name.normalize("NFC");

// A name the disk takes as the same place under another spelling (case, a letter with two
// lower cases, composed or decomposed) is in the way like the same spelling: an untracked
// file or folder there, at the path or above it, keeps its content, the path is skipped
// with a reason, and the path's index is as it was.
{
  const pairs = [["Fold", "fold"], ["Σ", "ς"], ["σ", "ς"], ["S", "ſ"], ["ẞ", "ß"], [nfc("é"), nfd("é")], [nfd("ü"), nfc("ü")]];
  for (const [name, other] of pairs) {
    if (!sameFile(name, other)) { console.log(`skipped: the disk under the temporary folder tells ${JSON.stringify(name)} and ${JSON.stringify(other)} apart`); continue; }
    for (const deletion of ["staged", "unstaged"]) {
      const repo = init(`fold-${[...name].map((c) => c.codePointAt(0).toString(16)).join("-")}-${deletion}`);
      mkdirSync(`${repo}/${name}`);
      mkdirSync(`${repo}/${name}-s`);
      for (const path of [`${name}/x`, `${name}.txt`, `${name}.d`, `${name}-s/x`, `${name}.st`]) writeFileSync(`${repo}/${path}`, "head\n");
      sh(repo, "git add -A && git commit -q -m first");
      // The paths as git lists them (the Commit panel's names): with core.precomposeunicode
      // on, git keeps a decomposed name composed.
      const [aboveStaged, folder, atStaged, at, above] = sh(repo, "git ls-files -z").split("\0").filter(Boolean).sort();
      for (const path of [name, `${name}-s`, at, folder, atStaged]) rmSync(`${repo}/${path}`, { recursive: true });
      // A file at the path itself under another spelling, with the deletion not staged, is
      // what git and the Commit panel take for the file, modified: not a deleted file.
      sh(repo, deletion === "staged" ? "git add -u" : `git rm -q --cached -- "${at}" "${atStaged}"`);
      writeFileSync(`${repo}/${other}`, "mine\n");
      writeFileSync(`${repo}/${other}.txt`, "mine\n");
      mkdirSync(`${repo}/${other}.d`);
      writeFileSync(`${repo}/${other}.d/inside`, "mine\n");
      // Files not chosen, staged under the other spelling: above the path, and at it.
      writeFileSync(`${repo}/${other}-s`, "mine\n");
      writeFileSync(`${repo}/${other}.st`, "mine\n");
      sh(repo, `git add -- "${other}-s" "${other}.st"`);
      const indexBefore = sh(repo, "git ls-files -s -z"), statusBefore = status(repo);
      // With core.precomposeunicode on, git stages a decomposed name composed: then it is
      // the chosen file itself, modified, and not in its way.
      const apart = indexBefore.split("\0").filter((entry) => entry.endsWith(".st")).length === 2;

      const label = `${name} against ${other}, ${deletion}`;
      const paths = [above, at, folder, aboveStaged, ...(apart ? [atStaged] : [])];
      const r = await rollback(git, repo, { files: paths.map((path) => ({ path, status: "deleted" })) });
      assert.equal(r.ok, false, label);
      assert.deepEqual(r.skipped.map((skip) => skip.path).sort(), paths.sort(), label);
      assert.equal(text(repo, other), "mine\n", label);
      assert.equal(lstatSync(`${repo}/${other}`).isFile(), true, label);
      assert.equal(text(repo, `${other}.txt`), "mine\n", label);
      assert.equal(text(repo, `${other}.d/inside`), "mine\n", label);
      assert.equal(text(repo, `${other}-s`), "mine\n", label);
      assert.equal(text(repo, `${other}.st`), "mine\n", label);
      assert.equal(sh(repo, "git ls-files -s -z"), indexBefore, label);
      assert.deepEqual(status(repo), statusBefore, label);
    }
  }
}

// A renamed file (listed as its old name deleted and its new name added) goes back: the old
// name returns, the new one is untracked, or deleted with deleteAdded. Deleted files with
// Korean and accented names come back too, deletion staged or not.
for (const deleteAdded of [false, true]) {
  const repo = init(`renamed-${deleteAdded}`);
  mkdirSync(`${repo}/새 폴더`);
  sh(repo, `echo head > old.txt && echo head > "새 폴더/삭제.md" && echo head > café.txt && echo head > "Ärger.md"
git add -A && git commit -q -m first && git mv old.txt new.txt
rm -r "새 폴더" café.txt Ärger.md && git rm -q --cached café.txt`);
  const [ärger, café] = sh(repo, "git ls-tree -r -z --name-only HEAD").split("\0").filter((name) => /^(Ä|caf)/.test(name.normalize("NFC"))).sort();

  const r = await rollback(git, repo, { files: [["old.txt", "deleted"], ["new.txt", "added"], ["새 폴더/삭제.md", "deleted"], [café, "deleted"], [ärger, "deleted"]].map(([path, status]) => ({ path, status })), deleteAdded });
  assert.equal(r.ok, true, r.err);
  assert.equal(text(repo, "old.txt"), "head\n");
  assert.equal(text(repo, "새 폴더/삭제.md"), "head\n");
  assert.equal(text(repo, café), "head\n");
  assert.equal(text(repo, ärger), "head\n");
  assert.deepEqual(status(repo), deleteAdded ? [] : ["?? new.txt"]);
  assert.equal(existsSync(`${repo}/new.txt`), !deleteAdded);
}

// 1,000 deleted files in one call, some staged and some not, with things in the way of a few
// spread through the list (an empty folder at the path; where the disk folds case, a file
// above under another case, which stops git's whole call): every other one comes back, and
// only the blocked ones are skipped.
{
  const repo = init("many-deleted");
  const folds = sameFile("Probe", "probe");
  const paths = Array.from({ length: 1000 }, (_, i) => `d${i % 7}/sub ${i % 3}/file-${String(i).padStart(4, "0")}.txt`);
  const empty = [17, 400, 401, 998].map((i) => paths[i]);
  const caseAbove = folds ? [3, 500].map((i) => paths[i]) : [];
  const blocked = new Set([...empty, ...caseAbove.map((path) => path.replace("file-", "F/file-"))]);
  const all = paths.map((path) => (caseAbove.includes(path) ? path.replace("file-", "F/file-") : path));
  for (const path of all) { mkdirSync(`${repo}/${path.split("/").slice(0, -1).join("/")}`, { recursive: true }); writeFileSync(`${repo}/${path}`, "head\n"); }
  sh(repo, "git add -A && git commit -q -m first");
  for (const path of all) rmSync(`${repo}/${path}`);
  for (const path of caseAbove) rmSync(`${repo}/${path.replace(/file-.*/, "F")}`, { recursive: true });
  sh(repo, "git add -u d1 d4");
  for (const path of empty) mkdirSync(`${repo}/${path}`);
  for (const path of caseAbove) writeFileSync(`${repo}/${path.replace(/file-.*/, "f")}`, "mine\n");
  const statusBefore = status(repo);

  const r = await rollback(git, repo, { files: all.map((path) => ({ path, status: "deleted" })) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.skipped.map((skip) => skip.path).sort(), [...blocked].sort());
  for (const path of all) if (!blocked.has(path)) assert.equal(text(repo, path), "head\n", path);
  for (const path of caseAbove) assert.equal(text(repo, path.replace(/file-.*/, "f")), "mine\n");
  assert.deepEqual(status(repo), statusBefore.filter((line) => [...blocked].some((path) => line.endsWith(path) || line.endsWith(path.replace(/F\/file-.*/, "f")))));
}

// In a repository whose git tells case and composition apart (core.ignorecase off), two
// names that differ only in composition are two files: rollback asks git about neither as
// the other's obstacle. Where the disk folds them, the disk refuses the second, and only
// that one is skipped, its index as it was.
{
  const repo = init("forms-apart");
  sh(repo, "git config core.ignorecase false && git config core.precomposeunicode false && echo head > keep && git add keep");
  const blob = (content) => sh(repo, `echo ${content} | git hash-object -w --stdin`).trim();
  const composed = "é.txt".normalize("NFC"), decomposed = "é.txt".normalize("NFD");
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob("composed")},${composed}`, "--cacheinfo", `100644,${blob("decomposed")},${decomposed}`], { cwd: repo });
  sh(repo, "git commit -q -m first");
  const indexBefore = sh(repo, "git ls-files -s -z");

  const r = await rollback(git, repo, { files: [composed, decomposed].map((path) => ({ path, status: "deleted" })) });
  for (const skip of r.skipped) assert.equal(skip.reason, "something else is there on disk");
  if (sameFile(composed, decomposed)) {
    assert.equal(r.skipped.length, 1);
    const [{ path: refused }] = r.skipped, written = refused === composed ? decomposed : composed;
    assert.equal(text(repo, written), `${written === composed ? "composed" : "decomposed"}\n`);
  } else {
    assert.equal(r.ok, true, r.err);
    assert.equal(text(repo, composed), "composed\n");
    assert.equal(text(repo, decomposed), "decomposed\n");
  }
  assert.equal(sh(repo, "git ls-files -s -z"), indexBefore);
}

// On a disk that tells case apart, `a` and `A/b/c` are different places: neither is in the
// other's way.
if (!sameFile("Probe", "probe")) {
  const repo = init("case-apart");
  sh(repo, "mkdir -p A/b && echo head > A/b/c && git add -A && git commit -q -m first && rm -rf A && git add -u && echo mine > a");
  const r = await rollback(git, repo, { files: [{ path: "A/b/c", status: "deleted" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(text(repo, "A/b/c"), "head\n");
  assert.equal(text(repo, "a"), "mine\n");
} else console.log("skipped: the disk under the temporary folder folds case, so a and A can't be told apart here");

// A newly added file is only untracked: it leaves the index and stays in the folder with
// what was written to it, staged or not. An added file that wasn't chosen stays added.
{
  const repo = init("added");
  mkdirSync(`${repo}/src`);
  sh(repo, "echo head > keep.txt && git add -A && git commit -q -m first");
  sh(repo, "echo new > src/new.ts && git add src/new.ts && echo newer > src/new.ts"); // staged, then changed again
  sh(repo, "echo new > later.ts && git add --intent-to-add later.ts"); // known to git, nothing staged
  sh(repo, "echo new > other-new.ts && git add other-new.ts");

  const r = await rollback(git, repo, { files: [{ path: "src/new.ts", status: "added" }, { path: "later.ts", status: "added" }] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), ["?? later.ts", "?? src/new.ts", "A  other-new.ts"]);
  assert.equal(text(repo, "src/new.ts"), "newer\n");
  assert.equal(text(repo, "later.ts"), "new\n");
}

// With deleteAdded a chosen added file is also removed from the folder. Added files that
// weren't chosen, and modified ones in the same call, are handled as without it.
{
  const repo = init("delete-added");
  mkdirSync(`${repo}/src/deep`, { recursive: true });
  sh(repo, "echo head > keep.txt && git add -A && git commit -q -m first");
  sh(repo, "echo new > src/deep/new.ts && git add src/deep/new.ts && echo newer > src/deep/new.ts");
  sh(repo, "echo new > later.ts && git add --intent-to-add later.ts");
  sh(repo, "echo new > other-new.ts && git add other-new.ts");
  writeFileSync(`${repo}/keep.txt`, "work\n");

  const r = await rollback(git, repo, {
    files: [{ path: "src/deep/new.ts", status: "added" }, { path: "later.ts", status: "added" }, { path: "keep.txt", status: "modified" }],
    deleteAdded: true,
  });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), ["A  other-new.ts"]);
  assert.equal(existsSync(`${repo}/src/deep/new.ts`), false);
  assert.equal(existsSync(`${repo}/later.ts`), false);
  assert.equal(text(repo, "other-new.ts"), "new\n");
  assert.equal(text(repo, "keep.txt"), "head\n");
}

// Unversioned Files are never touched, even when they're handed in and deleteAdded is on:
// git doesn't have them, so nothing could bring them back.
{
  const repo = init("unversioned");
  sh(repo, "echo head > keep.txt && git add -A && git commit -q -m first");
  writeFileSync(`${repo}/keep.txt`, "work\n");
  writeFileSync(`${repo}/scratch.txt`, "mine\n");
  writeFileSync(`${repo}/notes.txt`, "mine\n");

  for (const deleteAdded of [false, true]) {
    const r = await rollback(git, repo, { files: [{ path: "scratch.txt", status: "unversioned" }], deleteAdded });
    assert.equal(r.ok, true, r.err);
    assert.deepEqual(status(repo), [" M keep.txt", "?? notes.txt", "?? scratch.txt"]);
    assert.equal(text(repo, "scratch.txt"), "mine\n");
  }
  // The same file listed as "added" from a stale read (it was untracked again meanwhile):
  // still not deleted, and the rest of the call goes through.
  const r = await rollback(git, repo, { files: [{ path: "notes.txt", status: "added" }, { path: "keep.txt", status: "modified" }], deleteAdded: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), ["?? notes.txt", "?? scratch.txt"]);
  assert.equal(text(repo, "notes.txt"), "mine\n");
}

// Names are taken literally: a file called "*.ts" rolls back only itself, and names with
// spaces, Korean or a leading ":" work.
{
  const repo = init("names");
  mkdirSync(`${repo}/새 폴더`);
  sh(repo, `echo head > "*.ts" && echo head > a.ts && echo head > "my notes.md" && echo head > "새 폴더/한글 문서.md" && echo head > ":top" && echo head > "[ab].ts"
git add -A && git commit -q -m first`);
  for (const path of ["*.ts", "a.ts", "my notes.md", "새 폴더/한글 문서.md", ":top", "[ab].ts"]) writeFileSync(`${repo}/${path}`, "work\n");
  sh(repo, `echo new > "new *.ts" && echo new > "new a.ts" && git add "new *.ts" "new a.ts"`);

  const r = await rollback(git, repo, {
    files: [
      { path: "*.ts", status: "modified" }, { path: "my notes.md", status: "modified" }, { path: "새 폴더/한글 문서.md", status: "modified" },
      { path: ":top", status: "modified" }, { path: "[ab].ts", status: "modified" }, { path: "new *.ts", status: "added" },
    ],
    deleteAdded: true,
  });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), [" M a.ts", "A  new a.ts"]);
  assert.equal(text(repo, "a.ts"), "work\n");
  assert.equal(text(repo, "*.ts"), "head\n");
  assert.equal(text(repo, "새 폴더/한글 문서.md"), "head\n");
  assert.equal(existsSync(`${repo}/new *.ts`), false);
  assert.equal(text(repo, "new a.ts"), "new\n");
}

// In a repository without a commit every file is newly added: rolled back, it is only
// untracked.
{
  const repo = init("no-head");
  sh(repo, "echo new > a.ts && echo new > b.ts && git add a.ts b.ts");

  const r = await rollback(git, repo, { files: [{ path: "a.ts", status: "added" }] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), ["?? a.ts", "A  b.ts"]);
  assert.equal(text(repo, "a.ts"), "new\n");
}

// A file is untracked or deleted only when it was listed as added. Listed as modified but
// missing from HEAD (a stale list), git's refusal comes back and the file stays as it is.
{
  const repo = init("stale");
  sh(repo, "echo head > keep.txt && git add -A && git commit -q -m first");
  sh(repo, "echo new > fresh.ts && git add fresh.ts");

  const r = await rollback(git, repo, { files: [{ path: "fresh.ts", status: "modified" }], deleteAdded: true });
  assert.equal(r.ok, false);
  assert.match(r.err, /fresh\.ts/);
  assert.deepEqual(status(repo), ["A  fresh.ts"]);
  assert.equal(text(repo, "fresh.ts"), "new\n");
}

// The other way round: listed as added, but HEAD has it by now (it was committed after
// the list was read). It goes back to HEAD instead of being untracked or deleted.
{
  const repo = init("stale-added");
  sh(repo, "echo head > keep.txt && git add -A && git commit -q -m first");
  sh(repo, "echo new > fresh.ts && git add fresh.ts && git commit -q -m second && echo work > fresh.ts");

  const r = await rollback(git, repo, { files: [{ path: "fresh.ts", status: "added" }], deleteAdded: true });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), []);
  assert.equal(text(repo, "fresh.ts"), "new\n");
}

// Conflicted files: one HEAD has goes back to HEAD's side; one HEAD doesn't have (we
// deleted it, they changed it) is untracked like an added file.
{
  const repo = init("conflict");
  sh(repo, `echo base > both.txt && echo base > ours-gone.txt && git add -A && git commit -q -m base
git checkout -q -b other && echo theirs > both.txt && echo theirs > ours-gone.txt && git commit -q -am theirs
git checkout -q main && echo ours > both.txt && git rm -q ours-gone.txt && git commit -q -am ours
git merge -q other || true`);
  assert.deepEqual(status(repo), ["DU ours-gone.txt", "UU both.txt"]);

  const r = await rollback(git, repo, { files: [{ path: "both.txt", status: "conflict" }, { path: "ours-gone.txt", status: "conflict" }] });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), ["?? ours-gone.txt"]);
  assert.equal(text(repo, "both.txt"), "ours\n");
  assert.equal(text(repo, "ours-gone.txt"), "theirs\n");
}

// A long list (more than one command line holds) is rolled back whole, and the one file
// left out of it is not.
{
  const repo = init("many");
  const dir = "a-rather-long-folder-name/with-another-long-folder-name-inside";
  mkdirSync(`${repo}/${dir}`, { recursive: true });
  const paths = Array.from({ length: 2500 }, (_, i) => `${dir}/file-with-a-long-name-${String(i).padStart(4, "0")}.txt`);
  for (const path of paths) writeFileSync(`${repo}/${path}`, "head\n");
  sh(repo, "git add -A && git commit -q -m first");
  for (const path of paths) writeFileSync(`${repo}/${path}`, "work\n");
  const left = paths[1234];

  const r = await rollback(git, repo, { files: paths.filter((path) => path !== left).map((path) => ({ path, status: "modified" })) });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(status(repo), [` M ${left}`]);
  assert.equal(text(repo, left), "work\n");
}

// A file git is told not to watch (`assume-unchanged`, `skip-worktree`, both, or the
// assume-unchanged that core.ignoreStat puts on what git stages) is not rolled back,
// whatever its state: staged and gone with a link under another spelling of its folder
// above it, gone with an empty folder at its place, edited, edited behind a clean filter
// that fails, or added. Each is skipped with the reason, and the disk (the place, the
// folders above, the link and its target), the index entries and their flags are as they
// were. The files without a flag, in the same call, are rolled back.
{
  const folds = sameFile("Σ", "ς");
  for (const how of ["assume-unchanged", "skip-worktree", "both", "ignoreStat"]) {
    const repo = init(`flagged-${how}`);
    const flagged = ["Σ/x", "gone", "edited", "filtered", "new"], plain = ["plain", "plain-gone", "plain-new"];
    const tracked = ["Σ/x", "gone", "edited", "filtered", "plain", "plain-gone"];
    mkdirSync(`${repo}/Σ`);
    writeFileSync(`${repo}/.gitattributes`, "filtered filter=broken\n");
    for (const path of tracked) writeFileSync(`${repo}/${path}`, "head\n");
    sh(repo, "git add -A && git commit -q -m first");
    if (how === "ignoreStat") sh(repo, "git config core.ignoreStat true");
    for (const path of ["Σ/x", "gone", "edited", "filtered", "new", "plain-new"]) writeFileSync(`${repo}/${path}`, "staged\n");
    sh(repo, "git add -- Σ/x gone edited filtered new plain-new");
    if (how === "ignoreStat") sh(repo, "git update-index --no-assume-unchanged -- plain-new");
    if (how === "assume-unchanged" || how === "both") sh(repo, `git update-index --assume-unchanged -- ${flagged.join(" ")}`);
    if (how === "skip-worktree" || how === "both") sh(repo, `git update-index --skip-worktree -- ${flagged.join(" ")}`);
    // -v: a lower-case tag is assume-unchanged, S skip-worktree, s both.
    const tags = sh(repo, "git ls-files -v -z").split("\0").filter(Boolean);
    assert.deepEqual(tags.filter((line) => /^[a-zS] /.test(line)).map((line) => line.slice(2)).sort(), [...flagged].sort(), how);
    sh(repo, "git config filter.broken.clean false && git config filter.broken.smudge cat && git config filter.broken.required true");
    sh(repo, "echo work > edited && echo work > filtered && echo work > plain && rm plain-gone gone && mkdir gone");
    sh(repo, "rm -rf Σ && mkdir target && echo mine > target/x");
    if (folds) symlinkSync("target", `${repo}/ς`);
    const disk = () => ["Σ", "ς", "target", "gone", "edited", "filtered", "new"].map((name) => [name, onDisk(repo, name)]);
    const entry = (path) => sh(repo, `git ls-files -v -s -z -- ":(literal)${path}"`);
    const before = { disk: disk(), index: flagged.map(entry) };

    const files = [["Σ/x", "modified"], ["gone", "deleted"], ["edited", "modified"], ["filtered", "modified"], ["new", "added"], ["plain", "modified"], ["plain-gone", "deleted"], ["plain-new", "added"]];
    const r = await rollback(git, repo, { files: files.map(([path, status]) => ({ path, status })), deleteAdded: true });
    assert.equal(r.ok, false, how);
    assert.deepEqual(r.skipped.map((skip) => skip.path).sort(), [...flagged].sort(), how);
    for (const skip of r.skipped) assert.equal(skip.reason, "git is told not to watch this file (assume-unchanged or skip-worktree); clear that flag to roll it back", how);
    for (const path of flagged) assert.match(r.err, new RegExp(`^${path}: git is told not to watch`, "m"), how);
    assert.deepEqual(disk(), before.disk, how);
    assert.deepEqual(flagged.map(entry), before.index, how);
    assert.equal(text(repo, "plain"), "head\n", how);
    assert.equal(text(repo, "plain-gone"), "head\n", how);
    assert.equal(existsSync(`${repo}/plain-new`), false, how);
    assert.equal(sh(repo, "git diff HEAD --name-only -- plain plain-gone plain-new"), "", how);
  }
}

// The git runner with some calls failing: `fails(args, options)` picks them.
const failing = (fails) => {
  const failed = { ok: false, code: 1, out: "", err: "injected failure" };
  const run = async (cwd, args, options) => fails(args, options) ? failed : git(cwd, args, options);
  run.read = async (cwd, args, options) => fails(args, options) ? failed : git.read(cwd, args, options);
  return run;
};
// A call on the real index, not on the scratch index a snapshot is built in.
const real = (options) => !options?.env?.GIT_INDEX_FILE;
const entriesOf = (repo) => sh(repo, "git ls-files -s -z");

// When git can't say which files carry those flags, nothing is written: every chosen file
// keeps its content and index, and git's words come back.
{
  const repo = init("flags-unknown");
  sh(repo, "echo head > edited && echo head > gone && echo head > dropped && git add -A && git commit -q -m first");
  sh(repo, "echo staged > edited && git add edited && echo work > edited && rm gone && echo new > new && git add new");
  const before = { index: entriesOf(repo), status: status(repo) };
  const writes = [];
  const run = failing((args) => args.includes("ls-files") && args.includes("-v"));
  const watched = async (cwd, args, options) => { writes.push(args); return run(cwd, args, options); };
  watched.read = run.read;

  const files = [["edited", "modified"], ["gone", "deleted"], ["new", "added"]];
  const r = await rollback(watched, repo, { files: files.map(([path, status]) => ({ path, status })), deleteAdded: true });
  assert.equal(r.ok, false);
  assert.match(r.err, /injected failure/);
  assert.deepEqual(writes, []);
  assert.equal(entriesOf(repo), before.index);
  assert.deepEqual(status(repo), before.status);
  assert.equal(text(repo, "edited"), "work\n");
  assert.equal(text(repo, "new"), "new\n");
}

// Two deleted names the disk takes as one place, with their own staged content: when git
// can't check what was written (hash-object fails), neither counts as rolled back. Both are
// skipped, err names them, and the index is as it was. When the index can't be put back
// either, err says which paths, beside the first failure.
if (sameFile("F", "f")) {
  for (const undo of ["works", "fails"]) {
    const repo = init(`unchecked-${undo}`);
    sh(repo, "git config core.ignorecase false");
    const blob = (content) => sh(repo, `echo ${content} | git hash-object -w --stdin`).trim();
    sh(repo, `git update-index --add --cacheinfo 100644,${blob("head-F")},F --cacheinfo 100644,${blob("head-f")},f && git commit -q -m first`);
    sh(repo, `git update-index --cacheinfo 100644,${blob("staged-F")},F --cacheinfo 100644,${blob("staged-f")},f`);
    const before = entriesOf(repo);

    const run = failing((args, options) => args.includes("hash-object") || (undo === "fails" && args.includes("--cacheinfo") && real(options)));
    const r = await rollback(run, repo, { files: ["F", "f"].map((path) => ({ path, status: "deleted" })) });
    assert.equal(r.ok, false, undo);
    assert.deepEqual(r.skipped.map((skip) => skip.path).sort(), ["F", "f"], undo);
    for (const path of ["F", "f"]) assert.match(r.err, new RegExp(`^${path}: `, "m"), undo);
    if (undo === "works") assert.equal(entriesOf(repo), before);
    else {
      assert.match(r.err, /injected failure/);
      assert.match(r.err, /index could not be put back/);
      for (const skip of r.skipped) assert.match(skip.reason, /index could not be put back/);
    }
  }
} else console.log("skipped: the disk under the temporary folder tells F and f apart");

// Deleted files with something in their way: when one kind of index entry can't be put
// back (a staged deletion, here), the others still are, and that path's reason and err say
// its index was not put back.
{
  const repo = init("undo-fails");
  sh(repo, "echo head > removed && echo head > changed && git add -A && git commit -q -m first");
  sh(repo, "git rm -q removed && echo staged > changed && git add changed && rm changed && mkdir removed changed");
  const before = { removed: index(repo, "removed"), changed: index(repo, "changed") };

  const r = await rollback(failing((args, options) => args.includes("--force-remove") && real(options)), repo, { files: ["removed", "changed"].map((path) => ({ path, status: "deleted" })) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.skipped.map((skip) => skip.path).sort(), ["changed", "removed"]);
  assert.equal(index(repo, "changed"), before.changed);
  assert.match(r.skipped.find((skip) => skip.path === "removed").reason, /index could not be put back/);
  assert.doesNotMatch(r.skipped.find((skip) => skip.path === "changed").reason, /index could not be put back/);
  assert.match(r.err, /^removed$/m);
  assert.match(r.err, /injected failure/);
  assert.equal(r.skipped.find((skip) => skip.path === "removed").msg.key, "dialogs.rollback.skipOnDiskNotPutBack");
  assert.equal(r.msg.key, "dialogs.rollback.failedNotRolledBack");
  assert.equal(r.msg.cause.key, "dialogs.rollback.indexLost");
  assert.equal(lstatSync(`${repo}/removed`).isDirectory(), true);
  assert.equal(lstatSync(`${repo}/changed`).isDirectory(), true);
}

// Two deleted names the disk takes as one place, with the same content in HEAD but one of
// them executable: the one not written as HEAD has it (content and mode) is skipped, its
// index as it was.
if (sameFile("F", "f")) {
  const repo = init("same-content-mode");
  const blob = (content) => sh(repo, `echo ${content} | git hash-object -w --stdin`).trim();
  const head = blob("same"), mine = blob("staged");
  sh(repo, `git update-index --add --cacheinfo 100644,${head},F --cacheinfo 100755,${head},f && git commit -q -m first`);
  sh(repo, `git update-index --cacheinfo 100644,${mine},F --cacheinfo 100755,${mine},f`);
  const before = { F: index(repo, "F"), f: index(repo, "f") };

  const r = await rollback(git, repo, { files: ["F", "f"].map((path) => ({ path, status: "deleted" })) });
  const executable = (lstatSync(`${repo}/f`).mode & 0o111) !== 0;
  const notWritten = executable ? "F" : "f";
  assert.equal(r.ok, false);
  assert.ok(r.skipped.some((skip) => skip.path === notWritten), JSON.stringify(r));
  for (const skip of r.skipped) assert.equal(index(repo, skip.path), before[skip.path], skip.path);
}

// Nothing chosen: nothing happens. Outside a repository: git's words come back.
{
  const repo = init("nothing");
  sh(repo, "echo head > keep.txt && git add -A && git commit -q -m first && echo work > keep.txt");
  const none = await rollback(git, repo, { files: [] });
  assert.equal(none.ok, true);
  assert.deepEqual(status(repo), [" M keep.txt"]);

  const outside = `${base}/not-a-repo`;
  mkdirSync(outside);
  writeFileSync(`${outside}/a.ts`, "mine\n");
  const r = await rollback(git, outside, { files: [{ path: "a.ts", status: "added" }], deleteAdded: true });
  assert.equal(r.ok, false);
  assert.notEqual(r.err, "");
  assert.equal(text(outside, "a.ts"), "mine\n");
}

// ---- Rollback snapshot: what rollback records before it writes anything.

const SNAPSHOTS = "refs/git-tools/rollback";
const tip = (repo) => sh(repo, `git rev-parse -q --verify ${SNAPSHOTS} || true`).trim();
// The snapshot's change against its first parent (or against nothing, for a root snapshot).
const changes = (repo, hash) => sh(repo, `git diff-tree -r --root --no-renames --name-status -z --diff-merges=first-parent ${hash}`).split("\0").filter(Boolean)
  .slice(1).reduce((out, word, i, all) => (i % 2 ? out : [...out, `${word} ${all[i + 1]}`]), []).sort();
const blob = (repo, hash, path) => sh(repo, `git cat-file -p "${hash}:${path}"`);

// The snapshot is a commit on HEAD holding, for each path rolled back, what the working tree
// had: a modified file's content, a deleted file's absence, an added file's content. Paths
// skipped (a flagged file) and paths not chosen are not in it. The commit is the tip of
// refs/git-tools/rollback, with a reflog entry, and rollback returns its hash.
{
  const repo = init("snapshot");
  mkdirSync(`${repo}/src`);
  sh(repo, `echo head > src/mod.ts && echo head > staged.ts && echo head > gone.md && echo head > flagged && echo head > other.ts
git add -A && git commit -q -m first`);
  writeFileSync(`${repo}/src/mod.ts`, "work\n");
  sh(repo, "echo index > staged.ts && git add staged.ts && echo work-after-index > staged.ts");
  sh(repo, "rm gone.md && echo new > -new.ts && git add -- -new.ts");
  sh(repo, "echo work > flagged && git update-index --assume-unchanged flagged && echo work > other.ts");
  const head = sh(repo, "git rev-parse HEAD").trim();

  const files = [["src/mod.ts", "modified"], ["staged.ts", "modified"], ["gone.md", "deleted"], ["-new.ts", "added"], ["flagged", "modified"]];
  const r = await rollback(git, repo, { files: files.map(([path, status]) => ({ path, status })), deleteAdded: true });
  assert.equal(r.ok, false); // the flagged file is skipped
  assert.deepEqual(r.skipped.map((skip) => skip.path), ["flagged"]);
  assert.match(r.snapshot, /^[0-9a-f]{40,64}$/);
  assert.equal(tip(repo), r.snapshot);
  assert.equal(sh(repo, `git rev-parse ${r.snapshot}^1`).trim(), head);
  assert.equal(sh(repo, `git log -1 --format=%s ${r.snapshot}`).trim(), "Rollback: 4 files");
  assert.deepEqual(changes(repo, r.snapshot), ["A -new.ts", "D gone.md", "M src/mod.ts", "M staged.ts"]);
  assert.equal(blob(repo, r.snapshot, "src/mod.ts"), "work\n");
  assert.equal(blob(repo, r.snapshot, "staged.ts"), "work-after-index\n");
  assert.equal(blob(repo, r.snapshot, "-new.ts"), "new\n");
  assert.equal(sh(repo, `git reflog show --format=%H ${SNAPSHOTS}`).trim(), r.snapshot);
  // Then the files were rolled back.
  assert.equal(text(repo, "src/mod.ts"), "head\n");
  assert.equal(existsSync(`${repo}/-new.ts`), false);
  assert.equal(text(repo, "other.ts"), "work\n");
  // Not a branch or a tag: nothing a branch list, a tag list or HEAD's log shows.
  assert.equal(sh(repo, "git branch --list --format='%(refname)'").trim(), "refs/heads/main");
  assert.equal(sh(repo, "git tag --list").trim(), "");
  assert.equal(sh(repo, "git rev-parse HEAD").trim(), head);
}

// The snapshot's second parent holds each rolled-back path's index as it was just before
// the rollback, on HEAD's tree: a staged change, a partly staged file, an added file, a
// staged deletion, and a file with nothing staged (HEAD's). A path in a conflict can't be
// in a tree: it is HEAD's there, and the snapshot's message names it. Paths not rolled
// back are HEAD's, whatever is staged for them. The first parent and the change against
// it are what they are without a second parent.
{
  const repo = init("snapshot-index");
  sh(repo, `for f in staged partly gone plain clash other; do echo head > $f; done
git add -A && git commit -q -m first`);
  sh(repo, `echo index > staged && git add staged && echo work > staged
printf 'head\\nindex\\n' > partly && git add partly && printf 'head\\nindex\\nwork\\n' > partly
git rm -q gone && echo plain-work > plain && echo new > fresh && git add fresh
echo staged-other > other && git add other`);
  const old = sh(repo, "git rev-parse HEAD:clash").trim();
  const ours = sh(repo, "echo ours | git hash-object -w --stdin").trim(), theirs = sh(repo, "echo theirs | git hash-object -w --stdin").trim();
  sh(repo, `printf '0 ${"0".repeat(40)}\\tclash\\n100644 ${old} 1\\tclash\\n100644 ${ours} 2\\tclash\\n100644 ${theirs} 3\\tclash\\n' | git update-index --index-info`);
  writeFileSync(`${repo}/clash`, "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n");
  const head = sh(repo, "git rev-parse HEAD").trim();
  // "<mode> <object>" by path: of a tree ("<mode> blob <object>\t<path>"), and of the
  // index's stage-0 entries ("<mode> <object> 0\t<path>").
  const lines = (out) => out.split("\0").filter(Boolean).map((line) => [...line.split("\t")[0].split(" "), line.slice(line.indexOf("\t") + 1)]);
  const treeOf = (rev) => new Map(lines(sh(repo, `git ls-tree -r -z ${rev}`)).map(([mode, , object, path]) => [path, `${mode} ${object}`]));
  const stageZero = new Map(lines(sh(repo, "git ls-files -s -z")).filter(([, , stage]) => stage === "0").map(([mode, object, , path]) => [path, `${mode} ${object}`]));
  const expected = treeOf("HEAD");
  for (const path of ["staged", "partly", "fresh"]) expected.set(path, stageZero.get(path));
  expected.delete("gone");

  const files = [["staged", "modified"], ["partly", "modified"], ["gone", "deleted"], ["plain", "modified"], ["fresh", "added"], ["clash", "conflict"]];
  const r = await rollback(git, repo, { files: files.map(([path, status]) => ({ path, status })), deleteAdded: true });
  assert.equal(r.ok, true, r.err);
  assert.equal(sh(repo, `git rev-parse ${r.snapshot}^1`).trim(), head);
  assert.deepEqual(changes(repo, r.snapshot), ["A fresh", "D gone", "M clash", "M partly", "M plain", "M staged"]);
  assert.equal(blob(repo, r.snapshot, "partly"), "head\nindex\nwork\n");
  const second = sh(repo, `git rev-parse ${r.snapshot}^2`).trim();
  assert.deepEqual(treeOf(second), expected);
  assert.equal(blob(repo, second, "partly"), "head\nindex\n");
  assert.equal(sh(repo, `git log -1 --format=%s ${r.snapshot}`).trim(), "Rollback: 6 files");
  assert.match(sh(repo, `git log -1 --format=%B ${r.snapshot}`), /^Conflict: "clash"$/m);
  assert.doesNotMatch(sh(repo, `git log -1 --format=%B ${r.snapshot}`), /Conflict: "(staged|partly|gone|plain|fresh)"/);
  // Then the files and their index went back to HEAD.
  assert.deepEqual(status(repo), ["M  other"]);
}

// When the second parent can't be made (any one of the commits or trees a snapshot takes
// fails), nothing is rolled back and no snapshot is left.
for (const step of ["write-tree", "commit-tree"]) {
  for (const nth of [1, 2]) {
    const repo = init(`snapshot-index-fails-${step}-${nth}`);
    sh(repo, "echo head > a && echo head > b && git add -A && git commit -q -m first");
    sh(repo, "echo staged > a && git add a && echo work > a && rm b && echo new > n && git add n");
    const before = { index: entriesOf(repo), status: status(repo) };
    let seen = 0;
    const run = failing((args) => args.includes(step) && ++seen === nth);
    const r = await rollback(run, repo, { files: [["a", "modified"], ["b", "deleted"], ["n", "added"]].map(([path, status]) => ({ path, status })), deleteAdded: true });
    assert.equal(r.ok, false, `${step} ${nth}`);
    assert.equal(r.snapshot, null, `${step} ${nth}`);
    assert.equal(r.msg?.key, "restore.notRecorded", `${step} ${nth}`);
    assert.equal(entriesOf(repo), before.index, `${step} ${nth}`);
    assert.deepEqual(status(repo), before.status, `${step} ${nth}`);
    assert.equal(tip(repo), "", `${step} ${nth}`);
  }
}

// Making the snapshot changes nothing in the real index or the working tree: when the
// rollback is stopped by the first write after it, the repository is exactly as before.
{
  const repo = init("snapshot-touches-nothing");
  sh(repo, "echo head > a && echo head > b && echo head > c && git add -A && git commit -q -m first");
  sh(repo, "echo staged > a && git add a && echo work > a && rm b && echo new > n && git add n && echo work > c");
  const before = { index: entriesOf(repo), status: status(repo), a: text(repo, "a"), n: text(repo, "n") };

  const run = failing((args) => args.includes("checkout") || args.includes("checkout-index") || args.includes("rm"));
  const r = await rollback(run, repo, { files: [["a", "modified"], ["b", "deleted"], ["n", "added"]].map(([path, status]) => ({ path, status })), deleteAdded: true });
  assert.equal(r.ok, false);
  assert.match(r.snapshot, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(changes(repo, r.snapshot), ["A n", "D b", "M a"]);
  assert.equal(entriesOf(repo), before.index);
  assert.deepEqual(status(repo), before.status);
  assert.equal(text(repo, "a"), before.a);
  assert.equal(text(repo, "n"), before.n);
}

// When the snapshot can't be made, nothing is rolled back: every chosen file keeps its
// content and index, no snapshot is left, and the failure comes back.
for (const step of ["write-tree", "commit-tree", "update-ref"]) {
  const repo = init(`snapshot-fails-${step}`);
  sh(repo, "echo head > a && echo head > b && git add -A && git commit -q -m first");
  sh(repo, "echo staged > a && git add a && echo work > a && rm b && echo new > n && git add n");
  const before = { index: entriesOf(repo), status: status(repo) };

  const r = await rollback(failing((args) => args.includes(step)), repo, { files: [["a", "modified"], ["b", "deleted"], ["n", "added"]].map(([path, status]) => ({ path, status })), deleteAdded: true });
  assert.equal(r.ok, false, step);
  assert.equal(r.snapshot, null, step);
  assert.match(r.err, /injected failure/, step);
  assert.match(r.err, /^Nothing was rolled back/, step);
  assert.equal(r.msg?.key, "restore.notRecorded", step);
  assert.equal(entriesOf(repo), before.index, step);
  assert.deepEqual(status(repo), before.status, step);
  assert.equal(text(repo, "a"), "work\n", step);
  assert.equal(tip(repo), "", step);
}

// Each copy of git-tools builds its snapshots in a scratch index of its own, named with its
// id. Another copy (another app on this repository) rolling back between this copy's steps
// changes nothing in this copy's snapshot, and neither does an index named without an id
// (git-tools-rollback-index), which stays as it was. Both snapshots hold what each rolled
// back, and each copy's scratch index is left empty.
{
  const repo = init("snapshot-two-copies");
  sh(repo, "echo head > a && echo head > b && echo head > c && git add -A && git commit -q -m first && echo work-a > a && echo work-b > b");
  const dir = sh(repo, "git rev-parse --absolute-git-dir").trim();
  // An index named without an id, holding a file of its own.
  sh(repo, `GIT_INDEX_FILE="${dir}/git-tools-rollback-index" git read-tree HEAD && echo stray > stray && GIT_INDEX_FILE="${dir}/git-tools-rollback-index" git update-index --add stray && rm stray`);
  const shared = readFileSync(`${dir}/git-tools-rollback-index`);
  const OTHER = "fedcba9876543210";
  let other = null;
  const run = async (cwd, args, options) => {
    if (options?.env?.GIT_INDEX_FILE && args.includes("write-tree") && !other) {
      other = await rollback(git, repo, { files: [{ path: "b", status: "modified" }], copy: OTHER });
    }
    return git(cwd, args, options);
  };
  run.read = git.read;

  const r = await rollback(run, repo, { files: [{ path: "a", status: "modified" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(other.ok, true, other.err);
  assert.deepEqual(changes(repo, r.snapshot), ["M a"]);
  assert.equal(blob(repo, r.snapshot, "a"), "work-a\n");
  assert.deepEqual(changes(repo, other.snapshot), ["M b"]);
  assert.equal(blob(repo, other.snapshot, "b"), "work-b\n");
  assert.deepEqual(sh(repo, `git reflog show --format=%H ${SNAPSHOTS}`).trim().split("\n"), [r.snapshot, other.snapshot]);
  assert.equal(text(repo, "a"), "head\n");
  assert.equal(text(repo, "b"), "head\n");
  assert.deepEqual(readFileSync(`${dir}/git-tools-rollback-index`), shared);
  for (const id of [COPY, OTHER]) assert.equal(sh(repo, `GIT_INDEX_FILE="${dir}/git-tools-rollback-index-${id}" git ls-files`), "", id);
}

// Without its copy's id, or with one that isn't lower-case hex, nothing is recorded or
// rolled back, and no scratch index is written.
for (const copy of [undefined, "", "ABCDEF0123456789", "../../x", "0123456789abcdef/x"]) {
  const repo = init(`snapshot-no-copy-${JSON.stringify(copy ?? null).replace(/\W/g, "_")}`);
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo work > a && echo new > n && git add n");
  const before = { index: entriesOf(repo), status: status(repo) };
  const r = await rollback(git, repo, { files: [{ path: "a", status: "modified" }, { path: "n", status: "added" }], deleteAdded: true, copy });
  assert.equal(r.ok, false, String(copy));
  assert.equal(r.snapshot, null, String(copy));
  assert.equal(r.msg?.key, "restore.notRecorded", String(copy));
  assert.equal(r.msg.cause?.key, "restore.noCopy", String(copy));
  assert.equal(entriesOf(repo), before.index, String(copy));
  assert.deepEqual(status(repo), before.status, String(copy));
  assert.equal(text(repo, "a"), "work\n", String(copy));
  assert.equal(tip(repo), "", String(copy));
  const dir = sh(repo, "git rev-parse --absolute-git-dir").trim();
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("git-tools-")), [], String(copy));
  assert.equal(existsSync(`${base}/x`), false, String(copy));
}

// A conflicted path that is a link (to a folder, to a file, to nothing) is recorded as that
// link, and rolled back to HEAD's file.
for (const target of ["folder", "file", "none"]) {
  const repo = init(`snapshot-conflict-link-${target}`);
  sh(repo, "echo head > a && git add -A && git commit -q -m first");
  const old = sh(repo, "git rev-parse HEAD:a").trim();
  sh(repo, `printf '0 ${"0".repeat(40)}\\ta\\n100644 ${old} 1\\ta\\n100644 ${old} 2\\ta\\n100644 ${old} 3\\ta\\n' | git update-index --index-info`);
  if (target === "folder") mkdirSync(`${repo}/target`);
  if (target === "file") writeFileSync(`${repo}/target`, "payload\n");
  rmSync(`${repo}/a`);
  symlinkSync("target", `${repo}/a`);

  const r = await rollback(git, repo, { files: [{ path: "a", status: "conflict" }] });
  assert.equal(r.ok, true, `${target}: ${r.err}`);
  assert.match(sh(repo, `git ls-tree ${r.snapshot} a`), /^120000 blob /, target);
  assert.equal(blob(repo, r.snapshot, "a"), "target", target);
  assert.equal(text(repo, "a"), "head\n", target);
}

// Two copies rolling back the same file in the same state within the same second, both
// having read the same snapshot before theirs (their steps interleaved): two snapshots.
{
  const repo = init("snapshot-same-second-copies");
  sh(repo, "echo head > a && git add -A && git commit -q -m first && echo work > a");
  const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "2026-01-02T03:04:05Z";
  try {
    let reached, release, moved;
    const atA = new Promise((resolve) => { reached = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const refA = new Promise((resolve) => { moved = resolve; });
    const runner = (who) => {
      const run = async (cwd, args, options) => {
        if (who === "B" && args.includes("update-ref")) await refA;
        const r = await git(cwd, args, options);
        if (who === "A" && args.includes("update-ref")) moved();
        return r;
      };
      run.read = async (cwd, args, options) => {
        const r = await git.read(cwd, args, options);
        if (args[0] === "rev-parse" && args.at(-1) === SNAPSHOTS) {
          if (who === "A") { reached(); await barrier; } else release();
        }
        return r;
      };
      return run;
    };
    const files = [{ path: "a", status: "modified" }];
    const a = rollback(runner("A"), repo, { files });
    await atA;
    // B starts once A has read the snapshot before its own, and B's id is another.
    sh(repo, "echo work > a");
    const b = rollback(runner("B"), repo, { files, copy: "fedcba9876543210" });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true, ra.err);
    assert.equal(rb.ok, true, rb.err);
    assert.notEqual(ra.snapshot, rb.snapshot);
    assert.deepEqual(sh(repo, `git reflog show --format=%H ${SNAPSHOTS}`).trim().split("\n"), [rb.snapshot, ra.snapshot]);
    for (const hash of [ra.snapshot, rb.snapshot]) assert.equal(sh(repo, `git log -1 --format=%s ${hash}`).trim(), "Rollback: 1 file");
  } finally {
    for (const [name, value] of [["GIT_AUTHOR_DATE", saved.author], ["GIT_COMMITTER_DATE", saved.committer]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// The scratch index given another path between the snapshot's steps: the tree changes a
// path that wasn't asked for, so no snapshot is made and nothing is rolled back. "empties":
// emptied just before the tree is written (every other tracked path missing from it).
const MEDDLES = {
  empties: [["read-tree", "--empty"]],
  adds: [["update-index", "--add", "--", "other"]],
};
for (const meddle of Object.keys(MEDDLES)) {
  const repo = init(`snapshot-meddled-${meddle}`);
  sh(repo, "echo head > a && echo head > b && echo head > other && git add -A && git commit -q -m first");
  sh(repo, "echo staged > a && git add a && echo work > a && rm b && echo new > n && git add n && echo work > other");
  const before = { index: entriesOf(repo), status: status(repo), a: text(repo, "a") };
  const run = async (cwd, args, options) => {
    const scratch = options?.env?.GIT_INDEX_FILE;
    if (scratch && args.includes("write-tree")) {
      const env = { ...process.env, GIT_INDEX_FILE: scratch };
      for (const step of MEDDLES[meddle]) execFileSync("git", step, { cwd, env });
    }
    return git(cwd, args, options);
  };
  run.read = git.read;

  const r = await rollback(run, repo, { files: [["a", "modified"], ["b", "deleted"], ["n", "added"]].map(([path, status]) => ({ path, status })), deleteAdded: true });
  assert.equal(r.ok, false, meddle);
  assert.equal(r.snapshot, null, meddle);
  assert.equal(r.msg?.key, "restore.notRecorded", meddle);
  assert.match(r.err, /^Nothing was rolled back/, meddle);
  assert.equal(entriesOf(repo), before.index, meddle);
  assert.deepEqual(status(repo), before.status, meddle);
  assert.equal(text(repo, "a"), before.a, meddle);
  assert.equal(text(repo, "n"), "new\n", meddle);
  assert.equal(tip(repo), "", meddle);
  // The words of why: a key of their own, so a Korean screen shows none of them in English.
  assert.equal(r.msg.cause?.key, "restore.recordChanged", meddle);
  const worded = wordRollback(ko, r);
  assert.doesNotMatch(ko(worded.key, worded.args), /recorded|rollback|Try again/, meddle);
}

// Nothing to roll back (every chosen path skipped, or none chosen): no snapshot.
{
  const repo = init("snapshot-none");
  sh(repo, "echo head > flagged && git add -A && git commit -q -m first && echo work > flagged && git update-index --skip-worktree flagged");
  const skipped = await rollback(git, repo, { files: [{ path: "flagged", status: "modified" }] });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.snapshot, null);
  const none = await rollback(git, repo, { files: [] });
  assert.equal(none.snapshot, null);
  assert.equal(tip(repo), "");
}

// In a repository without a commit, the snapshot has no parent and holds the added files.
{
  const repo = init("snapshot-unborn");
  sh(repo, "echo new > a && git add a");
  const r = await rollback(git, repo, { files: [{ path: "a", status: "added" }] });
  assert.equal(r.ok, true, r.err);
  assert.equal(sh(repo, `git rev-list --parents -n 1 ${r.snapshot}`).trim(), r.snapshot);
  assert.deepEqual(changes(repo, r.snapshot), ["A a"]);
  assert.equal(text(repo, "a"), "new\n");
}

// Every key a skipped path or a worded result came with is one of the module's, and the
// kinds every disk reaches did come back above.
const KEYS = ["skipFlagged", "skipOnDisk", "skipOnDiskNotPutBack", "skipUnchecked", "skipUncheckedNotPutBack", "skipFolder",
  "skipUntracked", "skipUntrackedAt", "skipTrackedAt", "notRolledBack", "failedNotRolledBack", "indexLost", "failedIndexLost"].map((name) => `dialogs.rollback.${name}`);
for (const key of keysSeen) assert.ok(KEYS.includes(key) || key === "restore.notRecorded", key);
for (const key of KEYS) assert.notEqual(en(key), key, `${key} is in the table`);
for (const key of ["skipFlagged", "skipOnDisk", "skipOnDiskNotPutBack", "skipFolder", "skipUntrackedAt", "skipTrackedAt", "notRolledBack", "failedNotRolledBack"]) {
  assert.ok(keysSeen.has(`dialogs.rollback.${key}`), `a rollback above came back with ${key}`);
}

console.log("ok");
