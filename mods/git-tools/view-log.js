// Log panel: Branch tree | Commit list | Commit details. This file is the frame and the
// one place the panel's state lives; the columns are parts in their own files:
// log-branches.js, log-filters.js, log-list.js, log-details.js.
// The parts get this panel as `host` (described at the top of log-list.js) and read and
// set the branch limit, the filter arguments and the selected commit only through it.
//
// props: { view: "log", folder?, on? }. With `folder` the panel shows that folder's
// repository instead of following the focused pane (a Log tab: tab.new { mod, props }).
//
// render only looks: a move to another repository, and changes that arrived while the
// panel was hidden, are taken up in a timer of this copy (cx.notify throws inside
// render, and cx.spawn runs its first part there).

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, theme, watchFolder } from "herdr";
import { makeGit, repoRoot } from "./git.js";
import { readRefsState, readGitDir, refsChanged, resolveCommit } from "./git-log.js";
import { fetchAll, restoreBranch } from "./git-branch.js";
import { location, panelFrame, toolbar, spacer, iconButton, notice, notRepository, errorStrip, noteBar, sentence, toggleLogPanel, logPanelShown, broadcast, scriptedRepo, takeWrite, releaseWrite, writeBlock, writeName, writingOn, readBlocked, fromRepo, gitButtonPlaced, openMenu } from "./ui.js";
import { sameRepo } from "./lock.js";
import { serveBranch } from "./view-branch-new.js";
import { serveDeletedBranches } from "./view-deleted-branches.js";
import { serveAction } from "./serve-actions.js";
import { openReset } from "./view-reset.js";
import { servePush } from "./view-push.js";
import { VcsWidget } from "./view-vcs-widget.js";
import LogBranches from "./log-branches.js";
import LogFilters from "./log-filters.js";
import LogList from "./log-list.js";
import LogDetails, { copyRevision, checkoutCommit, newBranchAt } from "./log-details.js";
import { menuItems } from "./log-menus.js";
import { NONE, pickCommit, pickForMenu, keepPicked, pickedInOrder } from "./log-select.js";
import { commitWithLocal, commitVersions, fileWithLocal, beforeWithLocal, editSource, repositoryVersion, getFromCommit, changesToParents } from "./view-compare-files.js";
import { compareWithCurrent, diffWithWorkingTree } from "./view-compare-branches.js";
import { showRepositoryAt } from "./view-revision-tree.js";
import { historyUpToHere } from "./view-history-tab.js";
import { openPatch, openFilePatch } from "./view-patch.js";
import { goToHash } from "./view-go-to-hash.js";
import { undoHere, editMessageHere, dropHere, squashHere } from "./log-rewrite.js";
import { cherryPickHere, revertHere, cherryPickPicked, revertChangesHere, cherryPickChangesHere } from "./log-pick.js";
import { OPTIONS_KEY, readOptions, toggleOption, readArgs, graphMenu, displayMenu, columnsMenu } from "./log-options.js";
import { appSetting, saveAppSetting } from "./app-files.js";
import { readMe } from "./git-log-filter.js";
import { newTagAt } from "./view-tag.js";
import { renameFrom } from "./view-rename-branch.js";
import { remoteDialog } from "./view-remote.js";
import { pushUpTo, pushBranch } from "./view-push.js";
import { updateHere, checkoutUpdateHere, pullHere, updateSelected } from "./view-update-project.js";
import { aimHere, extractHere, dropChangesHere } from "./view-extract.js";

// Column widths, px. The Commit list takes what the side columns leave and never gets
// narrower than LIST_MIN: when the panel is too narrow, Commit details goes first, then
// the Branch tree.
const BRANCHES = { key: "log.branches", width: 220, min: 120 };
const DETAILS = { key: "log.details", width: 340, min: 160 };
const LIST_MIN = 360, SPLIT = 5;
// The Commit list's toolbar: the filter row's width that keeps the search box readable
// next to the four filter buttons, and what the toolbar's padding, gaps and three icon
// buttons take besides it.
const FILTERS_MIN = 420, TOOLBAR_REST = 100;
const SHORT = 7; // a hash as Commit details and the Branch tree's HEAD row show it

const stored = (column) => {
  try { const n = Number(localStorage.getItem(column.key)); return n >= column.min ? n : column.width; }
  catch { return column.width; }
};
const store = (column, width) => { try { localStorage.setItem(column.key, String(Math.round(width))); } catch { /* the width just isn't remembered */ } };

// Script commands that change the repository. A command reaches every shown copy, the
// side panel on the person's own work included, so these run only in a Log tab on a
// chosen folder or for a repository with `gittools.scripted` set (ui.js scriptedRepo).
// Fetch is one of them: it moves remote branches and prunes the gone ones.
const WRITES = new Set(["branches-checkout", "branches-delete", "details-checkout-revision", "log-fetch", "branches-fetch", "log-restore-branch"]);

