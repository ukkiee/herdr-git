// Branch tree: the left column of the Log panel. A vertical toolbar (log-menus.js
// branchTools), a filter input, and the tree: HEAD, then Local, Remote and Tags. Branches
// show in branch-order.js order (the current one, the favorites, then by name), with
// "/" in a name making folders unless the ⋮ settings say otherwise. A favorite's icon is
// a star; on another branch's row the icon turns to an empty star under the pointer, and
// a click on it marks the branch (git-branch.js setFavorite).
//
// The ⋮ settings (single click, Group by Directory, Show Tags), Show My Branches and
// Hide Git Branches are kept in the app's settings file under SETTINGS_KEY.
//
// A part of the Log panel: `host` is described at the top of log-list.js. Clicking a
// branch calls host.setBranch(name, cx) (the same one again: host.setBranch(null, cx)).
// A checkout or a delete takes the repository's write lock through host.setBusy, and
// when it ends every screen on the repository is told to read again (ui.js `broadcast`),
// this panel included. While anyone holds the lock (a Fetch here, a commit in the Commit
// panel) Checkout, New Branch and Delete don't start (host.writeBlock()). The New Branch,
// Delete Branch and Deleted Branches dialogs are opened with this panel as their owner:
// it runs their writes (view-branch-new.js serveBranch, view-deleted-branches.js
// serveDeletedBranches).
//
// Two rows can be marked: the one the Commit list is limited to (host.branch), and the
// cursor, the row last clicked or reached with the arrow keys. The toolbar's Delete and
// the keyboard act on the cursor.
//
// command(name, cx) takes `branches-*` names (listed there) for keys and scripts.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme } from "herdr";
import { readBranches, trackedBranch, deleteBranch, readFavorites, setFavorite, readMyBranches, readTags } from "./git-branch.js";
import { isFavorite, nextFavorites, refOf as fullRef, treeSettings, treeSettingsMenu, toggleTreeSetting, treeRows } from "./branch-order.js";
import { appSetting, saveAppSetting } from "./app-files.js";
import { smartCheckout } from "./view-smart.js";
import { readOperation } from "./git-operation.js";
import { branchContext } from "./log-menus.js";
import { folderKeys } from "./tree.js";
import { openBranchNew, openBranchDelete } from "./view-branch-new.js";
import { openDeletedBranches } from "./view-deleted-branches.js";
import { tip, uiGlyph, darkLook, ICON, row, iconButton, notice, skeleton, skeletonSize, broadcast, openMenu, sentence, WindowedList } from "./ui.js";

const GROUPS = [["local", "log.local"], ["remote", "log.remote"]];
// One level is the fold arrow's place and the gap after it, so a child's arrow sits under
// its parent's icon and its icon under the parent's name. Every row keeps the arrow's
// place (branches and tags leave it empty), so siblings' icons line up.
const GAP = 5;
const INDENT = ICON + GAP;
// The tree's rows while the branches are read (ui.js skeleton): HEAD and the groups at
// depth 0 (the arrow's place and a name), branches and folders below (the arrow's place,
// the icon, a name).
const SKELETON = {
  indent: [6, INDENT], gap: GAP, padRight: 10, depth: [0, 0, 1, 1, 2, 2, 2, 1, 2],
  lead: ["slot", "icon"], at: { 0: { lead: ["slot"] } },
};
const FILTER_COMMAND = "branches-filter:";
const SETTINGS_KEY = "branchTree";
// The vertical toolbar's width: all that shows of the column while it is hidden.
export const TOOLS_WIDTH = 30;

