// Smart dialog ("Git Checkout Problem"): the local changes in the way of a request, as a
// file tree (group by directory, expand and collapse all), the sentence on what Smart
// does, and the buttons. A checkout has Force Checkout, Don't Checkout and Smart Checkout;
// any other request Cancel and Smart <request>.
//
// The dialog doesn't write itself: it asks the screen copy that opened it (props.owner)
// to run Smart or the forced checkout (serve-actions.js "smart-run" and "smart-force" →
// runSmartRequest),
// which tells what came of it: the Conflicts dialog when files are left in conflict, a
// notification when the changes stay in the stash.
//
// What screens call (git-smart.js does the git part):
//   offerSmart(result, args)        a request came back refused: opens this dialog
//   smartCheckout(repo, b, args)    a checkout as a screen's write, Smart when refused
//   settleSmartMark(panel, repo, op, cx)  the Commit panel's read found nothing in
//                                   progress: brings back what a stopped Smart left
//
// props: { view: "smart", root, on, owner, who, overlay, request, blocked }

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, notify } from "herdr";
import { checkoutBranch, smartRun, forceCheckout, readSmartMark, settleSmartStash } from "./git-smart.js";
import { buildRows, folderKeys } from "./tree.js";
import { pickNotes, commitsOf, noteText } from "./pick-notes.js";
import { openConflicts } from "./view-conflicts.js";
import { openDialog, dialogFrame, button, iconButton, row, notice, errorStrip, uiGlyph, ICON, fileGlyph, folderGlyph, darkLook, close, WindowedList, askOwner, writeBlock, sentence, broadcast, copyId } from "./ui.js";

const stop = (_e, cx) => cx.stop_propagation();
const str = (value) => (typeof value === "string" ? value : "");
const COPY_KEY = "commit.copy";

// The requests Smart knows, with their words: [name on a button, verb in a sentence].
const WORDS = {
  checkout: ["smart.nameCheckout", "smart.verbCheckout"],
  merge: ["smart.nameMerge", "smart.verbMerge"],
  pull: ["smart.namePull", "smart.verbPull"],
  rebase: ["smart.nameRebase", "smart.verbRebase"],
  "cherry-pick": ["smart.nameCherryPick", "smart.verbCherryPick"],
  revert: ["smart.nameRevert", "smart.verbRevert"],
  "checkout-rebase": ["smart.nameCheckoutRebase", "smart.verbCheckoutRebase"],
};
const wordsFor = (t, type) => { const [name, op] = WORDS[type] ?? WORDS.checkout; return { name: t(name), op: t(op) }; };

// A request as plain JSON, or null: { type, ...args } with a type Smart knows.
function requestOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.prototype.hasOwnProperty.call(WORDS, value.type) ? JSON.parse(JSON.stringify(value)) : null;
}

// openSmart({ root, on, owner, lang, who, request, blocked })
//   request: { type, ...args } as git-smart.js smartRun runs it (plain JSON).
//   blocked: the paths in the way. owner: the opener's bus id; that copy runs the writes.
//   who: the opener as the person knows it, a message key ("ui.logPanel").
export function openSmart({ root, on = null, owner = null, lang, who = "ui.commitPanel", request, blocked = [] } = {}) {
  return openDialog("smart", { root, on, owner, who, lang, request, blocked: blocked.filter((p) => typeof p === "string") }, { width: 560, height: 440 });
}

// offerSmart(result, { root, on, owner, lang, who, request }) → true when it opened the
// Smart dialog: what a screen calls with the result of a request it ran (a refusal with
// the files in the way, git-operation.js runOperation's outcome "refused" and blocked).
export function offerSmart(result, args) {
  if (result?.outcome !== "refused" || !Array.isArray(result.blocked) || !result.blocked.length || !requestOf(args?.request)) return false;
  openSmart({ ...args, blocked: result.blocked });
  return true;
}

// smartCheckout(repo, { name, remote }, { owner, lang, who }) → a screen write's result:
// the checkout, or, when local changes refused it, the Smart dialog and { ok: false,
// quiet: true } (nothing changed, nothing to say in a strip).
export async function smartCheckout(repo, { name, remote = false }, { owner = null, lang, who } = {}) {
  const request = { type: "checkout", name, remote: remote === true };
  const r = await checkoutBranch(repo.git, repo.root, request);
  if (offerSmart(r, { root: repo.root, on: repo.on ?? null, owner, lang, who, request })) return { ok: false, quiet: true };
  return r;
}

