// Rollback dialog: the Changes files as a checkbox tree, how many will be
// rolled back, "Delete local copies of added files", Close and Rollback. A rollback
// overwrites the working tree (what it threw away comes back only through Restore, and
// not the staging), so this dialog is the only way to one: only the checked files, and
// only on its Rollback button.
//
// The dialog doesn't run git itself: it asks the Commit panel copy that opened it
// (props.owner) to roll the files back under the repository's write lock
// (serveRollback, ui.js serveRequest), so the rollback, the "changed" and git's error
// outlive a dialog that Herdr closes on Esc.
//
// props: { view: "rollback", root, on, files, checked, owner, overlay } (see openRollback).
//
// Commands (`git-tools.<name>`, for scripts): rollback-up, rollback-down, rollback-left,
//   rollback-right, rollback-toggle (the Space key), rollback-group-by-directory,
//   rollback-expand-all, rollback-collapse-all, rollback-delete-added.
//   The Rollback button has no command on purpose: a command reaches every shown copy of
//   the mod and can't say which dialog it means, and this one overwrites files.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readStatus } from "./git-status.js";
import { rollback, wordRollback } from "./git-rollback.js";
import { buildRows, checkState, toggleIncluded, keepIncluded, folderKeys, parentIndex } from "./tree.js";
import { openDialog, dialogFrame, button, iconButton, checkbox, row, notice, errorStrip, icon, fileGlyph, folderGlyph, darkLook, close, WindowedList, askOwner, serveRequest, writeBlock, sentence } from "./ui.js";

// openRollback({ root, on, files, checked, owner, lang })
//   Opens the Rollback dialog. Nothing is rolled back without it.
//   root, on: the repository and its machine (null: this computer).
//   files: the Changes group as git-status.js reports it, [{ path, status }]
//          (never Unversioned Files; the dialog drops any that come anyway).
//   checked: paths checked when it opens (the selection); empty or omitted → all of `files`.
//   owner: the opening Commit panel's bus id; that copy runs the rollback (serveRollback).
//   When a rollback finishes every screen on the repository is told "changed" (also
//   after a failure: files before the one git refused are rolled back). The dialog
//   closes itself only when the rollback succeeded; otherwise it stays with the reason
//   and the files as they are now.
//   lang: the opener's language ("en" | "ko"), so the dialog draws in it from the start
//   (ui.js openDialog). Pass `lang: this.lang`.
export function openRollback({ root, on = null, files, checked = [], owner = null, lang } = {}) {
  return openDialog("rollback", { root, on, files, checked, owner, lang }, { width: 520, height: 460 });
}

// A checkout of thousands of files on another machine outlasts exec's default 30 s.
const TIMEOUT = 120000;

// serveRollback(panel, e, cx)
//   The Commit panel's side: rolls back e.args.files ([{ path, status }]) in
//   e.args.root under the write lock (ui.js serveRequest). When the rollback recorded a
//   Rollback snapshot, the panel hears of it before the lock goes:
//   panel.rolledBack(repo, { snapshot, n, by }) (n: the files rolled back; by: the
//   request's key, which the "changed" told after it carries).
//   panel.copy: the panel copy's id (ui.js copyId), which names its scratch index.
export function serveRollback(panel, e, cx) {
  const { files, deleteAdded = false } = e.args ?? {};
  const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === "string" && f.status !== "unversioned");
  // Runs outside the panel's own call: its words come from panel.t.
  serveRequest(panel, e, { key: "dialogs.rollback.running" }, async (repo) => {
    if (!list.length) return { ok: false, err: "No files to roll back.", msg: { key: "dialogs.rollback.noFiles", args: {} } };
    const git = makeGit(exec, repo.on);
    const timed = (cwd, args, options) => git(cwd, args, { timeout: TIMEOUT, ...options });
    timed.read = (cwd, args, options) => git.read(cwd, args, { timeout: TIMEOUT, ...options });
    const r = await rollback(timed, repo.root, { files: list, deleteAdded: deleteAdded === true, copy: panel.copy });
    if (r.snapshot) panel.rolledBack?.(repo, { snapshot: r.snapshot, n: list.length - r.skipped.length, by: e.key });
    // The skipped reasons go into the msg worded in the panel's language: the dialog gets
    // the msg, not the list. Cut like the answer's err, since it travels in shared state.
    const msg = wordRollback(panel.t, r);
    if (typeof msg?.args?.list === "string" && msg.args.list.length > CLIP) msg.args.list = `${msg.args.list.slice(0, CLIP)}…`;
    return { ...r, ...(msg ? { msg } : {}), changed: true };
  }, cx);
}
// How much of the skipped list goes with the answer (ui.js cuts the err the same way).
const CLIP = 4000;
const KINDS = [["modified", "dialogs.rollback.countModified"], ["added", "dialogs.rollback.countAdded"], ["deleted", "dialogs.rollback.countDeleted"], ["conflict", "dialogs.rollback.countConflict"]];
const stop = (_e, cx) => cx.stop_propagation();

