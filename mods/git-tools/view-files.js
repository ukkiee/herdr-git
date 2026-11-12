// Files panel: the focused pane's folder as a tree that opens folder by folder, with the
// Icon theme's icons, git marks (the name in its status color, a letter on the right, a
// dot beside a folder with changed files below it, ignored ones dim) and a read-only
// preview of the file pressed. Kept fresh by a folder watch (this computer) and a 10 s
// timer (everywhere), like the Commit panel; the timer keeps reading while the panel is
// hidden. Each space and folder keeps its open folders and its previewed file.
//
// props: { view: "files" }: the `files` block of the main-git layout.
//
// Reading is files-data.js's and every decision (which rows show, what a mark means for
// a row) files-tree.js's; this file draws. The rows as drawn are `this.rows`
// (visibleRows) and the chosen row is `this.current` (its path): what moves the choice
// works on these two.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { exec, theme, settings, watchFolder, readTextFile, window as hostWindow } from "herdr";
import { readFolder, readMarks, roomFor, PER_FOLDER, TOTAL } from "./files-data.js";
import { markLookup, visibleRows } from "./files-tree.js";
import { location, icon, fileGlyph, folderGlyph, darkLook, panelFrame, toolbar, row, notice, errorStrip, WindowedList } from "./ui.js";

const POLL = 10000;
// The preview shows at most this many characters; readTextFile itself stops at 1 MiB.
const PREVIEW_CHARS = 400000;
// File extensions the editor knows by another language's name.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const LETTER = { modified: "M", added: "A", deleted: "D", conflict: "U" };
const NO_LOOKUP = markLookup({});

// The Commit panel's colors, so a file reads the same in both panels. Untracked files are
// "added" here: the panel tells them apart only by the letter's tooltip.
function statusColor(mark, t) {
  return { modified: t.ansi4, added: t.ansi2, deleted: t.muted, conflict: t.ansi9 ?? t.ansi1, ignored: t.dim }[mark] ?? t.foreground;
}

// 5000 → "5,000": the runtime has no Intl.
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const folderName = (path) => String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

export default class FilesView {
  init(_p, cx) {
    // context key → { open, file } the panel left there (see enter).
    this.saved = new Map();
    this.context = null;
    this.reset();
    this.list = new WindowedList("files-tree");
    this.refresh(cx);
    // The watch misses things (a remote space has none at all), so the timer stays on.
    cx.timer.every(POLL, (cx) => this.refresh(cx));
  }

  where() { return location(); }
  contextKey() { const { folder, on, space } = this.where(); return JSON.stringify([folder, on, space]); }

  // What the panel shows of one folder, emptied when it moves to another.
  reset() {
    this.root = null; this.on = null;
    this.entries = new Map(); // folder path ("" for the root) → readFolder's entries
    this.open = new Set();
    this.pending = new Set(); // folders being read after a press
    this.marks = NO_LOOKUP; this.prefix = "";
    this.rows = []; this.current = null;
    this.limited = false; this.gone = false; this.read = false; this.loading = false; this.again = false;
    this.error = null; this.rootError = null;
    this.watching = null;
    this.release();
    this.file = null; this.fileNote = null; this.cut = false;
  }

  // ---- reading

  // A folder change is taken up first: the open folders and the previewed file of the
  // folder left are kept for coming back.
  enter(cx) {
    const key = this.contextKey();
    if (key === this.context?.key) return;
    if (this.context) this.saved.set(this.context.key, { open: this.open, file: this.file });
    const { folder, on } = this.where();
    this.reset();
    this.context = { key };
    this.root = folder; this.on = on;
    const was = this.saved.get(key);
    if (was) this.open = new Set(was.open);
    if (this.list) this.list.top = 0;
    if (was?.file) this.show(was.file, cx);
  }