// What came of a Smart run, said where the person sees it: the Conflicts dialog for files
// left in conflict, a notification when the changes stay in the stash, and a Cherry-Pick's
// or Revert's own notifications as the run without Smart has them (pick-notes.js).
// request: the request run, when there is one.
function tell(r, { root, on, panel, who, type, request = null }) {
  const t = panel?.t ?? ((key) => key), words = wordsFor(t, type);
  const ref = r.stash?.ref ?? r.stash?.hash?.slice(0, 7) ?? "";
  const conflicts = r.operation?.conflicts?.length > 0;
  const stopped = r.outcome === "stopped" && r.operation?.kind;
  // Stopped with nothing in progress: the request went through, only the changes came back
  // in conflict.
  const ran = { ...r, outcome: r.outcome === "stopped" && !stopped ? "done" : r.outcome };
  if (request) for (const n of pickNotes(type, commitsOf(request), ran)) notify(noteText(t, n));
  if (stopped) notify({ title: t("smart.kept"), body: t("smart.keptBody", { ref, op: words.op }), level: "warning" });
  else if (r.outcome === "stopped" && r.kept) notify({ title: t("smart.backConflict"), body: t("smart.backConflictBody", { ref }), level: "warning" });
  else if (r.kept) notify({ title: t("smart.backFailed"), body: t("smart.backFailedBody", { ref }), level: "error" });
  if (conflicts) openConflicts({ root, on, owner: panel?.bus?.id ?? null, lang: panel?.lang, who, stash: stopped ? null : r.stash?.ref ?? null });
}

// runSmartRequest(git, root, args, panel): the serving copy's side of "smart-run" and
// "smart-force" (serve-actions.js, which sets the mode). args: { request, mode: "smart" | "force", on?, who? } as plain JSON.
// panel: the serving copy ({ bus, lang, t, copy? }). A request that stopped, or whose
// changes came back in conflict, counts as done: the person goes on from there.
export async function runSmartRequest(git, root, args, panel) {
  const request = requestOf(args?.request);
  const bad = { ok: false, code: -1, out: "", err: "The request names nothing to run.", msg: { key: "smart.badRequest" } };
  if (!request) return bad;
  const on = typeof args.on === "string" ? args.on : null, who = str(args.who) || "ui.commitPanel";
  if (args.mode === "force") {
    if (request.type !== "checkout") return bad;
    const copy = typeof panel?.copy === "string" ? panel.copy : copyId(COPY_KEY);
    return forceCheckout(git, root, { name: str(request.name), remote: request.remote === true, copy });
  }
  const r = await smartRun(git, root, { request });
  tell(r, { root, on, panel, who, type: request.type, request });
  return r.outcome === "stopped" ? { ...r, ok: true } : r;
}

// settleSmartMark(panel, repo, op, cx): after the Commit panel read `op` (readOperation)
// on `repo`. Once nothing is in progress, a stash a stopped Smart left is brought back
// under the repository's write lock; when anyone else writes, the next read tries again.
export function settleSmartMark(panel, repo, op, cx) {
  if (!repo || !op?.ok || op.kind || op.conflicts.length || panel.smartSettling) return;
  panel.smartSettling = true;
  cx.spawn(async (cx) => {
    try {
      const mark = await readSmartMark(repo.git, repo.root);
      if (!mark.ok || !mark.hash || writeBlock(panel, repo)) return;
      if (!panel.setBusy({ key: "smart.restoring" }, cx, repo)) return;
      let r;
      try { r = await settleSmartStash(repo.git, repo.root); } catch (error) { r = { ok: false, err: String(error?.message ?? error), outcome: "failed" }; }
      panel.setBusy(null, cx);
      if (r.changed) broadcast({ type: "changed", root: repo.root });
      if (r.outcome === "stopped" || (r.outcome === "failed" && r.stash)) tell({ ...r, kept: true }, { root: repo.root, on: repo.on ?? null, panel, who: "ui.commitPanel", type: "checkout" });
      else if (!r.ok && r.err) notify({ title: panel.t("smart.backFailed"), body: sentence(panel.t, r.msg, r.err), level: "error" });
    } finally {
      panel.smartSettling = false;
      cx.notify();
    }
  });
}

