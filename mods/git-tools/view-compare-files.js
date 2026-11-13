// The file compare tabs and the file views they and Commit details open.
//
// Compare files tab (view "compare-files"), one per kind and space (space-tabs.js):
//   mode "working":  Show Diff with Working Tree on a branch: its files against the
//                    working tree, a header with Swap branches, Diff, Get from Branch,
//                    View Options.
//   mode "local":    Compare with Local on a commit: the same against the commit, with
//                    Refresh, Diff, Get, View Options.
//   mode "versions": Compare Versions on two commits: the files changed between them.
//   Colors: blue in both and different, gray only in the branch or commit, green only in
//   the working tree; Compare Versions uses the change colors of Commit details.
// File diff tab (view "compare-diff"): one file between two revisions, or a revision and
//   the working file (view-diff.js draws it).
// File view tab (view "compare-file"): one file read only, as a commit has it (Open
//   Repository Version) or as it is on disk (Edit Source: the platform has no editor a
//   mod can open a file in, so it is the Files panel's kind of preview).
//
// props are saved with the tab: plain JSON, read again after a restart. A working-tree
// list follows the working tree: read again on Refresh, after a git write another copy
// announced, and every POLL while it is drawn.

import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { exec, theme, settings, readTextFile } from "herdr";
import { tip, ROW, ICON, uiGlyph, fileGlyph, folderGlyph, darkLook, row, toolbar,spacer, iconButton, notice, errorStrip, openMenu, openTab, broadcast, takeWrite, releaseWrite, writeBlock, copyId, sentence, WindowedList, panelFrame } from "./ui.js";
import { makeGit } from "./git.js";
import { buildRows } from "./tree.js";
import DiffView, { openDiff } from "./view-diff.js";
import { openSpaceTab } from "./space-tabs.js";
import { workingTreeFiles, versionFiles, swapState, getFromRevision, fileParent, readFileDiff, readRevisionFile } from "./git-compare.js";
import { editorLanguage } from "./editor-language.js";
import { en, ko } from "./messages-compare.js";

const SHORT = 7;
const short = (hash) => String(hash ?? "").slice(0, SHORT);
const INDENT = 14;
const POLL = 10000;
// The scratch index of the Rollback snapshots this copy records before a Get (ui.js copyId).
const COPY_KEY = "compare.copy";
const PREVIEW_CHARS = 400000;
const GETTING = { key: "compare.getting" };

const KINDS = {
  working: [en["compare.workingTreeTab"], ko["compare.workingTreeTab"]],
  local: [en["compare.localTab"], ko["compare.localTab"]],
  versions: [en["compare.versionsTab"], ko["compare.versionsTab"]],
};

// ---- opening

// t: the opener's t (its language names the tab).
// ref: what git compares (a full ref name or a hash); refName: how it is shown;
// current: the current branch's name (or a short hash on a detached HEAD).
export function openWorkingTreeCompare(t, { root, on = null, ref, refName, current }) {
  openSpaceTab({ view: "compare-files", props: { mode: "working", root, on, ref, refName, current }, name: t("compare.workingTreeTab", { ref: refName }), kind: KINDS.working });
}

export function openLocalCompare(t, { root, on = null, rev }) {
  openSpaceTab({ view: "compare-files", props: { mode: "local", root, on, ref: rev, refName: short(rev) }, name: t("compare.localTab", { rev: short(rev) }), kind: KINDS.local });
}

// from, to: the older and the newer commit.
export function openVersionsCompare(t, { root, on = null, from, to }) {
  openSpaceTab({ view: "compare-files", props: { mode: "versions", root, on, from, to }, name: t("compare.versionsTab", { a: short(from), b: short(to) }), kind: KINDS.versions, unlike: [...KINDS.local, ...KINDS.working] });
}

// One file from revision `from` to revision `to` (null: the working file); reverse: the
// other way round. oldPath: its name in `from` when renamed since. A new tab each time,
// as Show Diff opens one.
export function openFileDiff({ root, on = null, path, from, to = null, oldPath = null, reverse = false }) {
  openTab("compare-diff", { root, on, path, from, commit: to, oldPath, reverse }, path.split("/").pop());
}

