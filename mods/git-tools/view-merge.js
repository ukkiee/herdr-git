// Merge dialog (VCS Operations popup: Merge…, title "Merge into main"): `git merge`, the
// branch (typed or picked from ▾), Modify options with the options picked shown under it,
// the message when -m is picked, Cancel and Merge.
//
// Also what every screen calls to start a merge or rebase (startOperation): the Branch
// tree's and the VCS widget popup's Merge, Rebase and Checkout and Rebase, the Commit
// list's Rebase onto Selected Commit, and the Merge and Rebase dialogs through their panel
// (serveOperation). What came of it is said there: the Conflicts dialog and a notification
// when it stopped on conflicts, the Smart dialog when local changes stood in the way,
// git's words when it failed.
//
// The dialog doesn't write itself: it asks the panel copy that opened it (props.owner) to
// run "merge-start" (serve-actions.js → serveOperation).
// props: { view: "merge", root, on, owner, who, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, notify } from "herdr";
import { makeGit } from "./git.js";
import { readBranches } from "./git-branch.js";
import { runOperation, requestProblem } from "./git-operation.js";
import { offerSmart } from "./view-smart.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, openMenu, iconButton } from "./ui.js";

const stop = (_e, cx) => cx.stop_propagation();
const str = (value) => (typeof value === "string" ? value : "");
const MENU_MAX = 20;

// ---- starting a merge or rebase from any screen

// startOperation(repo, request, { owner, lang, who, t }) → a screen write's result.
//   repo: { git, root, on }. request: git-operation.js runOperation's ({ type: "merge" |
//   "rebase" | "checkout-rebase", ... }). owner, lang, who: the screen that runs the writes
//   of the dialogs this may open (its bus id, language, and name as a message key).
//   A request that stopped has been told (Conflicts dialog, notification) and comes back
//   as { ok: true } without its outcome, so the caller doesn't tell it again. One local
//   changes refused opened the Smart dialog: { ok: false, quiet: true, smart: true }.
export async function startOperation(repo, request, { owner = null, lang, who = "ui.logPanel", t = (key) => key } = {}) {
  const r = await runOperation(repo.git, repo.root, request);
  if (offerSmart(r, { root: repo.root, on: repo.on ?? null, owner, lang, who, request })) return { ok: false, quiet: true, smart: true };
  if (r.outcome !== "stopped") return r;
  if (openConflictsIfStopped(r, { root: repo.root, on: repo.on ?? null, owner, lang, who })) {
    if (r.operation?.kind === "merge") notify({ title: t("merge.mergedWithConflicts", { name: r.operation.target ?? str(request.target) }), body: "", level: "warning" });
    else if (r.operation?.kind === "rebase") notify({ title: t("merge.rebaseStopped"), body: r.operation.current?.subject ?? "", level: "warning" });
  }
  return { ok: true, code: r.code, out: r.out, err: r.err, operation: r.operation };
}

// The work names the write lock shows while a request runs.
export const WORK = { merge: { key: "merge.merging" }, rebase: { key: "merge.rebasing" }, "checkout-rebase": { key: "merge.rebasing" } };

// operateHere(host, request, cx): a Log panel menu item's merge or rebase (Branch tree,
// Commit list), run as the Branch tree's write under the repository's lock.
export function operateHere(host, request, cx) {
  host.branches.act(WORK[request.type], (repo) => startOperation(repo, request, { owner: host.bus.id, lang: host.lang, who: "ui.logPanel", t: host.t }), cx);
}

// operateFromWidget(w, request, cx): the same from the VCS widget popup's branch menu,
// as the widget's write.
export function operateFromWidget(w, request, cx) {
  w.write(WORK[request.type], (repo) => startOperation(repo, request, { owner: w.host.bus.id, lang: w.host.lang, who: w.who, t: w.host.t }), cx);
}

// The requests a dialog may ask its panel to start, from plain JSON.
const TYPES = ["merge", "rebase", "checkout-rebase"];
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
function requestOf(value) {
  if (!value || typeof value !== "object" || !TYPES.includes(value.type)) return null;
  return {
    type: value.type, target: str(value.target), options: strings(value.options), message: str(value.message),
    onto: str(value.onto), branch: str(value.branch), name: str(value.name), remote: value.remote === true,
  };
}

