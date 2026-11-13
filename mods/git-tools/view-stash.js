// Stash dialog (Stash Changes…): the Git root, the current branch, a message, Keep index
// and Include untracked, Cancel and Create Stash. With props.confirm it is instead the
// question before Drop ("drop", one stash) or Clear ("clear", every stash) from the
// Stash tab.
//
// The dialog doesn't write itself: it asks the panel copy that opened it (props.owner)
// to run the write under the repository's lock (serve-actions.js "stash-create",
// "stash-drop", "stash-clear"), so the write and its failure outlive a dialog Herdr
// closes on Esc. Nothing to stash: git makes nothing and says yes, the module notices
// (git-stash.js createStash) and the dialog stays open with "No local changes to save".
//
// props: { view: "stash", root, on, owner, overlay, confirm?, stash? }
//   confirm: "drop" | "clear". stash: { hash, ref, message }, the stash Drop removes.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { currentBranch } from "./git-reset.js";
import { createStash, dropStash, clearStashes } from "./git-stash.js";
import { openDialog, dialogFrame, button, checkbox, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

const str = (value) => (typeof value === "string" ? value : "");

// openStash({ root, on, owner, lang, who }): the Stash dialog on a repository. owner: the
// opening panel's bus id; that copy runs the write (the Commit panel and the Log panel
// both can). lang: the opener's (this.lang). who: the owner as the person knows it,
// "ui.commitPanel" (the default) or "ui.logPanel", for "didn't answer" sentences.
export function openStash({ root, on = null, owner = null, lang, who = "ui.commitPanel" } = {}) {
  return openDialog("stash", { root, on, owner, lang, who }, { width: 520, height: 300 });
}

// openStashConfirm({ root, on, owner, lang, confirm, stash }): the question before Drop
// ("drop", stash: { hash, ref, message }) or Clear ("clear").
export function openStashConfirm({ root, on = null, owner = null, lang, confirm, stash = null } = {}) {
  const { hash = "", ref = "", message = "" } = stash ?? {};
  return openDialog("stash", { root, on, owner, lang, confirm, stash: { hash, ref, message } }, { width: 460, height: 190 });
}

// The serving panel's side of the dialog's requests (serve-actions.js). args come from the
// dialog as plain JSON: each value is checked before use.
export const runStashCreate = (git, root, args) => createStash(git, root, { message: str(args.message), keepIndex: args.keepIndex === true, untracked: args.untracked === true });
export const runStashDrop = (git, root, args) => dropStash(git, root, { hash: str(args.hash) });
export const runStashClear = (git, root) => clearStashes(git, root);

export default class StashView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.confirm = p.confirm === "drop" || p.confirm === "clear" ? p.confirm : null;
    this.stash = p.stash ?? { hash: "", ref: "", message: "" };
    this.git = makeGit(exec, this.on);
    this.keepIndex = false;
    this.untracked = false;
    this.branch = undefined; // undefined: not read yet; null: a detached HEAD
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    if (this.confirm) { this.handle.focus(); return; }
    this.input = InputState.new({ value: "" });
    this.input.on("submit", (_e, cx) => this.run(cx));
    this.input.focus();
    // The dialog takes the keyboard as it opens; ask for it once more after that.
    cx.timer.after(300, () => { if (!this.waiting) this.input.focus(); });
    if (this.root) {
      cx.spawn(async (cx) => {
        const r = await currentBranch(this.git, this.root);
        this.branch = r.ok ? r.branch : null;
        cx.notify();
      });
    }
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || this.writing()) return;
    if (this.confirm === "drop" && !this.stash.hash) return;
    this.waiting = true; this.error = null;
    cx.notify();
    const action = this.confirm === "drop" ? "stash-drop" : this.confirm === "clear" ? "stash-clear" : "stash-create";
    const args = this.confirm === "drop" ? { hash: this.stash.hash }
      : this.confirm ? {}
      : { message: this.input.value(), keepIndex: this.keepIndex, untracked: this.untracked };
    askOwner(this, action, { root: this.root, on: this.on, ...args }, this.who, cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  option(id, on, label, t, flip) {
    return h_flex().id(`${id}-row`).flex_none().gap(7).items_center().cursor_pointer()
      .on_click((_e, cx) => { if (!this.waiting) flip(); cx.notify(); })
      .child(checkbox(id, on, t, { disabled: this.waiting, onClick: (_e, cx) => { flip(); cx.notify(); } }))
      .child(label);
  }

  renderConfirm(t) {
    const writing = this.writing(), said = this.error ?? writing;
    const drop = this.confirm === "drop", s = this.stash;
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(8)
      .child(div().w_full().child(drop ? this.t("stash.dropBody", { ref: s.ref, message: s.message }) : this.t("stash.clearBody")))
      .when(Boolean(said), (el) => el.child(scrollText("stash-confirm-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return this.frame("stash-confirm", drop ? this.t("stash.dropTitle", { ref: s.ref }) : this.t("stash.clearTitle"), t, body, [
      button("stash-confirm-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
      button("stash-confirm-ok", drop ? this.t("stash.drop") : this.t("stash.clear"), t, {
        kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
        onClick: (_e, cx) => this.run(cx),
      }),
    ], drop ? this.t("stash.dropping") : this.t("stash.clearing"));
  }

  frame(id, title, t, body, footer, working) {
    return dialogFrame(id, title, t, { body, footer, onClose: () => this.shut(), note: this.waiting ? working : "" })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.shut();
        else if (e.key === "enter" && this.confirm) this.run(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      });
  }

  render() {
    const t = theme();
    if (this.confirm) return this.renderConfirm(t);
    const writing = this.writing(), said = this.error ?? writing;
    const branch = this.branch === undefined ? "…" : this.branch ?? this.t("stash.detached");
    const label = (text) => div().w(110).flex_none().text_color(t.muted).child(text);
    const line = (id, name, value) => h_flex().id(id).w_full().gap(8).items_center().child(label(name)).child(value);
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(9)
      .child(line("stash-root", this.t("stash.root"), div().flex_1().min_w(0).truncate().child(this.root ?? "")))
      .child(line("stash-branch", this.t("stash.currentBranch"), div().flex_1().min_w(0).truncate().child(branch)))
      .child(line("stash-message", this.t("stash.message"), div().id("stash-message-box").flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(6).border_1()
        .border_color(t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
        .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(t.foreground))))
      .child(h_flex().w_full().gap(16).items_center()
        .child(this.option("stash-keep-index", this.keepIndex, this.t("stash.keepIndex"), t, () => { this.keepIndex = !this.keepIndex; }))
        .child(this.option("stash-untracked", this.untracked, this.t("stash.includeUntracked"), t, () => { this.untracked = !this.untracked; })))
      .when(Boolean(said), (el) => el.child(scrollText("stash-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return this.frame("stash", this.t("stash.title"), t, body, [
      button("stash-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
      button("stash-create", this.t("stash.create"), t, {
        kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
        onClick: (_e, cx) => this.run(cx),
      }),
    ], this.t("stash.stashing"));
  }
}