// rev: a commit (Open Repository Version) or null (the file on disk: Edit Source).
export function openFileView(t, { root, on = null, path, rev = null }) {
  const name = path.split("/").pop();
  openTab("compare-file", { root, on, path, rev }, rev ? t("compare.revisionFileTab", { name, rev: short(rev) }) : name);
}

// ---- the Log panel's items (view-log.js ACTIONS)

// Compare with Local on the commit picked. commits: newest first.
export function commitWithLocal(host, commits) {
  const c = commits?.[0];
  if (host.repo && c?.hash) openLocalCompare(host.t, { root: host.repo.root, on: host.repo.on, rev: c.hash });
}

// Compare Versions on the two commits picked, older to newer.
export function commitVersions(host, commits) {
  if (!host.repo || commits?.length !== 2) return;
  openVersionsCompare(host.t, { root: host.repo.root, on: host.repo.on, from: commits[1].hash, to: commits[0].hash });
}

// Commit details' file items: target is its file row.

// The commit a Commit details file row belongs to: its own when several commits are
// picked, else the one shown.
const commitOf = (host, m) => m?.item?.commit ?? host.details?.info?.hash ?? null;
const usable = (host, m) => Boolean(host.repo && m && !m.folder && commitOf(host, m));

// Compare with Local: the commit's file against the working file.
export function fileWithLocal(host, m) {
  if (!usable(host, m)) return;
  openFileDiff({ root: host.repo.root, on: host.repo.on, path: m.path, from: commitOf(host, m) });
}

// Compare Before with Local and Show Changes to Parents both start at the file's
// version in the commit's first parent; a commit without one has nothing before it.
function withParent(host, m, cx, then) {
  if (!usable(host, m)) return;
  const repo = host.repo;
  cx.spawn(async (cx) => {
    const p = await fileParent(repo.git, repo.root, { commit: commitOf(host, m), path: m.path, from: m.item.from ?? null });
    if (!p.ok) host.failedOn(repo, p.err, cx);
    else if (p.parent) then(repo, p);
    cx.notify();
  });
}

export function beforeWithLocal(host, m, cx) {
  withParent(host, m, cx, (repo, p) => openFileDiff({ root: repo.root, on: repo.on, path: m.path, from: p.parent, oldPath: p.path }));
}

// Show Changes to Parents: the parent commit's own change to the file.
export function changesToParents(host, m, cx) {
  withParent(host, m, cx, (repo, p) => openDiff({ root: repo.root, on: repo.on, path: p.path, commit: p.parent }));
}

export function editSource(host, m) {
  if (!host.repo || !m || m.folder) return;
  openFileView(host.t, { root: host.repo.root, on: host.repo.on, path: m.path });
}

export function repositoryVersion(host, m) {
  if (!usable(host, m)) return;
  openFileView(host.t, { root: host.repo.root, on: host.repo.on, path: m.path, rev: commitOf(host, m) });
}

// Get from Revision: the file as the commit has it, under the panel's write lock.
export function getFromCommit(host, m, cx) {
  if (!usable(host, m) || !host.setBusy(GETTING, cx)) return;
  const repo = host.repo, rev = commitOf(host, m);
  cx.spawn(async (cx) => {
    let r;
    try { r = await getFromRevision(repo.git, repo.root, { rev, paths: [m.path], copy: copyId(COPY_KEY) }); }
    catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
    host.setBusy(null, cx);
    if (!r.ok) host.failedOn(repo, sentence(host.t, r.msg, r.err) || host.t("ui.gitFailed"), cx);
    // A snapshot alone changes what Restore lists.
    if (r.ok || r.snapshot) broadcast({ type: "changed", root: repo.root });
    cx.notify();
  });
}

// ---- the compare files tab

