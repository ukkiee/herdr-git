// Conflicts dialog: the files an operation (merge, rebase, cherry-pick, revert, or a stash
// that came back) left in conflict, unresolved and resolved, a column per side with its
// Accept, Resolve All Simple Conflicts, Revert Conflict Resolution, Resolve Manually (the
// Merge Revisions dialog for one file) and Accept and Finish. What is shown and what is on
// comes from conflicts-model.js; this file draws it.
//
// The dialog reads (the operation, the branch, a file before Accept) but never writes: it
// asks the panel copy that opened it (props.owner) to run each write under the
// repository's lock (serve-actions.js, ui.js askOwner). Herdr closes a dialog on Esc even
// while it waits, and the panel still finishes the write and shows a failure.
//
// Accept and Finish only closes it: the operation goes on from the Commit panel's commit
// button or the VCS widget, as nothing is left to resolve. Closed early, what is left
// stays in the Commit panel's Merge Conflicts node.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, readTextFile, writeTextFile } from "herdr";
import { makeGit } from "./git.js";
import { readOperation } from "./git-operation.js";
import { readVersions, remoteWriter } from "./git-conflict.js";
import { heading, columns, sortFiles, controls, pick, editedSince, editedAmong, stoppedOnConflicts } from "./conflicts-model.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, openMenu, uiGlyph, fileGlyph, darkLook, WindowedList, ROW } from "./ui.js";

// The dialog's size; the Commit panel's "Resolve" link opens it the same size.
const SIZE = { width: 760, height: 460 };
// How often the dialog reads the repository again while open, for what a terminal or an
// editor did: the panels' "changed" covers git-tools' own writes at once.
const POLL = 2000;
// Width of each side's column.
const COLUMN = 190;

// openConflicts({ root, on, owner, lang, stash, who })
//   Opens the Conflicts dialog on a repository.
//   root, on: the repository and its machine (null: this computer).
//   owner: the opening panel copy's bus id (`this.bus.id`); it runs the dialog's writes.
//   lang: the opener's language (`this.lang`), so the dialog draws in it from the start.
//   stash: the stash a conflicted unstash came from ("stash@{0}"), for the heading.
//   who: the owner as the person knows it, for "didn't answer" sentences: "ui.commitPanel"
//   (the default) or "ui.logPanel".
export function openConflicts({ root, on = null, owner = null, lang, stash = null, who = "ui.commitPanel" } = {}) {
  return openDialog("conflicts", { root, on, owner, stash, who, lang }, SIZE);
}

// openConflictsIfStopped(result, args) → true when it opened the dialog: what a screen
// that ran a request calls with the request's result (git-operation.js runOperation, or a
// request that starts an operation). args: as for openConflicts.
export function openConflictsIfStopped(result, args) {
  if (!stoppedOnConflicts(result)) return false;
  openConflicts(args);
  return true;
}

// writerOn(on) → write(absolutePath, text): how a resolved file is written. This
// computer's space: writeTextFile, replacing what is there now. Another machine's: in
// parts with sh there (git-conflict.js remoteWriter), as exec has no stdin.
// writeTextFile replaces only the text it is shown, and readTextFile reads at most 1 MiB:
// a file it can't read is written the other machines' way, with this computer's sh.
// readerOn(on) → read(absolutePath): a file's text on the space's machine (readTextFile).
export const readerOn = (on) => (path) => readTextFile(path, { on });

export function writerOn(on) {
  if (on) return remoteWriter(exec, on);
  return async (path, text) => {
    let now;
    try { now = await readTextFile(path); } catch { return remoteWriter(exec, null)(path, text); }
    await writeTextFile(path, text, now);
  };
}

