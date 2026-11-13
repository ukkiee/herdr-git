// node merge-revisions-model.test.mjs: what the Merge Revisions dialog shows and allows for
// one conflicted file, with no app: the pane titles, the aligned rows of the picture, the
// chunk buttons, the toolbar, the count, the edit round trip, the save request.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { paneTitles, openFile, layoutRows, chunkButtons, toolbar, countWords, seekConflict, nextFile, leftToDecide, saveRequest } from "./merge-revisions-model.js";
import { columns } from "./conflicts-model.js";
import { decide, resultText, edit } from "./merge-chunks.js";
import { translator } from "./i18n.js";
import { makeGit } from "./git.js";

const en = translator("en"), ko = translator("ko");
const say = (t, w) => t(w.key, w.args);
const NONE = { kind: null, target: null, rebasing: null, current: null, step: null, sequence: false, message: "", conflicts: [], staged: [], canContinue: false, canSkip: false };
const op = (extra) => ({ ok: true, ...NONE, head: "h".repeat(40), ...extra });
const picked = { hash: "0acda529c3f0e1d2b3a4958677a8b9c0d1e2f3a4", subject: "feature: alpha line two", author: "practice" };
const versions = (base, ours, theirs, extra = {}) => ({ ok: true, path: "src/alpha.txt", binary: false, has: { base: base !== null, ours: ours !== null, theirs: theirs !== null }, base, ours, theirs, ...extra });

// Pane titles by operation: the left pane is the person's side, the right the other one.
{
  const titles = (o, extra = {}) => {
    const p = paneTitles(o, extra);
    return { en: [say(en, p.left), say(en, p.right)], ko: [say(ko, p.left), say(ko, p.right)] };
  };
  const merge = titles(op({ kind: "merge", target: "feature" }), { branch: "main" });
  assert.deepEqual(merge.en, ["Your version, branch main", "Changes from feature"]);
  assert.deepEqual(merge.ko, ["현재 버전, 브랜치 main", "feature의 변경 내용"]);

  const pick = titles(op({ kind: "cherry-pick", current: picked }), { branch: "main" });
  assert.deepEqual(pick.en, ["Local Changes", "Changes from cherry-pick 0acda529"]);
  assert.deepEqual(pick.ko, ["로컬 변경 내용", "0acda529 체리픽의 변경 내용"]);

  const rebase = titles(op({ kind: "rebase", target: "main", rebasing: "feature", current: picked }));
  assert.deepEqual(rebase.en, ["Rebasing 0acda529 from feature", "Already rebased commits and commits from main"]);

  const unstash = titles(op({ conflicts: [{ path: "a" }] }), { branch: "main", stash: "stash@{0}" });
  assert.deepEqual(unstash.en, ["Local changes", "Changes from stash"]);

  const plain = titles(op({}), { branch: "main" });
  assert.deepEqual(plain.en, ["Your version", "Their version"]);
  assert.deepEqual(plain.ko, ["내 버전", "상대 버전"]);
}

// A file opens as text with the person's side on the left: in a rebase that is git's
// theirs (the commit being replayed). The result starts as the base.
{
  const v = versions("a\nb\nc\n", "a\nOURS\nc\n", "a\nTHEIRS\nc\n");
  const merge = openFile(v, columns(op({ kind: "merge", target: "feature" }), { branch: "main" }));
  assert.equal(merge.mode, "text");
  assert.equal(resultText(merge.state), "a\nb\nc\n");
  assert.equal(merge.state.chunks[1].ours.join(""), "OURS\n");

  const rebase = openFile(v, columns(op({ kind: "rebase", target: "main", rebasing: "feature" }), {}));
  assert.equal(rebase.state.chunks[1].ours.join(""), "THEIRS\n", "left is the replayed commit in a rebase");
  assert.equal(rebase.state.chunks[1].theirs.join(""), "OURS\n");

  // A binary file, or one a side deleted, gets no panes: only the two Accept buttons.
  const cols = columns(op({ kind: "merge", target: "feature" }), { branch: "main" });
  assert.equal(openFile(versions(null, null, null, { binary: true }), cols).mode, "binary");
  assert.equal(openFile(versions("k\n", "km\n", null), cols).mode, "deleted");
  assert.equal(openFile(versions("k\n", null, "kf\n"), cols).mode, "deleted");
  // No common base (both added the file): the base is empty.
  const added = openFile(versions(null, "x\n", "y\n"), cols);
  assert.equal(added.mode, "text");
  assert.equal(resultText(added.state), "");
}

