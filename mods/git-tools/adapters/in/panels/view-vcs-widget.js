// VCS widget: the current branch with the commits to pull (blue ↓) and to push (green ↑),
// the commit of a detached HEAD, or an operation in progress ("⚠ main 병합 중") with ≫
// (resolve the conflicts, or go on once none is left) and ■ (abort, after asking).
// Clicking it opens the popup (view-vcs-popup.js). git-heads.js widgetFace decides
// what it shows.
//
// Two places draw it. On macOS the git-tools layout has a block of its own left of the
// Git button (layout.mjs, props.view "vcs-widget"): the default export below. Elsewhere
// the Log panel draws it at the left end of the Commit list's toolbar (view-log.js).
// Both make a VcsWidget part with a host:
//   where() → { folder, on }      the folder it follows (ui.js location)
//   bus, lang, t, locks           as main.js sets them on a screen
//   setBusy(work, cx, repo)       the write lock (ui.js takeWrite), as the panels have it
//   noteDeleted(repo, deleted)?   a branch deleted from the popup (the Log panel's Restore notice)
//   popupRight(origin)?           the rightmost window px the popup may reach (origin: the
//                                 widget's top left), or undefined
//   popupSide()?                  where a branch's menu opens beside the popup: "right" (default) or "left"
// and the host's copy serves the dialogs the widget opens with it as owner: New Branch,
// Delete Branch (view-branch-new.js serveBranch) and Push (view-push.js servePush).
//
// The widget reads (readHeads, readOperation) when it starts, when the folder it follows
// changes (once it has stayed DWELL ms, later.js), on "changed" for its repository, when its git folder changes (this computer
// only), and every POLL while shown. Its writes
// (Abort, Continue, Skip, Checkout, Delete) run as the host copy's own work under the
// repository's lock; their failures and stops show as notifications.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, theme, notify, run } from "herdr";
import { makeGit } from "../../out/git.js";
import { repoRoot } from "../../../core/app/git-root.js";
import { readTurns } from "../logic/read-turns.js";
import { oneTimer, dwell, each, spawnOrUndo } from "../logic/later.js";
import { popupPress } from "../logic/popup-press.js";
import { readHeads, widgetFace, faceOf } from "../../../core/app/git-heads.js";
import { moveRecent } from "../logic/recent.js";
import { readGitDir, stateChanged } from "../../../core/app/git-log.js";
import { readOperation, continueOperation, abortOperation, skipOperation, operationName } from "../../../core/app/git-operation.js";
import { checkout, deleteBranch, readFavorites } from "../../../core/app/git-branch.js";
import { pressSpot, widgetBlockWidth } from "../logic/ui-size.js";
import { openConflicts, openConflictsIfStopped } from "../dialogs/view-conflicts.js";
import { location, watchSettled, uiGlyph, iconButton, darkLook, skeleton, broadcast, openCommitPanel, openMenu, takeWrite, releaseWrite, writeBlock, readBlocked, sentence } from "../shared/ui.js";
import { openPush, servePush } from "../dialogs/view-push.js";
import { openBranchNew, openBranchDelete, serveBranch } from "../dialogs/view-branch-new.js";
import { serveAction } from "../shared/serve-actions.js";
import { openVcsPopup, askAbort, branchMenuRows, deleteBlockOf, popupHandles, POPUP_ACTIONS, POPUP_WIDTH } from "../dialogs/view-vcs-popup.js";

const POLL = 10000;
const FIRST_LOOK = 6000; // ms after the block starts: a first read still unanswered then is made again once
const PAD = 2; // the block's padding each side of the widget
// The layout block install.mjs gives the widget (the git-tools layout on macOS), sized to the widget.
const BLOCK_ID = "git-vcs-widget";
const WIDGET_MAX = 360; // px: a longer branch name is cut rather than widen the block further
const SEEN = 8; // how many folders besides the one shown the widget keeps the last face of (see remember)
// The block before the first answer (ui.js skeleton): one bar where the widget's text goes.
const WAITING = { rows: 1, rowHeight: 26, indent: [8, 0], cols: [{ fill: true }] };
const stop = (_e, cx) => cx.stop_propagation();