// The vertical toolbar's buttons, by item (log-menus.js branchTools): element id and icon.
// Written out as calls so ui-icons.test.mjs sees every icon name. An item missing here
// draws the settings icon: an unknown name would throw in render.
const TOOL_BUTTONS = {
  "branches.hide": (t, o) => iconButton("log-branch-hide", "hide-branches", t, o),
  "branches.new": (t, o) => iconButton("log-branch-new", "plus", t, o),
  "branches.updateSelected": (t, o) => iconButton("log-branch-update", "update", t, o),
  "branches.delete": (t, o) => iconButton("log-branch-delete", "branch-delete", t, o),
  "branches.deleted": (t, o) => iconButton("log-branch-deleted", "restore", t, o),
  "branches.compareWithCurrent": (t, o) => iconButton("log-branch-compare", "compare", t, o),
  "branches.showMine": (t, o) => iconButton("log-branch-mine", "my-branches", t, o),
  "branches.fetch": (t, o) => iconButton("log-branch-fetch", "fetch", t, o),
  "branches.favorite": (t, o) => iconButton("log-branch-favorite", "favorite", t, o),
  "branches.navigateLog": (t, o) => iconButton("log-branch-navigate", "locate", t, o),
  "branches.settings": (t, o) => iconButton("log-branch-settings", "branch-settings", t, o),
  "branches.expandAll": (t, o) => iconButton("log-branch-expand", "expand-all", t, o),
  "branches.collapseAll": (t, o) => iconButton("log-branch-collapse", "collapse-all", t, o),
};
function toolButton(id, t, o) {
  if (TOOL_BUTTONS[id]) return TOOL_BUTTONS[id](t, o);
  const elementId = `log-${id.split(".").join("-")}`;
  return iconButton(elementId, "settings", t, o);
}

export default class LogBranches {
  init(host, cx) {
    this.host = host;
    this.data = null; // what readBranches last returned
    this.read = false; // false until the first read of this repository ends
    this.turn = 0;
    this.collapsed = new Set(); // "local", "remote", "local:feature/", "remote:origin/x/"
    this.cursor = null; // key of the row the keyboard is on
    this.picked = null; // key of the row whose click set host.branch
    this.rows = treeRows(null);
    this.stale = true; // rows must be worked out again (see current)
    this.list = new WindowedList("log-branch-rows");
    this.handle = cx.focus_handle();
    this.prefs = { favorite: [], unfavorite: [] }; // git-branch.js readFavorites
    this.settings = treeSettings(null);
    this.mine = null; // readMyBranches' result while Show My Branches is on
    this.hovered = null; // key of the row under the pointer
    this.makeInput("");
    cx.spawn(async (cx) => {
      const saved = treeSettings(await appSetting(SETTINGS_KEY));
      if (JSON.stringify(saved) === JSON.stringify(this.settings)) return;
      this.settings = saved;
      this.stale = true;
      this.reload(cx);
      cx.notify();
    });
  }

  hidden() { return this.settings.hidden; }