  refresh(cx) {
    this.enter(cx);
    const context = this.context, root = this.root, on = this.on;
    if (!root) return;
    // A change that lands while a read is running is read once that one is done.
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    const platform = hostWindow()?.platform ?? null;
    cx.spawn(async (cx) => {
      try {
        const next = new Map();
        let limited = false, failed = null;
        const folders = ["", ...this.open];
        for (const path of folders) {
          if (path && !next.has(parentOf(path))) continue;
          const r = await readFolder(exec, path ? `${root}/${path}` : root, { on, platform, room: roomFor(next, path) });
          if (this.context !== context) return;
          if (!r.ok) {
            if (!path) { this.gone = r.gone; this.rootError = r.gone ? null : r.err || "?"; this.entries = new Map(); this.rebuild(); return; }
            // A folder deleted since it was opened just has nothing under it.
            if (!r.gone) failed = failed ?? r.err;
            continue;
          }
          next.set(path, r.entries);
          limited = limited || r.limited;
        }
        // Folders opened by a press while this read ran keep what that press read.
        for (const [path, entries] of this.entries) if (!folders.includes(path) && this.open.has(path)) next.set(path, entries);
        const m = await readMarks(exec, root, { on });
        if (this.context !== context) return;
        // Folders closed by a press while this read ran give their share back.
        for (const path of [...next.keys()]) if (path && !this.open.has(path)) next.delete(path);
        this.gone = false; this.rootError = null;
        this.entries = next; this.limited = limited;
        // A failed git read keeps the marks it had and says nothing: the Commit panel
        // shows git's errors, and a machine without git would get one every 10 s.
        if (m.ok) { this.marks = markLookup(m.marks); this.prefix = m.repo?.prefix ?? ""; }
        this.error = failed;
        this.rebuild();
        this.watch(cx);
      } finally {
        if (this.context === context) {
          this.loading = false; this.read = true;
          if (this.again) this.refresh(cx);
        }
        cx.notify();
      }
    });
  }

