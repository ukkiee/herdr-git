// VCS widget popup: the search box, the actions on top, the in-progress items, New
// Branch, and the Recent, Local, Remote and Tags trees (git-heads.js popupRows decides
// what shows and in what order). The same screen, with props.mode "abort", is the
// question before an operation is aborted.
//
// The popup only reads. A pick goes back to the widget that opened it (openVcsPopup
// resolves in the widget's copy, like ui.js openMenu), which runs it as its own work:
// Herdr closes a popup on any click outside it, and what a closed copy started stops.
// A branch row's pick comes back as { id: "branch", target, at }; the widget then opens
// that branch's menu (log-menus.js) where the row was.
//
// POPUP_ACTIONS is what each action and branch menu item does; an item shows only when
// it is there. Each gets (widget, target, cx): the widget part (view-vcs-widget.js) and
//   vcs.* and ops.*: the pick ({ id, run? })
//   branch.*:        { name, scope ("local" | "remote"), current, upstream }

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, openOverlay, closeOverlay } from "herdr";
import { makeGit, repoRoot } from "./git.js";
import { readHeads, popupRows } from "./git-heads.js";
import { readOperation } from "./git-operation.js";
import { smartCheckout } from "./view-smart.js";
import { MOD, openDialog, answerMenu, dialogFrame, button, uiGlyph, iconButton, darkLook, notice, WindowedList } from "./ui.js";

export const POPUP_ACTIONS = {
  "vcs.commit": (w) => w.openCommit(),
  "vcs.push": (w) => w.openPush(),
  "ops.abort": (w, _p, cx) => w.abort(cx),
  "ops.continue": (w, _p, cx) => w.goOn(cx),
  "ops.skip": (w, _p, cx) => w.skip(cx),
  "vcs.newBranch": (w, _p, cx) => w.newBranch(null, cx),
  // Local changes in the way open the Smart dialog, with the widget's host running its writes.
  "branch.checkout": (w, b, cx) => {
    if (!b || b.current) return;
    w.write({ key: "log.checkingOut" }, (repo) => smartCheckout(repo, { name: b.name, remote: b.scope === "remote" }, { owner: w.host.bus.id, lang: w.host.lang, who: w.who }), cx);
  },
  "branch.newFrom": (w, b, cx) => w.newBranch(b, cx),
  "branch.delete": (w, b, cx) => w.remove(b, cx),
};
export const popupHandles = (id) => Object.prototype.hasOwnProperty.call(POPUP_ACTIONS, id);

// Which log-menus.js menu a branch row of the popup has, or null (a tag has none yet).
export function branchMenu(target) {
  if (target?.scope === "remote") return "remoteBranch";
  if (target?.scope === "local") return target.current ? "currentBranch" : "localBranch";
  return null;
}

