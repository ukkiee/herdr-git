// node conflicts-model.test.mjs: what the Conflicts dialog shows and allows, from the
// operation in progress (git-operation.js readOperation), with no app. The words are
// checked in both languages through the message tables, the way the dialog words them.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { heading, columns, sortFiles, controls, pick, editedSince, stoppedOnConflicts } from "./conflicts-model.js";
import { translator } from "./i18n.js";
import { makeGit } from "./git.js";
import { readVersions } from "./git-conflict.js";
import { continueOperation } from "./git-operation.js";

const en = translator("en"), ko = translator("ko");
// A line of the heading as the dialog writes it: a message, or text shown as it is.
const say = (t, lines) => lines.map((line) => (line.key ? t(line.key, line.args) : line.text));

const conflict = (path, ours = "modified", theirs = "modified") => ({ path, xy: "UU", ours, theirs });
const NONE = { kind: null, target: null, rebasing: null, current: null, step: null, sequence: false, message: "", conflicts: [], staged: [], canContinue: false, canSkip: false };
const op = (extra) => ({ ok: true, ...NONE, head: "h".repeat(40), ...extra });
const picked = { hash: "0acda529c3f0e1d2b3a4958677a8b9c0d1e2f3a4", subject: "feature: alpha line two", author: "practice" };

// The heading names the operation: what is merged into what, the commit picked or
// replayed and its author (short hash, then its subject on a line of its own), the stash.
{
  const merge = op({ kind: "merge", target: "feature", current: picked, conflicts: [conflict("a")] });
  assert.deepEqual(say(en, heading(merge, { branch: "main" })), ["Merging branch feature into branch main"]);
  assert.deepEqual(say(ko, heading(merge, { branch: "main" })), ["브랜치 feature을(를) 브랜치 main에 병합합니다"]);

  const pick = op({ kind: "cherry-pick", current: picked, conflicts: [conflict("a")] });
  assert.deepEqual(say(en, heading(pick, { branch: "main" })), ["Conflicts during cherry-picking commit 0acda529 made by practice", "feature: alpha line two"]);
  assert.deepEqual(say(ko, heading(pick, { branch: "main" })), ["practice 님이 작성한 커밋 0acda529을(를) cherry-pick하는 동안 충돌이 발생했습니다", "feature: alpha line two"]);

  const revert = op({ kind: "revert", current: picked, conflicts: [conflict("a")] });
  assert.deepEqual(say(en, heading(revert, { branch: "main" })), ["Conflicts during reverting commit 0acda529 made by practice", "feature: alpha line two"]);
  assert.deepEqual(say(ko, heading(revert, { branch: "main" })), ["practice 님이 작성한 커밋 0acda529을(를) 되돌리는 동안 충돌이 발생했습니다", "feature: alpha line two"]);

  const rebase = op({ kind: "rebase", target: "main", rebasing: "feature", current: picked, step: { n: 1, total: 2 }, conflicts: [conflict("a")] });
  assert.deepEqual(say(en, heading(rebase, { branch: null })), ["Rebasing branch feature onto branch main", "Current commit 0acda529 made by practice:", "feature: alpha line two"]);
  assert.deepEqual(say(ko, heading(rebase, { branch: null })), ["브랜치 main에 브랜치 feature 리베이스하는 중", "practice이(가) 작성한 현재 커밋 0acda529:", "feature: alpha line two"]);
  // A rebase started on a detached HEAD rewrites no branch: HEAD stands for it.
  assert.deepEqual(say(en, heading({ ...rebase, rebasing: null }, {}))[0], "Rebasing branch HEAD onto branch main");

  // A stash that came back with conflicts leaves no operation: the opener names the stash.
  const unstash = op({ conflicts: [conflict("a")] });
  assert.deepEqual(say(en, heading(unstash, { branch: "main", stash: "stash@{0}" })), ["Conflicts during unstashing stash@{0}"]);
  assert.deepEqual(say(ko, heading(unstash, { branch: "main", stash: "stash@{0}" })), ["stash@{0}을(를) 스태시 취소하는 동안 충돌이 발생했습니다"]);
  // Nothing known about where the conflicts came from.
  assert.deepEqual(say(en, heading(unstash, { branch: "main" })), ["The following files have conflicts:"]);
  assert.deepEqual(say(ko, heading(unstash, { branch: "main" })), ["다음 파일에 충돌이 있습니다:"]);
  // A merge on a detached HEAD: merged into HEAD.
  assert.deepEqual(say(en, heading(merge, { branch: null })), ["Merging branch feature into branch HEAD"]);
}

