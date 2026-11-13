// Edit Commit Message dialog (Commit list: Edit Commit Message…): "Edit message for commit
// <hash> by <author>", the message as it is now, Cancel and OK. The last commit gets the
// message by an amend, an older one by replaying the branch (git-rewrite.js editMessage).
//
// The dialog doesn't write itself: it asks the Log panel copy that opened it (props.owner)
// to run the edit under the repository's write lock (serve-actions.js "rewrite-reword"),
// so the edit, the "changed" and a stop on conflicts outlive a dialog Herdr closes on Esc.
//
// Before the form, two things may show (here and in view-squash.js, view-drop-commits.js):
// a question when the edit touches the first commit of the history (initialStep), and a
// note when the commits are already on a remote, so the next push needs Force Push.
//
// props: { view: "reword", root, on, owner, commit: { hash, author, message }, pushed,
//   initial, overlay }.

import { div } from "gpui-kit";
import { v_flex, TextareaState } from "gpui-base";
import { theme } from "herdr";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, textBox } from "./ui.js";

const SHORT = 8;

// openReword({ root, on, owner, commit, pushed, initial, lang })
//   commit: { hash, author, message } (the whole message). pushed: the commit is on a
//   remote (git-rewrite.js readEditFacts). initial: it is the first commit of the history.
//   owner: the opening Log panel's bus id; lang: its language.
export function openReword({ root, on = null, owner = null, commit, pushed = false, initial = false, lang } = {}) {
  const { hash = "", author = "", message = "" } = commit ?? {};
  return openDialog("reword", { root, on, owner, commit: { hash, author, message }, pushed, initial, lang }, { width: 560, height: 340 });
}

// initialStep(screen, id, t, cx): the question asked before an edit of the first commit,
// as the dialog's whole frame, or null once answered (screen.initial false). screen:
// { initial, overlay, t }.
export function initialStep(screen, id, t) {
  if (!screen.initial) return null;
  return dialogFrame(`${id}-initial`, screen.t("rewrite.initialTitle"), t, {
    body: div().px(14).py(12).child(screen.t("rewrite.initialBody")),
    onClose: () => close(screen.overlay),
    footer: [
      button(`${id}-initial-cancel`, screen.t("dialogs.cancel"), t, { onClick: () => close(screen.overlay) }),
      button(`${id}-initial-ok`, screen.t("rewrite.ok"), t, { kind: "primary", onClick: (_e, cx) => { screen.initial = false; screen.handle?.focus(); cx.notify(); } }),
    ],
  });
}

// The note under a form whose commits are already pushed.
export function forcePushNote(screen, t) {
  return div().w_full().text_size(12).text_color(t.ansi3).child(screen.t("rewrite.forcePush"));
}

// A message dialog's shared part: asks the owner, closes on success, else shows why.
export function askRewrite(screen, action, args, cx) {
  screen.waiting = true; screen.error = null;
  cx.notify();
  askOwner(screen, action, { root: screen.root, on: screen.on, ...args }, "ui.logPanel", cx, (r) => {
    screen.waiting = false;
    if (r.ok) close(screen.overlay);
    else screen.error = sentence(screen.t, r.msg, r.err) || screen.t("ui.gitFailed");
  });
}

export default class RewordView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.commit = p.commit ?? { hash: "", author: "", message: "" };
    this.pushed = Boolean(p.pushed);
    this.initial = Boolean(p.initial);
    this.text = TextareaState.new({ value: this.commit.message, rows: 6 });
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || !this.commit.hash || this.writing()) return;
    const message = this.text.value();
    if (!message.trim()) { this.error = this.t("commit.noMessage"); cx.notify(); return; }
    askRewrite(this, "rewrite-reword", { commit: this.commit.hash, message }, cx);
  }

  shut() { if (!this.waiting) close(this.overlay); }

  render() {
    const t = theme();
    const asking = initialStep(this, "reword", t);
    if (asking) return asking;
    const writing = this.writing(), said = this.error ?? writing;
    const body = v_flex().size_full().min_h(0).px(14).py(10).gap(8)
      .child(div().w_full().truncate().child(this.t("rewrite.editDescription", { hash: this.commit.hash.slice(0, SHORT), author: this.commit.author })))
      .child(textBox("reword-message", this.text, t, { focused: true }))
      .when(this.pushed, (el) => el.child(forcePushNote(this, t)))
      .when(Boolean(said), (el) => el.child(scrollText("reword-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("reword", this.t("rewrite.editTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("rewrite.rewording") : "",
      footer: [
        button("reword-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("reword-ok", this.t("rewrite.ok"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      // Enter makes a new line in the message; Cmd/Ctrl+Enter is OK.
      else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) this.run(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