// What each menu and toolbar item of the Log panel does (log-menus.js has the items, their
// order and names). An item shows only when it is here. Each gets (host, target, cx):
//   commit.*   target: the commits picked, newest first
//   file.*     target: Commit details' file row
//   branch.*   target: a branch row's { name, from, scope, current } (log-branches.js target)
//   toolbars   target: the Branch tree's cursor branch, or nothing
const ACTIONS = {
  "commit.copyRevision": (host, commits, cx) => copyRevision(commits, cx),
  "commit.checkoutRevision": (host, commits, cx) => checkoutCommit(host, commits[0], cx),
  "commit.newBranch": (host, commits) => newBranchAt(host, commits[0]),
  "file.showDiff": (host, m) => host.details.showDiff(m),
  "details.expandAll": (host, _m, cx) => host.details.expandAll(cx),
  "details.collapseAll": (host, _m, cx) => host.details.collapseAll(cx),
  "branch.checkout": (host, b, cx) => host.branches.checkout(b, cx),
  "branch.newFrom": (host, b, cx) => host.branches.newBranch(b, cx),
  "branch.delete": (host, b, cx) => host.branches.remove(b, cx),
  "branches.new": (host, _b, cx) => host.branches.newBranch(null, cx),
  "branches.delete": (host, b, cx) => host.branches.remove(b, cx),
  "branches.deleted": (host, _b, cx) => host.branches.deletedBranches(cx),
  "branches.fetch": (host, _b, cx) => host.fetch(cx),
  "branches.expandAll": (host, _b, cx) => host.branches.expandAll(cx),
  "branches.collapseAll": (host, _b, cx) => host.branches.collapseAll(cx),
  "log.refresh": (host, _t, cx) => host.refresh(cx),
  "log.fetch": (host, _t, cx) => host.fetch(cx),
  "log.hide": () => toggleLogPanel(),
  "commit.compareWithLocal": (host, commits) => commitWithLocal(host, commits),
  "commit.compareVersions": (host, commits) => commitVersions(host, commits),
  "branch.compareWith": (host, b) => compareWithCurrent(host, b),
  "branch.showDiffWithWorkingTree": (host, b) => diffWithWorkingTree(host, b),
  "branches.compareWithCurrent": (host, b) => compareWithCurrent(host, b),
  "details.showDiff": (host, m) => host.details.showDiff(m),
  "file.showDiffNewTab": (host, m) => host.details.showDiff(m),
  "file.compareWithLocal": (host, m) => fileWithLocal(host, m),
  "file.compareBeforeWithLocal": (host, m, cx) => beforeWithLocal(host, m, cx),
  "file.editSource": (host, m) => editSource(host, m),
  "file.openRepositoryVersion": (host, m) => repositoryVersion(host, m),
  "file.getFromRevision": (host, m, cx) => getFromCommit(host, m, cx),
  "file.showChangesToParents": (host, m, cx) => changesToParents(host, m, cx),
  "commit.resetToHere": (host, commits) => { if (host.repo && commits[0] && !host.writeBlock()) openReset({ root: host.repo.root, on: host.repo.on, owner: host.bus.id, commit: commits[0], lang: host.lang }); },
  "commit.showRepository": (host, commits) => showRepositoryAt(host, commits),
  "commit.createPatch": (host, commits) => openPatch(host, { commits }),
  "file.createPatch": (host, m) => openFilePatch(host, m),
  "file.historyUpToHere": (host, m) => historyUpToHere(host, m),
  "details.historyUpToHere": (host, m) => historyUpToHere(host, m),
  "log.goToHash": (host, _t, cx) => goToHash(host, cx),
  "commit.goToChild": (host, commits, cx) => host.list.goToRelative("children", commits[0], cx),
  "commit.goToParent": (host, commits, cx) => host.list.goToRelative("parents", commits[0], cx),
  "commit.undo": (host, commits, cx) => undoHere(host, commits, cx),
  "commit.editMessage": (host, commits, cx) => editMessageHere(host, commits, cx),
  "commit.drop": (host, commits, cx) => dropHere(host, commits, cx),
  "commit.squash": (host, commits, cx) => squashHere(host, commits, cx),
  "log.graphOptions": (host, _t, cx) => host.openOptions("graph", cx),
  "log.displayOptions": (host, _t, cx) => host.openOptions("display", cx),
  "commit.newTag": (host, commits) => newTagAt(host, host.repo, commits[0]),
  "commit.pushUpToHere": (host, commits) => pushUpTo(host, host.repo, commits[0]),
  "branch.rename": (host, b) => renameFrom(host, host.repo, b),
  "branch.push": (host, b) => pushBranch(host, host.repo, b),
  // The tracked branch's own menu, as its row under Remote has it.
  "branch.trackedBranch": (host, b, cx) => { const up = host.branches.data?.local.find((x) => x.name === b?.name)?.upstream; if (up) host.branches.menu({ kind: "branch", scope: "remote", key: `remote:${up}`, label: up, branch: { name: up } }, cx); },
  "remote.edit": (host, r) => remoteDialog(host, host.repo, r?.remote, "edit"),
  "remote.remove": (host, r) => remoteDialog(host, host.repo, r?.remote, "remove"),
  "branch.update": (host, b, cx) => updateHere(host, host.repo, "ui.logPanel", b, cx),
  "branch.checkoutAndUpdate": (host, b, cx) => checkoutUpdateHere(host, host.repo, "ui.logPanel", b, cx),
  "branch.pullRebase": (host, b, cx) => pullHere(host, host.repo, "ui.logPanel", b, true, cx),
  "branch.pullMerge": (host, b, cx) => pullHere(host, host.repo, "ui.logPanel", b, false, cx),
  "branches.updateSelected": (host, b, cx) => updateSelected(host, host.repo, "ui.logPanel", b, cx),
  "commit.fixup": (host, commits, cx) => aimHere(host, commits, false, cx),
  "commit.squashInto": (host, commits, cx) => aimHere(host, commits, true, cx),
  "file.extractSelected": (host, m, cx) => extractHere(host, m, cx),
  "file.dropSelected": (host, m, cx) => dropChangesHere(host, m, cx),
  "commit.cherryPick": (host, commits, cx) => cherryPickHere(host, commits, cx),
  "commit.revert": (host, commits, cx) => revertHere(host, commits, cx),
  "log.cherryPick": (host, _t, cx) => cherryPickPicked(host, cx),
  "file.revertSelected": (host, m, cx) => revertChangesHere(host, m, cx),
  "file.cherryPickSelected": (host, m, cx) => cherryPickChangesHere(host, m, cx),
  "details.revertSelected": (host, m, cx) => revertChangesHere(host, m, cx),
};

