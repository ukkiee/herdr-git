// node rebase-plan.test.mjs: the rebase plan (a list of actions → git's to-do list) and
// the edit check (why an edit item is off), as pure functions.
import assert from "node:assert/strict";
import { todoList, editCheck, MESSAGE_VAR } from "./rebase-plan.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);

// ---- the to-do list

// Every line keeps its order; a reword is the commit picked, then its message given by
// an exec line that reads it from a variable (never from the line itself).
{
  const r = todoList([
    { hash: A, action: "pick" },
    { hash: B, action: "reword", message: "new \"one\"\n\nbody $HOME" },
    { hash: C, action: "edit" },
    { hash: D, action: "drop" },
  ]);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.lines, [
    `pick ${A}`,
    `pick ${B}`,
    `exec git commit --amend --allow-empty -q -m "$${MESSAGE_VAR}0"`,
    `edit ${C}`,
    `drop ${D}`,
  ]);
  assert.deepEqual(r.env, { [`${MESSAGE_VAR}0`]: "new \"one\"\n\nbody $HOME" });
  assert.deepEqual(r.groups, []);
}

// A squash without a message melds as git does (both messages kept); a fixup keeps the
// previous message. Both make one commit: a group, its first commit at the head.
{
  const r = todoList([
    { hash: A, action: "pick" },
    { hash: B, action: "squash" },
    { hash: C, action: "fixup" },
    { hash: D, action: "pick" },
  ]);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.lines, [`pick ${A}`, `squash ${B}`, `fixup ${C}`, `pick ${D}`]);
  assert.deepEqual(r.env, {});
  assert.deepEqual(r.groups, [{ head: A, members: [A, B, C] }]);
}

// A squash with a message: the commits meld as fixups and the message is set once, after
// the whole group, so the last one melded doesn't put its own back.
{
  const r = todoList([
    { hash: A, action: "pick" },
    { hash: B, action: "squash", message: "both" },
    { hash: C, action: "fixup" },
    { hash: D, action: "pick" },
  ]);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.lines, [
    `pick ${A}`, `fixup ${B}`, `fixup ${C}`,
    `exec git commit --amend --allow-empty -q -m "$${MESSAGE_VAR}0"`,
    `pick ${D}`,
  ]);
  assert.deepEqual(r.env, { [`${MESSAGE_VAR}0`]: "both" });
  assert.deepEqual(r.groups, [{ head: A, members: [A, B, C] }]);
}

// A reworded head of a group: its message is the group's, set after the group.
{
  const r = todoList([{ hash: A, action: "reword", message: "m" }, { hash: B, action: "fixup" }]);
  assert.deepEqual(r.lines, [`pick ${A}`, `fixup ${B}`, `exec git commit --amend --allow-empty -q -m "$${MESSAGE_VAR}0"`]);
}

// Two messages: one variable each, numbered in order.
{
  const r = todoList([{ hash: A, action: "reword", message: "one" }, { hash: B, action: "reword", message: "two" }]);
  assert.deepEqual(r.env, { [`${MESSAGE_VAR}0`]: "one", [`${MESSAGE_VAR}1`]: "two" });
  assert.equal(r.lines.filter((l) => l.startsWith("exec")).length, 2);
}

// A branch on a commit in the range follows it: update-ref after that commit's line, or
// after the whole group the commit melds into, or after a dropped commit (onto what came
// before it).
{
  const r = todoList([
    { hash: A, action: "pick" },
    { hash: B, action: "fixup" },
    { hash: C, action: "drop" },
    { hash: D, action: "pick" },
  ], { refs: { [B]: ["refs/heads/side"], [C]: ["refs/heads/gone"], [D]: ["refs/heads/x", "refs/heads/y"] } });
  assert.deepEqual(r.lines, [
    `pick ${A}`, `fixup ${B}`, "update-ref refs/heads/side",
    `drop ${C}`, "update-ref refs/heads/gone",
    `pick ${D}`, "update-ref refs/heads/x", "update-ref refs/heads/y",
  ]);
}

// Refused plans: a reword without a message, a squash or fixup with nothing before it to
// meld into, an unknown action, a step without a hash.
{
  const bad = (steps, key) => {
    const r = todoList(steps);
    assert.equal(r.ok, false);
    assert.equal(r.msg.key, key, JSON.stringify(steps));
    assert.ok(r.err);
  };
  bad([{ hash: A, action: "reword", message: "  \n" }], "commit.noMessage");
  bad([{ hash: A, action: "squash" }], "rewrite.nothingToMeld");
  bad([{ hash: A, action: "drop" }, { hash: B, action: "fixup" }], "rewrite.nothingToMeld");
  bad([{ hash: A, action: "move" }], "rewrite.badPlan");
  bad([{ action: "pick" }], "rewrite.badPlan");
  bad([], "rewrite.badPlan");
}

