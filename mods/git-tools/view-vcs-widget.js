// VCS widget: the current branch with the commits to pull (blue ↓) and to push (green ↑),
// the commit of a detached HEAD, or an operation in progress ("⚠ main 병합 중") with ≫
// (resolve the conflicts, or go on once none is left) and ■ (abort, after asking).
// Clicking it opens the popup (view-vcs-popup.js). git-heads.js widgetFace decides
// what it shows.
//
// Two places draw it. On macOS the main-git layout has a block of its own left of the
// Git button (layout.mjs, props.view "vcs-widget"): the default export below. Elsewhere
// the Log panel draws it at the left end of the Commit list's toolbar (view-log.js).
// Both make a VcsWidget part with a host:
//   where() → { folder, on }      the folder it follows (ui.js location)
//   bus, lang, t, locks           as main.js sets them on a screen
//   setBusy(work, cx, repo)       the write lock (ui.js takeWrite), as the panels have it
//   noteDeleted(repo, deleted)?   a branch deleted from the popup (the Log panel's Restore notice)
// and the host's copy serves the dialogs the widget opens with it as owner: New Branch,
// Delete Branch (view-branch-new.js serveBranch) and Push (view-push.js servePush).
//
// The widget reads (readHeads, readOperation) when it starts, when the folder it follows
// changes, on "changed" for its repository, and every POLL while shown. Its writes
// (Abort, Continue, Skip, Checkout, Delete) run as the host copy's own work under the
// repository's lock; their failures and stops show as notifications.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, theme, notify } from "herdr";
import { makeGit, repoRoot } from "./git.js";
import { readHeads, widgetFace } from "./git-heads.js";
import { readOperation, continueOperation, abortOperation, skipOperation, operationName } from "./git-operation.js";
import { checkout, deleteBranch } from "./git-branch.js";
import { shortenMiddle } from "./git-log.js";
import { menuItems } from "./log-menus.js";
import { location, uiGlyph, iconButton, darkLook, broadcast, openDialog, openCommitPanel, openMenu, takeWrite, releaseWrite, writeBlock, readBlocked, sentence } from "./ui.js";
import { openPush, servePush } from "./view-push.js";
import { openBranchNew, openBranchDelete, serveBranch } from "./view-branch-new.js";
import { serveAction } from "./serve-actions.js";
import { openVcsPopup, askAbort, branchMenu, popupHandles, POPUP_ACTIONS } from "./view-vcs-popup.js";

const POLL = 10000;
const stop = (_e, cx) => cx.stop_propagation();

export class VcsWidget {
  init(host) {
    this.host = host;
    this.repo = null; // { git, root, on } once the followed folder is a repository
    this.heads = null; // readHeads' result
    this.op = null; // readOperation's result, null when not read
    this.context = null;
    this.loading = false;
  }

  contextKey() { const { folder, on } = this.host.where(); return JSON.stringify([folder, on]); }

