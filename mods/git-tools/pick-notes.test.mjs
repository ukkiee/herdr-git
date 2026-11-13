// node pick-notes.test.mjs: the notifications a Cherry-Pick or Revert Commit ends with,
// run at once or through Smart (no app, no git).
import assert from "node:assert/strict";
import { pickNotes, commitsOf, noteText } from "./pick-notes.js";
import { translator } from "./i18n.js";

const ko = translator("ko"), en = translator("en");
const A = "a".repeat(40), B = "b".repeat(40);
const said = (t, notes) => notes.map((n) => noteText(t, n));

// A commit already in: one notification each, nothing else.
{
  const notes = pickNotes("cherry-pick", [{ hash: A, subject: "one" }, { hash: B, subject: "two" }], { outcome: "done", skipped: [A, B] });
  assert.deepEqual(said(ko, notes), [
    { title: "cherry-pick할 항목이 없습니다", body: "aaaaaaaa의 모든 변경 내용이 이미 적용되었습니다", level: "info" },
    { title: "cherry-pick할 항목이 없습니다", body: "bbbbbbbb의 모든 변경 내용이 이미 적용되었습니다", level: "info" },
  ]);
}

// A revert that went through names the commits it reverted, newest first; one already
// reverted gets its own notification instead.
{
  const notes = pickNotes("revert", [{ hash: A, subject: "one" }, { hash: B, subject: "two" }], { outcome: "done", skipped: [B] });
  assert.deepEqual(said(en, notes), [
    { title: "Nothing to revert", body: "The changes of bbbbbbbb are already reverted", level: "info" },
    { title: "Revert successful", body: "aaaaaaaa one", level: "info" },
  ]);
}

// A revert that stopped or failed, and a cherry-pick that went through, say nothing here
// (the Conflicts dialog, the error strip and the Commit list say it).
{
  assert.deepEqual(pickNotes("revert", [{ hash: A }], { outcome: "stopped" }), []);
  assert.deepEqual(pickNotes("revert", [{ hash: A }], { outcome: "failed" }), []);
  assert.deepEqual(pickNotes("cherry-pick", [{ hash: A }], { outcome: "done" }), []);
  assert.deepEqual(pickNotes("merge", [{ hash: A }], { outcome: "done", skipped: [A] }), []);
}

// A Smart request carries the hashes and, beside them, the subjects the Commit list showed.
{
  assert.deepEqual(commitsOf({ type: "revert", commits: [A, B], subjects: ["one", 2] }), [{ hash: A, subject: "one" }, { hash: B, subject: "" }]);
  assert.deepEqual(commitsOf({ type: "revert", commits: [A] }), [{ hash: A, subject: "" }]);
  assert.deepEqual(commitsOf({ type: "revert" }), []);
  const notes = pickNotes("revert", commitsOf({ commits: [A] }), { outcome: "done" });
  assert.deepEqual(said(ko, notes), [{ title: "Revert에 성공했습니다", body: "aaaaaaaa", level: "info" }]);
}

console.log("ok");
