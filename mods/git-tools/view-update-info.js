// Update Info tab (view "update-info"): what an update brought in, as the Log shows
// commits. On top "N files updated in M commits"; the commits newest first, read a page
// at a time; right of them the picked commit's files and message, a double click on a
// file opens its Diff tab. One per space (space-tabs.js): a new update replaces it.
// The commits are git-remote.js readUpdate's: `to` has them and `from` hasn't, without
// the ones a rebase replayed.
//
// props: { root, on, from, to } (full hashes). Saved with the tab: plain JSON.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { tip, ICON, fileGlyph, folderGlyph, darkLook, row, toolbar, spacer, iconButton, notice, skeleton, skeletonSize, errorStrip, WindowedList, panelFrame } from "./ui.js";
import { makeGit } from "./git.js";
import { readTurns, pageAt } from "./read-turns.js";
import { readCommit } from "./git-show.js";
import { readUpdate } from "./git-remote.js";
import { buildRows } from "./tree.js";
import { formatDateTime } from "./i18n.js";
import { openDiff } from "./view-diff.js";
import { openSpaceTab } from "./space-tabs.js";
import { en, ko } from "./messages-remote.js";

const SHORT = 7;
const short = (hash) => String(hash ?? "").slice(0, SHORT);
const ROW_H = 24;
const INDENT = 14;
// The rows while they are read (ui.js skeleton), as commitRow and fileRow lay them out.
const SKELETON_COMMITS = { indent: [10, 0], gap: 8, padRight: 10, cols: [{ fit: 52 }, { grow: true }, { fit: 72 }, { fit: 96 }] };
const SKELETON_FILES = { indent: [6, INDENT], gap: 5, padRight: 10, depth: [0, 1, 1, 0, 1, 1, 1], lead: ["slot", "file"] };
const PAGE = 1000;
const FIRST_LOOK = 6000; // ms: the first read still unanswered then is made again once
const KIND = [en["remote.infoTab"], ko["remote.infoTab"]];

// openUpdateInfo(t, { root, on, from, to }): t is the opener's (its language names the tab).
export function openUpdateInfo(t, { root, on = null, from, to }) {
  if (!root || !from || !to) return;
  openSpaceTab({ view: "update-info", props: { root, on, from, to }, name: t("remote.infoTab"), kind: KIND });
}

export default class UpdateInfoTab {
  init(p, cx) {
    this.repo = p.root ? { root: p.root, on: p.on ?? null } : null;
    this.from = p.from ?? null; this.to = p.to ?? null;
    this.commits = null; this.more = false; this.files = 0;
    this.reads = readTurns();
    this.error = null;
    this.picked = null; this.info = null; this.rows = []; this.cursor = null;
    this.turn = 0; this.page = 0;
    this.list = new WindowedList("update-info-commits", { rowHeight: ROW_H });
    this.fileList = new WindowedList("update-info-files");
    this.waits = { commits: skeletonSize("update-info-commits-wait"), files: skeletonSize("update-info-files-wait") };
    this.load(cx, false);
    // A tab opened in place of the one before (space-tabs.js) has been seen to get no answer
    // to its first read: once, a little later, it reads again beside it.
    cx.timer.after(FIRST_LOOK, (cx) => { if (this.commits === null) this.load(cx, false); });
  }

  git() { return makeGit(exec, this.repo?.on ?? null, { wait: this.wait }); }

  // more: the next page after what is shown; else from the start. From the start (Refresh)
  // always reads, also while a read is going: an answer that never comes must not keep
  // the tab on "Loading…" (read-turns.js). The next page waits for the read going.
  load(cx, more) {
    if (!this.repo || !this.from || !this.to) { this.commits = []; this.error = this.t("ui.gitFailed"); return; }
    if (more && this.reads.busy()) return;
    const turn = this.reads.start();
    const page = more ? this.page : ++this.page, skip = more ? this.commits?.length ?? 0 : 0;
    cx.spawn(async (cx) => {
      try {
        const r = await readUpdate(this.git(), this.repo.root, { from: this.from, to: this.to, skip, max: PAGE });
        if (page !== this.page || !this.reads.use(turn)) return;
        if (!r.ok) { this.commits ??= []; this.error = r.err || this.t("ui.gitFailed"); return; }
        // A next page placed already (asked twice) is left out.
        const commits = more ? pageAt(this.commits, skip, r.commits) : r.commits;
        if (commits) { this.commits = commits; this.more = r.more; this.files = r.files; this.error = null; }
      } catch (error) {
        if (page === this.page) { this.commits ??= []; this.error = String(error?.message ?? error); }
      } finally {
        this.reads.end(turn);
        cx.notify();
      }
    });
  }