// ---- the edit check

const commit = (hash, more = {}) => ({ hash, parents: 1, onBranch: true, pushedProtected: false, ...more });
const facts = (more = {}) => ({ head: A, operation: null, protected: null, mergeAbove: false, commits: [commit(A)], ...more });
const why = (action, f) => editCheck(action, f).why;

// On: the last commit of a branch nobody protects, nothing in progress.
for (const action of ["undo", "editMessage", "drop", "interactiveRebase"]) assert.equal(why(action, facts()), null, action);
assert.equal(why("squash", facts({ commits: [commit(A), commit(B)] })), null);

// A merge commit: its number of parents.
assert.deepEqual(why("editMessage", facts({ commits: [commit(A, { parents: 2 })] })), { key: "rewrite.parents", args: { n: 2 } });
assert.deepEqual(why("drop", facts({ commits: [commit(B), commit(A, { parents: 3 })] })), { key: "rewrite.parents", args: { n: 3 } });

// Not on the current branch: its short hash.
assert.deepEqual(why("drop", facts({ commits: [commit(B, { onBranch: false })] })), { key: "rewrite.notInBranch", args: { hash: B.slice(0, 8) } });

// An operation in progress: which one.
assert.deepEqual(why("editMessage", facts({ operation: "merge" })), { key: "rewrite.duringMerge", args: {} });
assert.deepEqual(why("undo", facts({ operation: "rebase" })), { key: "rewrite.duringRebase", args: {} });
assert.deepEqual(why("squash", facts({ operation: "cherry-pick", commits: [commit(A), commit(B)] })), { key: "rewrite.duringCherryPick", args: {} });
assert.deepEqual(why("drop", facts({ operation: "revert" })), { key: "rewrite.duringRevert", args: {} });

// Pushed to the protected branch the current one tracks: every edit item and Undo, the
// HEAD commit included.
for (const action of ["undo", "editMessage", "drop", "interactiveRebase", "fixup", "squashInto"]) {
  assert.deepEqual(why(action, facts({ protected: "origin/main", localChanges: true, commits: [commit(A, { pushedProtected: true })] })),
    { key: "rewrite.pushedProtected", args: { branch: "origin/main" } }, action);
}
// Not yet pushed there: on.
assert.equal(why("editMessage", facts({ protected: "origin/main", commits: [commit(A)] })), null);

// Undo: only the last commit, and never the first one (there is nothing to go back to).
assert.deepEqual(why("undo", facts({ commits: [commit(B)] })), { key: "rewrite.notLast", args: {} });
assert.deepEqual(why("undo", facts({ commits: [commit(A, { parents: 0 })] })), { key: "rewrite.undoInitial", args: {} });

// One commit for Undo, Edit Commit Message, Fixup, Squash Into and Interactively Rebase;
// two or more for Squash Commits.
assert.deepEqual(why("editMessage", facts({ commits: [commit(A), commit(B)] })), { key: "log.selectOneCommit", args: {} });
assert.deepEqual(why("squash", facts()), { key: "rewrite.selectTwo", args: {} });
assert.equal(why("drop", facts({ commits: [commit(A), commit(B)] })), null);

// Fixup and Squash Into: off without local changes.
assert.deepEqual(why("fixup", facts({ localChanges: false })), { key: "rewrite.nothingToCommit", args: {} });
assert.equal(why("squashInto", facts({ localChanges: true })), null);

// A merge commit between the commit and HEAD: the history can't be replayed as a line.
assert.deepEqual(why("drop", facts({ mergeAbove: true, commits: [commit(B)] , head: A })), { key: "rewrite.mergeAbove", args: {} });

// The first commit: on, after a confirmation.
{
  const r = editCheck("editMessage", facts({ commits: [commit(A, { parents: 0 })] }));
  assert.equal(r.why, null);
  assert.deepEqual(r.confirm, { title: "rewrite.initialTitle", body: "rewrite.initialBody" });
  assert.equal(editCheck("editMessage", facts()).confirm, null);
}

// No facts (not read yet): nothing to say beyond the selection's size.
assert.equal(editCheck("editMessage", null).why, null);
assert.deepEqual(editCheck("squash", null, 1).why, { key: "rewrite.selectTwo", args: {} });

console.log("ok");
