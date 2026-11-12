// Commit panel: the Changes and Unversioned Files groups as a checkbox tree, flat or
// grouped by directory, kept fresh by a folder watch (this computer) and a 10 s timer
// (everywhere). The commit form under the list is commit-form.js; Rollback… opens
// view-rollback.js, Restore Rolled-Back Changes… opens view-restore.js and Show Diff opens
// view-diff.js. The Rollback, Restore and Push dialogs this panel opens ask it to run
// their writes (serve), under the repository's lock. After a rollback that recorded a
// Rollback snapshot, a notice under the panel offers Restore… for it until it is
// dismissed, the panel starts another write, or the panel moves to another folder.
//
// props: { view: "commit", folder?, on? }. With `folder` the panel shows that folder's
// repository (on machine `on`) instead of following the focused pane: for opening it as a
// tab on a chosen repository.
//
// Commands (`git-tools.<name>`, for keys and scripts; they reach shown copies only):
//   refresh, commit-group-by-directory, commit-expand-all, commit-collapse-all,
//   commit-up, commit-down, commit-left, commit-right, commit-toggle (the Space key),
//   commit-show-diff, commit-rollback, commit-restore (opens the Restore dialog).
//   Anything else is passed on to the commit form.

import { div, svg } from "gpui-kit";
import { exec, theme, watchFolder } from "herdr";
import { makeGit, repoRoot } from "./git.js";
import { readStatus } from "./git-status.js";
import { buildRows, checkState, toggleIncluded, keepIncluded, folderKeys, parentIndex } from "./tree.js";
import { location, icon, fileGlyph, folderGlyph, darkLook, panelFrame, toolbar, spacer, iconButton, checkbox, row, notice, notRepository, errorStrip, noteBar, WindowedList, logPanelShown, toggleLogPanel, openMenu, takeWrite, releaseWrite, writeBlock, readBlocked, sentence, copyId } from "./ui.js";
import { sameRepo } from "./lock.js";
import CommitForm from "./commit-form.js";
import { openRollback, serveRollback } from "./view-rollback.js";
import { openRestore, serveRestore } from "./view-restore.js";
import { servePush } from "./view-push.js";
import { openDiff } from "./view-diff.js";

// The groups' names are worded when drawn (groupName): rows outlive a change of language.
const GROUPS = [{ id: "changes" }, { id: "unversioned" }];
const POLL = 10000;
// How many folders the panel keeps the last view of (see remember).
const SEEN = 8;
// localStorage is per copy of the mod and survives restarts: the view mode stays as picked.
const GROUPED_KEY = "commit.grouped";
// This copy's id, for the scratch index of the Rollbacks and Restores it runs (ui.js copyId).
const COPY_KEY = "commit.copy";

const stop = (_e, cx) => cx.stop_propagation();

function statusColor(status, t) {
  return { modified: t.ansi4, added: t.ansi2, deleted: t.muted, conflict: t.ansi9 ?? t.ansi1, unversioned: t.ansi1 }[status] ?? t.foreground;
}

export default class CommitView {
  init(p, cx) {
    this.fixed = p?.folder ? { folder: p.folder, on: p.on ?? null } : null;
    this.changes = []; this.unversioned = [];
    this.paths = { changes: [], unversioned: [] };
    this.hasHead = false;
    this.detached = false;
    // The Included paths. Not `this.included`: that name is the method the form calls,
    // and a field of the same name would hide it.
    this.picked = new Set();
    this.grouped = false;
    try { this.grouped = localStorage.getItem(GROUPED_KEY) === "1"; } catch { /* no storage: flat */ }
    this.copy = copyId(COPY_KEY);
    // Unversioned Files starts collapsed.
    this.closed = { changes: false, unversioned: true };
    this.collapsed = { changes: new Set(), unversioned: new Set() };
    this.rows = []; this.checks = new Map();
    this.selected = null; this.at = -1;
    this.busy = null; this.held = null; // ui.js takeWrite
    this.writeError = null;
    // The Rollback notice: { repo, snapshot, n }, or null (see rolledBack).
    this.note = null;
    // context key → what the panel showed there when it left (see remember), newest last.
    this.seen = new Map();
    this.list = new WindowedList("commit-files");
    this.handle = cx.focus_handle();
    this.form = new CommitForm();
    this.form.init(this, cx);
    this.refresh(cx);
    // The watch can miss things (a remote space has none at all), so the timer stays on.
    cx.timer.every(POLL, (cx) => this.refresh(cx));
  }