// The picture: one row per line, chunks aligned across the three panes (a chunk is as tall
// as its tallest side), each cell with its line number and its color.
//   conflict: red in all three; a change one side made: that side and the result, colored by
//   what it does (blue modified, green inserted, gray deleted); a decided chunk: plain.
{
  const v = versions("a\nb\nc\nd\n", "a\nB1\nB2\nc\nd\n", "a\nb\nc\nd\nE\n");
  // Left changed b (to two lines), right added E at the end.
  const { state } = openFile(v, columns(op({ kind: "merge", target: "f" }), { branch: "main" }));
  const { rows, starts } = layoutRows(state);
  const cell = (r, side) => (r[side] ? `${r[side].no}:${r[side].text.replace("\n", "")}:${r[side].color ?? "-"}` : ".");
  assert.deepEqual(rows.map((r) => [cell(r, "left"), cell(r, "result"), cell(r, "right")]), [
    ["1:a:-", "1:a:-", "1:a:-"],
    ["2:B1:modified", "2:b:modified", "2:b:-"],
    ["3:B2:modified", ".", "."],
    ["4:c:-", "3:c:-", "3:c:-"],
    ["5:d:-", "4:d:-", "4:d:-"],
    [".", ".", "5:E:inserted"],
  ]);
  assert.deepEqual(starts, [0, 1, 3, 5], "the row each chunk starts on");
  assert.equal(rows[1].first, true);
  assert.equal(rows[2].first, false);
  assert.equal(rows[1].chunk, 1);

  // Accepting the left change: the result takes its lines and the chunk turns plain.
  const after = layoutRows(decide(state, 1, "ours", "accept")).rows;
  assert.deepEqual(after.slice(1, 3).map((r) => [cell(r, "left"), cell(r, "result")]), [["2:B1:-", "2:B1:-"], ["3:B2:-", "3:B2:-"]]);

  // A conflict is red on all three panes; a deletion on one side is gray.
  const c = openFile(versions("x\ny\n", "X\ny\n", "Z\n"), columns(op({ kind: "merge", target: "f" }), {})).state;
  assert.deepEqual(layoutRows(c).rows.map((r) => [cell(r, "left"), cell(r, "result"), cell(r, "right")]), [
    ["1:X:conflict", "1:x:conflict", "1:Z:conflict"],
    ["2:y:conflict", "2:y:conflict", "."],
  ]);
  const d = openFile(versions("x\ny\n", "x\n", "x\ny\n"), columns(op({ kind: "merge", target: "f" }), {})).state;
  assert.deepEqual(layoutRows(d).rows.map((r) => [cell(r, "left"), cell(r, "result")]), [["1:x:-", "1:x:-"], [".", "2:y:deleted"]]);
}

// Chunk buttons: Accept and Ignore on each side that changed the chunk; on a conflict whose
// other side was accepted, that side's arrow appends instead. A decided side has none.
{
  const cols = columns(op({ kind: "merge", target: "f" }), {});
  // chunks: 0 same, 1 conflict (x), 2 same, 3 left-only change (q).
  const s = openFile(versions("x\nm\nq\n", "X\nm\nQ\n", "Z\nm\nq\n"), cols).state;
  assert.deepEqual(s.chunks.map((c) => c.kind), ["conflict", "same", "ours"]);
  assert.deepEqual(chunkButtons(s, 0), { ours: { apply: "accept", ignore: true }, theirs: { apply: "accept", ignore: true } });
  assert.deepEqual(chunkButtons(s, 1), { ours: null, theirs: null });
  assert.deepEqual(chunkButtons(s, 2), { ours: { apply: "accept", ignore: true }, theirs: null });

  const one = decide(s, 0, "ours", "accept");
  assert.deepEqual(chunkButtons(one, 0), { ours: null, theirs: { apply: "add", ignore: true } });
  const ignored = decide(s, 0, "ours", "ignore");
  assert.deepEqual(chunkButtons(ignored, 0), { ours: null, theirs: { apply: "accept", ignore: true } });
  const both = decide(one, 0, "theirs", "add");
  assert.deepEqual(chunkButtons(both, 0), { ours: null, theirs: null });
  assert.equal(resultText(both), "X\nZ\nm\nq\n");

  // Toolbar and count: one conflict and one change open; then the change applied; then the
  // conflict's two sides decided.
  assert.deepEqual(toolbar(s), { applyLeft: true, applyAll: true, applyRight: false, resolveSimple: false, conflicts: 1 });
  assert.deepEqual(countWords(s).map((w) => say(en, w)), ["1 change", "1 conflict"]);
  assert.deepEqual(countWords(s).map((w) => say(ko, w)), ["변경 내용 1개", "충돌 1개"]);
  const applied = decide(s, 2, "ours", "accept");
  assert.deepEqual(countWords(applied).map((w) => say(ko, w)), ["변경 내용 없음", "충돌 1개"]);
  assert.equal(leftToDecide(applied), 1);
  // One side of a conflict taken still leaves the conflict open (the reference counts it).
  assert.equal(leftToDecide(decide(applied, 0, "ours", "accept")), 1);
  const done = decide(decide(applied, 0, "ours", "accept"), 0, "theirs", "ignore");
  assert.deepEqual(countWords(done).map((w) => say(ko, w)), ["모든 충돌이 해결되었습니다"]);
  assert.equal(leftToDecide(done), 0);
  assert.deepEqual(toolbar(done), { applyLeft: false, applyAll: false, applyRight: false, resolveSimple: false, conflicts: 0 });

  // A simple conflict (the sides change different lines) turns the wand on.
  const simple = openFile(versions("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"), cols).state;
  // merge-chunks cuts it as two one-side changes when a same line sits between them:
  // build one where the changed lines touch.
  const touching = openFile(versions("a\nb\n", "A\nb\n", "a\nB\n"), cols).state;
  assert.deepEqual(touching.chunks.map((c) => [c.kind, c.simple]), [["conflict", true]]);
  assert.equal(toolbar(touching).resolveSimple, true);
  assert.equal(toolbar(simple).resolveSimple, false);
  assert.deepEqual(toolbar(simple), { applyLeft: true, applyAll: true, applyRight: true, resolveSimple: false, conflicts: 0 });
}

