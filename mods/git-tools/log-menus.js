// The Log panel's menus and toolbars as one model: the commit row's menu, Commit details'
// file menu and toolbar, the Branch tree's row menus and vertical toolbar, and the Log
// toolbar. Each lists every item it will have, in the order shown, with the separators
// between groups. No `herdr` import: node tests it (log-menus.test.mjs).
//
// An item is an action id. The screen keeps the table of what each id does (view-log.js
// ACTIONS); menuItems shows only the ids that table has, so an action no screen does yet
// never shows, and the separators close up around what is left.
//
// Names come from the message tables (messages-log.js, messages-branches.js): `key` and
// `args` go to t(). An item's `when` is the place for why it is off now: it returns
// { key, args } or { text } (shown on hover), or null when it is on. `write` items are
// also off while a git write runs on the repository (ctx.writing, its words). `shown`
// hides an item for this selection (Compare Versions needs two commits). `hint` is the
// key that does the same where the menu opens, drawn dim on the item's right.
//
// ctx, as each screen hands it:
//   commit menu:   { count (commits selected), current (branch name), writing, edit? (the
//                  edit facts of the commits selected, git-rewrite.js readEditFacts) }
//   file menu:     { writing, count (commits shown), files? ({ picked, total }: the commit's
//                  files picked), edit? (the edit facts of the commit shown) }
//   branch menus:  { name, current, upstream, writing, deleteBlock, scope (the row's:
//                  "local" | "remote" | "head", a detached HEAD) }
//   toolbars:      { loaded, name, writing, deleteBlock, fixed (a Log tab on a chosen folder) }

import { editCheck } from "./rebase-plan.js";

const RULE = "|";

const one = (ctx) => (ctx.count ?? 1) !== 1 ? { key: "log.selectOneCommit" } : null;
const deleteBlock = (ctx) => (ctx.deleteBlock ? { text: ctx.deleteBlock } : null);
// Nothing read yet: off, with nothing to say about it.
const unread = (ctx) => (ctx.loaded === false ? { text: "" } : null);
const name = (ctx) => ({ name: ctx.name });
const current = (ctx) => ({ current: ctx.current });
const both = (ctx) => ({ name: ctx.name, current: ctx.current });
// A branch without a tracked branch has nothing to update from: off, nothing to say.
const tracked = (ctx) => (ctx.upstream ? null : { text: "" });
// A history edit: off for the edit check's reason (rebase-plan.js). ctx.edit: the edit
// facts of the commits picked (git-rewrite.js readEditFacts) when the menu has them; without
// them only the number picked is checked, and the item checks the rest when picked.
const edit = (action) => (ctx) => editCheck(action, ctx.edit ?? null, ctx.count ?? 1).why;
// The same for Commit details' file edits, which also need how many of the commit's files
// are picked (ctx.files).
const fileEdit = (action) => (ctx) => editCheck(action, ctx.edit ?? null, ctx.count ?? 1, ctx.files ?? null).why;

