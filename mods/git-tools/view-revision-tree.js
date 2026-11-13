// Repository at revision tab (view "revision-tree"): Show Repository at Revision on a
// commit. Every file the commit has as a folder tree, read only, the way the Files panel
// shows a folder: a press on a file shows it in place of the tree, ← goes back. One per
// space (space-tabs.js).
//
// props: { root, on, rev, folder }: rev the commit's full hash, folder the repository's
// folder name for the tab. Saved with the tab: plain JSON.

import { div } from "gpui-kit";
import { v_flex, Editor, EditorState } from "gpui-base";
import { exec, theme, settings } from "herdr";
import { ICON, uiGlyph, fileGlyph, folderGlyph, darkLook, row, toolbar, notice, errorStrip, WindowedList, panelFrame } from "./ui.js";
import { makeGit } from "./git.js";
import { buildRows } from "./tree.js";
import { openSpaceTab } from "./space-tabs.js";
import { readRevisionFile } from "./git-compare.js";
import { revisionTree } from "./git-revision.js";
import { editorLanguage } from "./editor-language.js";
import { en, ko } from "./messages-revision.js";

const SHORT = 7;
const short = (hash) => String(hash ?? "").slice(0, SHORT);
const INDENT = 14;
const PREVIEW_CHARS = 400000;
const KIND = [en["revision.repositoryTab"], ko["revision.repositoryTab"]];