// serveOperation(git, root, args, panel): the serving panel's side of "merge-start" and
// "rebase-start" (serve-actions.js). args: { request, on?, who? } as plain JSON. A refusal
// that opened the Smart dialog counts as done for the asking dialog: it closes, and the
// Smart dialog carries on.
export async function serveOperation(git, root, args, panel) {
  const request = requestOf(args?.request);
  if (!request) return { ok: false, code: -1, out: "", err: "The request names nothing to run.", msg: { key: "smart.badRequest" } };
  const on = typeof args.on === "string" ? args.on : null;
  const who = str(args.who) || "ui.commitPanel";
  const r = await startOperation({ git, root, on }, request, { owner: panel?.bus?.id ?? null, lang: panel?.lang, who, t: panel?.t });
  return r.smart ? { ok: true } : r;
}

// ---- parts both dialogs draw

// A text field with ▾ on its right that lists the branches; picking one puts it in.
//   names: the branch names to list. The text typed so far narrows the list.
export function branchField(screen, id, input, t, { names = [], width, placeholder = "" } = {}) {
  const pick = (e, cx) => {
    cx.stop_propagation();
    const typed = input.value().trim().toLowerCase();
    const shown = names.filter((n) => !typed || n.toLowerCase().includes(typed));
    const list = (shown.length ? shown : names).slice(0, MENU_MAX);
    if (!list.length) return;
    cx.spawn(async (cx) => {
      const picked = await openMenu(screen.bus, list.map((n) => ({ label: n, value: n })), { width: 280, at: e?.position, lang: screen.lang });
      if (typeof picked === "string") { input.set_value(picked); screen.changed?.(cx); }
      cx.notify();
    });
  };
  let box = h_flex().id(id).min_w(0).h(28).pl(8).pr(2).gap(2).items_center().rounded(6).border_1()
    .border_color(t.input).bg(t.background).cursor_text()
    .on_mouse_down("left", (_e, cx) => { input.focus(); cx.stop_propagation(); })
    .child(div().flex_1().min_w(0).child(Input.new(input).w_full().h_full().text_size(13).text_color(t.foreground)))
    .child(iconButton(`${id}-pick`, "dropdown", t, { title: placeholder || undefined, size: 22, disabled: !names.length, onClick: pick }));
  box = width ? box.w(width).flex_none() : box.flex_1();
  return box;
}

// The options picked, each a chip with its flag and ✕.
export function optionChips(id, picked, t, { label = (o) => o, removeTitle, onRemove } = {}) {
  return h_flex().w_full().flex_wrap().gap(6).children(picked.map((o, i) =>
    h_flex().id(`${id}-${i}`).h(24).pl(8).pr(2).gap(2).items_center().rounded(12).bg(t.raised).text_size(12)
      .child(div().child(label(o)))
      .child(iconButton(`${id}-${i}-x`, "x", t, { title: removeTitle, size: 18, onClick: (_e, cx) => { cx.stop_propagation(); onRemove?.(o, cx); } }))));
}

// Modify options ▾: a menu of the options not picked yet (description, the flag dim on
// the right). pick(option, cx) with the one chosen.
export function modifyOptions(screen, id, t, { options, picked, label, title, pick }) {
  return h_flex().id(id).h(26).px(8).gap(4).items_center().rounded(5).cursor_pointer().text_color(t.accent)
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop)
    .on_click((e, cx) => {
      const left = options.filter((o) => !picked.includes(o.flag));
      if (!left.length) return;
      cx.spawn(async (cx) => {
        const chosen = await openMenu(screen.bus, left.map((o) => ({ label: screen.t(o.key), value: o.flag, hint: o.hint ?? o.flag })), { width: 420, at: e?.position, lang: screen.lang });
        if (typeof chosen === "string") pick(chosen, cx);
        cx.notify();
      });
    })
    .child(title)
    .child(div().text_color(t.muted).child("▾"));
}

// ---- the Merge dialog