// Two columns, "Yours" and "Theirs", each with the branch when it is known, and the side
// of git's each one stands for. In a rebase "Yours" is the commits being replayed (git's
// theirs) and "Theirs" what they go onto (git's ours).
{
  const words = (t, c) => [t(c.yours.label.key, c.yours.label.args), t(c.theirs.label.key, c.theirs.label.args)];

  const merge = columns(op({ kind: "merge", target: "feature", conflicts: [conflict("a")] }), { branch: "main" });
  assert.deepEqual([merge.yours.side, merge.theirs.side], ["ours", "theirs"]);
  assert.deepEqual(words(en, merge), ["Yours (main)", "Theirs (feature)"]);
  assert.deepEqual(words(ko, merge), ["내 변경 내용(main)", "다른 이의 변경 내용(feature)"]);

  const rebase = columns(op({ kind: "rebase", target: "main", rebasing: "feature", current: picked }), { branch: null });
  assert.deepEqual([rebase.yours.side, rebase.theirs.side], ["theirs", "ours"]);
  assert.deepEqual(words(ko, rebase), ["내 변경 내용(feature)", "다른 이의 변경 내용(main)"]);

  const pick = columns(op({ kind: "cherry-pick", current: picked }), { branch: "main" });
  assert.deepEqual([pick.yours.side, pick.theirs.side], ["ours", "theirs"]);
  assert.deepEqual(words(en, pick), ["Yours (main)", "Theirs (cherry-pick)"]);
  assert.deepEqual(words(en, columns(op({ kind: "revert", current: picked }), { branch: "main" })), ["Yours (main)", "Theirs (revert)"]);
  assert.deepEqual(words(en, columns(op({}), { branch: "main", stash: "stash@{0}" })), ["Yours (main)", "Theirs (stash@{0})"]);

  // Nothing to name: the plain titles.
  const plain = columns(op({ conflicts: [conflict("a")] }), { branch: null });
  assert.deepEqual([plain.yours.side, plain.theirs.side], ["ours", "theirs"]);
  assert.deepEqual(words(en, plain), ["Yours", "Theirs"]);
  assert.deepEqual(words(ko, plain), ["내 변경 내용", "다른 이의 변경 내용"]);
}

// The files in two groups: unresolved (in conflict now, with each column's state) and
// resolved (seen in conflict since the dialog opened, not any more). A file both sides
// added counts as modified on both; the columns follow the rebase swap.
{
  const merge = op({ kind: "merge", target: "feature", conflicts: [conflict("b/x"), conflict("a", "modified", "deleted"), conflict("n", "added", "added")] });
  const first = sortFiles(merge, columns(merge, { branch: "main" }), []);
  assert.deepEqual(first.unresolved, [
    { path: "a", yours: "modified", theirs: "deleted" },
    { path: "b/x", yours: "modified", theirs: "modified" },
    { path: "n", yours: "modified", theirs: "modified" },
  ]);
  assert.deepEqual(first.resolved, []);
  assert.deepEqual(first.seen, ["a", "b/x", "n"]);

  // "a" was resolved (in the dialog or a terminal): it moves to the resolved group.
  const later = op({ ...merge, conflicts: [conflict("b/x"), conflict("n", "added", "added")] });
  const next = sortFiles(later, columns(later, { branch: "main" }), first.seen);
  assert.deepEqual(next.unresolved.map((f) => f.path), ["b/x", "n"]);
  assert.deepEqual(next.resolved, ["a"]);
  // Undone again: back to unresolved.
  assert.deepEqual(sortFiles(merge, columns(merge, {}), next.seen).resolved, []);

  // In a rebase "Yours" shows git's theirs side.
  const rebase = op({ kind: "rebase", target: "main", rebasing: "feature", current: picked, conflicts: [conflict("a", "deleted", "modified")] });
  assert.deepEqual(sortFiles(rebase, columns(rebase, {}), []).unresolved, [{ path: "a", yours: "modified", theirs: "deleted" }]);

  // Everything resolved, the operation still in progress or already over.
  const over = sortFiles(op({}), columns(op({}), {}), ["a"]);
  assert.deepEqual([over.unresolved, over.resolved], [[], ["a"]]);
}

