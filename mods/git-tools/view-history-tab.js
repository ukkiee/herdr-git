// History tab (view "history"): Show History up to Here, from Commit details' toolbar and a
// file's menu there. The commits up to one (of one file, followed over renames, when a
// file is given), newest first, read a page at a time. Right of them the picked commit's
// files and message; a double click on a file opens its Diff tab. One per space
// (space-tabs.js).
//
// props: { root, on, rev, path }: rev the commit's full hash, path a repository path or
// null. Saved with the tab: plain JSON.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { ICON, fileGlyph, folderGlyph, darkLook, row, toolbar, spacer, iconButton, notice, errorStrip, WindowedList, panelFrame } from "./ui.js";
import { makeGit } from "./git.js";
import { readCommit } from "./git-show.js";
import { buildRows } from "./tree.js";
import { formatDateTime } from "./i18n.js";
import { openDiff } from "./view-diff.js";
import { openSpaceTab } from "./space-tabs.js";
import { historyUpTo } from "./git-revision.js";
import { en, ko } from "./messages-revision.js";

const SHORT = 7;
const short = (hash) => String(hash ?? "").slice(0, SHORT);
const ROW_H = 24;
const INDENT = 14;
const PAGE = 1000;
const KIND = [en["revision.historyTab"], ko["revision.historyTab"], en["revision.fileHistoryTab"], ko["revision.fileHistoryTab"]];

// t: the opener's t (its language names the tab).
export function openHistory(t, { root, on = null, rev, path = null }) {
  const name = path ? t("revision.fileHistoryTab", { name: path.split("/").pop(), rev: short(rev) }) : t("revision.historyTab", { rev: short(rev) });
  openSpaceTab({ view: "history", props: { root, on, rev, path }, name, kind: KIND });
}

// ---- Commit details' items, run by the Log panel (view-log.js ACTIONS)

// The commit a Commit details file row belongs to: its own when several commits are
// picked, else the one shown.
const commitOf = (host, m) => m?.item?.commit ?? host.details?.info?.hash ?? null;

// A file row: that file's history up to its commit. The toolbar's item gets the cursor's
// row: a file's, or the commit's whole history when no file is on it.
export function historyUpToHere(host, m) {
  const rev = commitOf(host, m);
  if (!host.repo || !rev) return;
  const path = m && !m.folder ? m.path : null;
  openHistory(host.t, { root: host.repo.root, on: host.repo.on, rev, path });
}

export default class HistoryTab {
  init(p, cx) {
    this.repo = p.root ? { root: p.root, on: p.on ?? null } : null;
    this.rev = p.rev ?? null; this.path = p.path ?? null;
    this.commits = null; this.more = false; this.loading = false;
    this.error = null;
    this.picked = null; this.info = null; this.files = []; this.cursor = null;
    this.turn = 0; this.page = 0;
    this.list = new WindowedList("history-commits", { rowHeight: ROW_H });
    this.fileList = new WindowedList("history-commit-files");
    this.load(cx, false);
  }

  git() { return makeGit(exec, this.repo?.on ?? null); }

