// Restore dialog: the repository's Rollback snapshots on the left (newest first, the
// newest or the one asked for selected), the chosen snapshot's files as a checkbox tree on
// the right (all checked), Close and Restore at the bottom. Double-clicking a file opens
// the snapshot's change of it in a Diff tab. Restore brings back the files and what was
// staged of them. After Restore the dialog stays open with what was restored, what was
// left, and whose staging was left, and why. Each snapshot row names the write it was
// taken before (Rollback, Reset, Checkout). A snapshot made on another HEAD is put back
// whole, 3-way (its files stay checked, the note says lines may be left as conflicts).
//
// The dialog doesn't write itself: it asks the Commit panel copy that opened it
// (props.owner) to restore under the repository's write lock (serveRestore, ui.js
// serveRequest), so the restore, the "changed" and the result outlive a dialog Herdr
// closes on Esc. Which paths are restored and which are left is git-snapshot.js's call.
//
// props: { view: "restore", root, on, owner, select, chosen, overlay } (see openRestore).
//
// Commands (`git-tools.<name>`, for scripts): refresh (reads the snapshots again),
// restore-next / restore-prev (the snapshot selection), restore-toggle-all, restore-run,
// restore-cancel. A command reaches every shown copy of the mod, so restore-run is only
// obeyed for a repository that opted in (`git config --local gittools.scripted true`) or
// a dialog opened from a Commit panel tab on a chosen folder (`chosen`).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { listSnapshots, restore, wordRestore } from "./git-snapshot.js";
import { formatTime } from "./i18n.js";
import { buildRows, checkState, toggleIncluded } from "./tree.js";
import { openDialog, dialogFrame, button, checkbox, row, notice, errorStrip, scrollText, uiGlyph, ICON, fileGlyph, folderGlyph, darkLook, close, scriptedRepo, sentence, WindowedList, askOwner, serveRequest, writeBlock } from "./ui.js";
import { openDiff } from "./view-diff.js";

// openRestore({ root, on, owner, select, chosen, lang })
//   Opens the Restore dialog. root, on: the repository and its machine (null: this
//   computer). owner: the opening Commit panel's bus id; that copy runs the restore
//   (serveRestore). select: a snapshot's hash to select first (the Rollback notice's);
//   otherwise the newest. chosen: true when the panel was opened on a chosen folder
//   (props.folder): script commands that write are obeyed. lang: the opener's language
//   (pass this.lang from a click handler).
export function openRestore({ root, on = null, owner = null, select = null, chosen = false, lang } = {}) {
  return openDialog("restore", { root, on, owner, select, chosen, lang }, { width: 760, height: 480 });
}

// Writing many files on another machine outlasts exec's default 30 s.
const TIMEOUT = 120000;

// serveRestore(panel, e, cx)
//   The Commit panel's side: restores e.args.paths of e.args.snapshot in e.args.root under
//   the write lock (ui.js serveRequest). Skipped paths' reasons are worded in the panel's
//   language for its error strip and the dialog's answer. panel.copy: the panel copy's id
//   (ui.js copyId), which names its scratch index.
export function serveRestore(panel, e, cx) {
  const { snapshot = null, paths } = e.args ?? {};
  const list = (Array.isArray(paths) ? paths : []).filter((path) => typeof path === "string" && path);
  serveRequest(panel, e, { key: "restore.running" }, async (repo) => {
    if (!list.length) return { ok: false, err: "No files to restore.", msg: { key: "restore.noFiles" } };
    const git = makeGit(exec, repo.on);
    const timed = (cwd, args, options) => git(cwd, args, { timeout: TIMEOUT, ...options });
    timed.read = (cwd, args, options) => git.read(cwd, args, { timeout: TIMEOUT, ...options });
    const r = await restore(timed, repo.root, { snapshot, paths: list, copy: panel.copy });
    return { ...r, msg: wordRestore(panel.t, r) };
  }, cx);
}

