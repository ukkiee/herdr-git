// Drop Commits confirmation (Commit list: Drop Commit / Drop Commits): "Do you want to drop
// N commits from the 'feature' branch?", Don't ask again, Cancel and OK. The Log panel
// copy that opened it (props.owner) drops under the repository's write lock
// (serve-actions.js "rewrite-drop" → log-rewrite.js), and with Don't ask again checked it
// also saves that in the app's settings, so it drops without this dialog from then on.
// The panel saves it, not the dialog: Herdr may close the dialog before a write of its
// own ends. The first-commit question and the Force Push note are view-reword.js's.
//
// props: { view: "drop-commits", root, on, owner, commits: [hash], branch, pushed,
//   initial, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme } from "herdr";
import { openDialog, dialogFrame, button, checkbox, close, writeBlock, scrollText } from "./ui.js";
import { initialStep, forcePushNote, askRewrite } from "./view-reword.js";

// openDropCommits({ root, on, owner, commits, branch, pushed, initial, lang })
//   branch: the current branch's name (null on a detached HEAD).
export function openDropCommits({ root, on = null, owner = null, commits = [], branch = null, pushed = false, initial = false, lang } = {}) {
  return openDialog("drop-commits", { root, on, owner, commits, branch, pushed, initial, lang }, { width: 480, height: 200 });
}

export default class DropCommitsView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.commits = Array.isArray(p.commits) ? p.commits : [];
    this.branch = typeof p.branch === "string" ? p.branch : null;
    this.pushed = Boolean(p.pushed);
    this.initial = Boolean(p.initial);
    this.dontAsk = false;
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || !this.commits.length || this.writing()) return;
    askRewrite(this, "rewrite-drop", { commits: this.commits, dontAsk: this.dontAsk }, cx);
  }

  shut() { if (!this.waiting) close(this.overlay); }

  render() {
    const t = theme();
    const asking = initialStep(this, "drop", t);
    if (asking) return asking;
    const writing = this.writing(), said = this.error ?? writing, n = this.commits.length;
    const body = v_flex().size_full().min_h(0).px(14).py(10).gap(8)
      .child(div().w_full().child(this.t("rewrite.dropQuestion", { n, branch: this.branch ?? this.t("rewrite.detached") })))
      .when(this.pushed, (el) => el.child(forcePushNote(this, t)))
      .child(h_flex().id("drop-dont-ask").gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.dontAsk = !this.dontAsk; cx.notify(); })
        .child(checkbox("drop-dont-ask-check", this.dontAsk, t, { onClick: (_e, cx) => { this.dontAsk = !this.dontAsk; cx.stop_propagation(); cx.notify(); } }))
        .child(div().child(this.t("rewrite.dontAskAgain"))))
      .when(Boolean(said), (el) => el.child(scrollText("drop-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("drop-commits", this.t("rewrite.dropTitle", { n }), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("rewrite.dropping") : "",
      footer: [
        button("drop-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("drop-ok", this.t("rewrite.ok"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "enter") this.run(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