// Same colors as the Commit panel's rows (view-commit.js keeps its own copy).
function statusColor(status, t) {
  return { modified: t.ansi4, added: t.ansi2, deleted: t.muted, conflict: t.ansi9 ?? t.ansi1 }[status] ?? t.foreground;
}

export default class RollbackView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.owner = p.owner ?? null; // the Commit panel copy that runs the rollback
    this.files = (Array.isArray(p.files) ? p.files : []).filter((f) => f && typeof f.path === "string" && f.status !== "unversioned");
    const listed = new Set(this.files.map((f) => f.path));
    const asked = (Array.isArray(p.checked) ? p.checked : []).filter((path) => listed.has(path));
    // The checked files. Opened on a selection, only that; otherwise every file.
    this.picked = new Set(asked.length ? asked : listed);
    this.deleteAdded = false;
    this.grouped = true;
    this.closed = false; this.collapsed = new Set();
    this.rows = []; this.selected = null; this.at = -1;
    this.running = false; this.error = null;
    this.list = new WindowedList("rollback-files");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.rebuild();
  }

  // ---- rows

  // One "Changes" row over the files (its checkbox checks all or none), then the files
  // flat or as a folder tree. Built when the files or the folding change, never in render.
  rebuild() {
    const paths = this.files.map((f) => f.path);
    const rows = [];
    if (paths.length) {
      // The group's name is worded where it is drawn.
      rows.push({ id: "g", kind: "group", depth: 0, name: "", count: paths.length, paths, open: !this.closed, item: null });
      if (!this.closed) {
        for (const r of buildRows(this.files, { grouped: this.grouped, compact: true, collapsed: this.collapsed })) {
          rows.push({ ...r, id: `f:${r.key}`, kind: r.folder ? "folder" : "file", depth: r.depth + 1 });
        }
      }
    }
    this.rows = rows;
    this.at = this.selected ? rows.findIndex((r) => r.id === this.selected) : -1;
    if (this.at < 0) this.selected = null;
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
    if (r.kind === "group") this.closed = !this.closed;
    else if (r.kind === "folder") { if (!this.collapsed.delete(r.key)) this.collapsed.add(r.key); }
    else return false;
    this.rebuild();
    return true;
  }

  toggleCheck(r) {
    if (!r || this.running) return false;
    this.picked = toggleIncluded(this.picked, r.paths);
    return true;
  }

  setGrouped(grouped) {
    this.grouped = grouped;
    this.rebuild();
    if (this.at >= 0) this.list.reveal(this.at, this.rows.length);
  }

  expandAll() { this.closed = false; this.collapsed = new Set(); this.rebuild(); }

  collapseAll() {
    this.closed = true;
    this.collapsed = new Set(folderKeys(this.files, { compact: true }));
    this.rebuild();
  }

  // ---- what will happen

  chosen() { return this.files.filter((f) => this.picked.has(f.path)); }

  // "2 modified, 1 added": the checked files by what they are.
  summary(chosen) {
    if (!this.files.length) return this.t("dialogs.rollback.noChanges");
    if (!chosen.length) return this.t("dialogs.rollback.noFilesChecked");
    const parts = [];
    for (const [status, key] of KINDS) {
      const n = chosen.filter((f) => f.status === status).length;
      if (n) parts.push(this.t(key, { n }));
    }
    return parts.join(", ");
  }

  hasAdded() { return this.files.some((f) => f.status === "added" || f.status === "conflict"); }

  toggleDelete() {
    if (this.running || !this.hasAdded()) return false;
    this.deleteAdded = !this.deleteAdded;
    return true;
  }

  shut() { if (!this.running) close(this.overlay); }

  // Another write on the repository, or null. This dialog's own runs under `running`.
  writing() { return this.running || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  // The Rollback button. Only the checked files; the dialog closes when the panel is done,
  // and stays open with git's words when it fails.
  confirm(cx) {
    const files = this.chosen();
    if (this.running || !this.root || !files.length || this.writing()) return false;
    this.running = true; this.error = null;
    const args = { root: this.root, on: this.on, files, deleteAdded: this.deleteAdded };
    askOwner(this, "rollback", args, "ui.commitPanel", cx, (r, cx) => {
      if (r.ok) { close(this.overlay); return; }
      this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      if (r.unheard) { this.running = false; return; }
      // Show what is left, so a second try doesn't work from a list that is no longer true.
      cx.spawn(async (cx) => {
        const status = await readStatus(makeGit(exec, this.on), this.root);
        if (status.ok) {
          this.files = status.changes;
          this.picked = keepIncluded(this.picked, this.files);
          this.rebuild();
        }
        this.running = false;
        cx.notify();
      });
    });
    return true;
  }

  // ---- keys and commands

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
    return false;
  }

  command(name, cx) {
    if (name === "focus") this.handle.focus();
    else if (name === "rollback-toggle") this.act("space");
    else if (name === "rollback-delete-added") this.toggleDelete();
    else if (name === "rollback-group-by-directory") this.setGrouped(!this.grouped);
    else if (name === "rollback-expand-all") this.expandAll();
    else if (name === "rollback-collapse-all") this.collapseAll();
    else if (/^rollback-(up|down|left|right)$/.test(name)) this.act(name.slice(9));
  }

  // ---- drawing

  renderRow(i, t) {
    const r = this.rows[i], folds = r.kind !== "file";
    const el = row(`rollback-row-${r.id}`, t, { selected: i === this.at, depth: r.depth })
      .on_click((e, cx) => {
        this.handle.focus();
        this.select(i);
        if (e.click_count === 2 && folds) this.toggleOpen(r);
        cx.notify();
      })
      // The arrow's place is kept on file rows so checkboxes line up under their folder's.
      .child(folds
        ? div().id(`rollback-fold-${r.id}`).size(14).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleOpen(r); cx.notify(); })
          .child(svg(icon(r.open ? "chevron-down" : "chevron-right")).size(12))
        : div().size(14).flex_none())
      .child(checkbox(`rollback-check-${r.id}`, checkState(r.paths, this.picked), t, {
        disabled: this.running, onClick: (_e, cx) => { this.toggleCheck(r); cx.notify(); },
      }));
    if (folds) {
      return el
        .when(r.kind === "folder", (el) => el.child(folderGlyph(r.name, { open: r.open })))
        .child(div().flex_none().max_w("70%").truncate().when(r.kind === "group", (el) => el.font_semibold())
          .child(r.kind === "group" ? this.t("dialogs.rollback.changes") : r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.t("dialogs.files", { n: r.count })));
    }
    // Flat rows say where the file is; in the tree its folders already do.
    const status = r.item.status, where = this.grouped ? "" : r.dir;
    const name = div().truncate().text_color(statusColor(status, t))
      .when(status === "deleted", (el) => el.line_through())
      .when(status === "conflict", (el) => el.font_semibold())
      .child(r.name);
    return el
      .child(fileGlyph(r.path, { dark: this.dark }))
      .child(where ? name.flex_none().max_w("70%") : name.flex_1().min_w(0))
      .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where)));
  }

  render() {
    const t = theme(), chosen = this.chosen(), canDelete = this.hasAdded() && !this.running, writing = this.writing();
    // The rows sit in rollback-list below, which paints them with the theme's background, not
    // with the dialog's popover color around it.
    this.dark = darkLook(t.background);
    const redraw = (fn) => (_e, cx) => { fn(cx); cx.notify(); };
    const list = this.rows.length
      ? this.list.render(this.rows.length, (i) => this.renderRow(i, t), t)
      : notice(this.t(this.root ? "dialogs.rollback.noChanges" : "dialogs.rollback.noRepository"), t);
    const body = v_flex().size_full().min_h(0)
      .child(h_flex().h(32).flex_none().px(10).gap(2).items_center()
        .child(iconButton("rollback-group", "folder", t, { title: this.t("dialogs.rollback.groupByDirectory"), active: this.grouped, onClick: redraw(() => this.setGrouped(!this.grouped)) }))
        .child(iconButton("rollback-expand", "expand-all", t, { title: this.t("dialogs.rollback.expandAll"), disabled: !this.rows.length, onClick: redraw(() => this.expandAll()) }))
        .child(iconButton("rollback-collapse", "collapse-all", t, { title: this.t("dialogs.rollback.collapseAll"), disabled: !this.rows.length, onClick: redraw(() => this.collapseAll()) })))
      .child(div().id("rollback-list").flex_1().min_h(0).mx(12).rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(list))
      .child(div().id("rollback-summary").flex_none().h(26).px(14).flex().items_center().truncate().text_size(12).text_color(t.muted).child(this.summary(chosen)))
      .child(h_flex().id("rollback-delete").flex_none().h(26).px(14).gap(8).items_center()
        .when(canDelete, (el) => el.cursor_pointer().on_click(redraw(() => this.toggleDelete())))
        .child(checkbox("rollback-delete-check", this.deleteAdded, t, { disabled: !canDelete, onClick: redraw(() => this.toggleDelete()) }))
        .child(div().min_w(0).truncate().text_color(canDelete ? t.foreground : t.dim).child(this.t("dialogs.rollback.deleteAdded"))))
      .child(div().h(8).flex_none())
      .when(Boolean(this.error), (el) => el.child(errorStrip("rollback-error", this.error ?? "", t, redraw(() => { this.error = null; }))));
    return dialogFrame("rollback", this.t("dialogs.rollback.title"), t, {
      body, onClose: () => this.shut(),
      note: this.running ? this.t("dialogs.rollback.running") : writing ?? this.t("dialogs.rollback.restoreLater"),
      footer: [
        // Not "rollback-close": dialogFrame gives its × that id, and two elements with one
        // id take each other's clicks.
        button("rollback-cancel", this.t("ui.close"), t, { disabled: this.running, onClick: () => this.shut() }),
        button("rollback-run", this.t("dialogs.rollback.run"), t, {
          kind: "primary", disabled: !this.root || !chosen.length || Boolean(writing), busy: this.running, title: writing ?? undefined,
          onClick: (_e, cx) => { this.confirm(cx); cx.notify(); },
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") {
        // Esc closes without changing anything. While the panel rolls back, shut() ignores
        // it (Herdr may close the dialog anyway: the panel still finishes and reports).
        this.shut();
        cx.stop_propagation();
        return;
      }
      const name = { up: "up", down: "down", left: "left", right: "right", space: "space" }[e.keystroke];
      if (!name) return;
      this.act(name);
      cx.stop_propagation();
      cx.notify();
    });
  }
}
