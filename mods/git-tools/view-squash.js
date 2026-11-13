// Squashed Commit Message dialog (Commit list: Squash Commits…, two or more commits): the
// message of the one commit they become, at first the messages of the commits picked,
// oldest first, one after another. Cancel and OK. The Log panel copy that opened it
// (props.owner) squashes under the repository's write lock (serve-actions.js
// "rewrite-squash" → git-rewrite.js squashCommits). The first-commit question and the
// Force Push note are view-reword.js's.
//
// props: { view: "squash", root, on, owner, commits: [hash] (newest first), message,
//   pushed, initial, overlay }.

import { div } from "gpui-kit";
import { v_flex, TextareaState } from "gpui-base";
import { theme } from "herdr";
import { openDialog, dialogFrame, button, close, writeBlock, scrollText, textBox } from "./ui.js";
import { initialStep, forcePushNote, askRewrite } from "./view-reword.js";

// openSquash({ root, on, owner, commits, message, pushed, initial, lang })
//   commits: the hashes picked, newest first. message: the message to start from.
export function openSquash({ root, on = null, owner = null, commits = [], message = "", pushed = false, initial = false, lang } = {}) {
  return openDialog("squash", { root, on, owner, commits, message, pushed, initial, lang }, { width: 560, height: 360 });
}

export default class SquashView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.commits = Array.isArray(p.commits) ? p.commits : [];
    this.pushed = Boolean(p.pushed);
    this.initial = Boolean(p.initial);
    this.text = TextareaState.new({ value: typeof p.message === "string" ? p.message : "", rows: 8 });
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || this.commits.length < 2 || this.writing()) return;
    const message = this.text.value();
    if (!message.trim()) { this.error = this.t("commit.noMessage"); cx.notify(); return; }
    askRewrite(this, "rewrite-squash", { commits: this.commits, message }, cx);
  }

  shut() { if (!this.waiting) close(this.overlay); }

  render() {
    const t = theme();
    const asking = initialStep(this, "squash", t);
    if (asking) return asking;
    const writing = this.writing(), said = this.error ?? writing;
    const body = v_flex().size_full().min_h(0).px(14).py(10).gap(8)
      .child(div().w_full().truncate().child(this.t("rewrite.squashDescription")))
      .child(textBox("squash-message", this.text, t, { focused: true }))
      .when(this.pushed, (el) => el.child(forcePushNote(this, t)))
      .when(Boolean(said), (el) => el.child(scrollText("squash-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("squash", this.t("rewrite.squashTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("rewrite.squashing") : "",
      footer: [
        button("squash-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("squash-ok", this.t("rewrite.ok"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) this.run(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
