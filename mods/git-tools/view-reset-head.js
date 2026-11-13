// Reset Head dialog (VCS Operations popup: Reset HEAD…): the Git root and the current
// branch, the reset type (Soft, Mixed, Hard), the commit to reset to as an expression
// (HEAD at first) with Validate, Cancel and Reset. Validate, and Reset before it asks,
// check the expression with git (git-reset.js checkCommit); a wrong one says so under the
// field and nothing runs.
//
// Like the Git Reset dialog it doesn't write itself: it asks the panel copy that opened it
// (props.owner; props.who names that panel for a sentence) to run "reset"
// (serve-actions.js → view-reset.js runReset). A hard reset records the local changes
// first.
//
// props: { view: "reset-head", root, on, owner, who, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { checkCommit, currentBranch } from "./git-reset.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";
import { radio } from "./view-reset.js";

const TYPES = [
  { mode: "soft", key: "reset.soft" },
  { mode: "mixed", key: "reset.mixed" },
  { mode: "hard", key: "reset.hard" },
];
const SHORT = 8;

// openResetHead({ root, on, owner, who, lang })
//   Opens the Reset Head dialog on the repository at root (on: its machine, null for this
//   computer). owner: the opening panel's bus id; that copy runs the reset. who: that
//   panel's message key ("ui.commitPanel" or "ui.logPanel"). lang: the opener's language.
export function openResetHead({ root, on = null, owner = null, who = "ui.commitPanel", lang } = {}) {
  return openDialog("reset-head", { root, on, owner, who, lang }, { width: 520, height: 300 });
}

export default class ResetHeadView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.git = makeGit(exec, this.on);
    this.mode = "mixed";
    this.branch = undefined; // undefined: not read yet; null: a detached HEAD
    this.verdict = null; // checkCommit's answer for the text `verdict.text`
    this.waiting = false;
    this.error = null;
    this.turn = 0;
    this.input = InputState.new({ value: "HEAD" });
    this.input.on("change", (_e, cx) => { this.verdict = null; this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.run(cx));
    this.input.focus();
    if (this.root) {
      cx.spawn(async (cx) => {
        const r = await currentBranch(this.git, this.root);
        this.branch = r.ok ? r.branch : null;
        cx.notify();
      });
    }
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  // Asks git about the text as typed; then(verdict, cx) when the answer is for that text.
  validate(cx, then) {
    const text = this.input.value(), turn = ++this.turn;
    cx.spawn(async (cx) => {
      const r = await checkCommit(this.git, this.root, text);
      if (turn !== this.turn) return;
      this.verdict = { text, ok: r.ok, hash: r.hash, msg: r.msg, err: r.err };
      then?.(this.verdict, cx);
      cx.notify();
    });
  }

  run(cx) {
    if (this.waiting || !this.root || this.writing()) return;
    this.validate(cx, (v, cx) => {
      if (!v.ok || this.waiting) return;
      this.waiting = true; this.error = null;
      askOwner(this, "reset", { root: this.root, on: this.on, commit: v.hash, mode: this.mode }, this.who, cx, (r) => {
        this.waiting = false;
        if (r.ok) close(this.overlay);
        else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      });
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  label(t, text) { return div().w(110).flex_none().text_color(t.muted).child(text); }

  render() {
    const t = theme(), writing = this.writing(), v = this.verdict;
    const branch = this.branch === undefined ? "…" : this.branch ?? this.t("reset.detached");
    const bad = v && !v.ok ? sentence(this.t, v.msg, v.err) : "";
    const said = this.error ?? (bad || writing);
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(10)
      .child(h_flex().w_full().items_center().child(this.label(t, this.t("reset.root"))).child(div().flex_1().min_w(0).truncate().child(this.root ?? "")))
      .child(h_flex().w_full().items_center().child(this.label(t, this.t("reset.branch"))).child(div().flex_1().min_w(0).truncate().child(branch)))
      .child(h_flex().w_full().items_center().child(this.label(t, this.t("reset.type")))
        .child(h_flex().flex_1().gap(14).items_center().children(TYPES.map((m) =>
          h_flex().id(`reset-head-type-${m.mode}`).gap(6).items_center().cursor_pointer()
            .on_click((_e, cx) => { if (!this.waiting) { this.mode = m.mode; cx.notify(); } })
            .child(radio(`reset-head-radio-${m.mode}`, this.mode === m.mode, t))
            .child(this.t(m.key))))))
      .child(h_flex().w_full().gap(8).items_center().child(this.label(t, this.t("reset.commit")))
        .child(div().id("reset-head-commit").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1()
          .border_color(bad ? t.ansi1 : t.input).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
          .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(t.foreground)))
        .child(button("reset-head-validate", this.t("reset.validate"), t, { disabled: this.waiting || !this.root, onClick: (_e, cx) => this.validate(cx) })))
      .when(Boolean(v?.ok) && !said, (el) => el.child(div().w_full().pl(118).text_size(12).text_color(t.muted).child(v?.hash?.slice(0, SHORT) ?? "")))
      .when(Boolean(said), (el) => el.child(scrollText("reset-head-error", said ?? "", t, { maxHeight: 48, color: this.error || bad ? t.ansi1 : t.muted })));
    return dialogFrame("reset-head", this.t("reset.headTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("reset.running") : "",
      footer: [
        button("reset-head-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("reset-head-run", this.t("reset.run"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
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