  where() { return this.fixed ?? location(); }
  contextKey() { const { folder, on } = this.where(); return JSON.stringify([folder, on]); }

  // ---- what the commit form (and anything else hosted here) may use

  // repo: { git, root, on, folder }, or null outside a repository.
  // included() → [{ path, status }]: the files checked for the next commit, both groups.
  included() {
    return [...this.changes, ...this.unversioned].filter((file) => this.picked.has(file.path));
  }

  // hasHead: false while the repository has no commit (nothing to amend).
  // detached: HEAD is on no branch (the form warns before a commit is made there).
  // busy: null, or the work of the git write running now ({ key, args? }); `held` is the
  // repository it runs on, which stops being the shown one when the panel follows the
  // focused pane elsewhere. While it's set the panel opens no other write anywhere.
  // setBusy(work, cx, repo) takes the repository's lock (ui.js takeWrite; `repo`
  // defaults to the panel's) and returns false, changing nothing, when this panel
  // already writes or any copy holds that repository. setBusy(null, cx) releases it.
  setBusy(work, cx, repo = this.repo) {
    let ok = true;
    if (work) {
      // A refused request leaves the write that runs, its lock and the notice as they are.
      ok = takeWrite(this, repo, work);
      // The next write ends the Rollback notice (a rollback's own sets a new one).
      if (ok) this.note = null;
    } else releaseWrite(this);
    if (this.waiting && !this.readBlocked()) this.refresh(cx);
    cx.notify();
    return ok;
  }

  // Why no write may start now (this panel's own label, its write on another
  // repository, or another copy's), or null.
  writeBlock() { return writeBlock(this, this.repo); }

  // Reads wait while anyone (this panel included) writes to the shown repository, and
  // run once it is released (render notices, see there).
  readBlocked() { return readBlocked(this, this.repo); }

  // A write's failure. Kept apart from `error` (the last read's), which the next read
  // clears; a failed write causes one, and its words would be gone at once.
  writeFailed(text, cx) { this.writeError = text ? String(text) : null; cx.notify(); }

  // A dialog this panel opened asks it to run the write (ui.js serveRequest), so the
  // write and its result outlive the dialog.
  serve(e, cx) {
    if (e.action === "push") servePush(this, e, cx);
    else if (e.action === "rollback") serveRollback(this, e, cx);
    else if (e.action === "restore") serveRestore(this, e, cx);
    else return false;
    return true;
  }

  // serveRollback's word that a rollback on `repo` recorded `snapshot` (n files rolled
  // back): the notice under the panel, while it shows that repository.
  // by: the rollback request's key, which its own "changed" carries (see event).
  rolledBack(repo, { snapshot, n, by }) { this.note = { repo, snapshot, n, by }; }

  // After a commit on `repo`: Included is cleared and the list read again, only while the
  // panel still shows that repository (the shown one's Included isn't the commit's). When
  // the panel has moved on, the commit's Included goes from what it kept of that
  // repository for coming back (remember), or the next commit there would start with it.
  committed(cx, repo) {
    for (const was of this.seen.values()) if (sameRepo(was.repo, repo)) was.picked = new Set();
    if (!sameRepo(repo, this.repo)) return;
    this.picked = new Set(); this.checks.clear();
    this.refresh(cx);
    cx.notify();
  }

  fail(text, cx) { this.error = text ? String(text) : null; cx.notify(); }

  // ---- reading