function stateColor(state, t) {
  return { changed: t.ansi4, "only-ref": t.muted, "only-local": t.ansi2 }[state] ?? t.foreground;
}
function statusColor(status, t) {
  return { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted }[status] ?? t.foreground;
}

export default class CompareFiles {
  init(p, cx) {
    this.mode = ["working", "local", "versions"].includes(p.mode) ? p.mode : "local";
    this.repo = p.root ? { root: p.root, on: p.on ?? null } : null;
    this.ref = p.ref ?? null; this.refName = p.refName ?? short(p.ref); this.current = p.current ?? "HEAD";
    this.from = p.from ?? null; this.to = p.to ?? null;
    this.files = null; this.rows = [];
    this.grouped = true; this.swapped = false;
    this.collapsed = new Set(); this.cursor = null;
    this.error = null;
    this.busy = null; this.held = null;
    this.list = new WindowedList("compare-files");
    this.handle = cx.focus_handle();
    this.drawn = false;
    this.load(cx);
    // A commit pair never changes; the working tree does.
    if (this.mode !== "versions") cx.timer.every(POLL, (cx) => { if (this.drawn) { this.drawn = false; this.load(cx); } });
  }

  git() { return makeGit(exec, this.repo?.on ?? null); }

  load(cx) {
    if (!this.repo) { this.files = []; this.error = this.t("dialogs.diff.noFileTab"); return; }
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    const { root } = this.repo;
    cx.spawn(async (cx) => {
      try {
        const r = this.mode === "versions" ? await versionFiles(this.git(), root, this.from, this.to) : await workingTreeFiles(this.git(), root, this.ref);
        if (r.ok) { this.files = r.files; this.error = null; this.build(); }
        else { this.files ??= []; this.error = r.err || this.t("ui.gitFailed"); }
      } catch (error) {
        this.files ??= []; this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        if (this.again) this.load(cx);
        cx.notify();
      }
    });
  }

  build() {
    const items = (this.files ?? []).map((f) => ({ ...f, shown: this.swapped && f.state ? swapState(f.state) : f.state }));
    this.rows = buildRows(items, { grouped: this.grouped, compact: true, collapsed: this.collapsed });
    if (this.cursor && !this.rows.some((r) => r.key === this.cursor)) this.cursor = null;
  }

  event(e, cx) {
    if (e.type === "changed" && this.mode !== "versions" && (!e.root || e.root === this.repo?.root)) this.load(cx);
  }

  close() { this.closed = true; }

  at(key) { return key ? this.rows.findIndex((r) => r.key === key) : -1; }
  cursorRow() { return this.rows[this.at(this.cursor)] ?? null; }

  // ---- what the buttons do

  showDiff(m) {
    if (!m || m.folder || !this.repo) return;
    const { root, on } = this.repo;
    if (this.mode === "versions") openFileDiff({ root, on, path: m.path, from: this.from, to: this.to, oldPath: m.item.from ?? null });
    else openFileDiff({ root, on, path: m.path, from: this.ref, reverse: this.swapped });
  }