export class VcsWidget {
  // who: the host as the person knows it, a message key ("ui.logPanel"), for a dialog's
  // "didn't answer" sentences.
  init(host, { who } = {}) {
    this.host = host;
    this.who = who;
    this.repo = null; // { git, root, on } once the followed folder is a repository
    this.heads = null; // readHeads' result
    this.prefs = null; // the favorite branches read with it, for the popup's order
    this.op = null; // readOperation's result, null when not read
    this.read = false; // a read has answered once (a repository or not), or there is no folder
    this.context = null;
    this.reads = readTurns();
    this.watching = null; // the repository its git folder watch belongs to (watch)
    this.watcher = null; // that watch, stopped when the widget leaves the folder or the repository
    this.catching = oneTimer(); // render's catchUp, one timer at a time
    this.stay = dwell(); // a folder moved to is read once it has stayed DWELL ms (refresh)
    // context key → what the widget showed there when it left (see remember), newest last.
    this.seen = new Map();
    this.recalled = false; // what shows was recalled, and no read has answered since
    this.presses = popupPress(); // whether a press on the widget opens its popup or closes it
  }

  contextKey() { const { folder, on } = this.host.where(); return JSON.stringify([folder, on]); }

  // ---- reading

  refresh(cx) {
    const { folder, on } = this.host.where(), context = this.contextKey();
    // A change that lands while this folder is read is read once that read ends. Another
    // folder doesn't wait, nor does anything once the read in flight is stuck (read-turns.js).
    if (context === this.context && this.reads.busy()) { this.again = true; return; }
    if (context !== this.context) {
      const left = this.context, kept = this.remember();
      this.context = context; this.repo = null; this.heads = null; this.prefs = null; this.op = null; this.reads.drop(); this.again = false;
      this.unwatch();
      if (left !== null) this.stay.moved();
      // A folder seen before shows what it showed at once. Another one shows the block's
      // waiting bar until its first answer, at the width the block has, instead of an empty
      // widget that shrinks the block to nothing and grows it back.
      this.recalled = this.recall(moveRecent(this.seen, left, kept, context, SEEN));
      this.read = this.recalled;
      // Drawn now, not when the read ends: the window would keep the folder left on screen
      // until then. Never called from render (catchUp takes a move up in a timer).
      cx.notify();
    }
    if (!folder) { this.read = true; return; }
    // A folder moved to is read once it has stayed DWELL ms: one passed through is never read.
    if (this.stay.hold(cx, (cx) => this.refresh(cx))) return;
    // A write running there would be seen half done: read once it ends (catchUp).
    if (this.repo && readBlocked(this.host, this.repo)) { this.waiting = true; return; }
    this.waiting = false;
    const turn = this.reads.start();
    cx.spawn(async (cx) => {
      try {
        // A recalled folder is asked for its repository again: it may hold another one now.
        let repo = this.recalled ? null : this.repo;
        if (!repo) {
          const git = makeGit(exec, on, { wait: this.host.wait });
          const top = await repoRoot(git, folder);
          if (context !== this.context) return;
          if (!top.ok) { if (this.reads.use(turn)) { this.repo = null; this.heads = null; this.op = null; this.read = true; this.recalled = false; } return; }
          repo = this.repo?.root === top.root ? this.repo : { git, root: top.root, on };
        }
        const [heads, op, prefs] = await Promise.all([readHeads(repo.git, repo.root), readOperation(repo.git, repo.root), readFavorites(repo.git, repo.root)]);
        if (context !== this.context || !this.reads.use(turn)) return;
        this.repo = repo;
        this.heads = heads;
        this.prefs = prefs.ok ? { favorite: prefs.favorite, unfavorite: prefs.unfavorite } : null;
        this.read = true;
        this.recalled = false;
        this.op = op.ok ? op : null;
        this.watch(repo, cx);
      } finally {
        // The read that waited, its timer refused, still leaves this one drawn: the POLL reads.
        if (this.reads.end(turn) && this.again) { this.again = false; each(() => cx.timer.after(0, (cx) => this.refresh(cx))); }
        cx.notify();
      }
    });
  }

  // Leaving a folder: what the widget shows of it is kept (git-heads.js faceOf, not the
  // branch and tag lists), so coming back draws it at once at its own width (recall).
  // → what to keep (refresh puts it in `seen`, recent.js moveRecent), or null.
  remember() {
    if (!this.context || !this.repo || !this.heads?.ok) return null;
    return { repo: this.repo, heads: faceOf(this.heads), op: this.op };
  }