const ITEMS = {
  // ---- the commit row's menu
  "commit.copyRevision": { key: "log.copyRevision" },
  "commit.createPatch": { key: "log.createPatch" },
  "commit.cherryPick": { key: "log.cherryPick" },
  "commit.checkoutRevision": { key: "log.checkoutRevision", write: true, when: one },
  "commit.showRepository": { key: "log.showRepositoryAtRevision" },
  "commit.compareVersions": { key: "log.compareVersions", shown: (ctx) => ctx.count === 2 },
  "commit.compareWithLocal": { key: "log.compareWithLocal", shown: (ctx) => (ctx.count ?? 1) === 1 },
  "commit.resetToHere": { key: "log.resetToHere", write: true, when: one },
  "commit.revert": { key: "log.revertCommit" },
  "commit.undo": { key: "log.undoCommit", write: true, when: edit("undo") },
  "commit.editMessage": { key: "log.editMessage", write: true, when: edit("editMessage") },
  "commit.fixup": { key: "log.fixup", write: true, when: edit("fixup") },
  "commit.squashInto": { key: "log.squashInto", write: true, when: edit("squashInto") },
  "commit.drop": { key: "log.dropCommits", args: (ctx) => ({ n: ctx.count ?? 1 }), write: true, when: edit("drop") },
  "commit.squash": { key: "log.squashCommits", shown: (ctx) => (ctx.count ?? 1) >= 2, write: true, when: edit("squash") },
  "commit.interactiveRebase": { key: "log.interactiveRebase" },
  "commit.pushUpToHere": { key: "log.pushUpToHere", when: one },
  "commit.rebaseOnto": { key: "log.rebaseOntoCommit", args: current },
  "commit.newBranch": { key: "log.newBranch", write: true, when: one },
  "commit.newTag": { key: "log.newTag", write: true, when: one },
  // The Commit list's left and right keys (log-list.js).
  "commit.goToChild": { key: "log.goToChild", hint: "←" },
  "commit.goToParent": { key: "log.goToParent", hint: "→" },

  // ---- Commit details: a file's menu and the toolbar
  "file.showDiff": { key: "log.showDiff" },
  "file.showDiffNewTab": { key: "log.showDiffNewTab" },
  "file.compareWithLocal": { key: "log.compareWithLocal" },
  "file.compareBeforeWithLocal": { key: "log.compareBeforeWithLocal" },
  "file.editSource": { key: "log.editSource" },
  "file.openRepositoryVersion": { key: "log.openRepositoryVersion" },
  "file.revertSelected": { key: "log.revertSelectedChanges" },
  "file.cherryPickSelected": { key: "log.cherryPickSelectedChanges" },
  "file.extractSelected": { key: "log.extractSelectedChanges", write: true, when: fileEdit("extractChanges") },
  "file.dropSelected": { key: "log.dropSelectedChanges", write: true, when: fileEdit("dropChanges") },
  "file.createPatch": { key: "log.createPatch" },
  "file.getFromRevision": { key: "log.getFromRevision", write: true },
  "file.historyUpToHere": { key: "log.historyUpToHere" },
  "file.showChangesToParents": { key: "log.showChangesToParents" },
  "details.showDiff": { key: "log.showDiff" },
  "details.revertSelected": { key: "log.revertSelectedChanges" },
  "details.historyUpToHere": { key: "log.historyUpToHere" },
  "details.displayOptions": { key: "log.displayOptions" },
  "details.expandAll": { key: "log.expandAll", when: unread },
  "details.collapseAll": { key: "log.collapseAll", when: unread },

  // ---- the Branch tree: a branch row's menu, a remote's folder
  "branch.checkout": { key: "log.checkout", write: true },
  "branch.newFrom": { key: "log.newBranchFrom", args: name, write: true },
  "branch.checkoutAndRebase": { key: "branches.checkoutAndRebase", args: current },
  "branch.checkoutAndUpdate": { key: "branches.checkoutAndUpdate", write: true, when: tracked },
  "branch.compareWith": { key: "branches.compareWith", args: current },
  "branch.showDiffWithWorkingTree": { key: "branches.showDiffWithWorkingTree" },
  "branch.rebaseOnto": { key: "branches.rebaseOnto", args: both },
  "branch.mergeInto": { key: "branches.mergeInto", args: both },
  "branch.newWorktreeFrom": { key: "branches.newWorktreeFrom", args: name },
  "branch.update": { key: "branches.update", write: true, when: (ctx) => (ctx.name === ctx.current ? null : tracked(ctx)) },
  "branch.push": { key: "branches.push" },
  "branch.trackedBranch": { key: "branches.trackedBranch", args: (ctx) => ({ upstream: ctx.upstream }), shown: (ctx) => Boolean(ctx.upstream) },
  "branch.pullRebase": { key: "branches.pullRebase", args: current, write: true },
  "branch.pullMerge": { key: "branches.pullMerge", args: current, write: true },
  // F2 on the Branch tree's cursor row does the same (log-branches.js). A detached HEAD
  // has no branch name to change.
  "branch.rename": { key: "branches.rename", write: true, hint: "F2", shown: (ctx) => ctx.scope !== "head" },
  "branch.delete": { key: "log.delete", write: true, when: deleteBlock },
  "remote.edit": { key: "branches.editRemote", write: true },
  "remote.remove": { key: "branches.removeRemote", write: true },
  // A tag's menu (the VCS widget popup's Tags): Push Tag opens one "Push to <remote>" per remote.
  "tag.push": { key: "refs.pushTag", write: true },

  // ---- the Branch tree's vertical toolbar
  "branches.hide": { key: "branches.hide" },
  "branches.new": { key: "log.newBranch", write: true, when: unread },
  "branches.updateSelected": { key: "branches.updateSelected", write: true, work: "remote.updating" },
  "branches.delete": { key: "log.deleteBranch", args: name, write: true, when: deleteBlock, work: "log.deleting" },
  // The branches deleted here, kept to restore: after Delete Branch, its neighbor.
  "branches.deleted": { key: "branches.openDeleted", when: unread },
  // On the cursor's branch: off without one.
  "branches.compareWithCurrent": { key: "branches.compareWithCurrent", when: (ctx) => (ctx.name ? null : { text: "" }) },
  "branches.showMine": { key: "branches.showMine" },
  "branches.fetch": { key: "log.fetch", write: true, work: "log.fetching" },
  "branches.favorite": { key: "branches.favorite" },
  "branches.navigateLog": { key: "branches.navigateLog" },
  "branches.settings": { key: "branches.settings" },
  "branches.expandAll": { key: "log.expandAll" },
  "branches.collapseAll": { key: "log.collapseAll" },

  // ---- the Log toolbar. Fetch and Hide are this panel's own.
  "log.regex": { key: "log.regex" },
  "log.matchCase": { key: "log.matchCase" },
  "log.graphOptions": { key: "log.graphOptions" },
  "log.refresh": { key: "log.refresh" },
  "log.fetch": { key: "log.fetch", write: true, work: "log.fetching" },
  "log.cherryPick": { key: "log.cherryPick" },
  "log.displayOptions": { key: "log.displayOptions" },
  "log.goToHash": { key: "log.goToHash" },
  "log.hide": { key: "log.hide", shown: (ctx) => !ctx.fixed },
};