// Which controls are on. Accept and Resolve All Simple Conflicts need an unresolved
// file, Resolve Manually a selected unresolved one, Accept and Finish no file left
// unresolved, Revert Conflict Resolution a resolved one. A write running turns them off.
{
  const files = { unresolved: [{ path: "a" }, { path: "b" }], resolved: ["c"] };
  assert.deepEqual(controls(files, { selected: "a", busy: false, loaded: true }), {
    accept: true, resolveSimple: true, resolveManually: true, finish: false, unresolve: false, allResolved: false,
  });
  assert.deepEqual(controls(files, { selected: "c", busy: false, loaded: true }), {
    accept: true, resolveSimple: true, resolveManually: false, finish: false, unresolve: true, allResolved: false,
  });
  assert.deepEqual(controls(files, { selected: "a", busy: true, loaded: true }), {
    accept: false, resolveSimple: false, resolveManually: false, finish: false, unresolve: false, allResolved: false,
  });
  const done = { unresolved: [], resolved: ["a", "b"] };
  assert.deepEqual(controls(done, { selected: "a", busy: false, loaded: true }), {
    accept: false, resolveSimple: false, resolveManually: false, finish: true, unresolve: true, allResolved: true,
  });
  // Before the first read nothing is known: Accept and Finish waits.
  assert.deepEqual(controls({ unresolved: [], resolved: [] }, { selected: null, busy: false, loaded: false }), {
    accept: false, resolveSimple: false, resolveManually: false, finish: false, unresolve: false, allResolved: false,
  });

  // The selection: kept while its file is shown, else the first unresolved file, else the
  // first resolved one.
  assert.equal(pick(files, "b"), "b");
  assert.equal(pick(files, "c"), "c");
  assert.equal(pick(files, "gone"), "a");
  assert.equal(pick(done, null), "a");
  assert.equal(pick({ unresolved: [], resolved: [] }, "a"), null);
}

