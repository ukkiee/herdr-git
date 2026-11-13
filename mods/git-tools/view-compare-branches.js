// Branch compare tab (view "compare-branches"): Compare with '<current>' on a branch.
// Two commit lists, one above the other: the commits the branch has and the current
// branch hasn't, then the other way. Right of them the picked commit's files and
// message; a double click on a file opens its Diff tab. One per space (space-tabs.js).
//
// props: { root, on, a, b, aName, bName }: a and b are what git compares (full ref
// names), aName and bName how they are shown. Saved with the tab: plain JSON.

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
import { openWorkingTreeCompare } from "./view-compare-files.js";
import { branchCommits } from "./git-compare.js";
import { en, ko } from "./messages-compare.js";

const SHORT = 7;
const short = (hash) => String(hash ?? "").slice(0, SHORT);
const ROW_H = 24;
const INDENT = 14;
const KIND = [en["compare.branchesTab"], ko["compare.branchesTab"]];

// t: the opener's t (its language names the tab).
export function openBranchCompare(t, { root, on = null, a, b, aName, bName }) {
  openSpaceTab({ view: "compare-branches", props: { root, on, a, b, aName, bName }, name: t("compare.branchesTab", { a: aName, b: bName }), kind: KIND });
}

// ---- the Branch tree's items, run by the Log panel (view-log.js ACTIONS)

// The current branch as the Branch tree read it: its name, or a short hash on a
// detached HEAD.
function currentOf(host) {
  const head = host.branches?.data?.head;
  if (head?.branch) return { ref: `refs/heads/${head.branch}`, name: head.branch };
  return { ref: "HEAD", name: head?.hash ? short(head.hash) : "HEAD" };
}

// Compare with '<current>' (a branch row) and Compare with Current (the toolbar, on the
// cursor's branch). b: log-branches.js target.
export function compareWithCurrent(host, b) {
  if (!host.repo || !b?.from) return;
  const current = currentOf(host);
  openBranchCompare(host.t, { root: host.repo.root, on: host.repo.on, a: b.from, b: current.ref, aName: b.name, bName: current.name });
}

// Show Diff with Working Tree (a branch row).
export function diffWithWorkingTree(host, b) {
  if (!host.repo || !b?.from) return;
  openWorkingTreeCompare(host.t, { root: host.repo.root, on: host.repo.on, ref: b.from, refName: b.name, current: currentOf(host).name });
}

export default class CompareBranches {
  init(p, cx) {
    this.repo = p.root ? { root: p.root, on: p.on ?? null } : null;
    this.a = p.a ?? null; this.b = p.b ?? null;
    this.aName = p.aName ?? this.a; this.bName = p.bName ?? this.b;
    this.lists = null; // { onlyA, onlyB }
    this.error = null;
    this.picked = null; // { side, hash }
    this.info = null; this.files = []; this.cursor = null;
    this.turn = 0;
    this.listA = new WindowedList("compare-only-a", { rowHeight: ROW_H });
    this.listB = new WindowedList("compare-only-b", { rowHeight: ROW_H });
    this.fileList = new WindowedList("compare-commit-files");
    this.load(cx);
  }

  git() { return makeGit(exec, this.repo?.on ?? null); }

  load(cx) {
    if (!this.repo || !this.a || !this.b) { this.lists = { onlyA: [], onlyB: [] }; this.error = this.t("dialogs.diff.noFileTab"); return; }
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await branchCommits(this.git(), this.repo.root, { a: this.a, b: this.b });
        if (r.ok) { this.lists = { onlyA: r.onlyA, onlyB: r.onlyB }; this.error = null; }
        else { this.lists ??= { onlyA: [], onlyB: [] }; this.error = r.err || this.t("ui.gitFailed"); }
      } catch (error) {
        this.lists ??= { onlyA: [], onlyB: [] }; this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Branches move with a commit, a fetch or a checkout elsewhere.
  event(e, cx) {
    if (e.type === "changed" && (!e.root || e.root === this.repo?.root)) this.load(cx);
  }

  pick(side, hash, cx) {
    this.picked = { side, hash };
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

  commitRow(side, c, i, t) {
    const picked = this.picked?.side === side && this.picked.hash === c.hash;
    return row(`compare-${side}-${i}`, t, { selected: picked, height: ROW_H }).px(10).gap(8)
      .on_click((_e, cx) => this.pick(side, c.hash, cx))
      .tooltip(c.subject)
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .child(div().flex_none().max_w(140).truncate().text_size(12).text_color(t.dim).child(c.author))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(formatDateTime(c.time, this.lang)));
  }

  half(side, commits, list, a, b, t) {
    const body = !commits.length ? notice(this.t("compare.noCommits"), t) : list.render(commits.length, (i) => this.commitRow(side, commits[i], i, t), t);
    return v_flex().flex_1().min_h(0).w_full()
      .child(h_flex().flex_none().h(28).px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
        .child(div().flex_none().text_color(t.ansi3).child("⚠"))
        .child(div().min_w(0).truncate().child(this.t("compare.onlyIn", { a, b }))))
      .child(div().flex_1().min_h(0).w_full().child(body));
  }

  fileRow(i, t, dark) {
    const m = this.files[i];
    const el = row(`compare-commit-file-${i}`, t, { selected: this.cursor === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
      .on_click((e, cx) => { this.cursor = m.key; if (e.click_count === 2) this.openFile(m); cx.notify(); });
    if (m.folder) return el.child(div().size(ICON).flex_none()).child(folderGlyph(m.name, { open: true, size: 13 })).child(div().flex_1().min_w(0).truncate().child(m.name));
    const color = { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted }[m.item.status] ?? t.foreground;
    return el.tooltip(m.path).child(div().size(ICON).flex_none()).child(fileGlyph(m.path, { dark, size: 13 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(m.name));
  }

  details(t) {
    const dark = darkLook(t.background), info = this.info;
    const body = !this.picked ? notice(this.t("compare.selectCommit"), t)
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
    const t = theme(), lists = this.lists;
    const bar = toolbar(t)
      .child(div().pl(4).min_w(0).truncate().text_color(t.dim).child(this.t("compare.branchesTab", { a: this.aName, b: this.bName })))
      .child(spacer())
      .child(iconButton("compare-branches-refresh", "refresh", t, { title: this.t("compare.refresh"), busy: Boolean(this.loading && lists), onClick: (_e, cx) => { this.load(cx); cx.notify(); } }));
    const body = !lists ? notice(this.t("ui.loading"), t, { busy: true })
      : h_flex().flex_1().min_h(0).w_full()
        .child(v_flex().flex_1().min_w(0).h_full()
          .child(this.half("a", lists.onlyA, this.listA, this.aName, this.bName, t))
          .child(div().flex_none().h(1).w_full().bg(t.border))
          .child(this.half("b", lists.onlyB, this.listB, this.bName, this.aName, t)))
        .child(this.details(t));
    return panelFrame("compare-branches-tab", t)
      .child(bar)
      .child(body)
      .when(Boolean(this.error), (el) => el.child(errorStrip("compare-branches-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}
