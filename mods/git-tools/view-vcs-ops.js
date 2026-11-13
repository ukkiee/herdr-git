// VCS Operations popup (view "vcs-ops"): cmd-shift-v's list of the menu bar Git menu's
// operations, numbered 1 … 9, 0. The items, their order and which copy opens it are in
// vcs-ops.js; what each item does is VCS_ACTIONS below.
//
// The key is a mod command (`git-tools.vcs-ops`), so it reaches every shown copy and no
// opener is known. The Log panel and the Commit panel hand it to vcsOpsCommand, and
// exactly one of them opens the popup (vcs-ops.js takesVcsOps). That panel is the owner:
// the popup answers it with the pick (as a popup menu does, ui.js answerMenu), and the
// panel runs the item as its own work, so the dialogs it opens ask it to run their writes.
// props: { key, group?, items, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, layout, run, openOverlay, closeOverlay } from "herdr";
import { MOD, LOG_NODE, answerMenu, logPanelShown, openCommitPanel, serveRequest, uiGlyph, darkLook } from "./ui.js";
import { vcsOpsItems, numberedPick, takesVcsOps, commitPanelShown } from "./vcs-ops.js";
import { makeGit } from "./git.js";
import { fetchAll } from "./git-branch.js";
import { openPush } from "./view-push.js";
import { openBranchNew } from "./view-branch-new.js";
import { newTagAtHead } from "./view-tag.js";
import { openResetHead } from "./view-reset-head.js";
import { openConsole } from "./view-console.js";
import { openStash } from "./view-stash.js";
import { openUnstash } from "./view-unstash.js";
import { listStashes } from "./git-stash.js";
import { startUpdateProject } from "./view-update-project.js";
import { openPull } from "./view-pull.js";
import { openMerge } from "./view-merge.js";
import { openRebase } from "./view-rebase.js";
import { openNewWorktree } from "./view-worktree.js";
import { VcsWidget } from "./view-vcs-widget.js";

// What each item does, run in the owning panel's copy: run(panel, cx, how).
//   panel: the Log panel (kind "log") or the Commit panel (kind "commit"): repo, bus, t,
//   lang, writeBlock(), setBusy(), writeFailed().
//   how: { kind, alt }. alt: Option was held while picking (Update Project then shows its
//   dialog even after "Don't show again").
//   by: the panel kinds that can serve the item's write; without it, both.
// A new operation is one line here; an id with no line never shows.
const WHO = { commit: "ui.commitPanel", log: "ui.logPanel" };
const repoOf = (panel) => (panel.repo?.root && !panel.writeBlock() ? panel.repo : null);
export const VCS_ACTIONS = {
  "commit": { run: () => openCommitPanel() },
  // The owning panel runs the push (view-push.js servePush; both panels serve it).
  "push": { run: (panel) => { const r = repoOf(panel); if (r) openPush({ root: r.root, on: r.on ?? null, owner: panel.bus.id, lang: panel.lang }); } },
  "fetch": { run: (panel, cx, how) => fetchFrom(panel, how.kind, cx) },
  "branches": { run: (panel, cx, how) => openBranches(panel, cx, how) },
  "newBranch": { run: (panel, cx, how) => {
    if (how.kind === "log") { panel.branches.newBranch(null, cx); return; }
    const r = repoOf(panel);
    if (r) openBranchNew({ root: r.root, on: r.on ?? null, owner: panel.bus.id, lang: panel.lang });
  } },
  "newTag": { run: (panel, cx, how) => newTagAtHead(panel, repoOf(panel), cx, WHO[how.kind]) },
  "resetHead": { run: (panel, _cx, how) => { const r = repoOf(panel); if (r) openResetHead({ root: r.root, on: r.on ?? null, owner: panel.bus.id, who: WHO[how.kind], lang: panel.lang }); } },
  "newWorktree": { run: (panel, _cx, how) => openNewWorktree(panel, repoOf(panel), null, WHO[how.kind]) },
  "showLog": { run: () => run("layout.show", { id: LOG_NODE }) },
  "stash": { run: (panel, _cx, how) => { const r = repoOf(panel); if (r) openStash({ root: r.root, on: r.on ?? null, owner: panel.bus.id, lang: panel.lang, who: WHO[how.kind] }); } },
  // The Unstash dialog is for one stash: the newest. Off while there is none.
  "unstash": {
    off: async (panel) => !(await newestStash(panel)),
    run: (panel, cx) => cx.spawn(async (cx) => {
      const r = repoOf(panel), stash = r ? await newestStash(panel) : null;
      if (stash && r === repoOf(panel)) openUnstash({ root: r.root, on: r.on ?? null, owner: panel.bus.id, lang: panel.lang, stash: { hash: stash.hash, ref: stash.ref, message: stash.message } });
      cx.notify();
    }),
  },
  // The Commit panel's Rollback with nothing selected: every changed file, checked.
  "rollback": { by: ["commit"], run: (panel) => panel.rollback(null) },
  "console": { run: (panel) => openConsole(panel.t) },
  "updateProject": { run: (panel, cx, how) => startUpdateProject(panel, repoOf(panel), WHO[how.kind], cx, { alt: how.alt }) },
  "pull": { run: (panel, _cx, how) => { const r = repoOf(panel); if (r) openPull({ root: r.root, on: r.on ?? null, owner: panel.bus.id, lang: panel.lang, who: WHO[how.kind] }); } },
  "merge": { run: (panel, _cx, how) => { const r = repoOf(panel); if (r) openMerge({ root: r.root, on: r.on ?? null, owner: panel.bus.id, who: WHO[how.kind], lang: panel.lang }); } },
  "rebase": { run: (panel, _cx, how) => { const r = repoOf(panel); if (r) openRebase({ root: r.root, on: r.on ?? null, owner: panel.bus.id, who: WHO[how.kind], lang: panel.lang }); } },
};