  // Only this computer's folders can be watched. Reads write nothing under .git, so a
  // refresh never wakes its own watch. One loop per root: a newer watch, or leaving the
  // folder, ends the older loop the next time it wakes.
  watch(cx) {
    if (this.on || !this.root || this.watching?.root === this.root) return;
    const mine = this.watching = { root: this.root };
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

  // Opens a closed folder (reading it if it isn't yet) or closes an open one. Closing
  // drops what was read inside it, which frees its share of the total.
  toggle(path, cx) {
    if (this.open.has(path)) {
      for (const folder of [...this.open]) if (folder === path || folder.startsWith(`${path}/`)) {
        this.open.delete(folder);
        this.entries.delete(folder);
      }
      this.rebuild();
      return;
    }
    this.open.add(path);
    this.rebuild();
    if (this.entries.has(path) || this.pending.has(path)) return;
    const context = this.context, root = this.root, on = this.on;
    this.pending.add(path);
    cx.spawn(async (cx) => {
      try {
        const r = await readFolder(exec, `${root}/${path}`, { on, platform: hostWindow()?.platform ?? null, room: roomFor(this.entries, path) });
        if (this.context !== context || !this.open.has(path)) return;
        if (r.ok) { this.entries.set(path, r.entries); this.limited = this.limited || r.limited; }
        else if (!r.gone) this.error = r.err || null;
        this.rebuild();
      } finally {
        if (this.context === context) this.pending.delete(path);
        cx.notify();
      }
    });
  }

  // ---- rows

  // The tree as drawn, built when the data or the folding changes, never in render.
  rebuild() {
    this.rows = visibleRows(this.entries, this.open);
    if (this.current && !this.rows.some((r) => r.path === this.current)) this.current = null;
  }

  // Chooses a row by its path (null: none). The list scrolls to show it.
  select(path) {
    const at = this.rows.findIndex((r) => r.path === path);
    this.current = at < 0 ? null : path;
    if (at >= 0) this.list.reveal(at, this.rows.length);
    return at >= 0;
  }

  press(r, cx) {
    this.select(r.path);
    if (r.folder) this.toggle(r.path, cx);
    else this.show(r.path, cx);
  }

  // ---- the preview

  release() {
    this.code?.release();
    this.code = null;
  }

  // Previews the file at `path` (from the root), or goes back to the tree with null.
  show(path, cx) {
    this.release();
    this.file = path; this.fileNote = null; this.cut = false;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || this.context !== context) return;
        if (text === null) { this.fileNote = "files.unavailable"; return; }
        if (text.includes("\0")) { this.fileNote = "files.binary"; return; }
        const t = theme(), name = path.slice(path.lastIndexOf("/") + 1);
        const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "txt";
        this.cut = text.length > PREVIEW_CHARS;
        this.code = EditorState.new({
          language: LANG[ext] ?? ext, readonly: true,
          value: this.cut ? text.slice(0, PREVIEW_CHARS) : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
      } catch {
        if (this.file === path && this.context === context) this.fileNote = "files.unreadable";
      } finally {
        cx.notify();
      }
    });
  }

  close() { this.release(); }

  // ---- drawing

  renderRow(i, t) {
    const r = this.rows[i];
    const mark = this.marks.mark(r.path);
    const ignored = mark === "ignored";
    const el = row(`files-row-${r.path}`, t, { selected: r.path === this.current, depth: r.depth })
      .cursor_pointer()
      .on_click((_e, cx) => { this.press(r, cx); cx.notify(); })
      .child(r.folder
        ? svg(icon(r.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.muted)
        : div().size(12).flex_none());
    if (r.folder) {
      const dot = this.marks.dot(r.path);
      return el
        .child(folderGlyph(r.name, { open: r.open }).when(ignored, (g) => g.opacity(0.5)))
        .child(div().flex_none().max_w("85%").truncate().text_color(ignored ? t.dim : t.foreground).child(r.name))
        .when(dot, (el) => el.child(div().id(`files-dot-${r.path}`).size(6).flex_none().rounded(3).bg(t.ansi4).tooltip(this.t("files.changedInside"))))
        .child(div().flex_1().min_w(0));
    }
    const letter = LETTER[mark];
    return el
      .child(fileGlyph(`${this.prefix}${r.path}`, { dark: this.dark }).when(ignored, (g) => g.opacity(0.5)))
      .child(div().flex_1().min_w(0).truncate().text_color(statusColor(mark, t))
        .when(mark === "conflict", (el) => el.font_semibold())
        .child(r.name))
      .when(Boolean(letter), (el) => el.child(div().id(`files-mark-${r.path}`).flex_none().text_size(11).text_color(statusColor(mark, t))
        .tooltip(this.t(`files.mark.${mark}`)).child(letter)));
  }

  renderTree(t) {
    if (!this.root) return notice(this.t("files.noFolder"), t);
    if (this.gone) return notice(this.t("files.gone", { folder: this.root }), t);
    if (this.rootError) return notice(this.rootError, t);
    if (!this.read) return notice(this.t("ui.loading"), t, { busy: true });
    if (!this.rows.length) return notice(this.t("files.empty"), t);
    return this.list.render(this.rows.length, (i) => this.renderRow(i, t), t);
  }

  renderPreview(t) {
    if (this.code) {
      return v_flex().flex_1().min_h(0)
        .when(this.cut, (el) => el.child(div().flex_none().px(12).py(4).border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
          .child(this.t("files.truncated", { n: grouped(PREVIEW_CHARS) }))))
        .child(Editor.new(this.code).flex_1().min_h(0));
    }
    return notice(this.fileNote ? this.t(this.fileNote) : this.t("files.loadingFile"), t, { busy: !this.fileNote });
  }

  render(cx) {
    // Another folder to follow: read in a timer, since nothing may start inside render
    // (cx.notify throws there and cx.spawn runs its first part there).
    if (this.contextKey() !== this.context?.key && !this.moving) {
      this.moving = true;
      cx.timer.after(0, (cx) => { this.moving = false; if (this.contextKey() !== this.context?.key) { this.refresh(cx); cx.notify(); } });
    }
    const t = theme();
    this.dark = darkLook();
    const previewing = Boolean(this.file);
    const where = previewing ? this.file : folderName(this.root);
    return panelFrame("files-panel", t)
      .child(toolbar(t).px(10).gap(8)
        // The mod has no left arrow icon: the arrow is a glyph, as in Herdr's own Files.
        .when(previewing, (el) => el.child(div().id("files-back").size(24).flex_none().flex().items_center().justify_center().rounded(5)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(this.t("files.back"))
          .on_click((_e, cx) => { this.show(null, cx); cx.notify(); })
          .child("←")))
        .child(div().flex_none().font_semibold().child(this.t("files.title")))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(where ?? "")))
      .child(previewing ? this.renderPreview(t)
        : v_flex().flex_1().min_h(0)
          .child(div().flex_1().min_h(0).child(this.renderTree(t)))
          .when(this.limited && !this.gone && !this.rootError, (el) => el.child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
            .child(this.t("files.limited", { perFolder: grouped(PER_FOLDER), total: grouped(TOTAL) })))))
      .when(Boolean(this.error) && !previewing, (el) => el.child(errorStrip("files-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}

// "a/b/c" → "a/b"; "a" → "".
function parentOf(path) {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}