  // ---- reading

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { folder, on } = this.host.where(), context = this.contextKey();
    if (context !== this.context) { this.context = context; this.repo = null; this.heads = null; this.op = null; }
    if (!folder) return;
    // A write running there would be seen half done: read once it ends (catchUp).
    if (this.repo && readBlocked(this.host, this.repo)) { this.waiting = true; return; }
    this.waiting = false;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let repo = this.repo;
        if (!repo) {
          const git = makeGit(exec, on);
          const top = await repoRoot(git, folder);
          if (context !== this.context) return;
          if (!top.ok) { this.heads = null; this.op = null; return; }
          repo = { git, root: top.root, on };
        }
        const [heads, op] = await Promise.all([readHeads(repo.git, repo.root), readOperation(repo.git, repo.root)]);
        if (context !== this.context) return;
        this.repo = repo;
        this.heads = heads;
        this.op = op.ok ? op : null;
      } finally {
        this.loading = false;
        if (this.again) { this.again = false; cx.timer.after(0, (cx) => this.refresh(cx)); }
        cx.notify();
      }
    });
  }

  event(e, cx) {
    if (e.type === "changed" && (!e.root || !this.repo || e.root === this.repo.root)) this.refresh(cx);
  }

  // From render: another folder to follow, or a read held back by a write that has ended,
  // taken up in a timer (render may not start work).
  catchUp(cx) {
    if (this.catching) return;
    const moved = this.contextKey() !== this.context;
    const waiting = this.waiting && !(this.repo && readBlocked(this.host, this.repo));
    if (!moved && !waiting) return;
    this.catching = true;
    cx.timer.after(0, (cx) => { this.catching = false; this.refresh(cx); });
  }

  // ---- writes

  // One git write under the repository's lock, as the host copy's work. Every screen on
  // the repository reads again after it, a refusal included (a hook may have moved things).
  write(work, run, cx) {
    const host = this.host, repo = this.repo;
    if (!repo) return;
    if (!host.setBusy(work, cx, repo)) {
      const why = writeBlock(host, repo);
      if (why) notify({ title: why, level: "info" });
      return;
    }
    cx.spawn(async (cx) => {
      let r;
      try { r = await run(repo); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      host.setBusy(null, cx);
      broadcast({ type: "changed", root: repo.root });
      if (r.ok) this.told(r);
      else if (!r.quiet) notify({ title: host.t("ui.gitFailed"), body: sentence(host.t, r.msg, r.err) || "", level: "error" });
      cx.notify();
    });
  }

  // An operation's request that stopped again on a conflict, or met a commit already in.
  told(r) {
    const t = this.host.t, name = operationName(r.operation);
    if (r.outcome === "stopped" && name) notify({ title: t("ops.stopped"), body: t(name.key, name.args), level: "warning" });
    else if (r.outcome === "empty") notify({ title: r.operation?.kind === "revert" ? t("ops.emptyRevertTitle") : t("ops.emptyTitle"), body: t("ops.emptyBody"), level: "info" });
  }

  abort(cx) {
    const host = this.host, kind = this.op?.kind;
    if (!kind || !this.repo) return;
    cx.spawn(async (cx) => {
      if (!(await askAbort(host.bus, kind, host.lang))) return;
      this.write({ key: "ops.aborting" }, (repo) => abortOperation(repo.git, repo.root), cx);
      cx.notify();
    });
  }

  // ≫ and the popup's Continue: the Conflicts dialog while a file is in conflict, else
  // go on with what is staged and the operation's own message.
  goOn(cx) {
    const op = this.op;
    if (!op?.kind || !this.repo) return;
    if (op.conflicts.length) { this.openConflicts(); return; }
    this.write({ key: "ops.continuing" }, (repo) => continueOperation(repo.git, repo.root), cx);
  }

  skip(cx) {
    if (!this.op?.canSkip) return;
    this.write({ key: "ops.skipping" }, (repo) => skipOperation(repo.git, repo.root), cx);
  }

  openConflicts() {
    const repo = this.repo, host = this.host;
    if (!repo) return;
    openDialog("conflicts", { root: repo.root, on: repo.on, owner: host.bus.id, lang: host.lang }, { width: 760, height: 460 });
  }

  openCommit() { openCommitPanel(); }

  openPush() {
    const repo = this.repo, host = this.host;
    if (repo) openPush({ root: repo.root, on: repo.on, owner: host.bus.id, lang: host.lang });
  }

  // b: a popup branch row's target, or null: from HEAD.
  newBranch(b) {
    const repo = this.repo, host = this.host;
    if (!repo || writeBlock(host, repo)) return;
    const from = b ? `${b.scope === "remote" ? "refs/remotes/" : "refs/heads/"}${b.name}` : null;
    openBranchNew({ root: repo.root, on: repo.on, from, label: b ? b.name : "HEAD", owner: host.bus.id, lang: host.lang });
  }

  checkout(b, cx) {
    if (!b || b.current) return;
    this.write({ key: "log.checkingOut" }, (repo) => checkout(repo.git, repo.root, b.name, { remote: b.scope === "remote" }), cx);
  }

  // As the Branch tree deletes: at once when nothing would be lost, else the dialog asks.
  remove(b, cx) {
    if (!b || this.deleteBlock(b)) return;
    const host = this.host;
    this.write({ key: "log.deleting" }, async (repo) => {
      const r = await deleteBranch(repo.git, repo.root, b.name);
      if (r.ok) host.noteDeleted?.(repo, r.deleted);
      if (!r.ok && r.unmerged > 0) {
        openBranchDelete({ root: repo.root, on: repo.on, name: b.name, unmerged: r.unmerged, owner: host.bus.id, lang: host.lang });
        return { ok: false, quiet: true };
      }
      return r;
    }, cx);
  }

  deleteBlock(b) {
    const tr = this.host.t;
    if (b.scope === "remote") return tr("log.remoteNoDelete");
    if (b.current) return tr("log.currentNoDelete");
    return null;
  }

  // ---- the popup

  open(at, cx) {
    const host = this.host, repo = this.repo;
    if (!repo) return;
    cx.spawn(async (cx) => {
      // The answer arrives in this copy's own call (ui.js), so what the pick starts is
      // this copy's work and outlives the popup.
      const pick = await openVcsPopup(host.bus, { root: repo.root, on: repo.on, lang: host.lang, at });
      if (!pick) return;
      if (pick.id === "branch") this.branchMenu(pick.target, pick.at, cx);
      else if (popupHandles(pick.id)) POPUP_ACTIONS[pick.id](this, pick, cx);
      cx.notify();
    });
  }

  // A branch's menu, as the Branch tree has it for that kind of branch (log-menus.js),
  // with the items the popup does.
  branchMenu(b, at, cx) {
    const host = this.host, tr = host.t, which = branchMenu(b);
    if (!which || !this.repo) return;
    const head = this.heads?.head;
    const ctx = {
      name: shortenMiddle(b.name, 30), current: head?.branch ?? (head?.hash ? head.hash.slice(0, 7) : "HEAD"),
      upstream: b.upstream ?? "", writing: writeBlock(host, this.repo), deleteBlock: this.deleteBlock(b),
    };
    const items = menuItems(which, popupHandles, ctx);
    if (!items.length) return;
    const rows = items.map((it) => ({ label: tr(it.key, it.args), value: it.id, rule: it.rule, disabled: it.disabled, title: it.why ? (it.why.text ?? tr(it.why.key, it.why.args)) || undefined : undefined }));
    cx.spawn(async (cx) => {
      const pick = await openMenu(host.bus, rows, { width: 300, at, lang: host.lang });
      if (pick && popupHandles(pick)) POPUP_ACTIONS[pick](this, b, cx);
      cx.notify();
    });
  }

  // ---- drawing

  // The widget itself: the button that opens the popup, and ≫ ■ while an operation is
  // in progress. `background`: what it sits on, for the icons' light or dark look.
  render(cx, { background } = {}) {
    this.catchUp(cx);
    const t = theme(), tr = this.host.t, face = widgetFace(this.heads, this.op);
    if (!face) return div().id("vcs-widget-none");
    const dark = darkLook(background ?? t.background);
    let main = h_flex().id("vcs-widget").h(26).px(8).gap(5).min_w(0).items_center().rounded(6).text_size(12).text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.open(e.position, cx); });
    if (face.kind === "progress") {
      main = main.child(div().flex_none().text_color(t.ansi3).child("⚠"))
        .child(div().min_w(0).truncate().child(tr(face.name.key, face.name.args)));
    } else {
      main = main.child(uiGlyph("branch-item", { dark }))
        .child(div().min_w(0).truncate().child(face.name))
        .when(face.kind === "branch" && face.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi4).child(`↓${face.behind}`)))
        .when(face.kind === "branch" && face.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${face.ahead}`)));
    }
    main = main.child(uiGlyph("chevron-down", { dark }).text_color(t.muted));
    if (face.kind !== "progress") return main;
    const next = face.next.run === "conflicts" ? () => this.openConflicts() : (_e, cx) => this.goOn(cx);
    return h_flex().id("vcs-widget-progress").min_w(0).gap(2).items_center()
      .child(main)
      .child(div().flex_none().on_mouse_down("left", stop)
        .child(iconButton("vcs-widget-next", "continue", t, { title: tr(face.next.key), onClick: next })))
      .child(div().flex_none().on_mouse_down("left", stop)
        .child(iconButton("vcs-widget-stop", "abort", t, { title: tr(face.stop.key), onClick: (_e, cx) => this.abort(cx) })));
  }
}

// The block left of the Git button (macOS main-git). It follows the focused pane like
// the panels, and serves the dialogs its widget opens.
export default class VcsWidgetBlock {
  init(_p, cx) {
    this.busy = null; // the work of this copy's git write (ui.js takeWrite)
    this.held = null;
    this.widget = new VcsWidget();
    this.widget.init(this);
    this.widget.refresh(cx);
    cx.timer.every(POLL, (cx) => this.widget.refresh(cx));
  }

  get repo() { return this.widget?.repo ?? null; }
  where() { return location(); }

  setBusy(work, cx, repo = this.repo) {
    let ok = true;
    if (work) ok = takeWrite(this, repo, work);
    else releaseWrite(this);
    cx.notify();
    return ok;
  }

  // A dialog's write that failed (ui.js serveRequest): the block has no room for a strip.
  writeFailed(text) { if (text) notify({ title: text, level: "error" }); }

  event(e, cx) { this.widget.event(e, cx); }

  serve(e, cx) {
    if (e.action === "push") { servePush(this, e, cx); return true; }
    return serveBranch(this, e, cx) || serveAction(this, e, cx);
  }

  render(cx) {
    const t = theme();
    // The strip continues the tab bar: its color and the line under it.
    return h_flex().id("vcs-widget-strip").size_full().min_w(0).pl(6).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(this.widget.render(cx, { background: t.chrome }));
  }
}