const folderName = (root) => String(root ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(root ?? "");

// t: the opener's t (its language names the tab).
export function openRevisionTree(t, { root, on = null, rev }) {
  const folder = folderName(root);
  openSpaceTab({ view: "revision-tree", props: { root, on, rev, folder }, name: t("revision.repositoryTab", { folder, rev: short(rev) }), kind: KIND });
}

// The commit row's item, run by the Log panel (view-log.js ACTIONS).
export function showRepositoryAt(host, commits) {
  const c = commits?.[0];
  if (host.repo && c?.hash) openRevisionTree(host.t, { root: host.repo.root, on: host.repo.on, rev: c.hash });
}

export default class RevisionTree {
  init(p, cx) {
    this.repo = p.root ? { root: p.root, on: p.on ?? null } : null;
    this.rev = p.rev ?? null; this.folder = p.folder ?? folderName(p.root);
    this.files = null; this.rows = []; this.collapsed = new Set();
    this.error = null; this.cursor = null;
    this.file = null; // the file shown in place of the tree: its tree row's item
    this.code = null; this.note = null; this.cut = false; this.turn = 0;
    this.list = new WindowedList("revision-tree-files");
    this.handle = cx.focus_handle();
    this.load(cx);
  }

  git() { return makeGit(exec, this.repo?.on ?? null); }

  load(cx) {
    if (!this.repo || !this.rev) { this.files = []; this.error = this.t("ui.gitFailed"); return; }
    cx.spawn(async (cx) => {
      try {
        const r = await revisionTree(this.git(), this.repo.root, this.rev);
        this.files = r.files;
        this.error = r.ok ? null : r.err || this.t("ui.gitFailed");
        // Folded to the top level at first: a whole repository is too long a list to open on.
        this.collapsed = new Set(buildRows(r.files, { grouped: true }).filter((m) => m.folder).map((m) => m.key));
        this.build();
      } catch (error) {
        this.files = []; this.error = String(error?.message ?? error);
      }
      cx.notify();
    });
  }

  build() { this.rows = buildRows(this.files ?? [], { grouped: true, collapsed: this.collapsed }); }

  toggle(m, cx) {
    if (this.collapsed.has(m.key)) this.collapsed.delete(m.key); else this.collapsed.add(m.key);
    this.build();
    cx.notify();
  }

  // Shows a file in place of the tree, or goes back to it with null.
  show(m, cx) {
    const turn = ++this.turn;
    this.code?.release(); this.code = null; this.note = null; this.cut = false;
    this.file = m?.item ?? null;
    if (!this.file) { this.handle.focus(); return; }
    if (this.file.kind !== "file") { this.note = this.file.kind === "link" ? "revision.link" : "revision.submodule"; return; }
    cx.spawn(async (cx) => {
      let note = null, text = null;
      try {
        const r = await readRevisionFile(this.git(), this.repo.root, { rev: this.rev, path: this.file.path });
        if (!r.ok) note = "compare.unreadable"; else if (r.binary) note = "compare.binary"; else text = r.text;
      } catch { note = "compare.unreadable"; }
      if (turn !== this.turn) return;
      this.note = note;
      if (text !== null) {
        const t = theme();
        this.cut = text.length > PREVIEW_CHARS;
        this.code = EditorState.new({
          language: editorLanguage(this.file.path), readonly: true,
          value: this.cut ? text.slice(0, PREVIEW_CHARS) : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
      }
      cx.notify();
    });
  }

  close() { this.code?.release(); this.code = null; }

  activate(m, cx) { if (m.folder) this.toggle(m, cx); else this.show(m, cx); }

  move(by, cx) {
    const n = this.rows.length;
    if (!n) return;
    const now = this.rows.findIndex((m) => m.key === this.cursor);
    const at = Math.max(0, Math.min(n - 1, now < 0 ? 0 : now + by));
    this.cursor = this.rows[at].key;
    this.list.reveal(at, n);
    cx.notify();
  }

  key(e, cx) {
    const m = this.rows.find((r) => r.key === this.cursor);
    if (this.file) { if (e.key === "escape" || e.key === "backspace") { this.show(null, cx); return true; } return false; }
    if (e.key === "down") this.move(1, cx);
    else if (e.key === "up") this.move(-1, cx);
    else if (e.key === "enter" && m) this.activate(m, cx);
    else if (e.key === "right" && m?.folder && !m.open) this.toggle(m, cx);
    else if (e.key === "left" && m?.folder && m.open) this.toggle(m, cx);
    else return false;
    return true;
  }

  // ---- drawing

  fileRow(i, t, dark) {
    const m = this.rows[i];
    const el = row(`revision-file-${i}`, t, { selected: this.cursor === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
      .on_click((_e, cx) => { this.handle.focus(); this.cursor = m.key; this.activate(m, cx); cx.notify(); });
    if (m.folder) {
      return el.child(div().size(ICON).flex_none().flex().items_center().justify_center().text_color(t.muted).child(uiGlyph(m.open ? "chevron-down" : "chevron-right")))
        .child(folderGlyph(m.name, { open: m.open, size: 13 }))
        .child(div().flex_1().min_w(0).truncate().child(m.name));
    }
    return el.tooltip(m.path).child(div().size(ICON).flex_none()).child(fileGlyph(m.path, { dark, size: 13 }))
      .child(div().flex_1().min_w(0).truncate().child(m.name));
  }

  preview(t) {
    if (this.code) {
      return v_flex().flex_1().min_h(0)
        .when(this.cut, (el) => el.child(div().flex_none().px(12).py(4).border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
          .child(this.t("compare.cut", { n: PREVIEW_CHARS }))))
        .child(Editor.new(this.code).flex_1().min_h(0));
    }
    return notice(this.note ? this.t(this.note) : this.t("ui.loading"), t, { busy: !this.note });
  }

  render() {
    const t = theme(), dark = darkLook(t.background), file = this.file;
    const body = file ? this.preview(t)
      : !this.files ? notice(this.t("ui.loading"), t, { busy: true })
      : !this.rows.length ? notice(this.t("revision.noFiles"), t)
      : this.list.render(this.rows.length, (i) => this.fileRow(i, t, dark), t);
    return panelFrame("revision-tree-tab", t).track_focus(this.handle)
      .on_key_down((e, cx) => { if (!this.key(e, cx)) return; cx.stop_propagation(); cx.notify(); })
      .child(toolbar(t).px(10).gap(8)
        // The mod has no left arrow icon: the arrow is a glyph, as the Files panel draws it.
        .when(Boolean(file), (el) => el.child(div().id("revision-back").size(24).flex_none().flex().items_center().justify_center().rounded(5)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(this.t("revision.back"))
          .on_click((_e, cx) => { this.show(null, cx); cx.notify(); })
          .child("←")))
        .child(div().flex_none().font_semibold().child(this.t("revision.repositoryTab", { folder: this.folder, rev: short(this.rev) })))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(file?.path ?? "")))
      .child(div().flex_1().min_h(0).w_full().child(body))
      .when(Boolean(this.error) && !file, (el) => el.child(errorStrip("revision-tree-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}
