// VCS widget popup: the search box, the actions on top, the in-progress items, New
// Branch, and the Recent, Local, Remote and Tags trees (git-heads.js popupRows decides
// what shows and in what order; the Local and Remote branches come to it in
// branch-order.js order, with the Branch tree's stars). The same screen, with props.mode "abort", is the
// question before an operation is aborted.
//
// The popup only reads. A pick goes back to the widget that opened it (openVcsPopup
// resolves in the widget's copy, like ui.js openMenu), which runs it as its own work:
// Herdr closes a popup on any click outside it, and what a closed copy started stops.
// A branch row (click, right-click, Enter or →) opens that branch's menu (log-menus.js)
// beside the row, drawn by this popup itself (a gpui-base Popup anchored to the row), so
// the popup stays open under it. A second overlay can't be placed there: a press inside
// this popup reports a position Herdr doesn't place an overlay by. An item of that menu
// comes back as { id, target } with the branch as target.
//
// POPUP_ACTIONS is what each action and branch menu item does; an item shows only when
// it is there. Each gets (widget, target, cx): the widget part (view-vcs-widget.js) and
//   vcs.* and ops.*: the pick ({ id, run? })
//   branch.*:        { name, scope ("local" | "remote"), current, upstream }
//   tag.*:           { name, scope: "tag" }

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup } from "gpui-base";
import { exec, theme, openOverlay, closeOverlay } from "herdr";
import { makeGit, repoRoot } from "./git.js";
import { readHeads, popupRows } from "./git-heads.js";
import { readFavorites } from "./git-branch.js";
import { isFavorite, orderBranches, refOf } from "./branch-order.js";
import { readOperation } from "./git-operation.js";
import { smartCheckout } from "./view-smart.js";
import { renameFrom } from "./view-rename-branch.js";
import { pushBranch } from "./view-push.js";
import { pushTagMenu } from "./view-tag.js";
import { startUpdateProject, updateHere, checkoutUpdateHere, pullHere } from "./view-update-project.js";
import { operateFromWidget } from "./view-merge.js";
import { openNewWorktree } from "./view-worktree.js";
import { checkoutRefFrom } from "./view-checkout-ref.js";
import { compareWithCurrent, diffWithWorkingTree } from "./view-compare-branches.js";
import { shortenMiddle } from "./git-log.js";
import { menuItems } from "./log-menus.js";
import { menuWidth, sideOf } from "./ui-size.js";
import { MOD, openDialog, answerMenu, dialogFrame, button, uiGlyph, iconButton, darkLook, notice, writeBlock, menuMetrics, WindowedList } from "./ui.js";

export const POPUP_ACTIONS = {
  "vcs.commit": (w) => w.openCommit(),
  "vcs.push": (w) => w.openPush(),
  "ops.abort": (w, _p, cx) => w.abort(cx),
  "ops.continue": (w, _p, cx) => w.goOn(cx),
  "ops.skip": (w, _p, cx) => w.skip(cx),
  "vcs.newBranch": (w, _p, cx) => w.newBranch(null, cx),
  "vcs.newWorktree": (w) => openNewWorktree(w.host, w.repo, null, w.who),
  "vcs.checkoutRef": (w, _p, cx) => checkoutRefFrom(w, cx),
  // Local changes in the way open the Smart dialog, with the widget's host running its writes.
  "branch.checkout": (w, b, cx) => {
    if (!b || b.current) return;
    w.write({ key: "log.checkingOut" }, (repo) => smartCheckout(repo, { name: b.name, remote: b.scope === "remote" }, { owner: w.host.bus.id, lang: w.host.lang, who: w.who }), cx);
  },
  "branch.newFrom": (w, b, cx) => w.newBranch(b, cx),
  "branch.delete": (w, b, cx) => w.remove(b, cx),
  "branch.rename": (w, b) => renameFrom(w.host, w.repo, b),
  "branch.push": (w, b) => pushBranch(w.host, w.repo, b),
  "branch.trackedBranch": (w, b, cx) => { if (b?.upstream) w.branchMenu({ name: b.upstream, scope: "remote", current: false }, cx); },
  "tag.push": (w, b, cx) => pushTagMenu(w, b, null, cx),
  "vcs.updateProject": (w, _p, cx) => startUpdateProject(w.host, w.repo, w.who, cx),
  "branch.update": (w, b, cx) => updateHere(w.host, w.repo, w.who, b, cx),
  "branch.checkoutAndUpdate": (w, b, cx) => checkoutUpdateHere(w.host, w.repo, w.who, b, cx),
  "branch.pullRebase": (w, b, cx) => pullHere(w.host, w.repo, w.who, b, true, cx),
  "branch.pullMerge": (w, b, cx) => pullHere(w.host, w.repo, w.who, b, false, cx),
  "branch.mergeInto": (w, b, cx) => { if (b) operateFromWidget(w, { type: "merge", target: b.name }, cx); },
  "branch.rebaseOnto": (w, b, cx) => { if (b) operateFromWidget(w, { type: "rebase", target: b.name }, cx); },
  "branch.checkoutAndRebase": (w, b, cx) => { if (b) operateFromWidget(w, { type: "checkout-rebase", name: b.name, remote: b.scope === "remote" }, cx); },
  "branch.newWorktreeFrom": (w, b) => openNewWorktree(w.host, w.repo, b, w.who),
  "branch.compareWith": (w, b) => compareWithCurrent({ repo: w.repo, t: w.host.t }, withRef(b), w.heads?.head),
  "branch.showDiffWithWorkingTree": (w, b) => diffWithWorkingTree({ repo: w.repo, t: w.host.t }, withRef(b), w.heads?.head),
};
// A popup branch with the ref the compare tabs read.
const withRef = (b) => (b && (b.scope === "local" || b.scope === "remote") ? { ...b, from: refOf(b.scope, b.name) } : null);
export const popupHandles = (id) => Object.prototype.hasOwnProperty.call(POPUP_ACTIONS, id);

