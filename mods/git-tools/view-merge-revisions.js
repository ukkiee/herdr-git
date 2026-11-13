// Merge Revisions dialog: one conflicted file in three panes, the person's side on the
// left, the result in the middle (the base at first), the other side on the right. Each
// chunk has Accept (≫ / ≪) and Ignore (✕) on the side that changed it, Append on a
// conflict whose other side is in already; the toolbar walks the conflicts, applies the
// changes that don't conflict, resolves the simple conflicts and counts what is left.
// What is shown and what is on comes from merge-revisions-model.js; the chunks and the
// decisions are merge-chunks.js's.
//
// The editor can't color lines, so the middle pane is drawn, not edited. "Edit Result
// Directly" swaps it for a plain editor holding the result text; pressed again, the text
// is cut into chunks again (merge-chunks.js edit) and the picture comes back.
//
// The dialog reads but never writes: saving the result, and Accept Left or Right, are
// asked of the panel copy that opened the Conflicts dialog (props.owner, serve-actions.js),
// which runs them under the repository's lock. After a file is resolved the dialog goes on
// to the next conflicted file, and closes when none is left.

import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { exec, theme, settings, appHome } from "herdr";
import { makeGit } from "./git.js";
import { readOperation } from "./git-operation.js";
import { readVersions, dropStaged, localPlacer, remotePlacer } from "./git-conflict.js";
import { columns } from "./conflicts-model.js";
import { writerOn } from "./view-conflicts.js";
import { decide, applyNonConflicting, resolveSimple, resultText, edit } from "./merge-chunks.js";
import { paneTitles, openFile, layoutRows, chunkButtons, toolbar, countWords, seekConflict, nextFile, leftToDecide, stageSave } from "./merge-revisions-model.js";
import { dialogFrame, button, iconButton, close, askOwner, writeBlock, scrollText, sentence, notice, WindowedList } from "./ui.js";

// Where a local space's result is staged for the panel: the app's own git-tools folder
// (app-files.js).
const STAGE_DIR = "git-tools";

// placerOn(on): how the panel puts a staged result in place (serve-actions.js
// "conflicts-save"). Another machine's space: with sh there. This computer's: written the
// way a local space writes (view-conflicts.js writerOn); read with cat, as readTextFile
// stops at 1 MiB.
export function placerOn(on) {
  if (on) return remotePlacer(exec, on);
  return localPlacer({
    read: async (file) => {
      const r = await exec("cat", [file]);
      if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || `cat exited with ${r.code}`);
      return r.stdout ?? "";
    },
    write: writerOn(null),
    remove: (file) => dropStaged(exec, null, file),
  });
}

// The height of one line of the picture.
const LINE = 20;
// The text size of the lines, and of the editor.
const SIZE = 12;
// Width of a line number, and of the gutter between two panes (its buttons).
const NUMBER = 40;
const GUTTER = 46;
// The characters of a line handed to the drawing: a very long line costs the same as
// one that fills the pane.
const COLUMNS = 400;

// "#rrggbb" plus an alpha byte: a tint of a theme color that works in light and dark.
const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + alpha : color);
// A line's text without its line end.
const bare = (text) => text.replace(/\r?\n$/, "");