// Order and separators. A branch row's menu depends on the row: a local branch, the
// current branch, the HEAD row (the current branch without its tracked branch), a
// remote branch.
const BRANCH_MIDDLE = [RULE, "branch.compareWith", "branch.showDiffWithWorkingTree", RULE, "branch.rebaseOnto", "branch.mergeInto", RULE, "branch.newWorktreeFrom", RULE];
const OWN = ["branch.newFrom", RULE, "branch.showDiffWithWorkingTree", RULE, "branch.newWorktreeFrom", RULE, "branch.update", "branch.push"];

export const MENUS = {
  commit: [
    "commit.copyRevision", "commit.createPatch", "commit.cherryPick", RULE,
    "commit.checkoutRevision", "commit.showRepository", "commit.compareVersions", "commit.compareWithLocal", RULE,
    "commit.resetToHere", "commit.revert", "commit.undo", RULE,
    "commit.editMessage", "commit.fixup", "commit.squashInto", "commit.drop", "commit.squash", "commit.interactiveRebase", "commit.pushUpToHere", RULE,
    "commit.rebaseOnto", "commit.newBranch", "commit.newTag", RULE,
    "commit.goToChild", "commit.goToParent",
  ],
  file: [
    "file.showDiff", "file.showDiffNewTab", "file.compareWithLocal", "file.compareBeforeWithLocal", "file.editSource", "file.openRepositoryVersion", RULE,
    "file.revertSelected", "file.cherryPickSelected", "file.extractSelected", "file.dropSelected",
    "file.createPatch", "file.getFromRevision", "file.historyUpToHere", "file.showChangesToParents",
  ],
  detailsTools: ["details.showDiff", "details.revertSelected", "details.historyUpToHere", "details.displayOptions", "details.expandAll", "details.collapseAll"],
  localBranch: [
    "branch.checkout", "branch.newFrom", "branch.checkoutAndRebase", "branch.checkoutAndUpdate", ...BRANCH_MIDDLE,
    "branch.update", "branch.push", RULE, "branch.rename", "branch.delete",
  ],
  currentBranch: [...OWN, "branch.trackedBranch", RULE, "branch.rename"],
  headBranch: [...OWN, RULE, "branch.rename"],
  remoteBranch: [
    "branch.checkout", "branch.newFrom", "branch.checkoutAndRebase", ...BRANCH_MIDDLE,
    "branch.pullRebase", "branch.pullMerge", RULE, "branch.delete",
  ],
  remoteFolder: ["remote.edit", "remote.remove"],
  tag: ["tag.push"],
  branchTools: [
    "branches.hide", "branches.new", "branches.updateSelected", "branches.delete", "branches.deleted", "branches.compareWithCurrent",
    "branches.showMine", "branches.fetch", "branches.favorite", "branches.navigateLog", "branches.settings", RULE,
    "branches.expandAll", "branches.collapseAll",
  ],
  // Right of the filter row. Regex and Match Case sit inside the search box, which draws
  // them (log-filters.js): logSearch.
  logTools: ["log.graphOptions", "log.refresh", "log.fetch", "log.cherryPick", "log.displayOptions", "log.goToHash", "log.hide"],
  logSearch: ["log.regex", "log.matchCase"],
};

// menuItems(menu, handled, ctx) → [{ id, key, args, rule, disabled, why, work, hint }] in order.
//   menu: a MENUS name. handled: a Set of the ids the screen can do, or a function id → bool.
//   rule: a separator line goes above this item (ui.js openMenu's `rule`). Only between
//   items shown: never first, never last, never two in a row.
//   why: null when on, else { key, args } or { text } (text may be "": off, nothing to say).
//   work: the write lock's key while this item's own write runs (a toolbar button spins).
//   hint: the item's key, or null.
export function menuItems(menu, handled, ctx = {}) {
  const has = typeof handled === "function" ? handled : (id) => Boolean(handled?.has?.(id));
  const out = [];
  let ruled = false;
  for (const id of MENUS[menu] ?? []) {
    if (id === RULE) { ruled = out.length > 0; continue; }
    const item = ITEMS[id];
    if (!item || !has(id) || (item.shown && !item.shown(ctx))) continue;
    const why = item.when?.(ctx) ?? (item.write && ctx.writing ? { text: ctx.writing } : null);
    out.push({ id, key: item.key, args: item.args ? item.args(ctx) : {}, rule: ruled, disabled: Boolean(why), why, work: item.work ?? null, hint: item.hint ?? null });
    ruled = false;
  }
  return out;
}