const stop = (_e, cx) => cx.stop_propagation();

// A restore that went through but left some paths, or their staging, as they were: shown
// as its result line (each path and why), not as an error. The *Failed ones end with
// git's words: the files are back, an index write failed.
const PARTLY = new Set(["restore.notAll", "restore.stagingNotAll", "restore.notAllStaging", "restore.stagingNotAllFailed", "restore.notAllStagingFailed", "restore.appliedUnstaged", "restore.appliedConflicts"]);

// The write each snapshot was taken before, as its row names it (git-snapshot.js ACTIONS).
const ACTION_NAMES = { Rollback: "restore.actionRollback", Reset: "restore.actionReset", Checkout: "restore.actionCheckout" };

// Same colors as the Commit panel's rows.
function statusColor(status, t) {
  return { modified: t.ansi4, added: t.ansi2, deleted: t.muted }[status] ?? t.foreground;
}

export default class RestoreView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.owner = p.owner ?? null; // the Commit panel copy that runs the restore
    this.wanted = typeof p.select === "string" ? p.select : null;
    this.scripted = p.chosen === true; // script commands that write are obeyed
    this.git = makeGit(exec, this.on);
    this.snapshots = null; // listSnapshots' list; null until the first answer
    this.listError = null;
    this.at = -1; // the selected snapshot's index
    this.picked = new Set(); // the checked paths of the selected snapshot
    this.collapsed = new Set();
    this.fileRows = []; this.fileAt = -1;
    this.running = false;
    this.result = null; // { msg, err }: what the last Restore did, in the words of `msg`
    this.error = null; // why the last Restore failed
    this.snapList = new WindowedList("restore-snapshots");
    this.fileList = new WindowedList("restore-files");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  // ---- reading

  load(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const [list, opted] = await Promise.all([listSnapshots(this.git, this.root), this.scripted || scriptedRepo(this.git, this.root)]);
        this.scripted = opted === true;
        this.listError = list.ok ? null : list.err || this.t("ui.gitFailed");
        if (list.ok) this.takeList(list.snapshots);
      } finally {
        this.loading = false;
      }
      if (this.again) this.load(cx);
      cx.notify();
    });
  }

  // Keeps the selected snapshot, its checks and the last result when it is still listed
  // (a newer rollback moves it down); else selects the one asked for, else the newest.
  takeList(snapshots) {
    const was = this.current()?.hash ?? null;
    this.snapshots = snapshots;
    const kept = was ? snapshots.findIndex((s) => s.hash === was) : -1;
    if (kept >= 0) { this.at = kept; this.snapList.reveal(kept, snapshots.length); return; }
    const wanted = this.wanted ? snapshots.findIndex((s) => s.hash === this.wanted) : -1;
    this.at = -1;
    this.pick(wanted >= 0 ? wanted : 0);
  }

  current() { return this.snapshots?.[this.at] ?? null; }

  // Selecting another snapshot checks all of its files and drops the last result.
  pick(index) {
    const snapshot = this.snapshots?.[index];
    if (!snapshot) { this.at = -1; this.picked = new Set(); this.fileRows = []; return false; }
    if (this.running) return false;
    if (index !== this.at) {
      this.at = index;
      this.picked = new Set(snapshot.files.map((f) => f.path));
      this.collapsed = new Set();
      this.fileAt = -1;
      this.result = null; this.error = null;
      this.rebuild();
    }
    this.snapList.reveal(index, this.snapshots.length);
    return true;
  }

  move(by) {
    const n = this.snapshots?.length ?? 0;
    if (!n) return false;
    return this.pick(this.at < 0 ? 0 : Math.max(0, Math.min(n - 1, this.at + by)));
  }

  // ---- the files

  rebuild() {
    const files = this.current()?.files ?? [];
    this.fileRows = buildRows(files, { grouped: true, compact: true, collapsed: this.collapsed });
    if (this.fileAt >= this.fileRows.length) this.fileAt = -1;
  }

  toggleCheck(paths) {
    // A 3-way snapshot is put back whole: its files stay checked.
    if (this.running || this.current()?.threeWay) return false;
    this.picked = toggleIncluded(this.picked, paths);
    return true;
  }

  allPaths() { return this.current()?.files.map((f) => f.path) ?? []; }

  toggleFold(r) {
    if (!this.collapsed.delete(r.key)) this.collapsed.add(r.key);
    this.rebuild();
  }

  showDiff(r) {
    const snapshot = this.current();
    if (!snapshot || r?.folder) return false;
    openDiff({ root: this.root, on: this.on, path: r.item.path, commit: snapshot.hash, status: r.item.status });
    return true;
  }

  // ---- restoring

  chosen() { return this.allPaths().filter((path) => this.picked.has(path)); }

  writing() { return this.running || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    const snapshot = this.current(), paths = this.chosen();
    if (this.running || !snapshot || !paths.length || this.writing()) return false;
    this.running = true; this.result = null; this.error = null;
    // Made on another HEAD: put back whole, 3-way (git-snapshot.js applySnapshot).
    if (snapshot.threeWay) {
      askOwner(this, "restore-3way", { root: this.root, on: this.on, snapshot: snapshot.hash }, "ui.commitPanel", cx, (r) => {
        this.running = false;
        if (r.ok) this.result = { msg: { key: "restore.applied" }, err: "" };
        else if (PARTLY.has(r.msg?.key)) this.result = { msg: r.msg, err: r.err };
        else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      });
      return true;
    }
    askOwner(this, "restore", { root: this.root, on: this.on, snapshot: snapshot.hash, paths }, "ui.commitPanel", cx, (r) => {
      this.running = false;
      if (r.ok) this.result = { msg: { key: "restore.restored", args: { n: paths.length } }, err: "" };
      else if (PARTLY.has(r.msg?.key)) this.result = { msg: r.msg, err: r.err };
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
    return true;
  }

  shut() { if (!this.running) close(this.overlay); }

  // ---- keys and commands

  command(name, cx) {
    if (name === "focus") this.handle.focus();
    else if (name === "refresh") { if (!this.running) this.load(cx); }
    else if (name === "restore-next") this.move(1);
    else if (name === "restore-prev") this.move(-1);
    else if (name === "restore-toggle-all") this.toggleCheck(this.allPaths());
    else if (name === "restore-cancel") this.shut();
    else if (name === "restore-run" && this.scripted) this.run(cx);
  }

  // A "changed" without a root is meant for every screen. The list only grows with a
  // rollback; the selection stays.
  event(e, cx) {
    if (e.type === "changed" && (!e.root || e.root === this.root) && !this.running) this.load(cx);
  }

  // ---- drawing

  snapshotRow(i, t) {
    const s = this.snapshots[i];
    return row(`restore-snapshot-${i}`, t, { selected: i === this.at })
      .cursor_pointer()
      .on_click((_e, cx) => { this.handle.focus(); this.pick(i); cx.notify(); })
      .child(uiGlyph("rollback", { dark: darkLook(t.background) }))
      .child(div().flex_none().whitespace_nowrap().child(this.t(ACTION_NAMES[s.action] ?? ACTION_NAMES.Rollback)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(formatTime(s.time, this.lang)))
      .child(div().flex_none().text_size(12).text_color(t.dim).whitespace_nowrap().child(this.t("restore.files", { n: s.files.length })));
  }

  fileRow(i, t) {
    const r = this.fileRows[i];
    const el = row(`restore-file-${r.key}`, t, { selected: i === this.fileAt, depth: r.depth })
      .on_click((e, cx) => {
        this.handle.focus();
        this.fileAt = i;
        if (e.click_count === 2) { if (r.folder) this.toggleFold(r); else this.showDiff(r); }
        cx.notify();
      })
      // The arrow's place is kept on file rows so checkboxes line up under their folder's.
      .child(r.folder
        ? div().id(`restore-fold-${r.key}`).size(ICON).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFold(r); cx.notify(); })
          .child(uiGlyph(r.open ? "chevron-down" : "chevron-right"))
        : div().size(ICON).flex_none())
      .child(checkbox(`restore-check-${r.key}`, checkState(r.paths, this.picked), t, {
        disabled: this.running || Boolean(this.current()?.threeWay), onClick: (_e, cx) => { this.toggleCheck(r.paths); cx.notify(); },
      }));
    if (r.folder) {
      return el
        .child(folderGlyph(r.name, { open: r.open }))
        .child(div().flex_none().max_w("70%").truncate().child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.t("restore.files", { n: r.count })));
    }
    const status = r.item.status;
    return el
      .child(fileGlyph(r.path, { dark: this.dark }))
      .child(div().flex_1().min_w(0).truncate().text_color(statusColor(status, t))
        .when(status === "deleted", (el) => el.line_through())
        .child(r.name));
  }

  body(t) {
    if (!this.root) return notice(this.t("ui.noRepository"), t);
    if (this.listError && !this.snapshots) return div().id("restore-list-error").p(12).text_color(t.ansi1).child(this.listError);
    if (!this.snapshots) return notice(this.t("ui.loading"), t, { busy: true });
    if (!this.snapshots.length) return notice(this.t("restore.none"), t);
    const all = this.allPaths();
    const left = v_flex().w(250).flex_none().min_h(0)
      .child(div().flex_1().min_h(0).child(this.snapList.render(this.snapshots.length, (i) => this.snapshotRow(i, t), t)));
    const right = v_flex().flex_1().min_w(0).min_h(0).border_l(1).border_color(t.border)
      .child(h_flex().id("restore-all").h(28).flex_none().px(10).gap(8).items_center()
        .child(checkbox("restore-all-check", checkState(all, this.picked), t, {
          disabled: this.running || !all.length || Boolean(this.current()?.threeWay), onClick: (_e, cx) => { this.toggleCheck(all); cx.notify(); },
        }))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
          .child(this.chosen().length ? this.t("restore.files", { n: all.length }) : this.t("restore.noFiles"))))
      .child(div().flex_1().min_h(0).child(this.fileList.render(this.fileRows.length, (i) => this.fileRow(i, t), t)));
    const result = this.result;
    return v_flex().size_full().min_h(0)
      .child(h_flex().flex_1().min_h(0).items_start().child(left.h_full()).child(right.h_full()))
      .when(Boolean(result), (el) => el.child(h_flex().id("restore-result").w_full().flex_none().px(10).py(6).border_t(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().min_w(0).child(scrollText("restore-result-text", sentence(this.t, result?.msg, result?.err), t, { maxHeight: 108, color: t.foreground })))))
      .when(Boolean(this.error), (el) => el.child(
        errorStrip("restore-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }

  render() {
    const t = theme(), writing = this.writing(), paths = this.chosen();
    // The rows sit on the dialog's popover color, not on the panels' background.
    this.dark = darkLook(t.popover);
    return dialogFrame("restore", this.t("restore.title"), t, {
      body: this.body(t), onClose: () => this.shut(),
      note: this.running ? this.t("restore.running") : writing ?? (!this.current() ? "" : this.current().threeWay ? this.t("restore.threeWayHint") : this.t("restore.hint")),
      footer: [
        // Not "restore-close": dialogFrame gives its × that id.
        button("restore-cancel", this.t("restore.close"), t, { disabled: this.running, onClick: () => this.shut() }),
        button("restore-run", this.t("restore.run"), t, {
          kind: "primary", disabled: !this.current() || !paths.length || Boolean(writing), busy: this.running, title: writing ?? undefined,
          onClick: (_e, cx) => { this.run(cx); cx.notify(); },
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "down") this.move(1);
      else if (e.key === "up") this.move(-1);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