export default class MergeRevisionsView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.stash = typeof p.stash === "string" ? p.stash : null;
    this.path = typeof p.path === "string" ? p.path : null;
    this.git = makeGit(exec, this.on);
    this.op = null;
    this.cols = columns(null, {});
    this.titles = paneTitles(null, {});
    this.file = null; // openFile's answer: { mode, state? }
    this.rows = []; this.starts = [];
    this.current = -1; // the chunk Previous and Next Conflict went to
    this.editor = null; // the EditorState while the result is edited by hand
    this.waiting = false; // asked the owner, no answer yet
    this.confirm = null; // "apply" | "close": saving with something left to decide
    this.error = null;
    this.turn = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.list = new WindowedList("merge-revisions-lines", { rowHeight: LINE });
    this.leftList = new WindowedList("merge-revisions-left", { rowHeight: LINE });
    this.rightList = new WindowedList("merge-revisions-right", { rowHeight: LINE });
    this.load(cx);
  }

  repo() { return { root: this.root, on: this.on }; }

  // Reads the operation, the branch and the file's three versions; the chunks and the
  // picture are made here, once, not while drawing.
  load(cx) {
    if (!this.root || !this.path) return;
    const turn = ++this.turn, path = this.path;
    this.file = null;
    cx.spawn(async (cx) => {
      const [op, head, v] = await Promise.all([
        readOperation(this.git, this.root),
        this.git.read(this.root, ["symbolic-ref", "--short", "-q", "HEAD"]),
        readVersions(this.git, this.root, path),
      ]);
      if (turn !== this.turn) return;
      if (!op.ok || !v.ok) { const r = op.ok ? v : op; this.error = sentence(this.t, r.msg, r.err); cx.notify(); return; }
      const branch = head.ok ? head.out.trim() || null : null;
      this.op = op;
      this.cols = columns(op, { branch, stash: this.stash });
      this.titles = paneTitles(op, { branch, stash: this.stash });
      this.file = openFile(v, this.cols);
      this.current = -1;
      this.list.top = 0;
      if (this.file.state) this.lay();
      cx.notify();
    });
  }

  // The picture again, after a decision.
  lay() {
    const { rows, starts } = layoutRows(this.file.state);
    this.rows = rows; this.starts = starts;
  }

  change(state) {
    this.file = { ...this.file, state };
    this.lay();
  }

  free() { return Boolean(this.file?.state) && !this.waiting && !this.writing(); }

  writing() { return this.root ? writeBlock(this, this.repo()) : null; }

  // ---- decisions

  decideChunk(index, side, action) {
    if (!this.free() || this.editor) return;
    this.change(decide(this.file.state, index, side, action));
  }

  applyNonConflicting(which) {
    if (!this.free() || this.editor) return;
    this.change(applyNonConflicting(this.file.state, which));
  }

  resolveSimple() {
    if (!this.free() || this.editor) return;
    this.change(resolveSimple(this.file.state));
  }

  // Previous or Next Conflict: the picture scrolls to put it near the top.
  seek(dir) {
    if (!this.file?.state || this.editor) return;
    const found = seekConflict(this.file.state, this.current, dir);
    if (found < 0) return;
    this.current = found;
    this.list.scrollTo(this.starts[found] - 2, this.rows.length);
  }

  // Edit Result Directly, on and off. Off cuts the written text into chunks again.
  toggleEdit() {
    if (!this.file?.state || this.waiting) return;
    if (this.editor) {
      const text = this.editor.value();
      this.editor.release();
      this.editor = null;
      this.change(edit(this.file.state, text));
      return;
    }
    this.editor = EditorState.new({ value: resultText(this.file.state), font_family: settings().font_family, font_size: SIZE });
  }

  // The result as it stands, with what is in the editor taken in.
  settled() {
    if (this.editor) this.change(edit(this.file.state, this.editor.value()));
    return this.file.state;
  }

  // ---- writes (asked of the owner)

  ask(action, args, cx, done, failed) {
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, action, { ...this.repo(), ...args }, this.who, cx, (r, cx) => {
      this.waiting = false;
      if (!r.ok) { failed?.(r); this.error = sentence(this.t, r.msg, r.err); return; }
      done?.(cx);
    });
  }

  // Apply Changes (then: "apply", the next file) or Save and Close (then: "close"). With
  // something left to decide it asks first, unless `anyway`.
  save(then, cx, anyway = false) {
    if (!this.free()) return;
    const state = this.settled();
    // The footer buttons don't redraw on their own: without cx.notify() the question
    // would wait for some later redraw.
    if (!anyway && leftToDecide(state) > 0) { this.confirm = then; cx.notify(); return; }
    this.confirm = null;
    if (this.editor) { this.editor.release(); this.editor = null; }
    const text = resultText(state);
    this.waiting = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const staged = await stageSave(exec, this.on, { path: this.path, text, dir: `${appHome()}/${STAGE_DIR}` });
      if (!staged.ok) { this.waiting = false; this.error = sentence(this.t, staged.msg, staged.err); cx.notify(); return; }
      this.ask("conflicts-save", staged.args, cx, (cx) => (then === "apply" ? this.goOn(cx) : this.shut()), (r) => {
        // A panel that never took the request leaves the staged file to us; one that took
        // it removes it.
        if (r.unheard) dropStaged(exec, this.on, staged.args.file);
      });
    });
  }

  // Accept Left or Accept Right: the whole file from that side.
  acceptAll(column, cx) {
    if (!this.file || this.waiting || this.writing()) return;
    if (this.editor) { this.editor.release(); this.editor = null; }
    this.ask("conflicts-accept", { path: this.path, side: this.cols[column].side }, cx, (cx) => this.goOn(cx));
  }

  // The next conflicted file, or close when none is left.
  goOn(cx) {
    cx.spawn(async (cx) => {
      const op = await readOperation(this.git, this.root);
      const next = op.ok ? nextFile(op.conflicts, this.path) : null;
      if (!next) { this.shut(); return; }
      this.path = next;
      this.load(cx);
      cx.notify();
    });
  }

  shut() {
    if (this.editor) { this.editor.release(); this.editor = null; }
    close(this.overlay);
  }

  close() { if (this.editor) { this.editor.release(); this.editor = null; } }

  // ---- drawing

  word(w) { return this.t(w.key, w.args); }

  // A side's chunk buttons in a gutter: on the left pane's side ✕ then ≫, on the right
  // pane's side ≪ then ✕, each pointing at the result.
  gutter(r, side, t) {
    const cell = h_flex().w(GUTTER).flex_none().h_full().items_center().justify_center().gap(2);
    if (!r.first || this.editor) return cell;
    const b = chunkButtons(this.file.state, r.chunk)[side];
    if (!b) return cell;
    const left = side === "ours";
    const add = b.apply === "add";
    const applyTitle = left ? (add ? "conflicts.mrAppendLeftSide" : "conflicts.mrAcceptLeftSide") : (add ? "conflicts.mrAppendRightSide" : "conflicts.mrAcceptRightSide");
    const ignoreTitle = left ? "conflicts.mrIgnoreLeftSide" : "conflicts.mrIgnoreRightSide";
    const ok = this.free();
    const glyph = (id, text, title, onClick) => div().id(id).w(18).h(16).flex().items_center().justify_center().rounded(3)
      .text_size(12).text_color(ok ? t.muted : t.dim).tooltip(this.t(title))
      .when(ok, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); cx.notify(); }))
      .child(text);
    const apply = glyph(`mr-${side}-apply-${r.chunk}`, add ? (left ? "+≫" : "≪+") : (left ? "≫" : "≪"), applyTitle, () => this.decideChunk(r.chunk, side, add ? "add" : "accept"));
    const ignore = glyph(`mr-${side}-ignore-${r.chunk}`, "✕", ignoreTitle, () => this.decideChunk(r.chunk, side, "ignore"));
    return left ? cell.child(ignore).child(apply) : cell.child(apply).child(ignore);
  }

  pane(cell, t, look) {
    const bg = cell?.color ? look[cell.color] : null;
    return h_flex().flex_1().min_w(0).h_full().items_center()
      .when(Boolean(bg), (el) => el.bg(bg))
      .child(div().w(NUMBER).flex_none().pr(6).text_right().text_color(t.dim).child(cell ? String(cell.no) : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().overflow_hidden().child(cell ? bare(cell.text).slice(0, COLUMNS) : ""));
  }

  renderRow(i, t, look, panes = "all") {
    const r = this.rows[i];
    const row = h_flex().h(LINE).w_full().flex_none().items_center();
    if (panes === "left") return row.child(this.pane(r.left, t, look));
    if (panes === "right") return row.child(this.pane(r.right, t, look));
    return row
      .child(this.pane(r.left, t, look))
      .child(this.gutter(r, "ours", t))
      .child(this.pane(r.result, t, look))
      .child(this.gutter(r, "theirs", t))
      .child(this.pane(r.right, t, look));
  }

  renderToolbar(t) {
    const bar = toolbar(this.file.state);
    const on = this.free() && !this.editor;
    const glyphButton = (id, text, title, enabled, onClick) => div().id(id).h(24).px(6).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(enabled ? t.muted : t.dim).tooltip(title)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); cx.notify(); }))
      .child(text);
    const count = countWords(this.file.state).map((w) => this.word(w)).join(", ");
    return h_flex().w_full().flex_none().px(14).py(6).gap(4).items_center().border_b(1).border_color(t.border)
      .child(glyphButton("mr-prev", "↑", this.t("conflicts.mrPrevConflict"), on && bar.conflicts > 0, () => this.seek(-1)))
      .child(glyphButton("mr-next", "↓", this.t("conflicts.mrNextConflict"), on && bar.conflicts > 0, () => this.seek(1)))
      .child(div().w(8).flex_none())
      .child(div().flex_none().text_size(12).text_color(t.muted).child(this.t("conflicts.mrApplyLabel")))
      .child(glyphButton("mr-apply-left", "≫", this.t("conflicts.mrApplyLeft"), on && bar.applyLeft, () => this.applyNonConflicting("ours")))
      .child(iconButton("mr-apply-all", "apply-non-conflicts", t, { title: this.t("conflicts.mrApplyAll"), disabled: !(on && bar.applyAll), onClick: (_e, cx) => { this.applyNonConflicting("all"); cx.notify(); } }))
      .child(glyphButton("mr-apply-right", "≪", this.t("conflicts.mrApplyRight"), on && bar.applyRight, () => this.applyNonConflicting("theirs")))
      .child(iconButton("mr-resolve-simple", "magic-resolve", t, { title: this.t("conflicts.mrResolveSimple"), disabled: !(on && bar.resolveSimple), onClick: (_e, cx) => { this.resolveSimple(); cx.notify(); } }))
      .child(div().w(8).flex_none())
      .child(button("mr-edit", this.t("conflicts.mrEditResult"), t, { kind: this.editor ? "primary" : "plain", disabled: this.waiting, onClick: (_e, cx) => { this.toggleEdit(); cx.notify(); } }))
      .child(div().flex_1().min_w(0))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(count));
  }

  renderPanes(t) {
    const look = { conflict: tint(t.ansi1, "30"), modified: tint(t.ansi4, "28"), inserted: tint(t.ansi2, "28"), deleted: tint(t.dim, "30") };
    const head = (text) => div().flex_1().min_w(0).px(8).truncate().child(text);
    const titles = h_flex().w_full().h(26).flex_none().items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(head(this.word(this.titles.left)))
      .child(div().w(GUTTER).flex_none())
      .child(head(this.t("conflicts.mrResult", { path: this.path })))
      .child(div().w(GUTTER).flex_none())
      .child(head(this.word(this.titles.right)));
    const font = (el) => el.font_family(settings().font_family ?? "JetBrains Mono").text_size(SIZE);
    const lines = this.editor
      ? h_flex().flex_1().min_h(0).w_full()
        .child(font(div().flex_1().min_w(0).h_full()).child(this.leftList.render(this.rows.length, (i) => this.renderRow(i, t, look, "left"), t)))
        .child(div().w(GUTTER).flex_none())
        .child(div().flex_1().min_w(0).h_full().border_1().border_color(t.accent).child(Editor.new(this.editor).size_full()))
        .child(div().w(GUTTER).flex_none())
        .child(font(div().flex_1().min_w(0).h_full()).child(this.rightList.render(this.rows.length, (i) => this.renderRow(i, t, look, "right"), t)))
      : font(div().flex_1().min_h(0).w_full()).child(this.list.render(this.rows.length, (i) => this.renderRow(i, t, look), t));
    return v_flex().flex_1().min_h(0).mx(14).mt(8).rounded(4).border_1().border_color(t.border).overflow_hidden().bg(t.background)
      .child(titles)
      .child(lines);
  }

  renderConfirm(t) {
    const then = this.confirm, state = this.file.state;
    const back = (_e, cx) => { this.confirm = null; cx.notify(); };
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(8)
      .child(div().w_full().child(this.t("conflicts.mrUnresolvedBody", { n: leftToDecide(state) })));
    return dialogFrame("mr-unresolved", this.t("conflicts.mrUnresolvedTitle"), t, {
      body,
      onClose: back,
      footer: [
        button("mr-unresolved-back", this.t("conflicts.mrBackToResolving"), t, { onClick: back }),
        button("mr-unresolved-save", this.t("conflicts.mrSaveAnyway"), t, { kind: "primary", onClick: (_e, cx) => this.save(then, cx, true) }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.confirm = null;
      else if (e.key === "enter") this.save(then, cx, true);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }

  render() {
    const t = theme();
    if (this.confirm && this.file?.state) return this.renderConfirm(t);
    const said = this.error ?? this.writing();
    const text = this.file?.mode === "text";
    const busy = this.waiting || Boolean(this.writing());
    let body;
    if (!this.file) body = this.error ? notice("", t) : notice(this.t("ui.loading"), t, { busy: true });
    else if (!text) body = notice(this.t(this.file.mode === "binary" ? "conflicts.mrBinary" : "conflicts.mrDeleted", { path: this.path }), t);
    else body = v_flex().size_full().min_h(0).child(this.renderToolbar(t)).child(this.renderPanes(t));
    const frame = v_flex().size_full().min_h(0)
      .child(div().flex_1().min_h(0).child(body))
      .when(Boolean(said), (el) => el.child(div().w_full().flex_none().px(14).pt(6)
        .child(scrollText("mr-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted }))))
      .child(div().h(6).flex_none());
    const loaded = Boolean(this.file) && !busy;
    return dialogFrame("merge-revisions", this.path ?? "", t, {
      body: frame,
      onClose: () => this.shut(),
      footer: [
        button("mr-accept-left", this.t("conflicts.mrAcceptLeft"), t, { disabled: !loaded, onClick: (_e, cx) => this.acceptAll("yours", cx) }),
        button("mr-accept-right", this.t("conflicts.mrAcceptRight"), t, { disabled: !loaded, onClick: (_e, cx) => this.acceptAll("theirs", cx) }),
        div().w(12).flex_none(),
        ...(text ? [
          button("mr-save-close", this.t("conflicts.mrSaveClose"), t, { disabled: !loaded, busy: this.waiting, onClick: (_e, cx) => this.save("close", cx) }),
          button("mr-apply", this.t("conflicts.mrApply"), t, { kind: "primary", disabled: !loaded, onClick: (_e, cx) => this.save("apply", cx) }),
        ] : []),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      // Keys typed in the editor stay the editor's.
      if (this.editor) return;
      if (e.key === "escape") this.shut();
      else return;
      cx.stop_propagation();
    });
  }
}