// Was the file edited since git left it? Accepting a side overwrites the file, so the
// dialog asks first when it was. Checked on real conflicts: the file as git wrote it, in
// each conflict style, and after edits of different kinds.
{
  const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-conflicts-model-`));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
  const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
  const git = makeGit(exec, null);
  const sh = (cwd, cmd) => { try { return execFileSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return e.stdout; } };
  const put = (repo, path, text) => writeFileSync(`${repo}/${path}`, text);
  const read = async (p) => readFileSync(p, "utf8");
  const edited = async (repo, path) => {
    const v = await readVersions(git, repo, path, { read });
    assert.equal(v.ok, true, v.err);
    return editedSince(v);
  };

  // m: both changed one line; w: a conflict and, further down, a change only theirs made
  // (git applies it outside the markers); h: CRLF; d1, d2: one side deleted; bin: binary.
  const files = {
    m: ["a\nb\n", "a\nM\n", "a\nF\n"],
    w: ["1\n2\n3\n4\n5\n6\n", "ONE\n2\n3\n4\n5\n6\n", "uno\n2\n3\n4\n5\nsix\n"],
    h: ["a\r\nb\r\n", "a\r\nM\r\n", "a\r\nF\r\n"],
    d1: ["k\n", "km\n", null],
    d2: ["k\n", null, "kf\n"],
    bin: ["x\0base", "x\0main", "x\0feature"],
  };
  const setUp = (name, style) => {
    const repo = `${base}/${name}`;
    mkdirSync(repo, { recursive: true });
    sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
    if (style) sh(repo, `git config merge.conflictStyle ${style}`);
    for (const [path, [b]] of Object.entries(files)) put(repo, path, b);
    sh(repo, "git add -A && git commit -qm base && git checkout -qb feature");
    for (const [path, [, , t]] of Object.entries(files)) t === null ? sh(repo, `git rm -q ${path}`) : put(repo, path, t);
    sh(repo, "git add -A && git commit -qm feature && git checkout -q main");
    for (const [path, [, o]] of Object.entries(files)) o === null ? sh(repo, `git rm -q ${path}`) : put(repo, path, o);
    sh(repo, "git add -A && git commit -qm main");
    return repo;
  };

  for (const style of [null, "diff3", "zdiff3"]) {
    const repo = setUp(`merge-${style ?? "merge"}`, style);
    sh(repo, "git merge feature");
    for (const path of Object.keys(files)) assert.equal(await edited(repo, path), false, `${style ?? "merge"}: ${path} as git left it`);
  }

  // A rebase writes other labels on the markers; the sides swap.
  {
    const repo = setUp("rebase");
    sh(repo, "git checkout -q feature && git rebase main");
    for (const path of Object.keys(files)) assert.equal(await edited(repo, path), false, `rebase: ${path} as git left it`);
  }

  const repo = setUp("edits");
  sh(repo, "git merge feature");
  const left = readFileSync(`${repo}/w`, "utf8");
  // A line outside the markers changed.
  put(repo, "w", left.replace("4\n", "four\n"));
  assert.equal(await edited(repo, "w"), true, "a line outside the conflict");
  // A line inside one side of the markers changed.
  put(repo, "w", left.replace("ONE\n", "ONE!\n"));
  assert.equal(await edited(repo, "w"), true, "a line inside the conflict");
  // Resolved by hand, not marked resolved yet.
  put(repo, "w", "ONE uno\n2\n3\n4\n5\nsix\n");
  assert.equal(await edited(repo, "w"), true, "resolved by hand");
  // Made one side's version by hand: still something the person wrote.
  put(repo, "m", "a\nM\n");
  assert.equal(await edited(repo, "m"), true, "one side's text by hand");
  // A marker taken out.
  put(repo, "w", left.replace(/^=======\n/m, ""));
  assert.equal(await edited(repo, "w"), true, "a marker taken out");
  // The file deleted: there's nothing of it to lose when one side deleted it too.
  sh(repo, "rm -f m d1");
  assert.equal(await edited(repo, "m"), true, "a file both sides kept, deleted");
  assert.equal(await edited(repo, "d1"), false, "a file one side deleted, deleted");
  // The kept side changed.
  put(repo, "d2", "kf edited\n");
  assert.equal(await edited(repo, "d2"), true, "the kept side changed");
  // A binary file can't be compared as text: never asked about.
  put(repo, "bin", "x\0mine");
  assert.equal(await edited(repo, "bin"), false, "binary");

  // The dialog opens by itself when a request stopped on conflicts, not when it stopped
  // without any (a rebase's edit stop), ended, or failed. A rebase of two commits that
  // both conflict: Continue after the first stops on the second.
  {
    const r2 = `${base}/rebase-two`;
    mkdirSync(r2, { recursive: true });
    sh(r2, "git init -q -b main && git config user.email t@t && git config user.name t");
    put(r2, "a", "0\n"); put(r2, "b", "0\n");
    sh(r2, "git add -A && git commit -qm base && git checkout -qb feature");
    put(r2, "a", "f\n"); sh(r2, "git commit -qam fa");
    put(r2, "b", "f\n"); sh(r2, "git commit -qam fb");
    sh(r2, "git checkout -q main");
    put(r2, "a", "m\n"); put(r2, "b", "m\n"); sh(r2, "git commit -qam m && git checkout -q feature && git rebase main");
    put(r2, "a", "resolved\n"); sh(r2, "git add a");
    const r = await continueOperation(git, r2);
    assert.equal(r.outcome, "stopped", r.err);
    assert.equal(stoppedOnConflicts(r), true);
    put(r2, "b", "resolved\n"); sh(r2, "git add b");
    const end = await continueOperation(git, r2);
    assert.equal(end.outcome, "done", end.err);
    assert.equal(stoppedOnConflicts(end), false);
  }
  assert.equal(stoppedOnConflicts({ ok: true, outcome: "stopped", operation: { kind: "rebase", conflicts: [] } }), false);
  assert.equal(stoppedOnConflicts({ ok: false, outcome: "failed", operation: null }), false);
  assert.equal(stoppedOnConflicts(null), false);
}

console.log("ok");