// The bus event that tells every Log panel the options file changed.
const OPTIONS_EVENT = "log-options";

// A log-options.js popup item as an openMenu item: group names are dim lines nothing
// can pick, a check mark goes before what is on, "▸" after an item that opens a list.
// The unchecked label starts with a space as wide as the mark, so names line up.
const menuItem = (it, t, first) => (it.header
  ? { label: t(it.key), value: null, disabled: true, rule: !first }
  : { label: `${it.checked ? "✓" : " "}  ${t(it.key)}`, value: it.id, disabled: Boolean(it.disabled), hint: it.more ? "▸" : undefined });
const popupItems = (items, t) => items.map((it, i) => menuItem(it, t, i === 0));
const handled = (id) => Object.prototype.hasOwnProperty.call(ACTIONS, id);

// The Log toolbar's buttons, by item (log-menus.js logTools): element id and icon. Written
// out as calls so ui-icons.test.mjs sees every icon name. An item missing here draws the
// settings icon: an unknown name would throw in render.
const LOG_BUTTONS = {
  "log.graphOptions": (t, o) => iconButton("log-graph-options", "graph-options", t, o),
  "log.refresh": (t, o) => iconButton("log-refresh", "refresh", t, o),
  "log.fetch": (t, o) => iconButton("log-fetch", "fetch", t, o),
  "log.cherryPick": (t, o) => iconButton("log-cherry-pick", "cherry-pick", t, o),
  "log.displayOptions": (t, o) => iconButton("log-display-options", "layout", t, o),
  "log.goToHash": (t, o) => iconButton("log-go-to-hash", "go-to-hash", t, o),
  "log.hide": (t, o) => iconButton("log-hide", "x", t, o),
};
function logButton(id, t, o) {
  if (LOG_BUTTONS[id]) return LOG_BUTTONS[id](t, o);
  const elementId = id.split(".").join("-");
  return iconButton(elementId, "settings", t, o);
}

export default class LogView {
  init(p, cx) {
    this.fixed = p.folder ? { folder: p.folder, on: p.on ?? null } : null;
    // The panel's state. Parts read these and change them through the methods below.
    this.repo = null; // { git, root, on, folder }
    this.branch = null; // the ref the list is limited to
    this.filterArgs = []; // extra `git log` arguments from the filter row
    this.selected = null; // the commit last clicked among those picked (picks.lead)
    this.picks = NONE; // the commits picked in the Commit list (log-select.js)
    this.detailsOf = ""; // the hashes Commit details was last told to show
    this.busy = null; // the work of the git write running now ({ key }, ui.js takeWrite)
    this.held = null; // the repository this panel's write lock is on (ui.js takeWrite)
    this.error = null;
    this.writeError = null; // the strip's text when it came from a dialog's write
    // The branch deleted last, for the Restore notice: deleteBranch's `deleted` plus
    // repo { root, on }. One only: replaced by the next branch deleted, gone on dismiss,
    // a Restore that worked, another repository.
    this.deleted = null;
    this.widths = { branches: stored(BRANCHES), details: stored(DETAILS) };
    this.listWidth = null;
    this.refs = null; // the refs' state the list was last read at
    this.lost = false; // finding the repository failed (not "not a repository"): the poll asks again
    this.jumpTurn = 0; // one per hash jump; a search, a filter or a pick makes older ones void
    // The graph and display options (log-options.js): the defaults until the settings
    // file is read, app-wide, saved on every change.
    this.options = readOptions(undefined);
    this.me = null; // the email of the user git is configured with in this.repo
    this.branches = new LogBranches();
    this.filters = new LogFilters();
    this.list = new LogList();
    this.details = new LogDetails();
    for (const part of [this.branches, this.filters, this.list, this.details]) part.init(this, cx);
    // Reads only while drawn: it follows the folder from render (view-vcs-widget.js).
    this.widget = new VcsWidget();
    this.widget.init(this, { who: "ui.logPanel" });
    this.loadOptions(cx);
    this.refresh(cx);
    // The watch below covers this computer; this covers other machines and a watch that
    // could not start. Cheap: one for-each-ref, and only while the panel shows.
    cx.timer.every(10000, (cx) => this.poll(cx));
  }

