// Diff tab: one file's unified diff, drawn line by line. The platform has no diff viewer
// and its Editor can't color a line's background, so each line is a row of plain elements
// (no syntax highlighting, no side-by-side view).
//
// props: { view: "diff", root, on, path, commit, status, oldPath } (see openDiff). They are
// saved with the tab, so the tab reads its diff again after a restart.
//
// A working file's diff follows the file: it is read again when a folder watch reports a
// change that can touch it (this computer only), every POLL, and after a git write
// another copy announced. A commit's diff never changes and is read once.
//
// Commands (`git-tools.<name>`, for keys and scripts; the same as the keys while the tab
// has the keyboard): refresh, diff-up, diff-down, diff-page-up, diff-page-down, diff-top,
// diff-end, diff-left, diff-right.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, settings, watchFolder } from "herdr";
import { openTab, notice, iconButton, errorStrip, spacer, fileGlyph, darkLook, WindowedList, sentence } from "./ui.js";
import { makeGit } from "./git.js";
import { readDiff, touchesDiff, MAX_ROWS, MAX_CHARS } from "./git-diff.js";

// openDiff({ root, on, path, commit?, status?, oldPath? })
//   Opens a Diff tab in the shown space, titled with the file's name.
//   root: repository root. on: the machine git runs on (null: this computer).
//   path: the file, relative to root.
//   commit: omitted or null → the working file against HEAD;
//           a commit hash → that commit against its first parent.
//   status: optional hint for a working file ("modified" | "added" | "deleted" |
//           "conflict" | "unversioned"), as git-status.js reports it.
//   oldPath: for a file the commit renamed, the path it had before (git-show.js `from`):
//           the diff is then against that file.
//   The tab's props are saved with the tab, so everything here is plain JSON.
export function openDiff({ root, on = null, path, commit = null, status = null, oldPath = null }) {
  openTab("diff", { root, on, path, commit, status, oldPath }, path.split("/").pop());
}

// How often a working file's diff is read again without a watch saying so: a space on
// another machine has no watch at all, and a watch can miss things.
const POLL = 10000;

const LINE = 20; // row height
const SIZE = 12; // text size
// The width of one character in a monospace font at SIZE, near enough for JetBrains Mono
// and Geist Mono (0.6 em). Only the gutter width and sideways scrolling depend on it.
const CHAR = SIZE * 0.6;
const TAB = 4;
const STEP = 8; // columns per sideways step

// Tabs become spaces up to the next tab stop: a row is one text run and a raw tab
// character has no width of its own there.
function expandTabs(text) {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(TAB - (out.length % TAB)) : ch;
  return out;
}

// "#rrggbb" plus an alpha byte: a tint of a theme color that works in light and dark.
const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + alpha : color);

// 5000 → "5,000". Written out: toLocaleString doesn't group digits in the app's runtime.
const count = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");

export default class DiffView {
  init(p, cx) {
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.path = p.path ?? ""; this.commit = p.commit ?? null; this.status = p.status ?? null;
    this.oldPath = p.oldPath ?? null;
    this.result = null; // the last diff read
    this.rows = []; this.adds = 0; this.dels = 0; this.digits = 1; this.widest = 0;
    this.sides = 2; this.olds = true; this.news = true;
    this.error = null;
    this.left = 0; // columns scrolled sideways
    this.width = 0; this.sideways = 0;
    this.list = new WindowedList("diff-rows", { rowHeight: LINE });
    this.handle = cx.focus_handle();
    // drawn: render ran since the last wake. stale: a wake came while it hadn't.
    this.drawn = false; this.stale = false;
    this.load(cx);
    this.follow(cx);
  }

  // ---- reading

