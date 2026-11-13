// Rename Branch dialog: "Rename Branch <name>", the branch name field (starting as the
// name now), Cancel and Rename. The current branch can be renamed too; git moves its
// tracking setting along and the remote branch keeps its name (git-refs.js renameBranch).
// A taken or malformed name comes back as git's words and the dialog stays open.
//
// The dialog runs no git that writes: it asks the panel copy that opened it
// (props.owner), "branch-rename" in serve-actions.js, as the New Tag dialog does.
//
// props: { view: "rename-branch", root, on, name, owner, lang, overlay }.

import { div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { theme } from "herdr";
import { renameBranch } from "./git-refs.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

// openRenameBranch({ root, on, name, owner, lang }): name: the local branch's full short
// name ("feature/login"). owner: the opening panel's bus id.
export function openRenameBranch({ root, on = null, name, owner = null, lang } = {}) {
  return openDialog("rename-branch", { root, on, name, owner, lang }, { width: 460, height: 190 });
}

// renameFrom(host, repo, b): Rename… on a branch row. b: { name, scope }; only a local
// branch (a detached HEAD has no name to change). Nothing while another write runs.
export function renameFrom(host, repo, b) {
  if (!repo || b?.scope !== "local" || !b.name || writeBlock(host, repo)) return;
  openRenameBranch({ root: repo.root, on: repo.on, name: b.name, owner: host.bus.id, lang: host.lang });
}

// The panel's side of "branch-rename" { from, to } (serve-actions.js).
export function runRenameBranch(git, root, args) {
  const text = (v) => (typeof v === "string" ? v : "");
  return renameBranch(git, root, { from: text(args.from), to: text(args.to).trim() });
}

export default class RenameBranchView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.from = typeof p.name === "string" ? p.name : "";
    this.owner = p.owner ?? null;
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: this.from });
    this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.rename(cx));
    this.input.focus();
    cx.timer.after(300, () => { if (!this.waiting) this.input.focus(); });
  }

  to() { return this.input.value().trim(); }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  // The name as it is renames nothing: Rename waits for another one.
  ready() { const to = this.to(); return Boolean(to) && to !== this.from && Boolean(this.from) && !this.waiting && !this.writing(); }

  rename(cx) {
    if (!this.ready()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, "branch-rename", { root: this.root, on: this.on, from: this.from, to: this.to() }, "ui.logPanel", cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err);
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  render() {
    const t = theme(), said = this.error ?? this.writing();
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(6)
      .child(div().text_size(12.5).child(this.t("refs.renameLabel")))
      .child(div().id("rename-branch-name").w_full().min_w(0).h(30).px(9).flex().items_center().rounded(6).border_1()
        .border_color(this.error ? t.ansi1 : t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
        .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(t.foreground)))
      .when(Boolean(said), (el) => el.child(scrollText("rename-branch-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("rename-branch", this.t("refs.renameTitle", { name: this.from }), t, {
      body, onClose: () => this.shut(),
      footer: [
        button("rename-branch-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("rename-branch-ok", this.t("refs.rename"), t, { kind: "primary", disabled: !this.ready() && !this.waiting, busy: this.waiting, onClick: (_e, cx) => this.rename(cx) }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      this.shut();
      cx.stop_propagation();
    });
  }
}