  where() { return this.fixed ?? location(); }
  contextKey() { const { folder, on } = this.where(); return JSON.stringify([folder, on]); }
  shown() { return this.fixed ? true : logPanelShown() !== false; }

  // ---- what the parts call (host)

  setBranch(ref, cx) {
    this.branch = ref || null;
    this.jumpTurn++;
    this.list.reload(cx);
    cx.notify();
  }

  setFilterArgs(args, cx) {
    this.filterArgs = Array.isArray(args) ? args : [];
    this.jumpTurn++;
    this.list.reload(cx);
    cx.notify();
  }

  // The person picked a commit (click, arrow key): a hash jump still running is dropped.
  pick(hash, cx) {
    this.jumpTurn++;
    this.select(hash, cx);
  }

  // hash: a commit in the list, picked alone, or null: nothing picked. Commit details hears
  // about it only when the commits picked change (not when a reload reads them again).
  select(hash, cx) {
    this.picks = hash && this.list.find(hash) ? pickCommit(NONE, hash, {}, this.listIndex()) : NONE;
    this.settle(cx);
  }

  // A click with Shift (a range) or Cmd (one more, one fewer) on a commit row.
  pickWith(hash, mods, cx) {
    this.jumpTurn++;
    this.picks = pickCommit(this.picks, hash, mods, this.listIndex());
    this.settle(cx);
  }

  // A right-click: the menu acts on what is picked when the row is one of them.
  pickForMenu(hash, cx) {
    this.jumpTurn++;
    this.picks = pickForMenu(this.picks, hash);
    this.settle(cx);
  }

  // The list was read again: commits still in it stay picked.
  keepPicks(cx) {
    const at = (h) => this.list.index.get(h);
    this.picks = keepPicked(this.picks, (h) => at(h) !== undefined, at);
    this.settle(cx);
  }

  isPicked(hash) { return this.picks.picked.has(hash); }

  // The commits picked, newest first, as the list has them now.
  pickedCommits() {
    return pickedInOrder(this.picks, (h) => this.list.index.get(h)).map((h) => this.list.find(h));
  }

  listIndex() {
    const { list } = this;
    return { at: (h) => list.index.get(h), hashAt: (i) => list.rows[i]?.commit.hash };
  }

  // `selected` follows the lead (a newly read object after a reload: Commit details sees
  // that and reads the containing branches again); Commit details is told when the commits
  // picked are others now.
  settle(cx) {
    const commits = this.pickedCommits(), key = commits.map((c) => c.hash).join(" ");
    this.selected = this.picks.lead ? this.list.find(this.picks.lead) : null;
    if (key !== this.detailsOf) {
      this.detailsOf = key;
      if (commits.length > 1) this.details.showMany(commits, cx);
      else this.details.show(commits[0] ?? null, cx);
    }
    cx.notify();
  }

  // ---- the graph and display options (log-options.js)

  // Reads the options from the settings file (at start, and when another panel saved).
  loadOptions(cx) {
    cx.spawn(async (cx) => {
      const saved = await appSetting(OPTIONS_KEY);
      this.useOptions(readOptions(saved), cx);
    });
  }

  // Takes `next` as the options now: the list reads again when what it reads changed,
  // else it only draws its rows again.
  useOptions(next, cx) {
    const before = this.options;
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    this.options = next;
    if (JSON.stringify(readArgs(next)) !== JSON.stringify(readArgs(before))) {
      this.jumpTurn++;
      if (this.repo) this.list.reload(cx);
    } else this.list.restyle(cx);
    cx.notify();
  }

  // An item picked in a popup: shown at once, then saved, then the other panels told.
  setOption(id, cx) {
    const next = toggleOption(this.options, id);
    this.useOptions(next, cx);
    cx.spawn(async (cx) => {
      const r = await saveAppSetting(OPTIONS_KEY, next);
      if (r.ok) broadcast({ type: OPTIONS_EVENT });
      else this.fail(this.t("graph.saveFailed", { err: r.err }), cx);
      cx.notify();
    });
  }

  // which: "graph" (Graph Options) or "display" (Display Options, and its Columns list).
  openOptions(which, cx) {
    const items = which === "graph" ? graphMenu(this.options, { collapsed: this.list.collapsed }) : displayMenu(this.options);
    cx.spawn(async (cx) => {
      const id = await openMenu(this.bus, popupItems(items, this.t), { width: 260, lang: this.lang });
      if (!id) { this.list.handle.focus(); return; }
      if (id === "collapseLinear" || id === "expandLinear") this.list.setCollapsed(id === "collapseLinear", cx);
      else if (id === "columns") {
        const column = await openMenu(this.bus, popupItems(columnsMenu(this.options), this.t), { width: 200, lang: this.lang });
        if (column) this.setOption(column, cx);
      } else this.setOption(id, cx);
      this.list.handle.focus();
      cx.notify();
    });
  }

  // ---- menus and toolbars (log-menus.js, ACTIONS)

  // items(menu, ctx) → what that menu or toolbar shows now: the model's items this panel does.
  items(menu, ctx) { return menuItems(menu, handled, { fixed: Boolean(this.fixed), ...ctx }); }

