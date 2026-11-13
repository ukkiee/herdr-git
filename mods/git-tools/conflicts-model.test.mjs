// node conflicts-model.test.mjs: what the Conflicts dialog shows and allows, from the
// operation in progress (git-operation.js readOperation), with no app. The words are
// checked in both languages through the message tables, the way the dialog words them.
import assert from "node:assert/strict";
import { heading, columns } from "./conflicts-model.js";
import { translator } from "./i18n.js";

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

console.log("ok");