// Which log-menus.js menu a branch or tag row of the popup has, or null.
export function branchMenu(target) {
  if (target?.scope === "tag") return "tag";
  if (target?.scope === "remote") return "remoteBranch";
  if (target?.scope === "local") return target.current ? "currentBranch" : "localBranch";
  return null;
}

// Why a branch can't be deleted from the popup, or null.
export function deleteBlockOf(b, tr) {
  if (b?.scope === "remote") return tr("log.remoteNoDelete");
  if (b?.current) return tr("log.currentNoDelete");
  return null;
}

// branchMenuRows(b, { head, writing, tr }) → the rows of branch b's menu, as the menu
// screen takes them ([{ label, value, rule, disabled, hint, title }]), with the items the
// popup does. head: readHeads' head; writing: why no write may start now (ui.js writeBlock).
export function branchMenuRows(b, { head, writing = null, tr }) {
  const which = branchMenu(b);
  if (!which) return [];
  const ctx = {
    name: shortenMiddle(b.name, 30), current: head?.branch ?? (head?.hash ? head.hash.slice(0, 7) : "HEAD"),
    upstream: b.upstream ?? "", writing, deleteBlock: deleteBlockOf(b, tr),
  };
  return menuItems(which, popupHandles, ctx).map((it) => ({
    label: tr(it.key, it.args), value: it.id, rule: it.rule, disabled: it.disabled, hint: it.hint ?? undefined,
    title: it.why ? (it.why.text ?? tr(it.why.key, it.why.args)) || undefined : undefined,
  }));
}

