// Git Reset dialog (Commit list: Reset Current Branch to Here…): which commit and branch,
// what a reset does, the four modes as radio buttons (Mixed first chosen; Hard's words
// warn that local changes go), Cancel and Reset (Hard Reset while Hard is chosen).
//
// The dialog doesn't write itself: it asks the Log panel copy that opened it
// (props.owner) to reset under the repository's write lock (serve-actions.js "reset" →
// runReset), so the reset, the "changed" and the failure outlive a dialog Herdr closes on
// Esc. A hard reset first records the local changes (git-reset.js); the Restore dialog
// lists that snapshot as "Reset". A refused Keep changes nothing and shows git's words.
//
// props: { view: "reset", root, on, owner, commit: { hash, author, subject }, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { currentBranch, resetTo } from "./git-reset.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, copyId } from "./ui.js";

// The scratch index name of the snapshot a hard reset records, when the serving panel has
// no id of its own (the Log panel): the same key as the Commit panel's.
const COPY_KEY = "commit.copy";
const SHORT = 8;

// The modes in the order shown, with their words (messages-reset.js).
const MODES = [
  { mode: "soft", key: "reset.soft", hint: "reset.softHint" },
  { mode: "mixed", key: "reset.mixed", hint: "reset.mixedHint" },
  { mode: "hard", key: "reset.hard", hint: "reset.hardHint" },
  { mode: "keep", key: "reset.keep", hint: "reset.keepHint" },
];

// openReset({ root, on, owner, commit, lang })
//   Opens the Git Reset dialog for `commit` ({ hash, author, subject }, a Commit list row).
//   owner: the opening Log panel's bus id; that copy runs the reset. lang: the opener's
//   language (pass this.lang).
export function openReset({ root, on = null, owner = null, commit, lang } = {}) {
  const { hash = "", author = "", subject = "" } = commit ?? {};
  return openDialog("reset", { root, on, owner, commit: { hash, author, subject }, lang }, { width: 560, height: 330 });
}

// runReset(git, root, args, panel): the serving panel's side of "reset" (serve-actions.js).
//   args: { commit (a full hash), mode }. panel.copy: the panel copy's id, when it has one.
export function runReset(git, root, args, panel) {
  const copy = typeof panel?.copy === "string" ? panel.copy : copyId(COPY_KEY);
  return resetTo(git, root, { commit: typeof args.commit === "string" ? args.commit : "", mode: typeof args.mode === "string" ? args.mode : "", copy });
}

// A radio button: a ring, filled in the middle when chosen.
export function radio(id, on, t) {
  return div().id(id).size(14).flex_none().flex().items_center().justify_center().rounded_full().border_1()
    .border_color(on ? t.accent : t.input)
    .when(on, (el) => el.child(div().size(6).rounded_full().bg(t.accent)));
}

export default class ResetView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.commit = p.commit ?? { hash: "", author: "", subject: "" };
    this.git = makeGit(exec, this.on);
    this.mode = "mixed";
    this.branch = undefined; // undefined: not read yet; null: a detached HEAD
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
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
    if (this.waiting || !this.root || !this.commit.hash || this.writing()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, "reset", { root: this.root, on: this.on, commit: this.commit.hash, mode: this.mode }, "ui.logPanel", cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  choose(mode) { if (!this.waiting) { this.mode = mode; this.error = null; } }

  modeRow(m, t) {
    const on = this.mode === m.mode;
    return h_flex().id(`reset-mode-${m.mode}`).w_full().gap(8).items_start().cursor_pointer()
      .on_click((_e, cx) => { this.choose(m.mode); cx.notify(); })
      .child(div().pt(2).child(radio(`reset-radio-${m.mode}`, on, t)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().font_semibold().child(this.t(m.key)))
        .child(div().text_size(12).text_color(m.mode === "hard" ? t.ansi3 : t.muted).child(this.t(m.hint))));
  }

  render() {
    const t = theme(), writing = this.writing(), said = this.error ?? writing;
    const c = this.commit;
    const branch = this.branch === undefined ? "…" : this.branch ?? this.t("reset.detached");
    const body = v_flex().size_full().min_h(0).px(14).py(10).gap(8)
      .child(div().w_full().truncate().font_semibold().child(this.t("reset.header", { branch, hash: c.hash.slice(0, SHORT), subject: c.subject, author: c.author })))
      .child(div().w_full().text_size(12).text_color(t.muted).child(this.t("reset.description")))
      .children(MODES.map((m) => this.modeRow(m, t)))
      .when(Boolean(said), (el) => el.child(scrollText("reset-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("reset", this.t("reset.title"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("reset.running") : "",
      footer: [
        button("reset-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("reset-run", this.t(this.mode === "hard" ? "reset.runHard" : "reset.run"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      const at = MODES.findIndex((m) => m.mode === this.mode);
      if (e.key === "escape") this.shut();
      else if (e.key === "enter") this.run(cx);
      else if (e.key === "down") this.choose(MODES[Math.min(MODES.length - 1, at + 1)].mode);
      else if (e.key === "up") this.choose(MODES[Math.max(0, at - 1)].mode);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