  // Runs the item `id` on `target`.
  run(id, target, cx) { if (handled(id)) ACTIONS[id](this, target, cx); }

  // An item's tooltip: its reason when it is off, else its name.
  itemTitle(it) {
    if (it.why) return it.why.text ?? this.t(it.why.key, it.why.args);
    return this.t(it.key, it.args);
  }

  // A hash jump takes a turn (beginJump) before its first read and checks it after every
  // one (jumpLive): a newer jump, a search or filter change, a pick or another repository
  // makes it void, so a late answer can't move the selection or post its note.
  beginJump() { return ++this.jumpTurn; }
  jumpLive(turn) { return turn === this.jumpTurn; }

  // true: selected; false: no such commit in the list; null: dropped for something newer.
  async goTo(text, cx, turn = this.beginJump()) {
    const repo = this.repo;
    if (!repo) return false;
    const live = () => turn === this.jumpTurn && repo === this.repo;
    const r = await resolveCommit(repo.git, repo.root, String(text).trim());
    if (!live()) return null;
    if (!r.ok) return false;
    return this.list.goTo(r.hash, cx, live);
  }

  reload(cx) {
    this.branches.reload(cx);
    this.list.reload(cx);
    this.details.retry(cx);
    cx.notify();
  }

  // main.js: the copy's language changed. What a part keeps already worded is made again.
  spoke() { this.details.spoke(); }

  // setBusy(work, cx, repo) takes the repository's write lock for work ({ key, args? },
  // ui.js takeWrite; `repo` defaults to the panel's) and returns false, changing nothing,
  // when this panel already writes or any copy holds that repository. setBusy(null, cx)
  // releases it.
  setBusy(work, cx, repo = this.repo) {
    let ok = true;
    if (work) ok = takeWrite(this, repo, work);
    else releaseWrite(this);
    cx.notify();
    return ok;
  }

  // Why no write may start now: this panel's own label, its write on another repository
  // ("Another git operation is running in another repository: …"), another copy's
  // ("Another git operation is running: Committing…"), or null.
  writeBlock() { return writeBlock(this, this.repo); }

  // This panel's own write while it runs on the shown repository (its work, whose key says
  // which button spins), else null. The panel follows the focused pane while it writes.
  writingHere() { return writingOn(this, this.repo) ? this.busy : null; }

  // Reads wait while anyone (this panel included) writes to the shown repository; they
  // run on the "changed" that follows, or the next poll.
  readBlocked() { return readBlocked(this, this.repo); }

  fail(text, cx) { this.error = text || null; cx.notify(); }

  // The strip's text. Every time it is set, errorMark moves on, so a part that put up an
  // error can tell it is still its own: the same words may come from another action.
  get error() { return this.strip ?? null; }
  set error(text) { this.strip = text; this.errorMark = (this.errorMark ?? 0) + 1; }

  // Whether the panel shows `repo` now: what a write does when it ends touches the
  // selection, filters and strip only then.
  shows(repo) { return sameRepo(repo, this.repo); }

  // A write on `repo` failed: git's words for the strip, with the repository's folder
  // name before them when the panel has moved on (ui.js fromRepo).
  failedOn(repo, text, cx) { this.fail(fromRepo(this, repo, text), cx); return this.error; }

  // A write a dialog asked for failed (ui.js serveRequest): git's words in the strip.
  // A later success clears only these words, not a read's error.
  writeFailed(text, cx) {
    if (text) { this.writeError = String(text); this.fail(text, cx); }
    else if (this.writeError) { if (this.error === this.writeError) this.fail(null, cx); this.writeError = null; }
  }

  // The New Branch, Delete Branch and Deleted Branches dialogs this panel opened ask it
  // to run their writes, so the branches and the result outlive the dialog.
  serve(e, cx) {
    // The VCS widget's Push… opens the Push dialog with this panel as its owner.
    if (e.action === "push") { servePush(this, e, cx); return true; }
    return serveBranch(this, e, cx) || serveDeletedBranches(this, e, cx) || serveAction(this, e, cx);
  }

  // noteDeleted(repo, deleted): a Delete on `repo` deleted a branch (git-branch.js
  // deleteBranch's `deleted`); its notice replaces the one before. A refused or
  // cancelled Delete never calls this, so the notice before stays restorable. A delete
  // that ends after the panel moved on puts up nothing. Called from a running write:
  // the write redraws when it ends.
  noteDeleted(repo, deleted) {
    if (deleted && this.shows(repo)) this.deleted = { ...deleted, repo: { root: repo.root, on: repo.on ?? null } };
  }

  // restoredElsewhere(repo, restored): the Deleted Branches dialog brought `restored`
  // ([{ name, hash }]) back on `repo`. The notice for one of them goes: its Restore would
  // only be refused now. A notice for any other branch stays. Called from a running
  // write: the write redraws when it ends.
  restoredElsewhere(repo, restored) {
    const gone = this.deleted;
    if (gone && sameRepo(gone.repo, repo) && restored.some((b) => b.name === gone.name && b.hash === gone.hash)) this.deleted = null;
  }