  pick(hash, cx) {
    this.picked = hash;
    const turn = ++this.turn;
    this.info = null; this.rows = []; this.cursor = null;
    cx.spawn(async (cx) => {
      const r = await readCommit(this.git(), this.repo.root, hash);
      if (turn !== this.turn) return;
      this.info = r;
      this.rows = r.ok ? buildRows(r.files, { grouped: true, compact: true }) : [];
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
    if (i === this.commits.length) {
      return row("update-info-more", t, { height: ROW_H }).px(10).justify_center().text_color(t.accent)
        .on_click((_e, cx) => { this.load(cx, true); cx.notify(); })
        .child(this.reads.busy() ? this.t("ui.loading") : this.t("revision.more"));
    }
    const c = this.commits[i];
    return row(`update-info-${i}`, t, { selected: this.picked === c.hash, height: ROW_H }).px(10).gap(8)
      .on_click((_e, cx) => this.pick(c.hash, cx))
      .map((el) => tip(el, c.subject))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(short(c.hash)))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .child(div().flex_none().max_w(140).truncate().text_size(12).text_color(t.dim).child(c.author))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(formatDateTime(c.time, this.lang)));
  }

  fileRow(i, t, dark) {
    const m = this.rows[i];
    const el = row(`update-info-file-${i}`, t, { selected: this.cursor === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
      .on_click((e, cx) => { this.cursor = m.key; if (e.click_count === 2) this.openFile(m); cx.notify(); });
    if (m.folder) return el.child(div().size(ICON).flex_none()).child(folderGlyph(m.name, { open: true, size: 13 })).child(div().flex_1().min_w(0).truncate().child(m.name));
    const color = { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted }[m.item.status] ?? t.foreground;
    return tip(el, m.path).child(div().size(ICON).flex_none()).child(fileGlyph(m.path, { dark, size: 13 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(m.name));
  }

  details(t) {
    const dark = darkLook(t.background), info = this.info;
    const body = !this.picked ? notice(this.t("revision.selectCommit"), t)
      : !info ? skeleton(t, SKELETON_FILES, this.waits.files)
      : !info.ok ? notice(info.err || this.t("ui.gitFailed"), t)
      : v_flex().size_full().min_h(0)
        .child(div().flex_1().min_h(0).w_full().child(this.fileList.render(this.rows.length, (i) => this.fileRow(i, t, dark), t)))
        .child(v_flex().flex_none().max_h(200).w_full().px(10).py(8).gap(4).border_t(1).border_color(t.border).overflow_hidden()
          .child(div().w_full().font_semibold().child(info.message.split("\n")[0] ?? ""))
          .child(div().w_full().text_size(12).text_color(t.dim).child(`${short(info.hash)} · ${formatDateTime(info.authorTime, this.lang)} · ${info.author} <${info.email}>`)));
    return div().flex_none().w(340).h_full().min_h(0).border_l(1).border_color(t.border).child(body);
  }

  render() {
    const t = theme(), commits = this.commits, n = commits?.length ?? 0;
    const summary = commits ? this.t("remote.infoSummary", { files: this.files, commits: this.more ? `${n}+` : n }) : "";
    const bar = toolbar(t)
      .child(div().pl(4).min_w(0).truncate().text_color(t.dim).child(summary))
      .child(spacer())
      .child(iconButton("update-info-refresh", "refresh", t, { title: this.t("compare.refresh"), busy: Boolean(this.reads.busy() && commits), onClick: (_e, cx) => { this.load(cx, false); cx.notify(); } }));
    const body = h_flex().flex_1().min_h(0).w_full()
      .child(div().flex_1().min_w(0).h_full().child(!commits ? skeleton(t, SKELETON_COMMITS, this.waits.commits)
        : !n ? notice(this.t("remote.infoEmpty"), t)
        : this.list.render(n + (this.more ? 1 : 0), (i) => this.commitRow(i, t), t)))
      .child(this.details(t));
    return panelFrame("update-info-tab", t)
      .child(bar)
      .child(body)
      .when(Boolean(this.error), (el) => el.child(errorStrip("update-info-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}