  load(cx) {
    if (this.loading) { this.again = true; return; }
    // error: { err, msg } (msg when it is ours), worded as it is drawn: a tab's language
    // can change after it opens.
    if (!this.root || !this.path) { this.result = { ok: false }; this.error = { err: "This tab has no file to show.", msg: { key: "dialogs.diff.noFileTab", args: {} } }; return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const r = await readDiff(makeGit(exec, this.on), this.root, { path: this.path, commit: this.commit, status: this.status, oldPath: this.oldPath });
        // A failed read keeps the diff that was read before; git's words go in the strip.
        if (r.ok || !this.result?.ok) this.apply(r);
        this.error = r.ok || !r.err ? null : { err: r.err, msg: r.msg };
      } catch (error) {
        this.error = { err: String(error?.message ?? error) };
        this.result ??= { ok: false };
      } finally {
        this.loading = false;
        if (this.again) this.load(cx);
        cx.notify();
      }
    });
  }

  // Keeps a working file's diff up to date. The timer and the watch go on while the tab
  // is hidden (a copy stays alive behind another tab), so they only wake it.
  follow(cx) {
    if (this.commit || !this.root || !this.path) return;
    cx.timer.every(POLL, (cx) => this.wake(cx));
    // Only this computer's folders can be watched. Reads don't write under .git (git.js
    // READ), so reading the diff never wakes its own watch.
    if (this.on) return;
    cx.spawn(async (cx) => {
      try {
        while (!this.closed) {
          const changed = await watchFolder(this.root);
          if (!this.closed && touchesDiff(changed, this.root, this.path)) this.wake(cx);
        }
      } catch {
        // The folder can't be watched (too large on Linux, gone): the timer still reads.
      }
    });
  }

  // Reads again, but only a tab that was drawn since its last wake: every read ends in a
  // redraw, so a tab on screen is drawn again and the next wake reads; a tab nobody looks
  // at stays stale at no cost and reads when it is next drawn (render).
  wake(cx) {
    if (!this.drawn) { this.stale = true; return; }
    this.drawn = false; this.stale = false;
    this.load(cx);
  }

  close() { this.closed = true; }

  // Everything render needs is worked out here, once per read.
  apply(r) {
    this.result = r;
    let adds = 0, dels = 0, last = 1, widest = 0, olds = false, news = false;
    this.rows = r.rows.map((row) => {
      if (row.kind === "add") adds++;
      else if (row.kind === "del") dels++;
      last = Math.max(last, row.old ?? 0, row.new ?? 0);
      olds ||= row.old !== null; news ||= row.new !== null;
      const text = expandTabs(row.text);
      if (row.kind !== "hunk") widest = Math.max(widest, text.length);
      return { kind: row.kind, old: row.old, new: row.new, text };
    });
    this.adds = adds; this.dels = dels; this.widest = widest;
    this.digits = String(last).length;
    // A side with no lines at all (a new file's old side, a deleted file's new side)
    // gets no number column.
    this.sides = (olds ? 1 : 0) + (news ? 1 : 0);
    this.olds = olds; this.news = news;
    this.left = Math.min(this.left, this.maxLeft());
  }

  // ---- scrolling

  gutter() { return this.digits * CHAR + 14; }
  // Columns of text that fit beside the two number columns and the sign.
  columns() { return Math.max(20, Math.floor((this.width - this.sides * this.gutter() - 30) / CHAR)); }
  maxLeft() { return Math.max(0, this.widest - this.columns() + 4); }

  slide(columns) {
    const next = Math.max(0, Math.min(this.left + columns, this.maxLeft()));
    if (next === this.left) return false;
    this.left = next;
    return true;
  }

  act(name) {
    const n = this.rows.length, page = Math.max(1, this.list.fit - 1);
    if (name === "up") return this.list.scrollBy(-1, n);
    if (name === "down") return this.list.scrollBy(1, n);
    if (name === "page-up") return this.list.scrollBy(-page, n);
    if (name === "page-down") return this.list.scrollBy(page, n);
    if (name === "top") return this.list.scrollTo(0, n);
    if (name === "end") return this.list.scrollTo(n, n);
    if (name === "left") return this.slide(-STEP);
    if (name === "right") return this.slide(STEP);
    return false;
  }

  command(name, cx) {
    if (name === "refresh") this.load(cx);
    else if (name === "focus") this.handle.focus();
    else if (name.startsWith("diff-")) this.act(name.slice(5));
  }

  // A git write somewhere else (a commit, a rollback) changes what a working file's diff
  // is. A commit's own diff never changes.
  event(e, cx) {
    if (e.type === "changed" && !this.commit && (!e.root || e.root === this.root)) this.load(cx);
  }

  // ---- drawing

  renderRow(i, t, look) {
    const r = this.rows[i];
    if (r.kind === "hunk") {
      return h_flex().h(LINE).w_full().flex_none().items_center().px(10).bg(t.raised).text_color(t.dim)
        .child(div().min_w(0).whitespace_nowrap().overflow_hidden().child(r.text));
    }
    const number = (n) => div().w(look.gutter).flex_none().pr(6).text_right().text_color(t.dim).child(n === null ? "" : String(n));
    // Only the columns in view are handed over: a 100,000-character line costs the same
    // as a short one, and sideways scrolling is a different slice.
    const text = this.left ? r.text.slice(this.left, this.left + look.columns + 8) : r.text.slice(0, look.columns + 8);
    return h_flex().h(LINE).w_full().flex_none().items_center()
      .when(r.kind === "add", (el) => el.bg(look.addBg))
      .when(r.kind === "del", (el) => el.bg(look.delBg))
      .when(this.olds, (el) => el.child(number(r.old)))
      .when(this.news, (el) => el.child(number(r.new)))
      .child(div().w(18).flex_none().pl(6).text_color(r.kind === "add" ? t.ansi2 : r.kind === "del" ? t.ansi1 : t.dim)
        .child(r.kind === "add" ? "+" : r.kind === "del" ? "-" : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().overflow_hidden()
        .text_color(r.kind === "note" ? t.dim : t.foreground)
        .child(r.kind === "note" ? `\\ ${r.text}` : text));
  }

  compared() {
    const r = this.result;
    if (!r || (!r.from && !r.to)) return this.commit ? String(this.commit).slice(0, 7) : "";
    // A working file is compared with the working tree (git-diff.js's "Working Tree").
    const to = this.commit ? r.to : this.t("dialogs.diff.workingTree");
    return r.from ? `${r.from} → ${to}` : to;
  }

  render(cx) {
    this.drawn = true;
    // Nothing may start inside render: the read a hidden tab skipped starts in a timer.
    if (this.stale && !this.waking) {
      this.waking = true;
      cx.timer.after(0, (cx) => { this.waking = false; this.wake(cx); });
    }
    const t = theme(), r = this.result;
    const renamed = Boolean(this.commit && this.oldPath && this.oldPath !== this.path);
    const parts = this.path.split("/"), name = parts.pop(), folder = parts.join("/");
    const look = { gutter: this.gutter(), columns: this.columns(), addBg: tint(t.ansi2, "24"), delBg: tint(t.ansi1, "24") };
    const body = !r ? notice(this.t("ui.loading"), t, { busy: true })
      : !r.ok ? notice(this.t("dialogs.diff.cantShow"), t)
      : r.binary ? notice(this.t("dialogs.diff.binary"), t)
      : !this.rows.length ? notice(this.t(renamed ? "dialogs.diff.renamedOnly" : r.from ? "dialogs.diff.identical" : "dialogs.diff.empty"), t)
      // Only the lines are in the terminal's font; notices stay in the interface's.
      : div().size_full().min_h(0).font_family(settings().font_family ?? "JetBrains Mono").text_size(SIZE)
        .child(this.list.render(this.rows.length, (i) => this.renderRow(i, t, look), t));
    const cut = r?.ok && r.truncated
      ? (this.rows.length >= MAX_ROWS ? this.t("dialogs.diff.cutLines", { n: count(MAX_ROWS) }) : this.t("dialogs.diff.cutChars", { n: count(MAX_CHARS) }))
      : null;
    const error = this.error ? sentence(this.t, this.error.msg, this.error.err) : "";
    return v_flex().id("diff-tab").size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        const name = { up: "up", down: "down", pageup: "page-up", pagedown: "page-down", home: "top", end: "end", left: "left", right: "right", space: "page-down", "shift-space": "page-up" }[e.keystroke];
        if (!name) return;
        cx.stop_propagation();
        if (this.act(name)) cx.notify();
      })
      .child(h_flex().h(34).flex_none().w_full().min_w(0).px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(fileGlyph(this.path, { dark: darkLook() }))
        .child(div().flex_none().max_w(360).truncate().font_semibold().child(name))
        .when(Boolean(folder), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(folder)))
        .when(renamed, (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.t("dialogs.diff.renamedFrom", { from: this.oldPath }))))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(this.compared()))
        .child(spacer())
        .when(Boolean(r?.ok && this.adds), (el) => el.child(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${count(this.adds)}`)))
        .when(Boolean(r?.ok && this.dels), (el) => el.child(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${count(this.dels)}`)))
        .child(iconButton("diff-refresh", "refresh", t, { title: this.t("dialogs.diff.refresh"), busy: Boolean(this.loading && r), onClick: (_e, cx) => { this.load(cx); cx.notify(); } })))
      .when(Boolean(cut), (el) => el.child(div().flex_none().w_full().px(10).py(5).border_b(1).border_color(t.border).bg(t.raised).text_size(12).text_color(t.ansi3).child(cut ?? "")))
      .child(div().id("diff-body").flex_1().min_h(0).min_w(0).overflow_hidden()
        .on_size_change((size, cx) => {
          if (size.width === this.width) return;
          this.width = size.width;
          this.left = Math.min(this.left, this.maxLeft());
          cx.notify();
        })
        // Up and down is the list's own; this takes what a touchpad or shift-wheel sends
        // sideways, and only when the gesture is mostly sideways.
        .on_scroll_wheel((e, cx) => {
          if (Math.abs(e.delta.x) <= Math.abs(e.delta.y)) return;
          this.sideways -= e.delta.x;
          const steps = Math.trunc(this.sideways / CHAR);
          if (!steps) return;
          this.sideways -= steps * CHAR;
          if (this.slide(steps)) cx.notify();
        })
        .child(body))
      .when(Boolean(this.error), (el) => el.child(errorStrip("diff-error", error, t, r?.ok ? (_e, cx) => { this.error = null; cx.notify(); } : null)));
  }
}
