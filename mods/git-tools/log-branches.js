// Branch tree: the left column of the Log panel. A vertical toolbar (New Branch, Delete,
// Deleted Branches, Fetch, Expand All, Collapse All), a filter input, and the tree: HEAD, then Local and
// Remote with "/" in a name making folders.
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
import { readBranches, checkout, deleteBranch } from "./git-branch.js";
import { shortenMiddle } from "./git-log.js";
import { buildRows, folderKeys, parentIndex } from "./tree.js";
import { openBranchNew, openBranchDelete } from "./view-branch-new.js";
import { openDeletedBranches } from "./view-deleted-branches.js";
import { uiGlyph, darkLook, ICON, row, iconButton, notice, broadcast, openMenu, sentence, WindowedList } from "./ui.js";

const GROUPS = [["local", "log.local"], ["remote", "log.remote"]];
const INDENT = 12;
const FILTER_COMMAND = "branches-filter:";

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
    this.rows = [];
    this.stale = true; // rows must be worked out again
    this.list = new WindowedList("log-branch-rows");
    this.handle = cx.focus_handle();
    this.makeInput("");
  }

  // The placeholder is fixed when the input is made: a copy whose language changed since
  // gets a new input holding what was typed.
  makeInput(value) {
    this.inputLang = this.host.lang;
    this.input = InputState.new({ placeholder: this.host.t("log.filterBranches"), value });
    this.input.on("change", (_e, cx) => { this.stale = true; this.list.top = 0; cx.notify(); });
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
    cx.spawn(async (cx) => {
      const r = await readBranches(repo.git, repo.root);
      if (turn !== this.turn) return;
      this.read = true;
      if (!r.ok) { this.failed = r.err; host.fail(r.err, cx); cx.notify(); return; }
      // The read works again: its own old error goes, anyone else's stays.
      if (this.failed && host.error === this.failed) host.fail(null, cx);
      this.failed = null;
      const before = this.picked ? this.refOf(this.picked) : null;
      this.data = r;
      this.stale = true;
      this.follow(before, cx);
      cx.notify();
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
    return (d[scope] ?? []).some((b) => b.name === name) ? name : null;
  }

  // The row the Commit list is limited to: the one that was clicked, or, when the limit
  // came from elsewhere (the Branch filter), the branch of that name.
  limitedKey() {
    const ref = this.host.branch, d = this.data;
    if (!ref || !d) return null;
    if (this.picked && this.refOf(this.picked) === ref) return this.picked;
    if (d.local.some((b) => b.name === ref)) return `local:${ref}`;
    if (d.remote.some((b) => b.name === ref)) return `remote:${ref}`;
    return null;
  }

  words() { return this.input.value().trim().toLowerCase(); }

  build() {
    const d = this.data, rows = [], tr = this.host.t;
    this.stale = false;
    this.builtLang = this.host.lang;
    this.rows = rows;
    if (!d) return;
    const words = this.words();
    const match = (name) => !words || name.toLowerCase().includes(words);
    const current = tr("log.headCurrent");
    if (match(current) || (d.head.branch && match(d.head.branch))) {
      rows.push({ key: "head", kind: "head", depth: 0, label: d.head.branch ? current : d.head.hash ? `HEAD (${d.head.hash.slice(0, 7)})` : "HEAD" });
    }
    for (const [scope, key] of GROUPS) {
      const label = tr(key);
      const items = d[scope].filter((b) => match(b.name)).map((b) => ({ path: b.name, branch: b }));
      if (words && !items.length) continue;
      // While filtering everything that matches shows, whatever is folded.
      const open = words ? true : !this.collapsed.has(scope);
      rows.push({ key: scope, kind: "group", depth: 0, label, open, count: items.length });
      if (!open) continue;
      const folded = new Set();
      if (!words) for (const key of this.collapsed) if (key.startsWith(`${scope}:`)) folded.add(key.slice(scope.length + 1));
      for (const r of buildRows(items, { grouped: true, collapsed: folded })) {
        rows.push(r.folder
          ? { key: `${scope}:${r.key}`, kind: "folder", depth: r.depth + 1, label: r.name, open: r.open, count: r.count }
          : { key: `${scope}:${r.path}`, kind: "branch", scope, depth: r.depth + 1, label: r.name, branch: r.item.branch });
      }
    }
  }

  // Rows hold their words: worked out again when the copy's language changes.
  current() {
    if (this.stale || this.builtLang !== this.host.lang) this.build();
    return this.rows;
  }

  at(key) { return key ? this.current().findIndex((r) => r.key === key) : -1; }
  cursorRow() { const i = this.at(this.cursor); return i < 0 ? null : this.rows[i]; }

  // What an action on a row works on: { name, from, scope, current }, or null for a
  // folder. `from` is what a new branch would start at: the full ref name, since a tag or
  // a local branch may share the short one.
  target(m) {
    const d = this.data;
    if (!m || !d) return null;
    if (m.kind === "branch") {
      const from = `${m.scope === "remote" ? "refs/remotes/" : "refs/heads/"}${m.branch.name}`;
      return { name: m.branch.name, from, scope: m.scope, current: m.scope === "local" && m.branch.current };
    }
    if (m.kind !== "head") return null;
    if (d.head.branch) return { name: d.head.branch, from: `refs/heads/${d.head.branch}`, scope: "local", current: true };
    return d.head.hash ? { name: d.head.hash.slice(0, 7), from: d.head.hash, scope: "head", current: true } : null;
  }

  // Why Delete can't run on this target, or null when it can.
  deleteBlock(b) {
    const tr = this.host.t;
    if (!b) return tr("log.selectLocalToDelete");
    if (b.scope === "remote") return tr("log.remoteNoDelete");
    if (b.current) return tr("log.currentNoDelete");
    return null;
  }

  // ---- what a click does

  setFold(key, folded, cx) {
    if (folded) this.collapsed.add(key); else this.collapsed.delete(key);
    this.stale = true;
    cx.notify();
  }

  // A click or Enter: a group or folder folds, a branch (or HEAD) limits the Commit
  // list to itself, and lets go of it when it already does.
  activate(m, cx) {
    if (!m) return;
    this.cursor = m.key;
    if (m.kind === "group" || m.kind === "folder") { if (!this.words()) this.setFold(m.key, m.open, cx); return; }
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
    this.cursor = rows[i].key;
    this.list.reveal(i, n);
    cx.notify();
  }

  move(by, cx) {
    const rows = this.current(), n = rows.length;
    if (!n) return;
    const now = this.at(this.cursor);
    const next = now < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, now + by));
    this.cursor = rows[next].key;
    this.list.reveal(next, n);
    cx.notify();
  }

  // Left folds an open folder, else goes to the row it sits under; right unfolds.
  fold(left, cx) {
    const rows = this.current(), i = this.at(this.cursor), m = rows[i];
    if (!m) return;
    const folder = m.kind === "group" || m.kind === "folder";
    if (folder && m.open === left && !this.words()) return this.setFold(m.key, left, cx);
    if (!left) return;
    const parent = parentIndex(rows, i);
    if (parent >= 0) { this.cursor = rows[parent].key; this.list.reveal(parent, rows.length); cx.notify(); }
  }

  expandAll(cx) { this.collapsed = new Set(); this.stale = true; cx.notify(); }

  collapseAll(cx) {
    const next = new Set(), d = this.data;
    for (const [scope] of GROUPS) {
      next.add(scope);
      for (const key of folderKeys((d?.[scope] ?? []).map((b) => ({ path: b.name })))) next.add(`${scope}:${key}`);
    }
    this.collapsed = next;
    this.stale = true;
    this.list.top = 0;
    cx.notify();
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
    if (!b || b.current || b.scope === "head") return;
    this.act({ key: "log.checkingOut" }, (repo) => checkout(repo.git, repo.root, b.name, { remote: b.scope === "remote" }), cx);
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
    if (m.kind === "folder") return m.key.startsWith("remote:") && m.depth === 1 ? "remoteFolder" : null;
    if (!b) return null;
    return b.scope === "remote" ? "remoteBranch" : b.current ? "currentBranch" : "localBranch";
  }

  menu(m, cx) {
    const { host } = this, b = this.target(m), which = m ? this.menuOf(m, b) : null;
    if (!which) return;
    const d = this.data, tr = host.t;
    const upstream = m.kind === "branch" && m.scope === "local" ? m.branch.upstream : null;
    const ctx = {
      name: b ? shortenMiddle(b.name, 30) : m.label, current: d?.head.branch ?? (d?.head.hash ? d.head.hash.slice(0, 7) : "HEAD"),
      upstream: upstream ?? "", writing: host.writeBlock(), deleteBlock: b ? this.deleteBlock(b) : null,
    };
    const items = host.items(which, ctx);
    if (!items.length) return;
    const target = b ?? { remote: m.label };
    const rows = items.map((it) => ({ label: tr(it.key, it.args), value: it.id, rule: it.rule, disabled: it.disabled, title: it.why ? (it.why.text ?? tr(it.why.key, it.why.args)) || undefined : undefined }));
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
    const m = this.cursorRow(), page = Math.max(1, this.list.fit - 1), n = this.current().length;
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
    else if (name.startsWith(FILTER_COMMAND)) { this.input.set_value(name.slice(FILTER_COMMAND.length)); this.stale = true; this.list.top = 0; cx.notify(); }
  }

  // ---- drawing

  chevron(m, t) {
    return uiGlyph(m.open ? "chevron-down" : "chevron-right").text_color(t.muted);
  }

  treeRow(i, t, limited) {
    const m = this.rows[i], cursor = this.cursor === m.key && limited !== m.key;
    let el = row(`log-branch-${i}`, t, { selected: limited === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
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
    const b = m.branch, here = m.scope === "local" && b.current;
    // No tooltip while this row's menu is open.
    if (this.menuRow !== m.key) el = el.tooltip(m.scope === "local" && b.upstream ? `${b.name} → ${b.upstream}` : b.name);
    return el
      .child(uiGlyph(here ? "current-branch" : "branch-item", { dark: darkLook(t.background) }))
      .child(div().flex_1().min_w(0).truncate().when(here, (el) => el.font_semibold()).child(m.label))
      // Commits not pushed yet (ahead) and not pulled yet (behind), against its upstream.
      .when(b.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${b.ahead}`)))
      .when(b.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi4).child(`↓${b.behind}`)));
  }

  // The vertical toolbar (log-menus.js branchTools). Its buttons act on the cursor row.
  tools(t) {
    const { host } = this, b = this.target(this.cursorRow()), tr = host.t;
    const items = host.items("branchTools", { loaded: Boolean(this.data), name: b?.name, writing: host.writeBlock(), deleteBlock: this.deleteBlock(b) });
    let bar = v_flex().id("log-branch-tools").flex_none().w(30).h_full().py(5).gap(2).items_center().border_r(1).border_color(t.border);
    for (const it of items) {
      if (it.rule) bar = bar.child(div().w(16).h(1).my(3).bg(t.border));
      const title = (it.why?.text ?? (it.why ? tr(it.why.key, it.why.args) : "")) || tr(it.key, it.args);
      bar = bar.child(toolButton(it.id, t, {
        title, disabled: it.disabled, busy: it.work !== null && host.writingHere()?.key === it.work, onClick: (_e, cx) => host.run(it.id, b, cx),
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
    const rows = this.current(), n = rows.length, limited = this.limitedKey();
    const body = !this.read ? notice(tr("ui.loading"), t, { busy: true })
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
