// node log-select.test.mjs: picking commits in the Commit list, one or many (no app, no git).
import assert from "node:assert/strict";
import { NONE, pickCommit, pickForMenu, keepPicked, pickedInOrder, combineChanges } from "./log-select.js";

// The list as the Commit list holds it, newest first.
const listOf = (hashes) => ({ at: (h) => { const i = hashes.indexOf(h); return i < 0 ? undefined : i; }, hashAt: (i) => hashes[i] });
const list = listOf(["a", "b", "c", "d", "e", "f"]);
const plain = {}, shift = { shift: true }, cmd = { cmd: true };
const shown = (sel) => pickedInOrder(sel, list.at);

// A plain click picks that commit alone.
{
  let s = pickCommit(NONE, "c", plain, list);
  assert.deepEqual(shown(s), ["c"]);
  assert.equal(s.lead, "c");
  s = pickCommit(s, "e", plain, list);
  assert.deepEqual(shown(s), ["e"]);
}

// Shift: every commit from the last plain or Cmd click to this one, downward or upward.
{
  let s = pickCommit(NONE, "b", plain, list);
  s = pickCommit(s, "e", shift, list);
  assert.deepEqual(shown(s), ["b", "c", "d", "e"]);
  assert.equal(s.lead, "e");
  // Another Shift click moves the far end from the same start: the range shrinks.
  s = pickCommit(s, "c", shift, list);
  assert.deepEqual(shown(s), ["b", "c"]);
  // Upward from the start.
  s = pickCommit(s, "a", shift, list);
  assert.deepEqual(shown(s), ["a", "b"]);
  // From the bottom up.
  s = pickCommit(pickCommit(NONE, "f", plain, list), "d", shift, list);
  assert.deepEqual(shown(s), ["d", "e", "f"]);
  // Shift with nothing picked before: that commit alone, and it starts the next range.
  s = pickCommit(NONE, "d", shift, list);
  assert.deepEqual(shown(s), ["d"]);
  assert.deepEqual(shown(pickCommit(s, "f", shift, list)), ["d", "e", "f"]);
}

// Cmd: adds a commit, or takes a picked one out; the others stay.
{
  let s = pickCommit(NONE, "a", plain, list);
  s = pickCommit(s, "c", cmd, list);
  s = pickCommit(s, "e", cmd, list);
  assert.deepEqual(shown(s), ["a", "c", "e"]);
  s = pickCommit(s, "c", cmd, list);
  assert.deepEqual(shown(s), ["a", "e"]);
  // Taking out the last one leaves nothing picked.
  s = pickCommit(pickCommit(NONE, "a", plain, list), "a", cmd, list);
  assert.deepEqual(shown(s), []);
  assert.equal(s.lead, null);
  // A Cmd click starts the next Shift range; Cmd+Shift adds the range to what is picked.
  s = pickCommit(pickCommit(NONE, "a", plain, list), "d", cmd, list);
  assert.deepEqual(shown(pickCommit(s, "f", shift, list)), ["d", "e", "f"]);
  assert.deepEqual(shown(pickCommit(s, "f", { shift: true, cmd: true }, list)), ["a", "d", "e", "f"]);
}

// A right-click on a picked commit keeps the commits picked (the menu acts on all of them);
// on another one it picks that one alone.
{
  const s = pickCommit(pickCommit(NONE, "b", plain, list), "d", shift, list);
  assert.deepEqual(shown(pickForMenu(s, "c")), ["b", "c", "d"]);
  assert.equal(pickForMenu(s, "c").lead, "c");
  assert.deepEqual(shown(pickForMenu(s, "f")), ["f"]);
}

// The list read again (a fetch, a commit made elsewhere): commits still in it stay picked,
// in their new places; the ones gone (amended, filtered out) drop out.
{
  let s = pickCommit(pickCommit(NONE, "b", plain, list), "d", shift, list);
  const again = listOf(["new", "a", "b", "d", "e", "f"]); // c is gone
  s = keepPicked(s, (h) => again.at(h) !== undefined);
  assert.deepEqual(pickedInOrder(s, again.at), ["b", "d"]);
  assert.equal(s.lead, "d");
  // The start of the range stays: a Shift click goes on from it in the new list.
  assert.deepEqual(pickedInOrder(pickCommit(s, "e", shift, again), again.at), ["b", "d", "e"]);
  // The commit last clicked gone: the newest one still picked takes its place.
  s = keepPicked(pickCommit(pickCommit(NONE, "e", plain, list), "b", cmd, list), (h) => h !== "b");
  assert.deepEqual(shown(s), ["e"]);
  assert.equal(s.lead, "e");
  // Every one gone: nothing picked.
  s = keepPicked(s, () => false);
  assert.deepEqual([shown(s), s.lead], [[], null]);
  // Nothing changed: the same value, so the panel can tell.
  const same = pickCommit(NONE, "a", plain, list);
  assert.equal(keepPicked(same, () => true), same);
}

// Commit details with several commits picked: every file any of them changed, once, with
// the change from before the oldest to after the newest. commits: newest first.
{
  const commits = [
    { files: [{ path: "a.txt", status: "modified" }, { path: "gone.txt", status: "deleted" }, { path: "new.txt", status: "modified" }] },
    { files: [{ path: "b.txt", status: "deleted" }, { path: "new.txt", status: "added" }, { path: "c2.txt", status: "renamed", from: "c.txt" }] },
    { files: [{ path: "a.txt", status: "added" }, { path: "gone.txt", status: "added" }, { path: "b.txt", status: "modified" }] },
  ];
  assert.deepEqual(combineChanges(commits), [
    // Added in the oldest, changed later: added.
    { path: "a.txt", status: "added" },
    // Changed, then deleted: deleted.
    { path: "b.txt", status: "deleted" },
    { path: "c2.txt", status: "renamed", from: "c.txt" },
    // Added, then deleted inside the range: no change left (gone.txt is not there).
    { path: "new.txt", status: "added" },
  ]);
  assert.deepEqual(combineChanges([]), []);
  assert.deepEqual(combineChanges([{ files: [{ path: "x", status: "modified" }] }]), [{ path: "x", status: "modified" }]);
  // Deleted, then made again: a change to the file.
  assert.deepEqual(combineChanges([{ files: [{ path: "x", status: "added" }] }, { files: [{ path: "x", status: "deleted" }] }]), [{ path: "x", status: "modified" }]);
}

console.log("ok");