  // Back on a folder seen before: its face until the read that follows lands. A new
  // repository record, not the one kept: watch starts a loop only for a record it isn't
  // watching yet, and the loop from the visit before may have ended already.
  recall(was) {
    if (!was) return false;
    this.repo = { ...was.repo }; this.heads = was.heads; this.op = was.op;
    return true;
  }

  // The block's first read, started as it opens, has been seen to get no answer at all when
  // the git-tools layout is switched back to: neither git's answer nor the runner's clock
  // comes, and while that read counts as going (read-turns.js STUCK) every poll waits for it
  // and the widget stays empty. So a first read still going is given up and made again once.
  firstLook(cx) {
    if (!this.reads.busy()) return;
    this.reads.drop();
    this.refresh(cx);
  }

  // On this computer: read again when a terminal's git moves a ref or HEAD, starts or
  // ends an operation, or resolves a conflict. One watch, for the repository record followed
  // (`this.watching`): another folder or repository stops it (unwatch), which cancels its
  // pending call at once. The reads write nothing there (git-port.js READ).
  watch(repo, cx) {
    if (repo.on || this.watching === repo) return;
    this.unwatch();
    this.watching = repo;
    const live = () => this.watching === repo && this.repo === repo;
    // A task the host refuses costs the watch only: the poll reads meanwhile, and the next
    // read tries the watch again.
    try {
      cx.spawn(async (cx) => {
        const where = await readGitDir(repo.git, repo.root);
        if (!where.ok || !live()) return;
        this.watcher = watchSettled(where.dir, { live, wakes: (paths) => stateChanged(where.dir, paths), wake: (cx) => this.refresh(cx) }, cx);
      });
    } catch { this.watching = null; }
  }

  // The watch stops: its pending call is cancelled now, not at the folder's next change.
  unwatch() {
    this.watching = null;
    this.watcher?.stop();
    this.watcher = null;
  }

  event(e, cx) {
    if (e.type === "changed" && (!e.root || !this.repo || e.root === this.repo.root)) this.refresh(cx);
  }