// Previous and Next Conflict walk the open conflicts by chunk; decided ones are skipped.
{
  const cols = columns(op({ kind: "merge", target: "f" }), {});
  const s = openFile(versions("1\n-\n2\n-\n3\n", "1o\n-\n2o\n-\n3o\n", "1t\n-\n2t\n-\n3t\n"), cols).state;
  assert.deepEqual(s.chunks.map((c) => c.kind), ["conflict", "same", "conflict", "same", "conflict"]);
  assert.equal(seekConflict(s, -1, 1), 0);
  assert.equal(seekConflict(s, 0, 1), 2);
  assert.equal(seekConflict(s, 4, 1), -1);
  assert.equal(seekConflict(s, 4, -1), 2);
  const two = decide(decide(s, 2, "ours", "accept"), 2, "theirs", "ignore");
  assert.equal(seekConflict(two, 0, 1), 4);
  assert.equal(seekConflict(two, 4, -1), 0);
}

// Edit Result Directly and back: the edited text is cut into chunks again, the hand-edited
// conflict counts as decided, and the picture shows what was written.
{
  const cols = columns(op({ kind: "merge", target: "f" }), {});
  const s = openFile(versions("a\nx\nb\n", "a\nX\nb\n", "a\nZ\nb\n"), cols).state;
  const back = edit(s, "a\nmine\nb\n");
  assert.equal(leftToDecide(back), 0);
  assert.equal(resultText(back), "a\nmine\nb\n");
  assert.deepEqual(layoutRows(back).rows.map((r) => r.result?.text), ["a\n", "mine\n", "b\n"]);
  // Untouched: the conflict is still open.
  assert.equal(leftToDecide(edit(s, resultText(s))), 1);
}

// After a file is resolved the dialog goes on to the next conflicted one by path.
{
  const c = (path) => ({ path });
  assert.equal(nextFile([c("a"), c("c"), c("b")], "b"), "c");
  assert.equal(nextFile([c("a"), c("c")], "c"), "a");
  assert.equal(nextFile([c("b")], "b"), null);
  assert.equal(nextFile([], "b"), null);
  // The file just saved is gone from git's list: the next after its place.
  assert.equal(nextFile([c("a"), c("d")], "b"), "d");
}

// Save request, on a real merge conflict: the panel writes the text and marks the file
// resolved; a request without a path or text is refused.
{
  const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-merge-revisions-`));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
  const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
  const git = makeGit(exec, null);
  const sh = (cwd, cmd) => { try { return execFileSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return e.stdout; } };
  const repo = `${base}/r`;
  mkdirSync(`${repo}/src`, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  writeFileSync(`${repo}/src/alpha.txt`, "a\nb\n");
  sh(repo, "git add -A && git commit -qm base && git checkout -qb feature");
  writeFileSync(`${repo}/src/alpha.txt`, "a\nF\n");
  sh(repo, "git commit -qam f && git checkout -q main");
  writeFileSync(`${repo}/src/alpha.txt`, "a\nM\n");
  sh(repo, "git commit -qam m && git merge feature");
  assert.match(sh(repo, "git ls-files -u"), /src\/alpha\.txt/);

  const write = async (p, text) => writeFileSync(p, text);
  const refused = await saveRequest(git, repo, { path: "src/alpha.txt" }, write);
  assert.equal(refused.ok, false);
  assert.equal(refused.msg.key, "conflicts.badRequest");
  assert.equal((await saveRequest(git, repo, { text: "x" }, write)).ok, false);

  const r = await saveRequest(git, repo, { path: "src/alpha.txt", text: "a\nM\nF\n" }, write);
  assert.equal(r.ok, true, r.err);
  assert.equal(readFileSync(`${repo}/src/alpha.txt`, "utf8"), "a\nM\nF\n");
  assert.equal(sh(repo, "git ls-files -u"), "");
  assert.equal(sh(repo, "git show :src/alpha.txt"), "a\nM\nF\n");
}