// A popup is as tall as what the mod draws, whatever height openOverlay asks for, so
// size_full() and flex_1() inside it measure 0 and leave a WindowedList no room: the
// popup and its list get their heights here. LIST_H is HEIGHT less the padding (5 above
// and below), the search row and the gap under it.
const WIDTH = 380, HEIGHT = 520, ROW_H = 26, PAD = 5, SEARCH_H = 32, GAP = 4;
const LIST_H = HEIGHT - 2 * PAD - SEARCH_H - GAP;
const newKey = (what) => `${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const POPUP_WIDTH = WIDTH;

// openVcsPopup(bus, { root, on, lang, at, side }) → resolves in the opener's copy with the
// pick ({ id, run? }, or { id, target } from a branch's menu), or null when the popup
// closes without one. bus: the opener's (`this.bus`); at: where the popup's top left
// goes, window coordinates; side: where a branch's menu opens, "right" or "left" (the
// popup sits at the window's right edge).
export function openVcsPopup(bus, { root, on = null, lang, at, side } = {}) {
  const key = newKey("vcs-popup");
  const answer = bus.wait(key);
  const spot = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { at: { x: at.x, y: at.y } } : {};
  openOverlay({ mod: MOD, kind: "popup", width: WIDTH, height: HEIGHT, ...spot, props: { view: "vcs-popup", key, root, on, lang, side: sideOf(side) } });
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
    this.prefs = { favorite: [], unfavorite: [] };
    this.op = null;
    this.read = false;
    this.err = null;
    this.folded = new Set(["remote", "tags"]);
    this.at = -1; // the row the keyboard is on
    this.side = sideOf(p.side);
    // The open branch menu: { row (its index in rows()), target, items, at }, or null.
    this.sub = null;
    this.list = new WindowedList("vcs-popup-rows", { rowHeight: ROW_H });
    this.makeInput("");
    this.input.focus();
    this.reload(cx);
  }

  makeInput(value) {
    this.inputLang = this.lang;
    this.input = InputState.new({ placeholder: this.t("vcs.search"), value });
    this.input.on("change", (_e, cx) => { this.at = -1; this.sub = null; this.list.top = 0; cx.notify(); });
  }

  reload(cx) {
    const repo = this.repo;
    if (!repo) { this.read = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      const top = await repoRoot(repo.git, repo.root);
      const [heads, op, prefs] = top.ok
        ? await Promise.all([readHeads(repo.git, top.root), readOperation(repo.git, top.root), readFavorites(repo.git, top.root)])
        : [{ ok: false, err: top.err }, null, null];
      this.loading = false;
      this.read = true;
      // The Branch tree's order and stars (branch-order.js). Favorites that can't be read
      // leave main and master starred.
      this.prefs = prefs?.ok ? { favorite: prefs.favorite, unfavorite: prefs.unfavorite } : { favorite: [], unfavorite: [] };
      const current = heads.ok ? heads.head.branch : null;
      this.heads = heads.ok ? {
        ...heads,
        local: orderBranches(heads.local, { scope: "local", current, prefs: this.prefs, favoritesFirst: true }),
        remote: orderBranches(heads.remote, { scope: "remote", current, prefs: this.prefs, favoritesFirst: true }),
      } : null;
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

  activate(r, cx, i = this.at) {
    if (!r) return;
    if (r.kind === "group") {
      this.sub = null;
      if (this.folded.has(r.id)) this.folded.delete(r.id); else this.folded.add(r.id);
      cx.notify();
    } else if (r.kind === "action") this.answer({ id: r.id, ...(r.run ? { run: r.run } : {}) });
    else if (r.kind === "branch") {
      // A second press on the same row closes its menu.
      if (this.sub?.row === i && this.sub.rowName === r.name) this.sub = null;
      else this.openSub(i, { name: r.name, scope: r.scope === "recent" ? "local" : r.scope, current: r.current, upstream: r.upstream });
      cx.notify();
    }
  }

  // The menu of branch `target` beside row i, the row of branch `rowName` (the tracked
  // branch's menu shows beside the local branch's row).
  openSub(i, target, rowName = target.name) {
    const items = branchMenuRows(target, { head: this.heads?.head, writing: writeBlock(this, this.repo), tr: this.t });
    this.sub = items.length ? { row: i, rowName, target, items, at: items.findIndex((it) => !it.disabled) } : null;
  }

  // An item of the open branch menu. The tracked branch's item shows that remote branch's
  // menu in its place, as the reference product's nested menu does.
  pickSub(k) {
    const sub = this.sub, item = sub?.items[k];
    if (!item || item.disabled) return;
    if (item.value === "branch.trackedBranch") {
      if (sub.target.upstream) this.openSub(sub.row, { name: sub.target.upstream, scope: "remote", current: false }, sub.rowName);
      return;
    }
    this.answer({ id: item.value, target: sub.target });
  }

  moveSub(by) {
    const items = this.sub?.items ?? [], n = items.length;
    for (let step = 1; step <= n; step++) {
      const k = (((this.sub.at + by * step) % n) + n) % n;
      if (!items[k].disabled) { this.sub.at = k; return; }
    }
  }

  // The open branch menu, drawn by this popup beside its row. Picked on the press, not
  // the click: the menu lies outside the popup's own box, and a press there may already
  // close the popup before the button comes up.
  subMenu(t) {
    const sub = this.sub, m = menuMetrics;
    return v_flex().id("vcs-popup-sub").w(menuWidth(sub.items, { min: 220 })).p(m.pad).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .rounded(8).border_1().border_color(t.border).shadow_lg()
      .children(sub.items.map((item, k) => v_flex().flex_none()
        .when(Boolean(item.rule) && k > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`vcs-popup-sub-${k}`).h(m.row).px(8).gap(9).rounded(6).items_center()
          .text_color(item.disabled ? t.dim : t.foreground)
          .when(k === sub.at && !item.disabled, (el) => el.bg(t.selected))
          .when(!item.disabled, (el) => el.hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.pickSub(k); cx.notify(); }))
          .when(Boolean(item.title), (el) => el.tooltip(item.title))
          .child(div().flex_1().min_w(0).truncate().child(item.label))
          .when(Boolean(item.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(item.hint))))));
  }

  move(by, rows) {
    this.sub = null;
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
      return el.hover((s) => s.bg(t.hover)).on_click(pressed((_e, cx) => this.activate(r, cx)))
        .child(div().flex_1().min_w(0).truncate().child(r.label));
    }
    if (r.kind === "group") {
      return el.hover((s) => s.bg(t.hover)).on_click(pressed((_e, cx) => this.activate(r, cx)))
        .child(uiGlyph(r.open ? "chevron-down" : "chevron-right", { dark }).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(r.label));
    }
    if (r.kind === "folder") {
      return el.pl(26).child(uiGlyph("folder", { dark }).text_color(t.muted)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.label));
    }
    const depth = r.scope === "remote" ? 44 : 26;
    const favorite = r.scope !== "tag" && isFavorite(refOf(r.scope === "remote" ? "remote" : "local", r.name), this.prefs);
    // Each name written out so ui-icons.test.mjs sees it.
    const glyph = r.scope === "tag" ? uiGlyph("tag", { dark })
      : r.current ? uiGlyph(favorite ? "current-branch-favorite" : "current-branch", { dark })
        : uiGlyph(favorite ? "favorite" : "branch-item", { dark });
    const open = this.sub?.row === i;
    const press = (_e, cx) => { this.at = i; this.activate(r, cx, i); cx.stop_propagation(); };
    // The menu hangs from a 1 px mark at the row's top corner on its side, so it starts
    // level with the row whichever corner of the mark the Popup pins it to.
    const left = this.side === "left";
    const mark = Popup.new(`vcs-popup-sub-mark-${i}`, div().w(1).h(1)).absolute().top(0)
      .anchor(left ? "top_right" : "top_left")
      .when(open, (el) => el.content(this.subMenu(t)));
    return el.relative().pl(depth).pr(4).hover((s) => s.bg(t.hover)).when(open, (el) => el.bg(t.selected))
      .on_mouse_down("left", press)
      .on_mouse_down("right", press)
      .child(glyph)
      .child(div().flex_1().min_w(0).truncate().when(r.current, (el) => el.font_semibold()).child(r.label))
      // Commits to pull (blue ↓) and to push (green ↑), and the branch it tracks.
      .when(r.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi4).child(`↓${r.behind}`)))
      .when(r.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${r.ahead}`)))
      .when(Boolean(r.upstream) && r.scope === "recent", (el) => el.child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(r.upstream)))
      // The row has a menu: › as the reference product marks it.
      .child(uiGlyph("chevron-right", { dark }).text_color(t.muted))
      .child(left ? mark.left(0) : mark.right(0));
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
    // A reload or a fold moved the rows: a menu open on a row that is now another closes.
    if (this.sub && (rows[this.sub.row]?.kind !== "branch" || rows[this.sub.row].name !== this.sub.rowName)) this.sub = null;
    const body = !this.read ? notice(this.t("ui.loading"), t, { busy: true })
      : this.err ? notice(this.err, t)
        : !n ? notice(this.t("vcs.nothing"), t)
          : this.list.render(n, (i) => this.rowFor(rows[i], i, t), t);
    return v_flex().id("vcs-popup").w_full().h(HEIGHT).p(PAD).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        // While a branch's menu is open the keys move in it; ← or Esc closes it.
        if (this.sub) {
          if (e.key === "down") this.moveSub(1);
          else if (e.key === "up") this.moveSub(-1);
          else if (e.key === "enter") this.pickSub(this.sub.at);
          else if (e.key === "left" || e.key === "escape") this.sub = null;
          else return;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (e.key === "right" && rows[this.at]?.kind === "branch") this.activate(rows[this.at], cx);
        else if (e.key === "down") this.move(1, rows);
        else if (e.key === "up") this.move(-1, rows);
        else if (e.key === "enter") this.activate(rows[this.at] ?? rows.find((r) => r.kind === "action" || r.kind === "branch"), cx);
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
