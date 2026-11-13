// node mods/git-tools/vcs-ops.test.mjs
import assert from "node:assert/strict";
import { VCS_OPS, vcsOpsItems, numberedPick, takesVcsOps, commitPanelShown } from "./vcs-ops.js";
import { translator } from "./i18n.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const all = () => true;
const ids = (items) => items.map((it) => it.id);
const en = translator("en"), ko = translator("ko");

// Every item the popup can ever have, in the menu bar Git menu's order, separators
// closed up: what shows when every id has a handler.
{
  const items = vcsOpsItems(all);
  assert.deepEqual(ids(items), [
    "commit", "push", "updateProject", "pull", "fetch",
    "merge", "rebase",
    "branches", "newBranch", "newTag", "resetHead",
    "newWorktree",
    "showLog", "patch", "uncommitted",
    "manageRemotes", "console",
  ]);
  assert.deepEqual(items.filter((it) => it.rule).map((it) => it.id), ["merge", "branches", "newWorktree", "showLog", "manageRemotes"]);
  // 1 … 9, then 0, then none.
  assert.deepEqual(items.map((it) => it.number), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", null, null, null, null, null, null, null]);
  assert.deepEqual(items.filter((it) => it.sub).map((it) => it.id), ["patch", "uncommitted"]);
}

// Only what has a handler shows; numbers follow what shows; a separator never starts,
// ends or doubles.
{
  const handled = new Set(["commit", "push", "fetch", "newBranch", "resetHead", "showLog", "rollback", "console"]);
  const items = vcsOpsItems((id) => handled.has(id));
  assert.deepEqual(ids(items), ["commit", "push", "fetch", "newBranch", "resetHead", "showLog", "uncommitted", "console"]);
  assert.deepEqual(items.filter((it) => it.rule).map((it) => it.id), ["newBranch", "showLog", "console"]);
  assert.deepEqual(items.map((it) => it.number), ["1", "2", "3", "4", "5", "6", "7", "8"]);
}

// A submenu shows when one of its items has a handler, and opens as its own list.
{
  assert.ok(!ids(vcsOpsItems((id) => id === "commit")).includes("uncommitted"));
  assert.deepEqual(ids(vcsOpsItems(all, "uncommitted")), ["stash", "unstash", "rollback"]);
  assert.deepEqual(ids(vcsOpsItems((id) => id === "rollback", "uncommitted")), ["rollback"]);
  assert.deepEqual(vcsOpsItems((id) => id === "rollback", "uncommitted").map((it) => it.number), ["1"]);
  assert.deepEqual(ids(vcsOpsItems(all, "patch")), ["createPatch", "applyPatch", "applyPatchFromClipboard"]);
  assert.deepEqual(vcsOpsItems(all, "nothing"), []);
}

// An item that is off now (Unstash with no stash) still shows and keeps its number, but
// a digit doesn't pick it.
{
  const items = vcsOpsItems(all, "uncommitted", (id) => id === "unstash");
  assert.deepEqual(items.map((it) => [it.id, it.disabled, it.number]), [["stash", false, "1"], ["unstash", true, "2"], ["rollback", false, "3"]]);
  assert.equal(numberedPick(items, "2"), -1);
  assert.equal(numberedPick(items, "3"), 2);
  assert.ok(vcsOpsItems(all).every((it) => it.disabled === false));
}

// The names, as the reference product's English and Korean menus have them.
{
  const label = (t, id) => t(vcsOpsItems(all).concat(vcsOpsItems(all, "uncommitted"), vcsOpsItems(all, "patch")).find((it) => it.id === id).key);
  assert.equal(label(ko, "commit"), "커밋…");
  assert.equal(label(ko, "updateProject"), "프로젝트 업데이트…");
  assert.equal(label(ko, "fetch"), "페치");
  assert.equal(label(ko, "resetHead"), "HEAD 재설정…");
  assert.equal(label(ko, "showLog"), "Git 로그 표시");
  assert.equal(label(ko, "uncommitted"), "커밋되지 않은 변경 내용");
  assert.equal(label(ko, "unstash"), "변경 내용 스태시 취소…");
  assert.equal(label(ko, "rollback"), "롤백…");
  assert.equal(label(ko, "manageRemotes"), "원격 관리…");
  assert.equal(label(en, "showLog"), "Show Git Log");
  assert.equal(label(en, "branches"), "Branches…");
  assert.equal(ko("vcs-ops.title"), "VCS 작업");
  assert.equal(en("vcs-ops.title"), "VCS Operations");
  // Every item's name is in both tables.
  for (const group of [undefined, "patch", "uncommitted"]) {
    for (const it of vcsOpsItems(all, group)) {
      assert.notEqual(en(it.key), it.key, it.key);
      assert.notEqual(ko(it.key), it.key, it.key);
    }
  }
  assert.ok(VCS_OPS.length > 0);
}

// A digit picks the item with that number; other keys and missing numbers pick nothing.
{
  const items = vcsOpsItems(all);
  assert.equal(items[numberedPick(items, "1")].id, "commit");
  assert.equal(items[numberedPick(items, "6")].id, "merge");
  assert.equal(items[numberedPick(items, "0")].id, "newTag");
  assert.equal(numberedPick(vcsOpsItems((id) => id === "commit"), "2"), -1);
  assert.equal(numberedPick(items, "a"), -1);
}

// Which copy opens the popup for cmd-shift-v. The key reaches every shown copy, so
// exactly one takes it: the Commit panel when it shows, else the Log panel block. A copy
// on a chosen folder (a tab) never takes it.
{
  assert.equal(takesVcsOps("commit", { commitShown: true, logShown: true }), true);
  assert.equal(takesVcsOps("log", { commitShown: true, logShown: true }), false);
  assert.equal(takesVcsOps("log", { commitShown: false, logShown: true }), true);
  assert.equal(takesVcsOps("commit", { commitShown: false, logShown: true }), false);
  assert.equal(takesVcsOps("log", { commitShown: false, logShown: true, folder: "/tmp/x" }), false);
  assert.equal(takesVcsOps("commit", { commitShown: true, logShown: false, folder: "/tmp/x" }), false);
  assert.equal(takesVcsOps("files", { commitShown: false, logShown: true }), false);
}

// The Commit panel shows when the side panel does and its stack has Changes up.
{
  const tree = (hidden, active) => ({ id: "root", children: [{ id: "panel", hidden, children: [{ id: "panel-body", type: "stack", active, children: [{ id: "files" }, { id: "changes" }] }] }] });
  assert.equal(commitPanelShown(tree(false, "changes")), true);
  assert.equal(commitPanelShown(tree(true, "changes")), false);
  assert.equal(commitPanelShown(tree(false, "files")), false);
  assert.equal(commitPanelShown(null), false);
}

// Every item the popup can have has a line in view-vcs-ops.js VCS_ACTIONS, except the
// ones with no screen yet. The screen imports the app, so its table is read as text.
{
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "view-vcs-ops.js"), "utf8");
  const table = source.slice(source.indexOf("export const VCS_ACTIONS = {"));
  const handled = new Set([...table.slice(0, table.indexOf("\n};")).matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]));
  const every = vcsOpsItems(all).flatMap((it) => (it.sub ? ids(vcsOpsItems(all, it.id)) : [it.id]));
  assert.ok(handled.has("commit") && handled.has("newWorktree"));
  assert.deepEqual(every.filter((id) => !handled.has(id)), ["branches", "createPatch", "applyPatch", "applyPatchFromClipboard", "manageRemotes"]);
}

console.log("ok");