  // more: the next page after what is shown; else from the start.
  load(cx, more) {
    if (!this.repo || !this.rev) { this.commits = []; this.error = this.t("ui.gitFailed"); return; }
    if (this.loading) return;
    this.loading = true;
    const page = more ? this.page : ++this.page, skip = more ? this.commits?.length ?? 0 : 0;
    cx.spawn(async (cx) => {
      try {
        const r = await historyUpTo(this.git(), this.repo.root, { rev: this.rev, path: this.path, skip, max: PAGE });
        if (page !== this.page) return;
        if (r.ok) { this.commits = more ? [...(this.commits ?? []), ...r.commits] : r.commits; this.more = r.more; this.error = null; }
        else { this.commits ??= []; this.error = r.err || this.t("ui.gitFailed"); }
      } catch (error) {
        this.commits ??= []; this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  pick(hash, cx) {
    this.picked = hash;
    const turn = ++this.turn;
    this.info = null; this.files = []; this.cursor = null;
    cx.spawn(async (cx) => {
      const r = await readCommit(this.git(), this.repo.root, hash);
      if (turn !== this.turn) return;
      this.info = r;
      this.files = r.ok ? buildRows(r.files, { grouped: true, compact: true }) : [];
      cx.notify();
    });
    cx.notify();
  }

  openFile(m) {
    if (!m || m.folder || !this.info?.ok) return;
    openDiff({ root: this.repo.root, on: this.repo.on, path: m.path, commit: this.info.hash, status: m.item.status, oldPath: m.item.from ?? null });
  }

  // ---- drawing

  commitRow(i, t) {
    const n = this.commits.length;
    if (i === n) {
      return row("history-more", t, { height: ROW_H }).px(10).justify_center().text_color(t.accent)
        .on_click((_e, cx) => { this.load(cx, true); cx.notify(); })
        .child(this.loading ? this.t("ui.loading") : this.t("revision.more"));
    }
    const c = this.commits[i];
    return row(`history-${i}`, t, { selected: this.picked === c.hash, height: ROW_H }).px(10).gap(8)
      .on_click((_e, cx) => this.pick(c.hash, cx))
      .tooltip(c.subject)
      .child(div().flex_none().text_size(12).text_color(t.dim).child(short(c.hash)))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .child(div().flex_none().max_w(140).truncate().text_size(12).text_color(t.dim).child(c.author))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(formatDateTime(c.time, this.lang)));
  }

  fileRow(i, t, dark) {
    const m = this.files[i];
    const el = row(`history-file-${i}`, t, { selected: this.cursor === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
      .on_click((e, cx) => { this.cursor = m.key; if (e.click_count === 2) this.openFile(m); cx.notify(); });
    if (m.folder) return el.child(div().size(ICON).flex_none()).child(folderGlyph(m.name, { open: true, size: 13 })).child(div().flex_1().min_w(0).truncate().child(m.name));
    const color = { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted }[m.item.status] ?? t.foreground;
    return el.tooltip(m.path).child(div().size(ICON).flex_none()).child(fileGlyph(m.path, { dark, size: 13 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(m.name));
  }

  details(t) {
    const dark = darkLook(t.background), info = this.info;
    const body = !this.picked ? notice(this.t("revision.selectCommit"), t)
      : !info ? notice(this.t("ui.loading"), t, { busy: true })
      : !info.ok ? notice(info.err || this.t("ui.gitFailed"), t)
      : v_flex().size_full().min_h(0)
        .child(div().flex_1().min_h(0).w_full().child(this.fileList.render(this.files.length, (i) => this.fileRow(i, t, dark), t)))
        .child(v_flex().flex_none().max_h(200).w_full().px(10).py(8).gap(4).border_t(1).border_color(t.border).overflow_hidden()
          .child(div().w_full().font_semibold().child(info.message.split("\n")[0] ?? ""))
          .child(div().w_full().text_size(12).text_color(t.dim).child(`${short(info.hash)} · ${formatDateTime(info.authorTime, this.lang)} · ${info.author} <${info.email}>`)));
    return div().flex_none().w(340).h_full().min_h(0).border_l(1).border_color(t.border).child(body);
  }

  render() {
    const t = theme(), commits = this.commits;
    const title = this.path ? this.t("revision.fileHistoryTab", { name: this.path, rev: short(this.rev) }) : this.t("revision.historyTab", { rev: short(this.rev) });
    const bar = toolbar(t)
      .child(div().pl(4).min_w(0).truncate().text_color(t.dim).child(title))
      .child(spacer())
      .child(iconButton("history-refresh", "refresh", t, { title: this.t("compare.refresh"), busy: Boolean(this.loading && commits), onClick: (_e, cx) => { this.load(cx, false); cx.notify(); } }));
    const n = commits?.length ?? 0;
    const body = !commits ? notice(this.t("ui.loading"), t, { busy: true })
      : h_flex().flex_1().min_h(0).w_full()
        .child(div().flex_1().min_w(0).h_full().child(!n ? notice(this.t("revision.empty"), t)
          : this.list.render(n + (this.more ? 1 : 0), (i) => this.commitRow(i, t), t)))
        .child(this.details(t));
    return panelFrame("history-tab", t)
      .child(bar)
      .child(body)
      .when(Boolean(this.error), (el) => el.child(errorStrip("history-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}