  // From render: another folder to follow, or a read held back by a write that has ended,
  // taken up in a timer (render may not start work).
  catchUp(cx) {
    if (this.catching.busy()) return;
    const moved = this.contextKey() !== this.context || this.stay.late();
    const waiting = this.waiting && !(this.repo && readBlocked(this.host, this.repo));
    if (!moved && !waiting) return;
    // A timer the host refuses leaves nothing set: the next render tries again (later.js).
    this.catching.after(cx, 0, (cx) => this.refresh(cx));
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
    spawnOrUndo(cx, () => host.setBusy(null, cx), async (cx) => {
      let r;
      try { r = await run(repo); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      host.setBusy(null, cx);
      broadcast({ type: "changed", root: repo.root });
      // Stopped on a conflict again: the Conflicts dialog opens, as after any request.
      if (r.ok) { if (!openConflictsIfStopped(r, this.conflictArgs(repo))) this.told(r); }
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

  // The Conflicts dialog's writes are the host copy's (serve-actions.js, served by both hosts).
  conflictArgs(repo) { return { root: repo.root, on: repo.on, owner: this.host.bus.id, lang: this.host.lang, who: this.who }; }

  openConflicts() {
    if (this.repo) openConflicts(this.conflictArgs(this.repo));
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

  deleteBlock(b) { return deleteBlockOf(b, this.host.t); }

  // ---- the popup

  // e: the press on the widget. The popup opens right under the widget, not over it,
  // held left of the host's right limit (host.popupRight, when it has one). Without a
  // press (a menu item opened it) it opens where Herdr last saw the pointer, as the VCS
  // Operations popup does.
  open(e, cx) {
    const host = this.host, repo = this.repo;
    if (!repo) return;
    const at = pressSpot(e, { width: POPUP_WIDTH, right: (origin) => host.popupRight?.(origin) });
    cx.spawn(async (cx) => {
      // The answer arrives in this copy's own call (ui.js), so what the pick starts is
      // this copy's work and outlives the popup.
      const shown = this.presses.opened();
      let pick;
      const kept = this.heads?.ok && this.heads.local ? { heads: this.heads, prefs: this.prefs } : null;
      try { pick = await openVcsPopup(host.bus, { root: repo.root, on: repo.on, lang: host.lang, at, side: host.popupSide?.(), op: this.op, kept }); }
      finally { this.presses.closed(shown); }
      if (!pick) return;
      // A branch menu's item comes with its branch; the popup's own actions with the pick.
      if (popupHandles(pick.id)) POPUP_ACTIONS[pick.id](this, pick.target ?? pick, cx);
      cx.notify();
    });
  }

  // A branch's menu, as the Branch tree has it for that kind of branch (log-menus.js),
  // with the items the popup does, at the pointer (view-vcs-popup.js says why).
  branchMenu(b, cx) {
    const host = this.host;
    if (!this.repo) return;
    const rows = branchMenuRows(b, { head: this.heads?.head, writing: writeBlock(host, this.repo), tr: host.t });
    if (!rows.length) return;
    cx.spawn(async (cx) => {
      const pick = await openMenu(host.bus, rows, { width: 300, lang: host.lang });
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
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (this.presses.opens()) this.open(e, cx); });
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

// The block left of the Git button (the git-tools layout on macOS). It follows the focused pane like
// the panels, and serves the dialogs its widget opens.
export default class VcsWidgetBlock {
  init(_p, cx) {
    this.busy = null; // the work of this copy's git write (ui.js takeWrite)
    this.held = null;
    this.widget = new VcsWidget();
    this.widget.init(this, { who: "vcs.widget" });
    this.widget.refresh(cx);
    cx.timer.after(FIRST_LOOK, (cx) => this.widget.firstLook(cx));
    cx.timer.every(POLL, (cx) => this.widget.refresh(cx));
  }

  get repo() { return this.widget?.repo ?? null; }
  where() { return location(); }

  // The block is the window's top right corner, so its popup keeps inside the block's right
  // edge and a branch's menu opens on the popup's left. origin: the widget's top left,
  // which sits PAD in from the block's left edge. The block's width is the one fit() gave it:
  // a size watch on the strip would make it a press target and stop the window drag.
  popupRight(origin) { return this.fitted ? origin.x - PAD + this.fitted : undefined; }
  popupSide() { return "left"; }

  setBusy(work, cx, repo = this.repo) {
    let ok = true;
    if (work) ok = takeWrite(this, repo, work);
    else releaseWrite(this);
    cx.notify();
    return ok;
  }

  // A dialog's write that failed (ui.js serveRequest): the block has no room for a strip.
  // A notification's title is cut to one line, so git's words go in its body.
  writeFailed(text) { if (text) notify({ title: this.t("ui.gitFailed"), body: text, level: "error" }); }

  event(e, cx) { this.widget.event(e, cx); }

  serve(e, cx) {
    if (e.action === "push") { servePush(this, e, cx); return true; }
    return serveBranch(this, e, cx) || serveAction(this, e, cx);
  }

  render(cx) {
    const t = theme();
    // The strip continues the tab bar: its color and the line under it. The widget sits at
    // its left, right after the tab bar's Changes button. The block is resized to the
    // widget's own width (measured on the wrapper, which doesn't shrink with the block), so
    // no empty space is left by the Git button; a long name is cut at WIDGET_MAX.
    // Like the tab bar's own root the strip has no id: a press on its padding is the block's
    // window_drag (layout.mjs) and moves the window. Only the widget stops the press.
    const strip = h_flex().size_full().min_w(0).px(PAD).items_center().overflow_hidden().bg(t.chrome).border_b(1).border_color(t.border);
    // Until the first answer one bar fills the block at the width the layout kept from the
    // last fit, and nothing is measured: the block keeps its width instead of shrinking to
    // nothing and growing back. The bar takes no presses, so the window drag still works.
    if (!this.widget.read) {
      this.widget.catchUp(cx);
      return strip.child(div().flex_1().min_w(0).h(26).child(skeleton(t, WAITING)));
    }
    return strip
      .child(h_flex().id("vcs-widget-fit").flex_none().max_w(WIDGET_MAX).min_w(0).items_center()
        .on_size_change((size) => this.fit(size.width))
        .child(this.widget.render(cx, { background: t.chrome })));
  }

  // The layout block to the widget's width plus the padding; asked only when that changes.
  fit(content) {
    const px = widgetBlockWidth(content, this.fitted ?? null, PAD);
    if (px === null) return;
    this.fitted = px;
    run("layout.resize", { id: BLOCK_ID, px });
  }
}