  // Get from Branch / Get: the cursor's file, or every file under the cursor's folder.
  get(cx) {
    const m = this.cursorRow();
    if (!m || !this.repo || this.mode === "versions") return;
    const repo = this.repo, paths = m.folder ? m.paths : [m.path];
    if (!takeWrite(this, repo, GETTING)) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await getFromRevision(this.git(), repo.root, { rev: this.ref, paths, copy: copyId(COPY_KEY) }); }
      catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      releaseWrite(this);
      this.error = r.ok ? null : sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      if (r.ok || r.snapshot) broadcast({ type: "changed", root: repo.root });
      this.load(cx);
      cx.notify();
    });
  }

  swap(cx) { this.swapped = !this.swapped; this.build(); cx.notify(); }

  options(e, cx) {
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.bus, [{ label: this.t("compare.groupByDirectory"), value: "group", hint: this.grouped ? "✓" : "" }], { width: 240, at: e?.position, lang: this.lang });
      if (picked === "group") { this.grouped = !this.grouped; this.build(); }
      cx.notify();
    });
  }

  setFold(m, folded, cx) {
    if (folded) this.collapsed.add(m.key); else this.collapsed.delete(m.key);
    this.build();
    cx.notify();
  }

  move(by, cx) {
    const n = this.rows.length;
    if (!n) return;
    const now = this.at(this.cursor);
    const next = now < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, now + by));
    this.cursor = this.rows[next].key;
    this.list.reveal(next, n);
    cx.notify();
  }

  activate(m, cx) {
    if (!m) return;
    this.cursor = m.key;
    if (m.folder) this.setFold(m, m.open, cx);
    else this.showDiff(m);
    cx.notify();
  }

  // ---- drawing

  fileRow(i, t, dark) {
    const m = this.rows[i];
    const el = row(`compare-file-${i}`, t, { selected: this.cursor === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
      .on_click((e, cx) => {
        this.handle.focus();
        this.cursor = m.key;
        if (e.click_count === 2) this.activate(m, cx);
        cx.notify();
      });
    if (m.folder) {
      return el
        .child(div().id(`compare-fold-${i}`).size(ICON).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.cursor = m.key; this.setFold(m, m.open, cx); })
          .child(uiGlyph(m.open ? "chevron-down" : "chevron-right")))
        .child(folderGlyph(m.name, { open: m.open, size: 13 }))
        .child(div().flex_1().min_w(0).truncate().child(m.name));
    }
    const { shown, status } = m.item;
    const color = shown ? stateColor(shown, t) : statusColor(status, t);
    const said = shown === "only-ref" ? this.t("compare.onlyRef", { ref: this.swapped ? this.current : this.refName })
      : shown === "only-local" ? this.t("compare.onlyLocal") : m.path;
    return tip(el, said)
      .child(div().size(ICON).flex_none())
      .child(fileGlyph(m.path, { dark, size: 13 }))
      .child(div().flex_none().max_w("60%").truncate().text_color(color).when(status === "deleted", (el) => el.line_through()).child(m.name))
      .when(Boolean(m.dir) && !this.grouped, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(m.dir)));
  }

  render() {
    this.drawn = true;
    const t = theme(), dark = darkLook(t.background), m = this.cursorRow();
    const writing = writeBlock(this, this.repo);
    const getName = this.mode === "working" ? "compare.getFromBranch" : "compare.get";
    let bar = toolbar(t);
    if (this.mode === "local") bar = bar.child(iconButton("compare-refresh", "refresh", t, { title: this.t("compare.refresh"), busy: Boolean(this.loading && this.files), onClick: (_e, cx) => { this.load(cx); cx.notify(); } }));
    bar = bar.child(iconButton("compare-diff", "show-diff", t, { title: this.t("compare.showDiff"), disabled: !m || m.folder, onClick: () => this.showDiff(this.cursorRow()) }));
    if (this.mode !== "versions") {
      bar = bar.child(iconButton("compare-get", "update", t, { title: writing ?? this.t(getName), disabled: !m || Boolean(writing), busy: Boolean(this.busy), onClick: (_e, cx) => this.get(cx) }));
    }
    bar = bar.child(iconButton("compare-options", "eye", t, { title: this.t("compare.viewOptions"), onClick: (e, cx) => this.options(e, cx) })).child(spacer());
    const head = this.mode === "working"
      ? h_flex().flex_none().w_full().min_w(0).px(10).py(5).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().min_w(0).truncate().text_color(t.dim).child(this.t("compare.workingTreeHead", { ref: this.refName, current: this.current })))
        .child(div().id("compare-swap").flex_none().text_color(t.accent).cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => this.swap(cx)).child(this.t("compare.swapBranches")))
      : null;
    const body = !this.files ? notice(this.t("ui.loading"), t, { busy: true })
      : !this.rows.length ? notice(this.t("compare.noDifferences"), t)
      : this.list.render(this.rows.length, (i) => this.fileRow(i, t, dark), t);
    return panelFrame("compare-files-tab", t)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "up" || k === "down") { cx.stop_propagation(); this.move(k === "up" ? -1 : 1, cx); }
        else if (k === "enter") { cx.stop_propagation(); this.activate(this.cursorRow(), cx); }
      })
      .when(Boolean(head), (el) => el.child(head))
      .child(bar)
      .child(div().flex_1().min_h(0).w_full().child(body))
      .when(Boolean(this.error), (el) => el.child(errorStrip("compare-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}

// ---- a file between two revisions, or a revision and the working file

export class FileDiff extends DiffView {
  init(p, cx) {
    this.from = p.from ?? null;
    this.reverse = p.reverse === true;
    super.init(p, cx);
  }

  load(cx) {
    if (this.loading) { this.again = true; return; }
    if (!this.root || !this.path || !this.from) { this.result = { ok: false }; this.error = { err: "This tab has no file to show.", msg: { key: "dialogs.diff.noFileTab", args: {} } }; return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const r = await readFileDiff(makeGit(exec, this.on), this.root, { from: this.from, to: this.commit, path: this.path, oldPath: this.oldPath, reverse: this.reverse });
        if (r.ok || !this.result?.ok) this.apply(r);
        this.error = r.ok || !r.err ? null : { err: r.err };
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

  compared() {
    const r = this.result;
    if (!r?.ok) return "";
    const work = this.t("dialogs.diff.workingTree");
    return `${r.from || work} → ${r.to || work}`;
  }
}

// ---- one file, read only

export class FileView {
  init(p, cx) {
    this.root = p.root ?? null; this.on = p.on ?? null; this.path = p.path ?? ""; this.rev = p.rev ?? null;
    this.code = null; this.note = null; this.cut = false; this.loaded = false;
    this.load(cx);
  }

  load(cx) {
    if (!this.root || !this.path) { this.loaded = true; this.note = "compare.unreadable"; return; }
    cx.spawn(async (cx) => {
      try {
        let text;
        if (this.rev) {
          const r = await readRevisionFile(makeGit(exec, this.on), this.root, { rev: this.rev, path: this.path });
          text = r.ok ? (r.binary ? "\0" : r.text) : null;
        } else text = await readTextFile(`${this.root}/${this.path}`, { on: this.on });
        if (text === null || text === undefined) this.note = "compare.unreadable";
        else if (text.includes("\0")) this.note = "compare.binary";
        else {
          const t = theme();
          this.cut = text.length > PREVIEW_CHARS;
          this.code?.release();
          this.code = EditorState.new({
            language: editorLanguage(this.path), readonly: true,
            value: this.cut ? text.slice(0, PREVIEW_CHARS) : text,
            font_family: settings().font_family, font_size: 12,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
          });
        }
      } catch {
        this.note = "compare.unreadable";
      } finally {
        this.loaded = true;
        cx.notify();
      }
    });
  }

  close() { this.code?.release(); this.code = null; }

  render() {
    const t = theme();
    const parts = this.path.split("/"), name = parts.pop(), folder = parts.join("/");
    const body = !this.loaded ? notice(this.t("ui.loading"), t, { busy: true })
      : !this.code ? notice(this.t(this.note ?? "compare.unreadable"), t)
      : Editor.new(this.code).flex_1().min_h(0);
    return v_flex().id("compare-file-tab").size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(ROW + 10).flex_none().w_full().min_w(0).px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(fileGlyph(this.path, { dark: darkLook(t.background) }))
        .child(div().flex_none().max_w(360).truncate().font_semibold().child(name))
        .when(Boolean(folder), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(folder)))
        .when(Boolean(this.rev), (el) => el.child(div().flex_none().text_size(12).text_color(t.muted).child(short(this.rev))))
        .child(spacer()))
      .when(this.cut, (el) => el.child(div().flex_none().w_full().px(10).py(5).border_b(1).border_color(t.border).bg(t.raised).text_size(12).text_color(t.ansi3).child(this.t("compare.cut", { n: PREVIEW_CHARS }))))
      .child(body);
  }
}