export default class SmartView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = str(p.who) || "ui.commitPanel";
    this.request = requestOf(p.request);
    this.files = (Array.isArray(p.blocked) ? p.blocked : []).filter((path) => typeof path === "string").map((path) => ({ path, status: "modified" }));
    this.grouped = true;
    this.collapsed = new Set();
    this.rows = [];
    this.at = -1;
    this.running = null; // "smart" | "force" while the owner runs it
    this.error = null;
    this.list = new WindowedList("smart-files");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.rebuild();
  }

  // Built when the folding changes, never in render.
  rebuild() {
    this.rows = buildRows(this.files, { grouped: this.grouped, compact: true, collapsed: this.collapsed })
      .map((r) => ({ ...r, id: r.key, kind: r.folder ? "folder" : "file" }));
    if (this.at >= this.rows.length) this.at = -1;
  }

  setGrouped(grouped) { this.grouped = grouped; this.rebuild(); }
  expandAll() { this.collapsed = new Set(); this.rebuild(); }
  collapseAll() { this.collapsed = new Set(folderKeys(this.files, { compact: true })); this.rebuild(); }
  toggleOpen(r) {
    if (r.kind !== "folder") return;
    if (!this.collapsed.delete(r.key)) this.collapsed.add(r.key);
    this.rebuild();
  }

  writing() { return this.running || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(mode, cx) {
    if (this.running || !this.root || !this.request || this.writing()) return;
    this.running = mode; this.error = null;
    cx.notify();
    askOwner(this, mode === "force" ? "smart-force" : "smart-run", { root: this.root, on: this.on, request: this.request, who: this.who }, this.who, cx, (r) => {
      this.running = null;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.running) close(this.overlay); }

  renderRow(i, t) {
    const r = this.rows[i], folds = r.kind === "folder";
    const el = row(`smart-row-${r.id}`, t, { selected: i === this.at, depth: r.depth })
      .on_click((e, cx) => { this.handle.focus(); this.at = i; if (e.click_count === 2) this.toggleOpen(r); cx.notify(); })
      .child(folds
        ? div().id(`smart-fold-${r.id}`).size(ICON).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleOpen(r); cx.notify(); })
          .child(uiGlyph(r.open ? "chevron-down" : "chevron-right"))
        : div().size(ICON).flex_none());
    if (folds) {
      return el.child(folderGlyph(r.name, { open: r.open }))
        .child(div().flex_none().max_w("70%").truncate().child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.t("dialogs.files", { n: r.count })));
    }
    // Flat rows say where the file is; in the tree its folders already do.
    const where = this.grouped ? "" : r.dir;
    const name = div().truncate().text_color(t.ansi4).child(r.name);
    return el.child(fileGlyph(r.path, { dark: this.dark }))
      .child(where ? name.flex_none().max_w("70%") : name.flex_1().min_w(0))
      .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where)));
  }

  render() {
    const t = theme(), type = this.request?.type ?? "checkout", words = wordsFor(this.t, type), writing = this.writing();
    this.dark = darkLook(t.background);
    const redraw = (fn) => (_e, cx) => { fn(); cx.notify(); };
    const list = this.rows.length ? this.list.render(this.rows.length, (i) => this.renderRow(i, t), t) : notice(this.t("smart.noFiles"), t);
    const body = v_flex().size_full().min_h(0)
      .child(div().id("smart-explain").flex_none().px(14).pt(12).pb(6).text_size(13).child(this.t("smart.explain", words)))
      .child(h_flex().h(32).flex_none().px(10).gap(2).items_center()
        .child(iconButton("smart-group", "folder", t, { title: this.t("smart.groupByDirectory"), active: this.grouped, onClick: redraw(() => this.setGrouped(!this.grouped)) }))
        .child(iconButton("smart-expand", "expand-all", t, { title: this.t("smart.expandAll"), disabled: !this.rows.length, onClick: redraw(() => this.expandAll()) }))
        .child(iconButton("smart-collapse", "collapse-all", t, { title: this.t("smart.collapseAll"), disabled: !this.rows.length, onClick: redraw(() => this.collapseAll()) })))
      .child(div().id("smart-list").flex_1().min_h(0).mx(12).rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(list))
      .child(div().h(8).flex_none())
      .when(Boolean(this.error), (el) => el.child(errorStrip("smart-error", this.error ?? "", t, redraw(() => { this.error = null; }))));
    const off = Boolean(this.running) || Boolean(writing) || !this.root || !this.request;
    const smart = button("smart-run", this.t("smart.smart", words), t, {
      kind: "primary", disabled: off, busy: this.running === "smart", title: writing ?? undefined, onClick: (_e, cx) => this.run("smart", cx),
    });
    // Not "smart-close": dialogFrame gives its × that id.
    const footer = type === "checkout"
      ? [
        button("smart-force", this.t("smart.force"), t, { disabled: off, busy: this.running === "force", title: writing ?? undefined, onClick: (_e, cx) => this.run("force", cx) }),
        button("smart-dont", this.t("smart.dont", words), t, { disabled: Boolean(this.running), onClick: () => this.shut() }),
        smart,
      ]
      : [button("smart-cancel", this.t("dialogs.cancel"), t, { disabled: Boolean(this.running), onClick: () => this.shut() }), smart];
    return dialogFrame("smart", this.t("smart.title", words), t, {
      body, onClose: () => this.shut(), footer,
      note: this.running === "force" ? this.t("smart.forcing") : this.running ? this.t("smart.running", words) : writing ?? "",
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "enter") this.run("smart", cx);
      else return;
      cx.stop_propagation();
    });
  }
}