// The options as the dialog lists them, in the order of the reference product's
// documentation (the dialog itself wasn't seen).
const MERGE_OPTIONS = [
  { flag: "--ff-only", key: "merge.optFfOnly" },
  { flag: "--no-ff", key: "merge.optNoFf" },
  { flag: "--squash", key: "merge.optSquash" },
  { flag: "-m", key: "merge.optMessage" },
  { flag: "--no-commit", key: "merge.optNoCommit" },
  { flag: "--no-verify", key: "merge.optNoVerify" },
  { flag: "--allow-unrelated-histories", key: "merge.optUnrelated" },
];

// openMerge({ root, on, owner, who, lang })
//   owner: the opening panel's bus id; that copy runs the merge. who: that panel's message
//   key ("ui.commitPanel" or "ui.logPanel").
export function openMerge({ root, on = null, owner = null, who = "ui.commitPanel", lang } = {}) {
  return openDialog("merge", { root, on, owner, who, lang }, { width: 560, height: 300 });
}

export default class MergeView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.git = makeGit(exec, this.on);
    this.current = undefined; // undefined: not read yet; null: a detached HEAD
    this.names = [];
    this.picked = [];
    this.waiting = false;
    this.error = null;
    this.target = InputState.new({ placeholder: this.t("merge.branch") });
    this.message = InputState.new({ placeholder: this.t("merge.message") });
    for (const input of [this.target, this.message]) {
      input.on("change", (_e, cx) => this.changed(cx));
      input.on("submit", (_e, cx) => this.run(cx));
    }
    this.target.focus();
    if (this.root) {
      cx.spawn(async (cx) => {
        const r = await readBranches(this.git, this.root);
        if (r.ok) {
          this.current = r.head.branch;
          this.names = [...r.local.filter((b) => !b.current).map((b) => b.name), ...r.remote.map((b) => b.name)];
        } else this.current = null;
        cx.notify();
      });
    }
  }

  changed(cx) { this.error = null; cx.notify(); }

  request() {
    return { type: "merge", target: this.target.value().trim(), options: [...this.picked], ...(this.picked.includes("-m") ? { message: this.message.value() } : {}) };
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || this.writing() || requestProblem(this.request())) return;
    this.waiting = true; this.error = null;
    askOwner(this, "merge-start", { root: this.root, on: this.on, who: this.who, request: this.request() }, this.who, cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  pick(flag, cx) {
    if (!this.picked.includes(flag)) this.picked = [...this.picked, flag];
    if (flag === "-m") this.message.focus();
    this.changed(cx);
  }

  render() {
    const t = theme(), writing = this.writing(), problem = requestProblem(this.request());
    const title = this.current ? this.t("merge.mergeTitle", { current: this.current }) : this.t("merge.mergeChanges");
    const said = this.error ?? writing;
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(10)
      .child(h_flex().w_full().gap(8).items_center()
        .child(div().flex_none().text_color(t.muted).child("git merge"))
        .child(branchField(this, "merge-target", this.target, t, { names: this.names, placeholder: this.t("merge.pickBranch") })))
      .child(h_flex().w_full().items_center()
        .child(modifyOptions(this, "merge-options", t, {
          options: MERGE_OPTIONS, picked: this.picked, title: this.t("merge.modifyOptions"),
          pick: (flag, cx) => this.pick(flag, cx),
        })))
      .when(this.picked.length > 0, (el) => el.child(optionChips("merge-picked", this.picked, t, {
        removeTitle: this.t("merge.remove"),
        onRemove: (o, cx) => { this.picked = this.picked.filter((x) => x !== o); this.changed(cx); },
      })))
      .when(this.picked.includes("-m"), (el) => el.child(div().id("merge-message").w_full().h(28).px(8).flex().items_center().rounded(6).border_1()
        .border_color(t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { this.message.focus(); cx.stop_propagation(); })
        .child(Input.new(this.message).w_full().h_full().text_size(13).text_color(t.foreground))))
      .when(Boolean(said), (el) => el.child(scrollText("merge-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("merge", title, t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("merge.merging") : "",
      footer: [
        button("merge-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("merge-run", this.t("merge.merge"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root || Boolean(problem), busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      this.shut();
      cx.stop_propagation();
    });
  }
}
