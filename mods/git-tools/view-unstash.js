// Unstash dialog ("Unstash Changes in <folder>", the Stash tab's Unstash…): the current
// branch, As new branch, Pop stash and Reinstate index, Cancel and Apply Stash (Pop
// Stash while Pop is checked, Branch while a branch name is typed: a new branch takes the
// stash whole, so Pop and Reinstate index are checked and fixed then).
//
// The dialog doesn't write itself: it asks the panel copy that opened it (props.owner)
// to run the unstash (serve-actions.js "stash-apply" → runUnstash). When files are left
// in conflict, that panel opens the Conflicts dialog and the stash stays in the list.
//
// props: { view: "unstash", root, on, owner, overlay, stash: { hash, ref, message } }

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { currentBranch } from "./git-reset.js";
import { applyStash } from "./git-stash.js";
import { stoppedOnConflicts } from "./conflicts-model.js";
import { openConflicts } from "./view-conflicts.js";
import { openDialog, dialogFrame, button, checkbox, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

const str = (value) => (typeof value === "string" ? value : "");
const folderName = (root) => String(root ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

// openUnstash({ root, on, owner, lang, stash }): the Unstash dialog for one stash
// ({ hash, ref, message }, a Stash tab row). owner: the opening panel's bus id.
export function openUnstash({ root, on = null, owner = null, lang, stash } = {}) {
  const { hash = "", ref = "", message = "" } = stash ?? {};
  return openDialog("unstash", { root, on, owner, lang, stash: { hash, ref, message } }, { width: 480, height: 260 });
}

// unstashWork(args) → the lock's work for an unstash with these args (the words the lock
// and the asking button show).
export const unstashWork = (args) => (str(args?.branch).trim() ? "stash.branching" : args?.pop === true ? "stash.popping" : "stash.applying");

// runUnstash(git, root, args, panel): the serving panel's side of "stash-apply"
// (serve-actions.js), and the Stash tab's own Apply and Pop.
//   args: { hash, ref?, pop?, index?, branch?, on? } as plain JSON from the asker.
//   panel: the serving copy ({ bus, lang }). Files left in conflict: it opens the
//   Conflicts dialog on the repository and the request counts as done (the stash stays,
//   the person goes on from there).
export async function runUnstash(git, root, args, panel) {
  const r = await applyStash(git, root, { hash: str(args.hash), pop: args.pop === true, index: args.index === true, branch: str(args.branch) });
  if (!stoppedOnConflicts(r)) return r;
  openConflicts({ root, on: typeof args.on === "string" ? args.on : null, owner: panel?.bus?.id ?? null, lang: panel?.lang, stash: str(args.ref) || null });
  return { ...r, ok: true };
}

export default class UnstashView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.stash = p.stash ?? { hash: "", ref: "", message: "" };
    this.git = makeGit(exec, this.on);
    this.pop = false;
    this.index = false;
    this.branch = undefined; // undefined: not read yet; null: a detached HEAD
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.run(cx));
    this.handle.focus();
    if (this.root) {
      cx.spawn(async (cx) => {
        const r = await currentBranch(this.git, this.root);
        this.branch = r.ok ? r.branch : null;
        cx.notify();
      });
    }
  }

  newBranch() { return this.input.value().trim(); }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || !this.stash.hash || this.writing()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    const branch = this.newBranch();
    const args = { root: this.root, on: this.on, hash: this.stash.hash, ref: this.stash.ref, pop: branch ? true : this.pop, index: branch ? true : this.index, branch };
    askOwner(this, "stash-apply", args, "ui.commitPanel", cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  option(id, on, label, t, fixed, flip) {
    const off = fixed || this.waiting;
    return h_flex().id(`${id}-row`).flex_none().gap(7).items_center()
      .when(!off, (el) => el.cursor_pointer().on_click((_e, cx) => { flip(); cx.notify(); }))
      .child(checkbox(id, on, t, { disabled: off, onClick: (_e, cx) => { flip(); cx.notify(); } }))
      .child(div().text_color(off ? t.dim : t.foreground).child(label));
  }

  render() {
    const t = theme(), writing = this.writing(), said = this.error ?? writing;
    const branch = this.branch === undefined ? "…" : this.branch ?? this.t("stash.detached");
    const naming = Boolean(this.newBranch());
    const label = (text) => div().w(110).flex_none().text_color(t.muted).child(text);
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(9)
      .child(h_flex().w_full().gap(8).items_center().child(label(this.t("stash.currentBranch"))).child(div().flex_1().min_w(0).truncate().child(branch)))
      .child(h_flex().w_full().gap(8).items_center().child(label(this.t("stash.asNewBranch")))
        .child(div().id("unstash-branch").flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(6).border_1()
          .border_color(t.input).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
          .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(t.foreground))))
      .child(h_flex().w_full().gap(16).items_center()
        .child(this.option("unstash-pop", naming || this.pop, this.t("stash.popStash"), t, naming, () => { this.pop = !this.pop; }))
        .child(this.option("unstash-index", naming || this.index, this.t("stash.reinstateIndex"), t, naming, () => { this.index = !this.index; })))
      .when(Boolean(said), (el) => el.child(scrollText("unstash-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    const go = naming ? "stash.branchButton" : this.pop ? "stash.popStashButton" : "stash.applyStash";
    return dialogFrame("unstash", this.t("stash.unstashTitle", { folder: folderName(this.root) }), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t(unstashWork({ pop: this.pop, branch: this.newBranch() })) : "",
      footer: [
        button("unstash-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("unstash-run", this.t(go), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root || !this.stash.hash, busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else return;
      cx.stop_propagation();
    });
  }
}