  refresh(cx) {
    // A change that lands while a read is running is read once that one is done.
    if (this.loading) { this.again = true; return; }
    const { folder, on } = this.where(), context = this.contextKey();
    // Another folder is taken up before asking whether reads wait: a write on the
    // repository left behind must not keep that repository on screen.
    if (context !== this.context) {
      this.remember();
      this.context = context; this.repo = null; this.watching = null; this.lost = false;
      // A write's failure belongs to the repository it ran on, like a read's.
      this.error = null; this.writeError = null; this.note = null; this.notRepo = false; this.read = false;
      this.picked = new Set(); this.selected = null;
      this.closed = { changes: false, unversioned: true };
      this.collapsed = { changes: new Set(), unversioned: new Set() };
      this.apply({ hasHead: false, changes: [], unversioned: [] });
      this.list.top = 0;
      this.recall(context);
    }
    if (this.readBlocked()) { this.waiting = true; return; }
    this.waiting = false;
    if (!folder) return;
    this.loading = true; this.again = false;
    let held = false;
    cx.spawn(async (cx) => {
      try {
        let repo = this.repo;
        // The root is asked for once per folder, and again after a failed read (the
        // folder may have stopped being a repository).
        if (!repo || this.lost) {
          const git = makeGit(exec, on);
          const top = await repoRoot(git, folder);
          if (this.contextKey() !== context) return;
          if (!top.ok) {
            this.repo = null; this.watching = null;
            this.notRepo = top.notRepo; this.folder = folder;
            this.error = top.notRepo ? null : sentence(this.t, top.msg, top.err);
            if (top.notRepo) this.apply({ hasHead: false, changes: [], unversioned: [] });
            return;
          }
          repo = { git, root: top.root, on, folder };
          // Just arrived on a repository someone writes to: its files are read once the
          // write is over (the release redraws, render takes the wait up).
          if (readBlocked(this, repo)) { this.repo = repo; this.waiting = held = true; return; }
        }
        const status = await readStatus(repo.git, repo.root);
        if (this.contextKey() !== context) return;
        this.repo = repo; this.notRepo = false;
        this.lost = !status.ok;
        // A failed read keeps what was read before; git's words go in the strip below.
        if (status.ok) { this.apply(status); this.error = null; }
        else this.error = sentence(this.t, status.msg, status.err);
        this.watch(cx);
      } finally {
        this.loading = false;
        if (!held) this.read = true;
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // Leaving a folder: what the panel shows of its repository is kept, so coming back
  // shows it at once instead of "Loading…" (recall); the read that follows puts it right.
  remember() {
    if (!this.context || !this.repo || !this.read || this.notRepo) return;
    this.seen.delete(this.context);
    this.seen.set(this.context, {
      repo: this.repo, status: { hasHead: this.hasHead, detached: this.detached, changes: this.changes, unversioned: this.unversioned },
      picked: this.picked, selected: this.selected, closed: this.closed, collapsed: this.collapsed, top: this.list.top,
    });
    // A handful of folders are gone back and forth between; the rest are read afresh.
    while (this.seen.size > SEEN) this.seen.delete(this.seen.keys().next().value);
  }

  // Back on a folder seen before: its files, Included, folding and place in the list as
  // they were left. They may be out of date for the moment the read takes; files gone
  // since then drop out of Included when it lands (apply).
  recall(context) {
    const was = this.seen.get(context);
    if (!was) return;
    this.seen.delete(context);
    this.repo = was.repo;
    this.picked = was.picked; this.selected = was.selected;
    this.closed = was.closed; this.collapsed = was.collapsed;
    this.apply(was.status);
    this.list.top = was.top;
    this.read = true;
  }

  // Takes a status as readStatus returns it. Files still listed stay Included.
  apply(status) {
    this.changes = status.changes; this.unversioned = status.unversioned; this.hasHead = status.hasHead;
    this.detached = Boolean(status.detached);
    this.paths = { changes: this.changes.map((f) => f.path), unversioned: this.unversioned.map((f) => f.path) };
    this.picked = keepIncluded(this.picked, [...this.changes, ...this.unversioned]);
    this.rebuild();
  }

  // Only this computer's folders can be watched. Reads don't write under .git (git.js
  // READ), so a refresh never wakes its own watch. One loop per root: a newer watch, or
  // leaving the repository, ends the older loop the next time it wakes.
  watch(cx) {
    const repo = this.repo;
    if (!repo || repo.on || this.watching?.root === repo.root) return;
    const mine = this.watching = { root: repo.root };
    cx.spawn(async (cx) => {
      try {
        while (this.watching === mine) {
          await watchFolder(mine.root);
          if (this.watching === mine) this.refresh(cx);
        }
      } catch {
        // The folder can't be watched (too large on Linux, gone): the timer still reads.
        if (this.watching === mine) this.watching = null;
      }
    });
  }

  // ---- rows

  // The list as drawn: a group row, then its files (flat) or its folder tree. Built when
  // the data or the folding changes, never in render.
  rebuild() {
    const rows = [];
    for (const group of GROUPS) {
      const items = this[group.id];
      if (!items.length) continue;
      const open = !this.closed[group.id];
      rows.push({ id: `g:${group.id}`, kind: "group", group: group.id, depth: 0, count: items.length, paths: this.paths[group.id], open, item: null });
      if (!open) continue;
      for (const r of buildRows(items, { grouped: this.grouped, compact: true, collapsed: this.collapsed[group.id] })) {
        rows.push({ ...r, id: `${group.id}:${r.key}`, kind: r.folder ? "folder" : "file", group: group.id, depth: r.depth + 1 });
      }
    }
    this.rows = rows;
    this.checks.clear();
    this.at = this.selected ? rows.findIndex((r) => r.id === this.selected) : -1;
    if (this.at < 0) this.selected = null;
  }

  check(r) {
    let state = this.checks.get(r.id);
    if (!state) { state = checkState(r.paths, this.picked); this.checks.set(r.id, state); }
    return state;
  }

  current() { return this.rows[this.at] ?? null; }

  select(index) {
    const r = this.rows[index];
    if (!r) return false;
    this.at = index; this.selected = r.id;
    this.list.reveal(index, this.rows.length);
    return true;
  }

  toggleOpen(r) {
    if (r.kind === "group") this.closed[r.group] = !this.closed[r.group];
    else if (r.kind === "folder") {
      const set = this.collapsed[r.group];
      if (!set.delete(r.key)) set.add(r.key);
    } else return false;
    this.rebuild();
    return true;
  }

  toggleCheck(r) {
    if (!r) return false;
    this.picked = toggleIncluded(this.picked, r.paths);
    this.checks.clear();
    return true;
  }

  setGrouped(grouped) {
    this.grouped = grouped;
    try { localStorage.setItem(GROUPED_KEY, grouped ? "1" : "0"); } catch { /* not kept, still switches */ }
    this.rebuild();
    if (this.at >= 0) this.list.reveal(this.at, this.rows.length);
  }

  expandAll() {
    this.closed = { changes: false, unversioned: false };
    this.collapsed = { changes: new Set(), unversioned: new Set() };
    this.rebuild();
  }

  collapseAll() {
    this.closed = { changes: true, unversioned: true };
    for (const group of GROUPS) this.collapsed[group.id] = new Set(folderKeys(this[group.id], { compact: true }));
    this.rebuild();
  }

  // ---- other screens

  showDiff(r = this.current()) {
    if (!this.repo || r?.kind !== "file") return false;
    openDiff({ root: this.repo.root, on: this.repo.on, path: r.item.path, commit: null, status: r.item.status });
    return true;
  }

  canRollback() { return Boolean(this.repo && this.changes.length && !this.writeBlock()); }

  // Always through the dialog. It opens with the selection checked (a file, or all files
  // under the selected folder); with nothing selected in Changes, with every file. The
  // dialog asks this panel to run the rollback.
  rollback(r = this.current()) {
    if (!this.canRollback()) return false;
    const checked = r && r.group === "changes" && r.kind !== "group" ? r.paths : [];
    openRollback({ root: this.repo.root, on: this.repo.on, files: this.changes, checked, owner: this.bus.id, lang: this.lang });
    return true;
  }

  // The Restore dialog, with `snapshot` selected (else the newest). Open even with no
  // snapshot: the dialog says so, and the panel doesn't ask git on every refresh.
  restore(snapshot = null) {
    if (!this.repo) return false;
    openRestore({ root: this.repo.root, on: this.repo.on, owner: this.bus.id, select: snapshot, chosen: Boolean(this.fixed), lang: this.lang });
    return true;
  }

  rowMenu(r, cx) {
    const items = [];
    if (r.kind === "file") items.push({ label: this.t("commit.showDiff"), value: "diff" });
    // Unversioned Files have nothing to roll back to.
    if (r.group === "changes") items.push({ label: this.t("commit.rollback"), value: "rollback", disabled: !this.canRollback(), title: this.writeBlock() ?? undefined });
    if (!items.length) return;
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.bus, items, { lang: this.lang });
      if (picked === "diff") this.showDiff(r);
      else if (picked === "rollback") this.rollback(r);
      cx.notify();
    });
  }

  viewOptions(cx) {
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.bus, [{ label: this.t("commit.groupByDirectory"), value: "group", hint: this.grouped ? "✓" : "" }], { lang: this.lang });
      if (picked === "group") this.setGrouped(!this.grouped);
      cx.notify();
    });
  }

  // ---- keys and commands

  // One list action by name: the arrow keys, Space and Enter, and the same from commands.
  act(name) {
    const r = this.current(), n = this.rows.length;
    if (name === "up") return this.select(this.at < 0 ? n - 1 : Math.max(0, this.at - 1));
    if (name === "down") return this.select(this.at < 0 ? 0 : Math.min(n - 1, this.at + 1));
    if (!r) return false;
    const folds = r.kind !== "file";
    if (name === "left") return folds && r.open ? this.toggleOpen(r) : this.select(parentIndex(this.rows, this.at));
    if (name === "right") {
      if (!folds) return false;
      return r.open ? this.select(this.at + 1) : this.toggleOpen(r);
    }
    if (name === "space") return this.toggleCheck(r);
    if (name === "enter") return folds ? this.toggleOpen(r) : this.showDiff(r);
    return false;
  }

  command(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "focus") this.handle.focus();
    else if (name === "commit-group-by-directory") this.setGrouped(!this.grouped);
    else if (name === "commit-expand-all") this.expandAll();
    else if (name === "commit-collapse-all") this.collapseAll();
    else if (name === "commit-toggle") this.act("space");
    else if (name === "commit-show-diff") this.showDiff();
    else if (name === "commit-rollback") this.rollback();
    else if (name === "commit-restore") this.restore();
    else if (/^commit-(up|down|left|right)$/.test(name)) this.act(name.slice(7));
    else this.form.command?.(name, cx);
  }

  event(e, cx) {
    if (e.type === "changed" && (!e.root || e.root === this.repo?.root)) this.refresh(cx);
    // Another write on the noticed repository, whichever copy ran it, ends the notice; the
    // rollback's own "changed" (by its request's key) doesn't. A "changed" without a root
    // stands for events that went unseen, which may hold such a write: it ends it too.
    if (e.type === "changed" && this.note && (!e.root || e.root === this.note.repo?.root) && (!e.by || e.by !== this.note.by)) this.note = null;
  }

  // ---- drawing

  renderRow(i, t) {
    const r = this.rows[i], folds = r.kind !== "file";
    const el = row(`commit-row-${r.id}`, t, { selected: i === this.at, depth: r.depth })
      .on_click((e, cx) => {
        this.handle.focus();
        this.select(i);
        if (e.click_count === 2) { if (folds) this.toggleOpen(r); else this.showDiff(r); }
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        this.handle.focus();
        this.select(i);
        this.rowMenu(r, cx);
        cx.notify();
      })
      // The arrow's place is kept on file rows so checkboxes line up under their folder's.
      .child(folds
        ? div().id(`commit-fold-${r.id}`).size(14).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleOpen(r); cx.notify(); })
          .child(svg(icon(r.open ? "chevron-down" : "chevron-right")).size(12))
        : div().size(14).flex_none())
      .child(checkbox(`commit-check-${r.id}`, this.check(r), t, { onClick: (_e, cx) => { this.toggleCheck(r); cx.notify(); } }));
    const count = folds ? this.t("commit.files", { n: r.count }) : "";
    if (r.kind === "group") {
      const name = r.group === "changes" ? this.t("commit.changes") : this.t("commit.unversioned");
      return el
        .child(div().flex_none().max_w("70%").truncate().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(count));
    }
    if (r.kind === "folder") {
      return el
        .child(folderGlyph(r.name, { open: r.open }))
        .child(div().flex_none().max_w("70%").truncate().child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(count));
    }
    // Flat rows say where the file is; in the tree its folders already do.
    const status = r.item.status, where = this.grouped ? "" : r.dir;
    const name = div().truncate().text_color(statusColor(status, t))
      .when(status === "deleted", (el) => el.line_through())
      .when(status === "conflict", (el) => el.font_semibold())
      .child(r.name);
    return el
      .child(fileGlyph(r.path, { dark: this.dark }))
      // A name alone takes the rest of the row and is cut there; next to its folder it
      // keeps its own width up to 70% so both stay readable at the panel's 280px.
      .child(where ? name.flex_none().max_w("70%") : name.flex_1().min_w(0))
      .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where)));
  }

  render(cx) {
    // Another folder to follow: read in a timer, since nothing may start inside render
    // (cx.notify throws there and cx.spawn runs its first part there).
    if (this.contextKey() !== this.context && !this.moving) {
      this.moving = true;
      cx.timer.after(0, (cx) => { this.moving = false; if (this.contextKey() !== this.context) this.refresh(cx); });
    }
    // A read skipped while another copy wrote to this repository: the release redraws
    // every copy (shared state), so it is taken up here, even if that copy's "changed"
    // never comes (its write failed, or it closed).
    else if (this.waiting && !this.readBlocked() && !this.moving) {
      this.moving = true;
      cx.timer.after(0, (cx) => { this.moving = false; if (this.waiting && !this.readBlocked()) this.refresh(cx); });
    }
    const t = theme(), shown = logPanelShown(), r = this.current();
    this.dark = darkLook();
    const note = this.note && sameRepo(this.note.repo, this.repo) ? this.note : null;
    const body = this.notRepo ? notice(notRepository(this.folder, this.t), t)
      : !this.read ? notice(this.t("ui.loading"), t, { busy: true })
      : !this.rows.length ? notice(this.repo ? this.t("commit.noChanges") : "", t)
      : this.list.render(this.rows.length, (i) => this.renderRow(i, t), t);
    const redraw = (fn) => (_e, cx) => { fn(cx); cx.notify(); };
    return panelFrame("commit-panel", t)
      .child(toolbar(t)
        .child(iconButton("commit-refresh", "refresh", t, { title: this.t("commit.refresh"), busy: Boolean(this.loading && this.read), onClick: redraw((cx) => this.refresh(cx)) }))
        .child(iconButton("commit-rollback", "rollback", t, { title: this.repo && this.writeBlock() || this.t("commit.rollback"), disabled: !this.canRollback(), onClick: redraw(() => this.rollback()) }))
        .child(iconButton("commit-restore", "restore", t, { title: this.t("restore.button"), disabled: !this.repo, onClick: () => this.restore() }))
        .child(iconButton("commit-diff", "diff", t, { title: this.t("commit.showDiff"), disabled: r?.kind !== "file", onClick: redraw(() => this.showDiff()) }))
        .child(iconButton("commit-view-options", "eye", t, { title: this.t("commit.viewOptions"), active: this.grouped, onClick: (_e, cx) => this.viewOptions(cx) }))
        .child(iconButton("commit-expand", "expand-all", t, { title: this.t("commit.expandAll"), disabled: !this.rows.length, onClick: redraw(() => this.expandAll()) }))
        .child(iconButton("commit-collapse", "collapse-all", t, { title: this.t("commit.collapseAll"), disabled: !this.rows.length, onClick: redraw(() => this.collapseAll()) }))
        .child(spacer())
        .when(shown !== null, (el) => el.child(iconButton("commit-log", "panel-bottom", t, { title: this.t("commit.gitLog"), active: shown === true, onClick: () => toggleLogPanel() }))))
      .child(div().id("commit-list").flex_1().min_h(0).track_focus(this.handle)
        .on_key_down((e, cx) => {
          const name = { up: "up", down: "down", left: "left", right: "right", space: "space", enter: "enter" }[e.keystroke];
          if (!name) return;
          this.act(name);
          cx.stop_propagation();
          cx.notify();
        })
        .child(body))
      .when(Boolean(this.repo), (el) => el.child(this.form.render(cx)))
      .when(Boolean(note), (el) => el.child(noteBar("commit-note", this.t("restore.rolledBack", { n: note?.n ?? 0 }), t, {
        action: { label: this.t("restore.open"), onClick: (_e, cx) => { this.restore(note?.snapshot ?? null); cx.notify(); } },
        onDismiss: (_e, cx) => { this.note = null; cx.notify(); },
      })))
      .when(Boolean(this.writeError), (el) => el.child(errorStrip("commit-write-error", this.writeError ?? "", t, (_e, cx) => { this.writeError = null; cx.notify(); })))
      .when(Boolean(this.error), (el) => el.child(errorStrip("commit-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}