// Branches…: the VCS widget's popup on the panel's repository. The Log panel's own widget
// when it follows that repository; otherwise one made for this pick, which reads the
// branches itself while the popup opens (its picks run in this panel's copy).
function openBranches(panel, cx, how) {
  const r = repoOf(panel);
  if (!r) return;
  let w = panel.widget?.repo?.root === r.root ? panel.widget : null;
  if (!w) {
    w = new VcsWidget();
    w.init(panel, { who: WHO[how.kind] });
    w.refresh(cx);
    w.repo = r;
  }
  w.open(null, cx);
}

const handledBy = (kind) => (id) => Object.prototype.hasOwnProperty.call(VCS_ACTIONS, id) && (!VCS_ACTIONS[id].by || VCS_ACTIONS[id].by.includes(kind));

// The panel's repository's newest stash ({ hash, ref, message }), or null.
async function newestStash(panel) {
  const r = panel.repo;
  if (!r?.root) return null;
  const list = await listStashes(makeGit(exec, r.on ?? null), r.root);
  return list.ok ? list.stashes[0] ?? null : null;
}

// Fetch as the panel's own write: the Log panel's toolbar Fetch (its button spins), or in
// the Commit panel the same write under the lock, with its failure in the panel's strip.
function fetchFrom(panel, kind, cx) {
  if (kind === "log") { panel.fetch(cx); return; }
  const r = repoOf(panel);
  if (!r) return;
  // serveRequest wants a request: this one's key is answered to nobody.
  const e = { key: `vcs-ops-fetch-${Date.now().toString(36)}`, args: { root: r.root, on: r.on ?? null } };
  serveRequest(panel, e, { key: "log.fetching" }, (repo) => fetchAll(makeGit(exec, repo.on), repo.root), cx);
}

// Popup size, px: title row, the group's caption, rows and separators.
const WIDTH = 300, TITLE = 34, CAPTION = 24, ROW = 26, RULE = 9, PAD = 5;
const heightOf = (items, group) => TITLE + (group ? 0 : CAPTION) + PAD * 2 + items.length * ROW + items.filter((it, i) => it.rule && i > 0).length * RULE;