export default class ConflictsView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null; // the panel copy that runs the writes
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.stash = typeof p.stash === "string" ? p.stash : null;
    this.git = makeGit(exec, this.on);
    this.op = null; // readOperation's last answer
    this.branch = null; // the branch HEAD is on
    this.seen = []; // every path in conflict since the dialog opened
    this.files = { unresolved: [], resolved: [] };
    this.cols = columns(null, {});
    this.loaded = false;
    this.selected = null;
    this.waiting = false; // asked the owner, no answer yet
    this.checking = false; // reading a file before Accept
    this.confirm = null; // { path, column }: Accept on a file edited since git left it
    this.error = null;
    this.note = null;
    this.running = null; // "simple" while Resolve All Simple Conflicts runs
    this.simpleFrom = null; // unresolved files before it ran, until the next read
    this.simpleKept = 0; // files it left because they were edited by hand
    this.reading = false;
    this.turn = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.list = new WindowedList("conflicts-files", { rowHeight: ROW + 4 });
    this.load(cx);
    cx.timer.every(POLL, (cx) => { if (!this.waiting && !this.reading) this.load(cx); });
  }

  repo() { return { root: this.root, on: this.on }; }

  // Reads the operation and the branch again. A newer read wins over an older one still
  // on its way.
  load(cx) {
    if (!this.root) return;
    const turn = ++this.turn;
    this.reading = true;
    cx.spawn(async (cx) => {
      const [op, head] = await Promise.all([
        readOperation(this.git, this.root),
        this.git.read(this.root, ["symbolic-ref", "--short", "-q", "HEAD"]),
      ]);
      if (turn !== this.turn) return;
      this.reading = false;
      if (!op.ok) { this.error = sentence(this.t, op.msg, op.err); cx.notify(); return; }
      this.op = op;
      this.branch = head.ok ? head.out.trim() || null : null;
      this.cols = columns(op, { branch: this.branch, stash: this.stash });
      const sorted = sortFiles(op, this.cols, this.seen);
      this.seen = sorted.seen;
      this.files = sorted;
      this.selected = pick(sorted, this.selected);
      this.loaded = true;
      // Resolve All Simple Conflicts that left every file as it was says so.
      if (this.simpleFrom !== null) {
        if (this.simpleKept > 0) this.note = this.t("conflicts.simpleKept", { n: this.simpleKept });
        else if (sorted.unresolved.length === this.simpleFrom) this.note = this.t("conflicts.noneSimple");
        this.simpleFrom = null;
        this.simpleKept = 0;
      }
      cx.notify();
    });
  }

  event(e, cx) {
    if (e.type === "changed" && (!e.root || e.root === this.root) && !this.waiting) this.load(cx);
  }

  // Another write on the repository (another copy's), or null.
  writing() { return this.root ? writeBlock(this, this.repo()) : null; }

  can() {
    return controls(this.files, { selected: this.selected, busy: this.waiting || this.checking || Boolean(this.writing()), loaded: this.loaded });
  }

  // Asks the owner to run a write, then reads again. done(r) runs on the answer.
  ask(action, args, cx, done) {
    this.waiting = true; this.error = null; this.note = null;
    cx.notify();
    askOwner(this, action, { ...this.repo(), ...args }, this.who, cx, (r, cx) => {
      this.waiting = false; this.running = null;
      if (!r.ok) this.error = sentence(this.t, r.msg, r.err);
      done?.(r);
      this.load(cx);
    });
  }

  // Accept on a column: a file edited since git left it asks first (Overwrite Changes).
  accept(path, column, cx) {
    if (!this.can().accept) return;
    this.checking = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const v = await readVersions(this.git, this.root, path, { read: (p) => readTextFile(p, { on: this.on }) });
      this.checking = false;
      if (v.ok && editedSince(v)) this.confirm = { path, column };
      else this.take(path, column, cx);
      cx.notify();
    });
  }

  take(path, column, cx) {
    this.confirm = null;
    this.ask("conflicts-accept", { path, side: this.cols[column].side }, cx);
  }

  // The panel leaves a file edited by hand as it is; the answer carries no list, so the
  // files edited are found here first to say how many were left.
  resolveSimple(cx) {
    if (!this.can().resolveSimple) return;
    const before = this.files.unresolved.length, paths = this.files.unresolved.map((f) => f.path);
    this.running = "simple"; this.checking = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const kept = await editedAmong(this.git, this.root, paths, readerOn(this.on));
      this.checking = false;
      this.ask("conflicts-resolve-simple", { paths }, cx, (r) => {
        // The files read again (load) tell whether any was simple.
        this.simpleFrom = r.ok ? before : null;
        this.simpleKept = r.ok ? kept.length : 0;
      });
    });
  }

  unresolve(path, cx) {
    if (!this.files.resolved.includes(path) || this.waiting) return;
    this.selected = path;
    this.ask("conflicts-unresolve", { path }, cx);
  }

  // The Merge Revisions dialog for one file, on top of this one. Its writes go to the same
  // panel; this dialog reads again when they're done ("changed").
  resolveManually() {
    if (!this.can().resolveManually) return;
    openDialog("merge-revisions", { root: this.root, on: this.on, owner: this.owner, who: this.who, stash: this.stash, path: this.selected, lang: this.lang }, { width: 1100, height: 680 });
  }

  // Revert Conflict Resolution, from a resolved file's right-click.
  rowMenu(path, at, cx) {
    if (!this.files.resolved.includes(path)) return;
    cx.spawn(async (cx) => {
      const v = await openMenu(this.bus, [{ label: this.t("conflicts.unresolve"), value: "unresolve", disabled: !this.can().unresolve }], { at, lang: this.lang, width: 240 });
      if (v === "unresolve") this.unresolve(path, cx);
      cx.notify();
    });
  }

  shut() { close(this.overlay); }

  // ---- drawing

  columnLabel(column) {
    const l = this.cols[column].label;
    return this.t(l.key, l.args);
  }

  state(word) { return this.t(word === "deleted" ? "conflicts.deleted" : "conflicts.modified"); }

  // The rows: a group header, then its files.
  rows() {
    const out = [];
    const { unresolved, resolved } = this.files;
    if (unresolved.length) {
      out.push({ kind: "group", id: "unresolved", label: this.t("conflicts.unresolvedGroup", { n: unresolved.length }) });
      for (const f of unresolved) out.push({ kind: "file", group: "unresolved", ...f });
    }
    if (resolved.length) {
      out.push({ kind: "group", id: "resolved", label: this.t("conflicts.resolvedGroup", { n: resolved.length }) });
      for (const path of resolved) out.push({ kind: "file", group: "resolved", path });
    }
    return out;
  }

  cell(id, r, column, t, can) {
    const open = r.group === "unresolved";
    return h_flex().w(COLUMN).flex_none().h_full().px(8).gap(8).items_center().border_l(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_color(open && r[column] === "deleted" ? t.muted : t.foreground).child(open ? this.state(r[column]) : ""))
      .when(open, (el) => el.child(
        div().id(id).flex_none().px(8).h(20).flex().items_center().rounded(4).text_size(12)
          .text_color(can.accept ? t.accent : t.dim)
          .tooltip(this.t("conflicts.acceptTitle", { path: r.path, column: this.columnLabel(column) }))
          .when(can.accept, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.selected = r.path; this.accept(r.path, column, cx); cx.notify(); }))
          .child(this.t("conflicts.accept"))));
  }

  renderRow(r, i, t, can, dark) {
    const h = ROW + 4;
    if (r.kind === "group") {
      return h_flex().id(`conflicts-group-${r.id}`).w_full().h(h).flex_none().px(8).gap(6).items_center()
        .bg(t.raised).text_size(12).font_semibold().text_color(t.muted)
        .child(uiGlyph("chevron-down"))
        .child(div().min_w(0).truncate().child(r.label));
    }
    const selected = r.path === this.selected;
    const name = r.path.split("/").pop(), folder = r.path.slice(0, r.path.length - name.length - 1);
    return h_flex().id(`conflicts-row-${i}`).w_full().h(h).flex_none().items_center()
      .bg(selected ? t.selected : t.background).hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((e, cx) => {
        this.handle.focus();
        this.selected = r.path;
        if (e.click_count === 2 && r.group === "unresolved") this.resolveManually();
        cx.notify();
      })
      .on_mouse_down("right", (e, cx) => {
        this.handle.focus();
        this.selected = r.path;
        this.rowMenu(r.path, e.position, cx);
        cx.notify();
      })
      .child(h_flex().flex_1().min_w(0).h_full().pl(26).pr(8).gap(6).items_center()
        .child(fileGlyph(r.path, { dark }))
        .child(div().flex_none().text_color(r.group === "unresolved" ? t.ansi1 : t.foreground).child(name))
        .when(Boolean(folder), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(folder))))
      .child(this.cell(`conflicts-accept-yours-${i}`, r, "yours", t, can))
      .child(this.cell(`conflicts-accept-theirs-${i}`, r, "theirs", t, can));
  }

  renderHead(t, can) {
    if (can.allResolved) {
      return h_flex().w_full().flex_none().px(14).py(10).gap(6).items_center()
        .child(uiGlyph("check"))
        .child(div().min_w(0).child(this.t("conflicts.allResolved")));
    }
    const lines = this.op ? heading(this.op, { branch: this.branch, stash: this.stash }) : [];
    return v_flex().w_full().flex_none().px(14).py(10).gap(2)
      .children(lines.map((line, i) => div().w_full().min_w(0).truncate()
        .text_color(i === 0 ? t.foreground : t.muted)
        .child(line.key ? this.t(line.key, line.args) : line.text)));
  }

  renderConfirm(t) {
    const { path, column } = this.confirm;
    const cancel = (_e, cx) => { this.confirm = null; cx.notify(); };
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(8)
      .child(div().w_full().child(this.t("conflicts.overwriteBody", { path, column: this.columnLabel(column) })));
    return dialogFrame("conflicts-overwrite", this.t("conflicts.overwriteTitle"), t, {
      body,
      onClose: cancel,
      footer: [
        button("conflicts-overwrite-cancel", this.t("dialogs.cancel"), t, { onClick: cancel }),
        button("conflicts-overwrite-ok", this.t("conflicts.discardAccept"), t, { kind: "primary", onClick: (_e, cx) => this.take(path, column, cx) }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.confirm = null;
      else if (e.key === "enter") this.take(path, column, cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }

  render() {
    const t = theme();
    if (this.confirm) return this.renderConfirm(t);
    const can = this.can(), dark = darkLook(), rows = this.rows();
    const said = this.error ?? this.writing();
    const body = v_flex().size_full().min_h(0)
      .child(this.renderHead(t, can))
      .child(h_flex().w_full().flex_none().px(14).pb(8).gap(8).items_center()
        .child(button("conflicts-resolve-simple", this.t("conflicts.resolveSimple"), t, { disabled: !can.resolveSimple, busy: this.running === "simple", onClick: (_e, cx) => this.resolveSimple(cx) })))
      .child(v_flex().flex_1().min_h(0).mx(14).rounded(4).border_1().border_color(t.border).overflow_hidden()
        .child(h_flex().w_full().h(ROW).flex_none().items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
          .child(div().flex_1().min_w(0).px(8).truncate().child(this.t("conflicts.name")))
          .child(div().w(COLUMN).flex_none().px(8).truncate().border_l(1).border_color(t.border).child(this.columnLabel("yours")))
          .child(div().w(COLUMN).flex_none().px(8).truncate().border_l(1).border_color(t.border).child(this.columnLabel("theirs"))))
        .child(div().flex_1().min_h(0).bg(t.background)
          .child(this.list.render(rows.length, (i) => this.renderRow(rows[i], i, t, can, dark), t))))
      .when(Boolean(said), (el) => el.child(div().w_full().flex_none().px(14).pt(6)
        .child(scrollText("conflicts-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted }))))
      .child(div().h(4).flex_none());
    return dialogFrame("conflicts", this.t("conflicts.title"), t, {
      body,
      note: this.note ?? "",
      onClose: () => this.shut(),
      footer: [
        // Not "conflicts-close": dialogFrame gives its × that id (ui-ids.test.mjs).
        button("conflicts-dismiss", this.t("ui.close"), t, { onClick: () => this.shut() }),
        button("conflicts-finish", this.t("conflicts.finish"), t, { disabled: !can.finish, onClick: () => this.shut() }),
        button("conflicts-manual", this.t("conflicts.resolveManually"), t, { kind: "primary", disabled: !can.resolveManually, onClick: () => this.resolveManually() }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "enter") this.resolveManually();
      else return;
      cx.stop_propagation();
    });
  }
}
