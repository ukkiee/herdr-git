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
//
// The search box under the header: typed letters put the search's results in the
// tree's place (rankSearch over readSearchList's files, `this.ranked`, the chosen result
// `this.hit`); an empty box brings the tree back. The file list is read when a search
// starts and again in another folder, not on every refresh: outside a repository it is
// a walk of up to 20,000 files.
//
// Keys: ↑ ↓ ← → Enter on the tree (moveKey), ↑ ↓ Enter on the results, Esc closes the
// preview or ends the search. A right-click opens the row menu (Show Diff for a file with
// a git mark, Copy Path, Copy Relative Path, Reveal in Finder); the preview's header has
// Show Diff too.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, theme, settings, watchFolder, readTextFile, window as hostWindow } from "herdr";
import { readFolder, readMarks, readSearchList, roomFor, PER_FOLDER, TOTAL, SEARCH_LIMIT } from "./files-data.js";
import { markLookup, visibleRows, rankSearch, moveKey, SEARCH_SHOWN } from "./files-tree.js";
import { location, icon, fileGlyph, folderGlyph, darkLook, panelFrame, toolbar, iconButton, row, notice, errorStrip, WindowedList, openMenu } from "./ui.js";
import { openDiff } from "./view-diff.js";

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
    this.found = new WindowedList("files-found");
    // The panel takes the keyboard when a row is pressed, as the Commit panel does: the
    // mod isn't "focusable", so Herdr never hands it over.
    this.handle = cx.focus_handle();
    this.makeInput("");
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
    this.marks = NO_LOOKUP; this.prefix = ""; this.repoRoot = null;
    this.rows = []; this.current = null;
    this.limited = false; this.gone = false; this.read = false; this.loading = false; this.again = false;
    this.error = null; this.rootError = null;
    this.watching = null;
    this.release();
    this.file = null; this.fileNote = null; this.cut = false;
    // The search: readSearchList's answer for this folder, whether it is being read, and
    // rankSearch's answer for what is typed (null until the list is in).
    this.listed = null; this.listing = false; this.ranked = null; this.hit = null;
  }

  // The placeholder is fixed when the input is made: a copy whose language changed since
  // gets a new input holding what was typed (see render).
  makeInput(value) {
    this.inputLang = this.lang;
    this.query = InputState.new({ placeholder: this.t("files.search"), value });
    this.query.on("change", (_e, cx) => {
      this.hit = null;
      this.found.top = 0;
      if (this.searching()) this.readList(cx);
      this.rank();
      cx.notify();
    });
    this.query.on("submit", (_e, cx) => { this.openHit(cx); cx.notify(); });
    this.query.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.query.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
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
    if (this.found) this.found.top = 0;
    if (was?.file) this.show(was.file, cx);
    // A search still typed searches the new folder.
    if (this.searching()) this.readList(cx);
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
        if (m.ok) { this.marks = markLookup(m.marks); this.prefix = m.repo?.prefix ?? ""; this.repoRoot = m.repo?.root ?? null; }
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

  // ---- the search

  searching() { return Boolean(this.query?.value().trim()); }

  // The files to search, read once per folder: when a search starts, and again in
  // another folder while one is typed.
  readList(cx) {
    if (!this.root || this.listed || this.listing) return;
    const context = this.context, root = this.root, on = this.on;
    this.listing = true;
    cx.spawn(async (cx) => {
      try {
        const r = await readSearchList(exec, root, { on, platform: hostWindow()?.platform ?? null });
        if (this.context !== context) return;
        this.listed = r;
        this.rank();
      } finally {
        if (this.context === context) this.listing = false;
        cx.notify();
      }
    });
  }

  // The results for what is typed, worked out when the text or the list changes, never
  // in render. The chosen result stays while it is still there; otherwise the first is
  // chosen, so Enter opens it.
  rank() {
    this.ranked = this.listed?.ok ? rankSearch(this.listed.files, this.query.value()) : null;
    const items = this.ranked?.items ?? [];
    if (!items.some((it) => it.path === this.hit)) this.hit = items[0]?.path ?? null;
  }

  chooseHit(path) {
    const items = this.ranked?.items ?? [];
    const at = items.findIndex((it) => it.path === path);
    this.hit = at < 0 ? null : path;
    if (at >= 0) this.found.reveal(at, items.length);
  }

  // Enter in the box and a press on a result: the result's preview. The box's submit and
  // the panel's own Enter can both come for one press, so an open preview isn't read again.
  openHit(cx, path = this.hit) {
    if (path && path !== this.file) this.show(path, cx);
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

  // ---- keys

  // One key, by its keystroke spelling; true when the panel used it. The keys reach the
  // panel from its rows and from the search box (bubbling up), so while the box has the
  // keyboard only ↑ ↓ (and Enter, Esc on results) are taken: ← → move its caret.
  key(name, cx) {
    if (this.file) {
      if (name !== "escape") return false;
      this.show(null, cx);
      return true;
    }
    if (!this.root || this.gone || this.rootError) return false;
    if (this.searching()) {
      if (name === "escape") {
        this.query.set_value("");
        this.hit = null; this.rank();
        return true;
      }
      if (name !== "up" && name !== "down" && name !== "enter") return false;
      const move = moveKey(this.ranked?.items ?? [], this.hit, name);
      this.chooseHit(move.current);
      if (move.preview) this.openHit(cx, move.preview);
      return true;
    }
    if (!["up", "down", "left", "right", "enter"].includes(name)) return false;
    if (this.typing && name !== "up" && name !== "down") return false;
    const move = moveKey(this.rows, this.current, name);
    if (move.current) this.select(move.current);
    if (move.expand && !this.open.has(move.expand)) this.toggle(move.expand, cx);
    if (move.collapse && this.open.has(move.collapse)) this.toggle(move.collapse, cx);
    if (move.preview) this.show(move.preview, cx);
    return true;
  }

  // ---- the row menu and Show Diff

  // The Diff tab a file with a git mark opens (the working file against HEAD, as the
  // Commit panel opens it), or null. Ignored files have nothing to compare.
  diffFor(path) {
    const mark = this.marks.mark(path);
    if (!this.repoRoot || !LETTER[mark]) return null;
    return { root: this.repoRoot, on: this.on, path: `${this.prefix}${path}`, status: mark };
  }

  // Reveal in Finder only where Finder can show the file: a macOS window and a space on
  // this computer.
  canReveal() { return hostWindow()?.platform === "macos" && !this.on; }

  // The menu of a tree row or a result. What a pick does is worked out before it opens,
  // so a pick made after the panel moved to another folder still acts on this row.
  rowMenu(path, folder, cx) {
    const diff = folder ? null : this.diffFor(path);
    const absolute = joinPath(this.root, path), relative = `${this.prefix}${path}`, reveal = this.canReveal();
    const items = [];
    if (diff) items.push({ label: this.t("files.showDiff"), value: "diff" });
    items.push({ label: this.t("files.copyPath"), value: "path", rule: true });
    items.push({ label: this.t("files.copyRelativePath"), value: "relative" });
    if (reveal) items.push({ label: this.t("files.revealInFinder"), value: "reveal" });
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.bus, items, { lang: this.lang });
      // The "focus" command never comes (the mod isn't focusable): the keyboard comes back here.
      this.handle.focus();
      if (picked === "diff") openDiff(diff);
      else if (picked === "path") cx.write_to_clipboard(absolute);
      else if (picked === "relative") cx.write_to_clipboard(relative);
      else if (picked === "reveal") {
        const r = await exec("open", ["-R", absolute]).catch(() => null);
        if (!r || r.code !== 0) this.error = (r?.stderr ?? "").trim() || this.t("files.revealFailed");
      }
      cx.notify();
    });
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
      .on_click((_e, cx) => { this.handle.focus(); this.press(r, cx); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { this.handle.focus(); this.select(r.path); this.rowMenu(r.path, r.folder, cx); cx.notify(); })
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

  // A result: the file's icon and name in its status color, then its folder, dim.
  renderHit(i, t) {
    const it = this.ranked.items[i];
    const mark = this.marks.mark(it.path);
    return row(`files-hit-${it.path}`, t, { selected: it.path === this.hit })
      .cursor_pointer()
      .on_click((_e, cx) => { this.handle.focus(); this.chooseHit(it.path); this.openHit(cx, it.path); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { this.handle.focus(); this.chooseHit(it.path); this.rowMenu(it.path, false, cx); cx.notify(); })
      .child(fileGlyph(`${this.prefix}${it.path}`, { dark: this.dark }))
      .child(div().flex_none().max_w("70%").truncate().text_color(statusColor(mark, t))
        .when(mark === "conflict", (el) => el.font_semibold())
        .child(it.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(it.dir));
  }

  renderFound(t) {
    if (this.listed && !this.listed.ok) return notice(this.listed.err || "?", t);
    if (!this.ranked) return notice(this.t("ui.loading"), t, { busy: true });
    const n = this.ranked.items.length;
    if (!n) return notice(this.t("files.noMatches"), t);
    return this.found.render(n, (i) => this.renderHit(i, t), t);
  }

  // What the search left out: files past the walk's limit outside a repository, and
  // matches past the shown ones.
  foundNotes() {
    const notes = [];
    if (this.listed?.ok && this.listed.limited) notes.push(this.t("files.searchLimited", { n: grouped(SEARCH_LIMIT) }));
    if (this.ranked?.limited) notes.push(this.t("files.moreMatches", { n: grouped(SEARCH_SHOWN) }));
    return notes;
  }

  renderSearchBox(t) {
    return h_flex().id("files-search").h(30).flex_none().w_full().min_w(0).px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .cursor_text().on_mouse_down("left", (_e, cx) => { this.query.focus(); cx.stop_propagation(); })
      .child(svg(icon("search")).size(13).flex_none().text_color(this.typing ? t.accent : t.dim))
      .child(Input.new(this.query).flex_1().min_w(0).h_full().text_size(12.5).text_color(t.foreground));
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
    if (this.inputLang !== this.lang && !this.relabeling) {
      // Not here: render may not make the redraw a new input needs.
      this.relabeling = true;
      cx.timer.after(1, (cx) => {
        this.relabeling = false;
        if (this.inputLang === this.lang) return;
        const typing = this.typing;
        this.makeInput(this.query.value());
        if (typing) this.query.focus();
        cx.notify();
      });
    }
    const t = theme();
    this.dark = darkLook();
    const previewing = Boolean(this.file);
    const where = previewing ? this.file : folderName(this.root);
    const diff = previewing ? this.diffFor(this.file) : null;
    const shown = Boolean(this.root) && !this.gone && !this.rootError;
    const searching = shown && this.searching();
    const notes = searching ? this.foundNotes()
      : this.limited && shown ? [this.t("files.limited", { perFolder: grouped(PER_FOLDER), total: grouped(TOTAL) })] : [];
    return panelFrame("files-panel", t).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (!this.key(e.keystroke, cx)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(toolbar(t).px(10).gap(8)
        // The mod has no left arrow icon: the arrow is a glyph, as in Herdr's own Files.
        .when(previewing, (el) => el.child(div().id("files-back").size(24).flex_none().flex().items_center().justify_center().rounded(5)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(this.t("files.back"))
          .on_click((_e, cx) => { this.show(null, cx); cx.notify(); })
          .child("←")))
        .child(div().flex_none().font_semibold().child(this.t("files.title")))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(where ?? ""))
        .when(Boolean(diff), (el) => el.child(iconButton("files-diff", "diff", t, { title: this.t("files.showDiff"), onClick: (_e, cx) => { openDiff(diff); cx.notify(); } }))))
      .when(shown && !previewing, (el) => el.child(this.renderSearchBox(t)))
      .child(previewing ? this.renderPreview(t)
        : v_flex().flex_1().min_h(0)
          .child(div().flex_1().min_h(0).child(searching ? this.renderFound(t) : this.renderTree(t)))
          .children(notes.map((note, i) => div().id(`files-note-${i}`).flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(note))))
      .when(Boolean(this.error) && !previewing, (el) => el.child(errorStrip("files-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}

// The absolute path of a row: the root and the row's path, joined with the root's own
// separator, so a Windows folder gives a Windows path.
function joinPath(root, path) {
  if (/\\/.test(root) && !root.includes("/")) return `${root.replace(/\\+$/, "")}\\${path.replaceAll("/", "\\")}`;
  return `${root.replace(/\/+$/, "")}/${path}`;
}

// "a/b/c" → "a/b"; "a" → "".
function parentOf(path) {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}