// ask(panel, kind, group) → Promise<{ id, alt } | null>: opens the popup over the panel's
// copy and resolves with the pick. Items with an `off` check are asked first (a read).
// Await it inside cx.spawn.
async function ask(panel, kind, group) {
  const shown = vcsOpsItems(handledBy(kind), group), off = new Set();
  for (const it of shown) {
    const check = VCS_ACTIONS[it.id]?.off;
    if (check && (await check(panel))) off.add(it.id);
  }
  const items = vcsOpsItems(handledBy(kind), group, (id) => off.has(id)).map((it) => ({ ...it, label: panel.t(it.key) }));
  if (!items.length) return null;
  const key = `vcs-ops-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const answer = panel.bus.wait(key);
  openOverlay({ mod: MOD, kind: "popup", width: WIDTH, height: heightOf(items, group), props: { view: "vcs-ops", key, group: group ?? null, items, lang: panel.lang } });
  return answer;
}

// vcsOpsCommand(panel, kind, cx, { folder }): the panel's `vcs-ops` command. kind: "log"
// or "commit". folder: the copy's props.folder (a tab on a chosen folder never opens it).
export function vcsOpsCommand(panel, kind, cx, { folder = null } = {}) {
  if (!takesVcsOps(kind, { commitShown: commitPanelShown(layout()), logShown: logPanelShown() === true, folder })) return;
  const open = (group) => cx.spawn(async (cx) => {
    const pick = await ask(panel, kind, group);
    if (!pick || typeof pick.id !== "string") return;
    if (vcsOpsItems(handledBy(kind), pick.id).length) { open(pick.id); return; }
    if (handledBy(kind)(pick.id)) VCS_ACTIONS[pick.id].run(panel, cx, { kind, alt: pick.alt === true });
    cx.notify();
  });
  open(undefined);
}

export default class VcsOps {
  init(p, cx) {
    this.key = p.key;
    this.overlay = p.overlay;
    this.group = p.group ?? null;
    this.items = Array.isArray(p.items) ? p.items : [];
    this.at = Math.max(0, this.items.findIndex((it) => !it.disabled));
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  pick(i, alt) {
    const item = this.items[i];
    if (!item || item.disabled) return;
    answerMenu(this.bus, this.key, { id: item.id, alt: Boolean(alt) });
    closeOverlay(this.overlay);
  }

  // Dismissed without a pick: the owner's promise still settles.
  close() { answerMenu(this.bus, this.key, null); }

  move(by) {
    const n = this.items.length;
    for (let step = 1; step <= n; step++) {
      const i = (((this.at + by * step) % n) + n) % n;
      if (!this.items[i].disabled) { this.at = i; return; }
    }
  }

  key_down(e) {
    const alt = Boolean(e.modifiers?.alt);
    if (e.key === "down") this.move(1);
    else if (e.key === "up") this.move(-1);
    else if (e.key === "enter" || (e.key === "right" && this.items[this.at]?.sub)) this.pick(this.at, alt);
    else if (e.key === "escape") closeOverlay(this.overlay);
    else {
      // A digit picks its row (Option-digit types a character on many Mac keyboards).
      const i = numberedPick(this.items, e.key);
      if (i < 0) return false;
      this.pick(i, alt);
    }
    return true;
  }

  render() {
    const t = theme(), dark = darkLook(t.popover);
    return v_flex().id("vcs-ops").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => { if (this.key_down(e)) { cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(TITLE).flex_none().px(12).items_center().border_b(1).border_color(t.border).font_semibold()
        .child(div().flex_1().min_w(0).truncate().child(this.group ? this.t(`vcs-ops.${this.group}`) : this.t("vcs-ops.title"))))
      .child(v_flex().flex_1().min_h(0).p(PAD)
        .when(!this.group, (el) => el.child(div().h(CAPTION).flex_none().px(8).flex().items_center().text_size(11.5).text_color(t.dim).child(this.t("vcs-ops.group"))))
        .children(this.items.map((item, i) =>
          v_flex().flex_none()
            .when(Boolean(item.rule) && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex().id(`vcs-ops-${item.id}`).h(ROW).px(8).gap(8).rounded(6).items_center()
              .when(i === this.at && !item.disabled, (el) => el.bg(t.selected))
              .when(!item.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
                .on_click((e, cx) => { cx.stop_propagation(); this.pick(i, e.modifiers?.alt); }))
              .child(div().w(12).flex_none().text_size(11.5).text_color(t.dim).child(item.number ?? ""))
              .child(div().flex_1().min_w(0).truncate().text_color(item.disabled ? t.dim : t.foreground).child(item.label))
              .when(Boolean(item.sub), (el) => el.child(uiGlyph("chevron-right", { dark, size: 12 })))))));
  }
}