  // The notice's Restore: the branch again at its commit, with its upstream, under the
  // write lock. On success the notice goes and every screen on the repository reads
  // again; on failure (a branch of that name exists now) git's words go to the strip and
  // the notice stays.
  restoreDeleted(cx) {
    const repo = this.repo, gone = this.deleted;
    if (!repo || !gone || !sameRepo(gone.repo, repo) || !this.setBusy({ key: "log.restoring" }, cx)) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await restoreBranch(repo.git, repo.root, gone); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      this.setBusy(null, cx);
      if (r.ok) {
        if (this.deleted === gone) this.deleted = null;
        // Only the strip a failed Restore put up, by its mark: the same words may have come
        // since from a read or from another repository.
        if (this.restoreMark != null && this.errorMark === this.restoreMark) this.fail(null, cx);
        this.restoreMark = null;
        // After the lock is released: the panel skips reads while a write runs.
        broadcast({ type: "changed", root: repo.root });
        if (this.shows(repo)) this.branches.reload(cx);
      } else {
        this.failedOn(repo, sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed"), cx);
        this.restoreMark = this.errorMark;
      }
      cx.notify();
    });
  }

  deletedNote(gone, t) {
    const writing = this.writeBlock();
    return noteBar("log-deleted", this.t("branches.deleted", { name: gone.name, hash: gone.hash.slice(0, SHORT) }), t, {
      action: { label: this.t("branches.restore"), busy: this.writingHere()?.key === "log.restoring", disabled: Boolean(writing), title: writing ?? undefined, onClick: (_e, cx) => this.restoreDeleted(cx) },
      onDismiss: (_e, cx) => { this.deleted = null; cx.notify(); },
    });
  }

  // Fetch from the Commit list's toolbar (the Branch tree has its own button for the same).
  fetch(cx) {
    const repo = this.repo;
    if (!repo || !this.setBusy({ key: "log.fetching" }, cx)) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await fetchAll(repo.git, repo.root); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      this.setBusy(null, cx);
      // Every screen on this repository reads again, this one included (see event()).
      if (r.ok) broadcast({ type: "changed", root: repo.root });
      else this.failedOn(repo, r.err, cx);
    });
  }

  // ---- reading

  // Finds the repository of the folder shown and reads everything again. This is the
  // Refresh button; changes in the repository come through poll(). Never from render.
  refresh(cx) {
    if (this.resolving) return;
    const { folder, on } = this.where(), context = this.contextKey();
    if (context !== this.context) {
      this.context = context; this.error = null; this.writeError = null; this.notRepo = false; this.read = false;
      this.lost = false; this.lostMark = null; this.jumpTurn++;
      this.setRepo(null, cx);
    }
    if (!folder) return;
    this.resolving = true;
    cx.spawn(async (cx) => {
      try {
        const git = makeGit(exec, on);
        const top = await repoRoot(git, folder);
        if (this.contextKey() !== context) return;
        this.folder = folder;
        if (!top.ok && !top.notRepo) {
          // git or the machine couldn't be reached: what was read stays, with git's words
          // under it, and the next poll asks again.
          this.lost = true; this.error = top.err; this.lostMark = this.errorMark;
          return;
        }
        if (this.lost && this.lostMark != null && this.errorMark === this.lostMark) this.error = null;
        this.lost = false; this.lostMark = null;
        this.notRepo = !top.ok;
        if (!top.ok) { this.setRepo(null, cx); this.error = null; this.deleted = null; return; }
        if (top.root !== this.repo?.root || on !== this.repo?.on) this.setRepo({ git, root: top.root, on, folder }, cx);
        this.reload(cx);
        this.note(cx);
      } finally {
        this.resolving = false; this.read = true;
        cx.notify();
      }
    });
  }

  // Another repository (or none): the branch limit and the selection belonged to the old one.
  setRepo(repo, cx) {
    this.repo = repo;
    // Kept while no repository is known yet (a move to another folder passes null first);
    // it shows only on its own repository.
    if (repo && this.deleted && !sameRepo(this.deleted.repo, repo)) this.deleted = null;
    this.branch = null;
    this.refs = null;
    if (this.picks.picked.size || this.selected) { this.picks = NONE; this.selected = null; this.detailsOf = ""; this.details.show(null, cx); }
    this.me = null;
    if (!repo) { this.list.reload(cx); return; }
    this.watch(repo, cx);
    // Whose commits My Commits highlights.
    cx.spawn(async (cx) => {
      const r = await readMe(repo.git, repo.root);
      if (repo !== this.repo) return;
      this.me = r.ok && r.email ? r.email : null;
      cx.notify();
    });
  }

  // On this computer: wake when a ref or HEAD moves (commit, checkout, fetch).
  watch(repo, cx) {
    if (repo.on) return;
    cx.spawn(async (cx) => {
      const where = await readGitDir(repo.git, repo.root);
      if (!where.ok) return;
      try {
        while (this.repo === repo) {
          const paths = await watchFolder(where.dir);
          if (this.repo !== repo) return;
          if (refsChanged(where.dir, paths)) this.poll(cx);
        }
      } catch { /* the folder can't be watched: the timer still polls */ }
    });
  }

  // Remembers the refs' state without reading the list (a reload just did).
  note(cx) {
    const repo = this.repo;
    cx.spawn(async () => {
      const r = await readRefsState(repo.git, repo.root);
      if (r.ok && repo === this.repo) this.refs = r.state;
    });
  }

  // Reads the list again only if a ref or HEAD moved since it was last read, or the last
  // read of the list or the branches failed, so a quiet repository costs one small git
  // call and nothing is redrawn. A repository that couldn't be found is looked for again;
  // a details read or a next batch of the list that failed is read again.
  poll(cx) {
    if (this.drawsWidget() && this.shown()) this.widget.refresh(cx);
    const repo = this.repo;
    if (this.readBlocked() || !this.shown()) { this.stale = Boolean(repo) || this.lost; return; }
    if (this.lost) { this.stale = false; this.refresh(cx); return; }
    if (!repo) { this.stale = false; return; }
    if (this.polling) { this.again = true; return; }
    this.polling = true; this.stale = false;
    cx.spawn(async (cx) => {
      const r = await readRefsState(repo.git, repo.root);
      this.polling = false;
      if (repo !== this.repo) return;
      if (!r.ok) {
        // git or the machine can't be reached: say so, try again on the next poll. Set even
        // when the strip has these words already (from a failed Restore, say), so its mark
        // moves on and the strip is this read's now.
        this.error = r.err; this.pollMark = this.errorMark; cx.notify();
      } else {
        // Only the strip this read put up: the same words may be another action's since.
        if (this.pollMark != null && this.errorMark === this.pollMark) { this.error = null; cx.notify(); }
        this.pollMark = null;
        if (r.state !== this.refs || this.list.failed || this.branches.failed) { this.refs = r.state; this.reload(cx); }
        else { this.details.retry(cx); this.list.retry(cx); }
      }
      if (this.again) { this.again = false; this.poll(cx); }
    });
  }

  // `git-tools.<name>`: refresh, log-fetch, log-restore-branch (the Restore notice's
  // button), focus (Herdr sends it when a popup over the panel closes), and the parts'
  // branches-*, details-*, log-* names (see each part).
  command(name, cx) {
    if (WRITES.has(name)) this.whenScripted(cx, (cx) => this.route(name, cx));
    else this.route(name, cx);
  }

  route(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "focus") this.list.handle.focus();
    else if (name === "log-fetch") this.fetch(cx);
    else if (name === "log-restore-branch") this.restoreDeleted(cx);
    else if (name.startsWith("branches-")) this.branches.command(name, cx);
    else if (name.startsWith("details-")) this.details.command(name, cx);
    else if (name.startsWith("log-")) this.list.command(name, cx);
  }

  // Runs `act` if this copy may obey a script command that writes: a Log tab on a chosen
  // folder, or a repository that opted in. Asked at the time, since the panel may have
  // moved to another repository since the last read.
  whenScripted(cx, act) {
    if (this.fixed) { act(cx); return; }
    const repo = this.repo;
    if (!repo) return;
    cx.spawn(async (cx) => {
      if (!(await scriptedRepo(repo.git, repo.root)) || repo !== this.repo) return;
      act(cx);
      cx.notify();
    });
  }

  // The VCS widget at the left end of the Commit list's toolbar: in the panel that
  // follows the focused pane, where the layout has no widget block of its own beside the
  // Git button (every OS but macOS; layout.mjs).
  drawsWidget() { return !this.fixed && !gitButtonPlaced(); }

  event(e, cx) {
    if (this.drawsWidget()) this.widget.event(e, cx);
    if (e.type === OPTIONS_EVENT) { this.loadOptions(cx); return; }
    if (e.type !== "changed" || (e.root && e.root !== this.repo?.root)) return;
    if (this.repo) this.poll(cx);
    else this.refresh(cx);
  }

  // ---- drawing

  // Which side columns fit, and the width each column gets.
  columns() {
    const total = this.width ?? 100000;
    let { branches, details } = this.widths;
    const showDetails = total >= branches + details + LIST_MIN + SPLIT * 2;
    if (!showDetails) details = 0;
    const showBranches = total >= branches + LIST_MIN + SPLIT;
    if (!showBranches) branches = 0;
    const list = total - branches - details - (showDetails ? SPLIT : 0) - (showBranches ? SPLIT : 0);
    return { branches, details, list, showBranches, showDetails, total };
  }

  split(id, which, t) {
    return div().id(id).flex_none().w(SPLIT).h_full().flex().justify_center().cursor_col_resize()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.drag = { which, x: e.position.x, start: this.widths[which] };
        cx.notify();
      })
      .child(div().w(1).h_full().bg(this.drag?.which === which ? t.accent : t.border));
  }

  dragTo(x, cx) {
    const { which, start } = this.drag, c = this.columns();
    const column = which === "branches" ? BRANCHES : DETAILS;
    // The Branch tree grows to the right, Commit details to the left; neither may push
    // the Commit list under its minimum (that would hide a column mid-drag).
    const room = c.total - LIST_MIN - SPLIT * 2 - (which === "branches" ? c.details : c.branches);
    const width = Math.max(column.min, Math.min(which === "branches" ? start + (x - this.drag.x) : start - (x - this.drag.x), room));
    if (width === this.widths[which]) return;
    this.widths[which] = width;
    cx.notify();
  }

  body(cx, t) {
    const c = this.columns(), loading = this.list.loading || this.resolving, writing = this.writeBlock();
    const writeLabel = writeName(this, this.repo);
    this.listWidth = c.list;
    // A plain flex row: its children stretch to the panel's height.
    return div().id("log-columns").flex().flex_1().min_h(0).w_full()
      // Dragged from the whole body: moves only arrive while the pointer is over it.
      .on_mouse_move((e, cx) => { if (this.drag) this.dragTo(e.position.x, cx); })
      .on_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        store(this.drag.which === "branches" ? BRANCHES : DETAILS, this.widths[this.drag.which]);
        this.drag = null;
        cx.notify();
      })
      .when(c.showBranches, (el) => el
        .child(div().id("log-branches").flex_none().w(c.branches).h_full().min_h(0).overflow_hidden().child(this.branches.render(cx)))
        .child(this.split("log-split-branches", "branches", t)))
      .child(v_flex().id("log-center").flex_1().min_w(0).h_full().min_h(0)
        .child(toolbar(t)
          .when(this.drawsWidget(), (el) => el.child(div().id("log-vcs-widget").flex_none().max_w(260).min_w(0).child(this.widget.render(cx))))
          // The filter row keeps FILTERS_MIN while the column has it (what the toolbar's
          // padding and three buttons leave, TOOLBAR_REST): the write's words below are
          // cut short first, so the search box stays wide enough to read.
          .child(div().flex_1().min_w(Math.min(FILTERS_MIN, Math.max(0, c.list - TOOLBAR_REST))).h_full().child(this.filters.render(cx)))
          // The running write's name first ("Committing…", "Checking out… (another repository)")
          // so a cut keeps it; the full sentence is the tooltip.
          .when(Boolean(writing), (el) => el.child(div().id("log-writing").flex_initial().min_w(0).max_w(320).truncate().px(6).text_size(12).text_color(t.muted)
            .tooltip(writing ?? "").child(writeLabel ?? "")))
          .children(this.items("logTools", { writing, picked: this.picks.picked.size }).map((it) => this.toolButton(it, t, it.id === "log.refresh" && loading))))
        .child(div().flex_1().min_h(0).w_full().child(this.list.render(cx))))
      .when(c.showDetails, (el) => el
        .child(this.split("log-split-details", "details", t))
        .child(div().id("log-details").flex_none().w(c.details).h_full().min_h(0).overflow_hidden().child(this.details.render(cx))));
  }

  // A Log toolbar item as a button (LOG_BUTTONS).
  toolButton(it, t, spinning = false) {
    const busy = spinning || (it.work !== null && this.writingHere()?.key === it.work);
    return logButton(it.id, t, { title: this.itemTitle(it), disabled: it.disabled, busy, onClick: (_e, cx) => this.run(it.id, null, cx) });
  }

  // Another folder to follow, or changes that arrived while the panel was hidden: taken
  // up in a timer, one at a time.
  catchUp(cx) {
    if (this.catching) return;
    // A poll skipped while a write ran is taken up once the lock is released (the release
    // redraws every copy), even if the writer's "changed" never comes.
    const moved = this.contextKey() !== this.context, waiting = this.stale && this.shown() && !this.readBlocked();
    if (!moved && !waiting) return;
    this.catching = true;
    cx.timer.after(0, (cx) => {
      this.catching = false;
      if (this.contextKey() !== this.context) this.refresh(cx);
      else if (this.stale && this.shown()) this.poll(cx);
    });
  }

  render(cx) {
    this.catchUp(cx);
    const t = theme();
    const frame = panelFrame("log-panel", t);
    const filled = this.repo
      ? frame.child(this.body(cx, t))
      : frame
        .child(toolbar(t)
          .child(div().px(6).font_semibold().child("Git"))
          .child(div().text_size(12).text_color(t.muted).child(this.t("log.title")))
          .child(spacer())
          .child(iconButton("log-refresh", "refresh", t, { title: this.t("log.refresh"), busy: Boolean(this.resolving) && this.read, onClick: (_e, cx) => this.refresh(cx) }))
          .when(!this.fixed, (el) => el.child(iconButton("log-hide", "x", t, { title: this.t("log.hide"), onClick: () => toggleLogPanel() }))))
        .child(div().flex_1().min_h(0).child(this.notRepo ? notice(notRepository(this.folder, this.t), t) : !this.read ? notice(this.t("ui.loading"), t, { busy: true }) : notice("", t)));
    const gone = this.deleted && sameRepo(this.deleted.repo, this.repo) ? this.deleted : null;
    // The layout pads this block left and right only; the gap above is work-body's own
    // padding, the gap to the status bar is this one. A Log tab is padded by its pane.
    return div().id("log-root").size_full().min_h(0).when(!this.fixed, (el) => el.pb(8))
      .on_size_change((size, cx) => {
        // The card's border takes 2px of the width.
        const width = size.width - 2;
        if (width === this.width) return;
        this.width = width;
        cx.notify();
      })
      .child(filled.when(Boolean(gone), (el) => el.child(this.deletedNote(gone, t))).when(Boolean(this.error), (el) => el.child(errorStrip("log-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); }))));
  }
}