  // The placeholder is fixed when the input is made: a copy whose language changed since
  // gets a new input holding what was typed.
  makeInput(value) {
    this.inputLang = this.host.lang;
    this.input = InputState.new({ placeholder: this.host.t("log.filterBranches"), value });
    this.input.on("change", (_e, cx) => { this.build(); this.list.top = 0; cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  // ---- reading

  // The panel calls this from host.reload: read the branches again. What is shown stays
  // until the new ones are there.
  reload(cx) {
    const { host } = this, repo = host.repo, turn = ++this.turn;
    if (!repo) { this.data = null; this.read = false; this.key = null; this.picked = null; this.cursor = null; this.stale = true; return; }
    const key = JSON.stringify([repo.root, repo.on]);
    if (key !== this.key) { this.key = key; this.data = null; this.read = false; this.picked = null; this.cursor = null; this.collapsed = new Set(); this.list.top = 0; this.stale = true; }
    const { tags, mine } = this.settings;
    cx.spawn(async (cx) => {
      const [r, prefs, tagged, my] = await Promise.all([
        readBranches(repo.git, repo.root), readFavorites(repo.git, repo.root),
        tags ? readTags(repo.git, repo.root) : null, mine ? readMyBranches(repo.git, repo.root) : null,
      ]);
      // A favorite or a tag that can't be read only goes without its star or its group.
      r.tags = tagged?.ok ? tagged.tags : [];
      if (prefs.ok) this.prefs = { favorite: prefs.favorite, unfavorite: prefs.unfavorite };
      // A rebase runs on a detached HEAD, and the HEAD row says so then. Asked only while
      // HEAD is detached: reading the operation also reads the working tree's status.
      if (r.ok && !r.head.branch && r.head.hash) {
        const op = await readOperation(repo.git, repo.root);
        r.rebasing = op.ok && op.kind === "rebase";
      }
      if (turn !== this.turn) return;
      this.read = true;
      if (!r.ok) { this.failed = r.err; host.fail(r.err, cx); host.redraw(cx); return; }
      this.mine = my?.ok ? { email: my.email, refs: new Set(my.mine) } : null;
      if (my && !my.ok) host.fail(my.err, cx);
      // The read works again: its own old error goes, anyone else's stays.
      if (this.failed && host.error === this.failed) host.fail(null, cx);
      this.failed = null;
      const before = this.picked ? this.refOf(this.picked) : null;
      this.data = r;
      this.build();
      this.follow(before, cx);
      host.redraw(cx);
    });
  }

  // The limit this tree set on the Commit list follows what it was set on: HEAD moves
  // with a checkout, and a branch that is gone can't limit anything.
  follow(before, cx) {
    const { host } = this;
    if (!this.picked) return;
    // The limit was changed elsewhere since (the Branch filter): it is no longer ours.
    if (!before || host.branch !== before) { this.picked = null; return; }
    const now = this.refOf(this.picked);
    if (now === before) return;
    if (!now) this.picked = null;
    host.setBranch(now, cx);
  }

  // ---- rows

  // key → the ref the Commit list is limited to for that row, or null when the row is
  // no branch (or no longer there).
  refOf(key) {
    const d = this.data;
    if (!d || !key) return null;
    if (key === "head") return d.head.branch ?? (d.head.hash ? "HEAD" : null);
    const cut = key.indexOf(":"), scope = key.slice(0, cut), name = key.slice(cut + 1);
    // Tags are names (git-branch.js readTags), branches readBranches entries.
    if (scope === "tags" ? !(d.tags ?? []).includes(name) : !(d[scope] ?? []).some((b) => b.name === name)) return null;
    // A tag by its full name: a branch may have the same short one.
    return scope === "tags" ? `refs/tags/${name}` : name;
  }

  // The row the Commit list is limited to: the one that was clicked, or, when the limit
  // came from elsewhere (the Branch filter), the branch of that name.
  limitedKey() {
    const ref = this.host.branch, d = this.data;
    if (!ref || !d) return null;
    if (this.picked && this.refOf(this.picked) === ref) return this.picked;
    if (d.local.some((b) => b.name === ref)) return `local:${ref}`;
    if (d.remote.some((b) => b.name === ref)) return `remote:${ref}`;
    if (ref.startsWith("refs/tags/") && (d.tags ?? []).includes(ref.slice(10))) return `tags:${ref.slice(10)}`;
    return null;
  }

  words() { return this.input.value().trim().toLowerCase(); }

  // The rows (branch-order.js treeRows): { length, row(i), index(key), parent(i) }. Show My
  // Branches shows only branches holding a commit of the person's (git-branch.js
  // readMyBranches); none at all while user.email isn't set.
  build() {
    this.stale = false;
    this.builtLang = this.host.lang;
    this.rows = treeRows(this.data, {
      settings: this.settings, prefs: this.prefs, mine: this.settings.mine ? this.mine : null,
      words: this.words(), collapsed: this.collapsed, t: this.host.t,
    });
  }

  // For a key, a click or a command: the rows as they are now. What changes them (a read,
  // the filter, a fold, a favorite, a setting) builds them at once; rows hold their words,
  // so a language change builds them too. render never builds them: in a repository with
  // thousands of branches and tags that takes longer than Herdr gives a render, which it
  // then stops ("interrupted"). It draws the last ones and has a timer build new ones.
  current() {
    if (this.stale || this.builtLang !== this.host.lang) this.build();
    return this.rows;
  }

  at(key) { return key ? this.rows.index(key) : -1; }
  cursorRow() { const i = this.at(this.cursor); return i < 0 ? null : this.rows.row(i) ?? null; }

  // What an action on a row works on: { name, from, scope, current, upstream, gone }, or
  // null for a folder. `from` is what a new branch would start at: the full ref name, since
  // a tag or a local branch may share the short one. upstream: the branch a local one
  // tracks (git-branch.js trackedBranch: none when gone), else null; gone: what it tracked
  // is no longer on the remote. A tag's scope is "tag".
  target(m) {
    const d = this.data;
    if (!m || !d) return null;
    if (m.kind === "branch") {
      const from = `${m.scope === "remote" ? "refs/remotes/" : "refs/heads/"}${m.branch.name}`;
      const local = m.scope === "local";
      return { name: m.branch.name, from, scope: m.scope, current: local && m.branch.current, upstream: local ? trackedBranch(m.branch) : null, gone: local && Boolean(m.branch.gone) };
    }
    if (m.kind === "tag") return { name: m.branch.name, from: `refs/tags/${m.branch.name}`, scope: "tag", current: false, upstream: null, gone: false };
    if (m.kind !== "head") return null;
    if (d.head.branch) {
      const mine = d.local.find((b) => b.name === d.head.branch);
      return { name: d.head.branch, from: `refs/heads/${d.head.branch}`, scope: "local", current: true, upstream: trackedBranch(mine), gone: Boolean(mine?.gone) };
    }
    return d.head.hash ? { name: d.head.hash.slice(0, 7), from: d.head.hash, scope: "head", current: true, upstream: null, gone: false } : null;
  }

  // Why Delete can't run on this target, or null when it can.
  deleteBlock(b) {
    const tr = this.host.t;
    if (!b || b.scope === "tag") return tr("log.selectLocalToDelete");
    if (b.scope === "remote") return tr("log.remoteNoDelete");
    if (b.current) return tr("log.currentNoDelete");
    return null;
  }

  // ---- what a click does

  setFold(key, folded, cx) {
    if (folded) this.collapsed.add(key); else this.collapsed.delete(key);
    this.build();
    cx.notify();
  }

  // A click or Enter: a group or folder folds. A branch, a tag or HEAD limits the Commit
  // list to itself, and lets go of it when it already does; with the ⋮ setting "Navigate
  // Log to Branch Head" it selects its head commit instead.
  activate(m, cx) {
    if (!m) return;
    this.cursor = m.key;
    if (m.kind === "group" || m.kind === "folder") { if (!this.words()) this.setFold(m.key, m.open, cx); return; }
    if (this.settings.click === "navigate") { this.navigate(this.target(m), cx); cx.notify(); return; }
    const ref = this.refOf(m.key);
    if (!ref) return;
    if (this.limitedKey() === m.key) { this.picked = null; this.host.setBranch(null, cx); }
    else { this.picked = m.key; this.host.setBranch(ref, cx); }
    cx.notify();
  }

  // The cursor on row `to` (clamped): Home and End.
  jump(to, cx) {
    const rows = this.current(), n = rows.length;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, to));
    this.cursor = rows.row(i).key;
    this.list.reveal(i, n);
    cx.notify();
  }

  move(by, cx) {
    const rows = this.current(), n = rows.length;
    if (!n) return;
    const now = this.at(this.cursor);
    const next = now < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, now + by));
    this.cursor = rows.row(next).key;
    this.list.reveal(next, n);
    cx.notify();
  }

  // Left folds an open folder, else goes to the row it sits under; right unfolds.
  fold(left, cx) {
    const rows = this.current(), i = this.at(this.cursor), m = i < 0 ? null : rows.row(i);
    if (!m) return;
    const folder = m.kind === "group" || m.kind === "folder";
    if (folder && m.open === left && !this.words()) return this.setFold(m.key, left, cx);
    if (!left) return;
    const parent = rows.parent(i);
    if (parent >= 0) { this.cursor = rows.row(parent).key; this.list.reveal(parent, rows.length); cx.notify(); }
  }

  expandAll(cx) { this.collapsed = new Set(); this.build(); cx.notify(); }

  collapseAll(cx) {
    const next = new Set(), d = this.data;
    for (const [scope] of GROUPS) {
      next.add(scope);
      for (const key of folderKeys((d?.[scope] ?? []).map((b) => ({ path: b.name })))) next.add(`${scope}:${key}`);
    }
    next.add("tags");
    this.collapsed = next;
    this.build();
    this.list.top = 0;
    cx.notify();
  }

  // ---- favorites, the ⋮ settings and the toolbar's toggles

  // A local or remote branch's full ref name, or null for HEAD detached, a tag, nothing.
  favoriteRef(b) { return b && (b.scope === "local" || b.scope === "remote") ? b.from : null; }

  // Mark or unmark `b` as a favorite: shown at once, then kept in the repository's config.
  // Not a write of the repository's content, so it takes no write lock; the screens on
  // the repository read again to show it.
  toggleFavorite(b, cx) {
    const { host } = this, repo = host.repo, ref = this.favoriteRef(b);
    if (!repo || !ref) return;
    const on = !isFavorite(ref, this.prefs);
    this.prefs = nextFavorites(this.prefs, ref, on);
    this.build();
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await setFavorite(repo.git, repo.root, ref, on);
      if (!r.ok) host.failedOn(repo, host.t("branch-tree.favoriteFailed", { err: r.err }), cx);
      broadcast({ type: "changed", root: repo.root });
      if (host.shows(repo)) this.reload(cx);
      cx.notify();
    });
  }

  // Selects the head commit of `b` in the Commit list. Not there (the list is limited to
  // something else, or filtered): says so.
  navigate(b, cx) {
    const { host } = this;
    if (!b?.from) return;
    const text = b.scope === "head" ? b.name : b.from.replace(/^refs\/(heads|remotes|tags)\//, "");
    cx.spawn(async (cx) => {
      const turn = host.beginJump();
      const found = await host.goTo(b.from, cx, turn);
      if (found === false && host.jumpLive(turn)) host.fail(host.t(host.branch || host.filterArgs?.length ? "log.commitFiltered" : "log.commitNowhere", { text }), cx);
      cx.notify();
    });
  }

  // Takes `next` as the settings now and saves them; what they change is read again.
  useSettings(next, cx) {
    const before = this.settings;
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    this.settings = next;
    this.build();
    if ((next.tags && !before.tags) || (next.mine && !before.mine)) this.reload(cx);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await saveAppSetting(SETTINGS_KEY, next);
      if (!r.ok) this.host.fail(this.host.t("branch-tree.settingsFailed", { err: r.err }), cx);
      cx.notify();
    });
  }

  // "mine" (Show My Branches) or "hidden" (Hide Git Branches).
  toggle(id, cx) { this.useSettings(toggleTreeSetting(this.settings, id), cx); }

  // The ⋮ Branches Pane Settings popup: a group name nothing can pick, then the choices
  // with a check mark before what is on.
  openSettings(cx) {
    const { host } = this, tr = host.t;
    const rows = treeSettingsMenu(this.settings).map((it) => (it.header
      ? { label: tr(it.key), value: null, disabled: true }
      : { label: `${it.checked ? "✓" : " "}  ${tr(it.key)}`, value: it.id, rule: Boolean(it.rule) }));
    cx.spawn(async (cx) => {
      const id = await openMenu(host.bus, rows, { width: 260, lang: host.lang });
      this.handle.focus();
      if (id) this.useSettings(toggleTreeSetting(this.settings, id), cx);
      cx.notify();
    });
  }

  // ---- git actions

  // One git write at a time for the repository: takes its write lock, and when the write
  // ends tells every screen on the repository to read again.
  act(label, work, cx) {
    const { host } = this, repo = host.repo;
    if (!repo || !host.setBusy(label, cx)) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await work(repo); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      host.setBusy(null, cx);
      // The panel may show another repository by now: its strip and Branch tree are
      // that one's, and only a failure reaches them, with this one's folder name.
      const here = host.shows(repo);
      if (r.ok) {
        if (here && this.acted && host.error === this.acted) host.fail(null, cx);
        this.acted = null;
      } else if (!r.quiet) {
        // git's own words, as they are: nothing is retried with force.
        this.acted = host.failedOn(repo, sentence(host.t, r.msg, r.err), cx);
      }
      // After the lock is released: the panel skips reads while a write runs.
      if (r.ok) { broadcast({ type: "changed", root: repo.root }); if (here) this.reload(cx); }
      cx.notify();
    });
  }

  checkout(b, cx) {
    if (!b || b.current || b.scope === "head" || b.scope === "tag") return;
    // Local changes in the way open the Smart dialog, with this panel running its writes.
    const host = this.host;
    this.act({ key: "log.checkingOut" }, (repo) => smartCheckout(repo, { name: b.name, remote: b.scope === "remote" }, { owner: host.bus.id, lang: host.lang, who: "ui.logPanel" }), cx);
  }

  newBranch(b, cx) {
    const { host } = this, repo = host.repo;
    if (!repo || host.writeBlock()) return;
    // The toolbar starts at HEAD; a row's menu starts at that row's branch.
    openBranchNew({ root: repo.root, on: repo.on, from: b ? b.from : null, label: b ? b.name : "HEAD", chosen: Boolean(host.fixed), owner: host.bus.id, lang: host.lang });
    cx.notify();
  }

  // Deleted at once when nothing would be lost. Otherwise git-branch.js refuses and
  // says how many commits would go; the dialog asks, and deletes if the answer is yes.
  // A branch deleted takes over the panel's Restore notice; a refusal leaves it.
  remove(b, cx) {
    if (this.deleteBlock(b)) return;
    this.act({ key: "log.deleting" }, async (repo) => {
      const r = await deleteBranch(repo.git, repo.root, b.name);
      if (r.ok) this.host.noteDeleted(repo, r.deleted);
      if (!r.ok && r.unmerged > 0) {
        openBranchDelete({ root: repo.root, on: repo.on, name: b.name, unmerged: r.unmerged, chosen: Boolean(this.host.fixed), owner: this.host.bus.id, lang: this.host.lang });
        return { ok: false, quiet: true };
      }
      return r;
    }, cx);
  }

  // Opens the Deleted Branches dialog on this repository. It opens while another write
  // runs too: the list reads, and the dialog keeps Restore off until the write ends.
  deletedBranches(cx) {
    const { host } = this, repo = host.repo;
    if (!repo || !this.data) return;
    openDeletedBranches({ root: repo.root, on: repo.on, chosen: Boolean(host.fixed), owner: host.bus.id, lang: host.lang });
    cx.notify();
  }

  // Which menu a row has (log-menus.js): the HEAD row, the current branch, another local
  // branch, a remote branch, a remote's own folder (the first level under Remote).
  menuOf(m, b) {
    if (m.kind === "head") return "headBranch";
    if (m.kind === "tag") return null;
    if (m.kind === "folder") return m.key.startsWith("remote:") && m.depth === 1 ? "remoteFolder" : null;
    if (!b) return null;
    return b.scope === "remote" ? "remoteBranch" : b.current ? "currentBranch" : "localBranch";
  }

  menu(m, cx) {
    const { host } = this, b = this.target(m), which = m ? this.menuOf(m, b) : null;
    if (!which) return;
    const d = this.data, tr = host.t;
    // A remote's folder has no branch: its label stands in for the name.
    const ctx = branchContext(b ?? { name: m.label }, { head: d?.head, writing: host.writeBlock(), deleteBlock: b ? this.deleteBlock(b) : null });
    const items = host.items(which, ctx);
    if (!items.length) return;
    const target = b ?? { remote: m.label };
    const rows = items.map((it) => ({ label: tr(it.key, it.args), value: it.id, rule: it.rule, disabled: it.disabled, hint: it.hint ?? undefined, title: it.why ? (it.why.text ?? tr(it.why.key, it.why.args)) || undefined : undefined }));
    // While the menu is open its row shows no tooltip: it would cover the first item.
    this.menuRow = m.key;
    cx.spawn(async (cx) => {
      // The answer arrives in this panel's own call (ui.js), so what the pick starts
      // (git, a dialog) is the panel's work and outlives the popup.
      const pick = await openMenu(host.bus, rows, { width: 300, lang: host.lang });
      if (this.menuRow === m.key) this.menuRow = null;
      this.handle.focus();
      if (pick) host.run(pick, target, cx);
      cx.notify();
    });
  }

  // `git-tools.branches-…` for keys and scripts. They act on the cursor row:
  //   branches-next, branches-prev, branches-left, branches-right, branches-top,
  //   branches-end, branches-page-down, branches-page-up: move, fold
  //   branches-toggle: what a click does (limit the Commit list, fold a folder)
  //   branches-menu, branches-checkout, branches-new-from, branches-delete: that row
  //   branches-new (from HEAD), branches-deleted (the Deleted Branches dialog),
  //   branches-fetch, branches-expand-all,
  //   branches-collapse-all, branches-focus, branches-filter-focus,
  //   branches-filter:<text> (sets the filter input; no text clears it)
  command(name, cx) {
    const n = this.current().length, m = this.cursorRow(), page = Math.max(1, this.list.fit - 1);
    if (name === "branches-next") this.move(1, cx);
    else if (name === "branches-prev") this.move(-1, cx);
    else if (name === "branches-page-down") this.move(page, cx);
    else if (name === "branches-page-up") this.move(-page, cx);
    else if (name === "branches-top") this.jump(0, cx);
    else if (name === "branches-end") this.jump(n, cx);
    else if (name === "branches-left") this.fold(true, cx);
    else if (name === "branches-right") this.fold(false, cx);
    else if (name === "branches-toggle") this.activate(m, cx);
    else if (name === "branches-menu") this.menu(m, cx);
    else if (name === "branches-checkout") this.checkout(this.target(m), cx);
    else if (name === "branches-new-from") this.newBranch(this.target(m), cx);
    else if (name === "branches-new") this.newBranch(null, cx);
    else if (name === "branches-delete") this.remove(this.target(m), cx);
    else if (name === "branches-deleted") this.deletedBranches(cx);
    else if (name === "branches-fetch") this.host.fetch(cx);
    else if (name === "branches-expand-all") this.expandAll(cx);
    else if (name === "branches-collapse-all") this.collapseAll(cx);
    else if (name === "branches-focus") this.handle.focus();
    else if (name === "branches-filter-focus") this.input.focus();
    else if (name.startsWith(FILTER_COMMAND)) { this.input.set_value(name.slice(FILTER_COMMAND.length)); this.build(); this.list.top = 0; cx.notify(); }
  }

  // ---- drawing

  chevron(m, t) {
    return uiGlyph(m.open ? "chevron-down" : "chevron-right").text_color(t.muted);
  }

  treeRow(i, t, limited) {
    const m = this.rows.row(i), cursor = this.cursor === m.key && limited !== m.key;
    let el = row(`log-branch-${i}`, t, { selected: limited === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(GAP)
      .when(cursor, (el) => el.bg(t.hover))
      .on_click((_e, cx) => { this.handle.focus(); this.activate(m, cx); })
      .on_mouse_down("right", (_e, cx) => { this.handle.focus(); this.cursor = m.key; this.menu(m, cx); cx.notify(); });
    if (m.kind === "group") {
      return el.child(this.chevron(m, t)).child(div().flex_1().min_w(0).truncate().font_semibold().child(m.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(String(m.count)));
    }
    if (m.kind === "folder") {
      return el.child(this.chevron(m, t)).child(uiGlyph("folder").text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(m.label))
        .when(!m.open, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(m.count))));
    }
    if (m.kind === "head") {
      // No icon on the HEAD row: the empty arrow-wide place lines its label up with the groups'.
      return el.child(div().size(ICON).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(m.label));
    }
    const dark = darkLook(t.background);
    if (m.kind === "tag") {
      if (this.menuRow !== m.key) el = tip(el, m.branch.name);
      return el.child(div().size(ICON).flex_none()).child(uiGlyph("tag", { dark })).child(div().flex_1().min_w(0).truncate().child(m.label));
    }
    const b = m.branch, here = m.scope === "local" && b.current;
    const favorite = isFavorite(fullRef(m.scope, b.name), this.prefs);
    // The icon is the star: a favorite's, or an empty one under the pointer. A click on it
    // marks or unmarks the branch and does nothing else.
    // Each name written out so ui-icons.test.mjs sees it.
    const glyph = here ? (favorite ? uiGlyph("current-branch-favorite", { dark }) : uiGlyph("current-branch", { dark }))
      : favorite ? uiGlyph("favorite", { dark }) : uiGlyph(this.hovered === m.key ? "favorite-hover" : "branch-item", { dark });
    const star = div().id(`log-branch-star-${i}`).flex_none().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFavorite(this.target(m), cx); })
      .child(glyph);
    el = el.on_hover((over, cx) => {
      const was = this.hovered;
      if (over) this.hovered = m.key; else if (this.hovered === m.key) this.hovered = null;
      if (was !== this.hovered) cx.notify();
    });
    // No tooltip while this row's menu is open.
    if (this.menuRow !== m.key) el = tip(el, m.scope === "local" && trackedBranch(b) ? `${b.name} → ${trackedBranch(b)}` : b.name);
    return el
      .child(div().size(ICON).flex_none())
      .child(star)
      .child(div().flex_1().min_w(0).truncate().when(here, (el) => el.font_semibold()).child(m.label))
      // Commits not pushed yet (ahead) and not pulled yet (behind), against its upstream.
      .when(b.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${b.ahead}`)))
      .when(b.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi4).child(`↓${b.behind}`)));
  }

  // The vertical toolbar (log-menus.js branchTools). Its buttons act on the cursor row.
  // While the column is hidden only Hide Git Branches shows, pressed, to bring it back.
  tools(t) {
    const { host } = this, b = this.target(this.cursorRow()), tr = host.t, hidden = this.hidden();
    const ctx = { loaded: Boolean(this.data), name: b?.name, upstream: b?.upstream ?? null, favoritable: Boolean(this.favoriteRef(b)), writing: host.writeBlock(), deleteBlock: this.deleteBlock(b) };
    const items = host.items("branchTools", ctx).filter((it) => !hidden || it.id === "branches.hide");
    const pressed = { "branches.hide": hidden, "branches.showMine": this.settings.mine };
    let bar = v_flex().id("log-branch-tools").flex_none().w(TOOLS_WIDTH).h_full().py(5).gap(2).items_center().border_r(1).border_color(t.border);
    for (const it of items) {
      if (it.rule && !hidden) bar = bar.child(div().w(16).h(1).my(3).bg(t.border));
      const title = (it.why?.text ?? (it.why ? tr(it.why.key, it.why.args) : "")) || tr(it.key, it.args);
      bar = bar.child(toolButton(it.id, t, {
        title, disabled: it.disabled, active: Boolean(pressed[it.id]), busy: it.work !== null && host.writingHere()?.key === it.work, onClick: (_e, cx) => host.run(it.id, b, cx),
      }));
    }
    return bar;
  }

  render(cx) {
    const { host } = this, t = theme(), tr = host.t;
    if (!host.repo) return div();
    if (this.inputLang !== host.lang && !this.relabeling) {
      // Not here: render may not make the redraw a new input needs.
      this.relabeling = true;
      cx.timer.after(1, (cx) => { this.relabeling = false; if (this.inputLang !== this.host.lang) { const typing = this.typing; this.makeInput(this.input.value()); if (typing) this.input.focus(); cx.notify(); } });
    }
    if ((this.stale || this.builtLang !== host.lang) && !this.building) {
      this.building = true;
      cx.timer.after(0, (cx) => { this.building = false; this.current(); cx.notify(); });
    }
    if (this.hidden()) return h_flex().id("log-branch-tree").size_full().min_h(0).items_start().child(this.tools(t));
    const rows = this.rows, n = rows.length, limited = this.limitedKey();
    const noEmail = this.settings.mine && this.mine && !this.mine.email;
    const body = !this.read ? skeleton(t, SKELETON, this.listSize ??= skeletonSize("branch-tree-wait"))
      : noEmail ? notice(tr("branch-tree.noEmail"), t)
        : !n ? notice(this.words() ? tr("log.noBranchesMatch") : "", t)
          : this.list.render(n, (i) => this.treeRow(i, t, limited), t);
    return h_flex().id("log-branch-tree").size_full().min_h(0).min_w(0).items_start().text_size(12.5)
      .child(this.tools(t))
      .child(v_flex().flex_1().min_w(0).h_full().min_h(0)
        // As tall as the Commit list's toolbar, so the two bottom lines meet.
        .child(h_flex().id("log-branch-filter").h(34).flex_none().w_full().min_w(0).px(8).gap(6).items_center().border_b(1).border_color(t.border)
          .cursor_text().on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
          .child(uiGlyph("search").text_color(this.typing ? t.accent : t.dim))
          .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12.5).text_color(t.foreground)))
        .child(div().id("log-branch-list").track_focus(this.handle).flex_1().min_h(0).w_full()
          .on_key_down((e, cx) => {
            const page = Math.max(1, this.list.fit - 1);
            if (e.key === "down") this.move(1, cx);
            else if (e.key === "up") this.move(-1, cx);
            else if (e.key === "pagedown") this.move(page, cx);
            else if (e.key === "pageup") this.move(-page, cx);
            else if (e.key === "home") this.jump(0, cx);
            else if (e.key === "end") this.jump(n, cx);
            else if (e.key === "left") this.fold(true, cx);
            else if (e.key === "right") this.fold(false, cx);
            else if (e.key === "enter") this.activate(this.cursorRow(), cx);
            else return;
            cx.stop_propagation();
          })
          .child(body)));
  }
}