// A popup is as tall as what the mod draws, whatever height openOverlay asks for, so
// size_full() and flex_1() inside it measure 0 and leave a WindowedList no room: the
// popup and its list get their heights here. LIST_H is HEIGHT less the padding (5 above
// and below), the search row and the gap under it.
const WIDTH = 380, HEIGHT = 520, ROW_H = 26, PAD = 5, SEARCH_H = 32, GAP = 4;
const LIST_H = HEIGHT - 2 * PAD - SEARCH_H - GAP;
const newKey = (what) => `${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// openVcsPopup(bus, { root, on, lang, at }) → resolves in the opener's copy with the pick
// ({ id, run? } or { id: "branch", target, at }), or null when the popup closes without one.
// bus: the opener's (`this.bus`); at: where the popup's top left goes, window coordinates.
export function openVcsPopup(bus, { root, on = null, lang, at } = {}) {
  const key = newKey("vcs-popup");
  const answer = bus.wait(key);
  const spot = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { at: { x: at.x, y: at.y } } : {};
  openOverlay({ mod: MOD, kind: "popup", width: WIDTH, height: HEIGHT, ...spot, props: { view: "vcs-popup", key, root, on, lang } });
  return answer;
}

// askAbort(bus, kind, lang) → resolves true when the person confirms aborting the
// operation of that kind ("merge", "rebase", "cherry-pick", "revert"): "Abort Merge /
// Are you sure you want to abort the merge? [Cancel] [Abort]". The VCS widget's ■ and the
// Commit panel's Abort both ask with it.
export async function askAbort(bus, kind, lang) {
  const key = newKey("vcs-abort");
  const answer = bus.wait(key);
  openDialog("vcs-popup", { mode: "abort", key, kind, lang }, { width: 420, height: 150 });
  return (await answer) === "abort";
}

const ABORT = {
  merge: ["ops.abortMerge", "vcs.abortMergeAsk"], rebase: ["ops.abortRebase", "vcs.abortRebaseAsk"],
  "cherry-pick": ["ops.abortCherryPick", "vcs.abortCherryPickAsk"], revert: ["ops.abortRevert", "vcs.abortRevertAsk"],
};

export default class VcsPopup {
  init(p, cx) {
    this.key = p.key;
    this.overlay = p.overlay;
    this.mode = p.mode === "abort" ? "abort" : "popup";
    this.kind = p.kind;
    if (this.mode === "abort") return;
    this.repo = p.root ? { git: makeGit(exec, p.on ?? null), root: p.root, on: p.on ?? null } : null;
    this.heads = null;
    this.op = null;
    this.read = false;
    this.err = null;
    this.folded = new Set(["remote", "tags"]);
    this.at = -1; // the row the keyboard is on
    this.list = new WindowedList("vcs-popup-rows", { rowHeight: ROW_H });
    this.makeInput("");
    this.input.focus();
    this.reload(cx);
  }

  makeInput(value) {
    this.inputLang = this.lang;
    this.input = InputState.new({ placeholder: this.t("vcs.search"), value });
    this.input.on("change", (_e, cx) => { this.at = -1; this.list.top = 0; cx.notify(); });
  }

  reload(cx) {
    const repo = this.repo;
    if (!repo) { this.read = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      const top = await repoRoot(repo.git, repo.root);
      const [heads, op] = top.ok ? await Promise.all([readHeads(repo.git, top.root), readOperation(repo.git, top.root)]) : [{ ok: false, err: top.err }, null];
      this.loading = false;
      this.read = true;
      this.heads = heads.ok ? heads : null;
      this.op = op?.ok ? op : null;
      this.err = heads.ok ? null : heads.err;
      cx.notify();
    });
  }

  rows() {
    return popupRows({ heads: this.heads, op: this.op, query: this.input.value(), folded: this.folded, handled: popupHandles }, this.t);
  }

  // Back to the widget, which runs it; the popup closes.
  answer(value) {
    if (this.answered) return;
    this.answered = true;
    answerMenu(this.bus, this.key, value);
    closeOverlay(this.overlay);
  }

  close() { if (!this.answered) answerMenu(this.bus, this.key, null); }

  activate(r, at, cx) {
    if (!r) return;
    if (r.kind === "group") {
      if (this.folded.has(r.id)) this.folded.delete(r.id); else this.folded.add(r.id);
      cx.notify();
    } else if (r.kind === "action") this.answer({ id: r.id, ...(r.run ? { run: r.run } : {}) });
    else if (r.kind === "branch") {
      const scope = r.scope === "recent" ? "local" : r.scope;
      this.answer({ id: "branch", target: { name: r.name, scope, current: r.current, upstream: r.upstream }, ...(at ? { at: { x: at.x, y: at.y } } : {}) });
    }
  }

  move(by, rows) {
    const n = rows.length;
    for (let step = 1; step <= n; step++) {
      const i = (((this.at + by * step) % n) + n) % n;
      if (rows[i].kind !== "rule" && rows[i].kind !== "folder") { this.at = i; this.list.reveal(i, n); return; }
    }
  }

  rowFor(r, i, t) {
    const dark = darkLook(t.popover);
    const el = h_flex().id(`vcs-popup-row-${i}`).h(ROW_H).flex_none().w_full().px(8).gap(6).items_center().rounded(6)
      .when(i === this.at, (el) => el.bg(t.selected));
    if (r.kind === "rule") return div().id(`vcs-popup-row-${i}`).h(ROW_H).flex_none().flex().items_center().child(div().mx(6).h(1).w_full().bg(t.border));
    const pressed = (handler) => (e, cx) => { this.at = i; handler(e, cx); };
    if (r.kind === "action") {
      return el.hover((s) => s.bg(t.hover)).on_click(pressed((_e, cx) => this.activate(r, null, cx)))
        .child(div().flex_1().min_w(0).truncate().child(r.label));
    }
    if (r.kind === "group") {
      return el.hover((s) => s.bg(t.hover)).on_click(pressed((_e, cx) => this.activate(r, null, cx)))
        .child(uiGlyph(r.open ? "chevron-down" : "chevron-right", { dark }).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(r.label));
    }
    if (r.kind === "folder") {
      return el.pl(26).child(uiGlyph("folder", { dark }).text_color(t.muted)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.label));
    }
    const depth = r.scope === "remote" ? 44 : 26;
    return el.pl(depth).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { this.at = i; this.activate(r, e.position, cx); cx.stop_propagation(); })
      .child(uiGlyph(r.scope === "tag" ? "tag" : r.current ? "current-branch" : "branch-item", { dark }))
      .child(div().flex_1().min_w(0).truncate().when(r.current, (el) => el.font_semibold()).child(r.label))
      // Commits to pull (blue ↓) and to push (green ↑), and the branch it tracks.
      .when(r.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi4).child(`↓${r.behind}`)))
      .when(r.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${r.ahead}`)))
      .when(Boolean(r.upstream) && r.scope === "recent", (el) => el.child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(r.upstream)));
  }

  renderAbort(t) {
    const [title, ask] = ABORT[this.kind] ?? ABORT.merge;
    const done = (value) => { this.answered = true; answerMenu(this.bus, this.key, value); closeOverlay(this.overlay); };
    return dialogFrame("vcs-abort", this.t(title), t, {
      body: div().text_size(13).child(this.t(ask)),
      footer: [
        button("vcs-abort-cancel", this.t("dialogs.cancel"), t, { onClick: () => done(null) }),
        button("vcs-abort-yes", this.t("vcs.abort"), t, { kind: "primary", onClick: () => done("abort") }),
      ],
      onClose: () => done(null),
    });
  }

  render(cx) {
    const t = theme();
    if (this.mode === "abort") return this.renderAbort(t);
    if (this.inputLang !== this.lang && !this.relabeling) {
      this.relabeling = true;
      cx.timer.after(1, (cx) => { this.relabeling = false; this.makeInput(this.input.value()); this.input.focus(); cx.notify(); });
    }
    const rows = this.read ? this.rows() : [], n = rows.length;
    const body = !this.read ? notice(this.t("ui.loading"), t, { busy: true })
      : this.err ? notice(this.err, t)
        : !n ? notice(this.t("vcs.nothing"), t)
          : this.list.render(n, (i) => this.rowFor(rows[i], i, t), t);
    return v_flex().id("vcs-popup").w_full().h(HEIGHT).p(PAD).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.move(1, rows);
        else if (e.key === "up") this.move(-1, rows);
        else if (e.key === "enter") this.activate(rows[this.at] ?? rows.find((r) => r.kind === "action" || r.kind === "branch"), null, cx);
        else if (e.key === "escape") closeOverlay(this.overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().id("vcs-popup-search").h(SEARCH_H).flex_none().w_full().px(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(uiGlyph("search").text_color(t.dim))
        .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12.8).text_color(t.foreground))
        .child(iconButton("vcs-popup-refresh", "refresh", t, { title: this.t("vcs.refresh"), busy: Boolean(this.loading), onClick: (_e, cx) => this.reload(cx) })))
      .child(div().h(LIST_H).flex_none().w_full().mt(GAP).child(body));
  }
}
