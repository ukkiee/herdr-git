// New Branch dialog, and the question asked before a branch with unmerged commits is
// deleted (the same small dialog with other words).
//
// Neither runs git that writes: they ask the Log panel copy that opened them
// (props.owner) to create or delete the branch under the repository's write lock
// (serveBranch, ui.js serveRequest). Herdr closes a dialog on Esc even while it waits;
// the branch, the "changed" for the panels and git's error must not go with it, so the
// panel does all three and shows a failure in its own error strip. While the dialog
// waits, Cancel, × and branch-dialog-cancel do nothing; on success it closes itself.
//
// Commands while one is open (keys, scripts): git-tools.branch-new-create,
// branch-new-toggle-checkout, branch-new-name:<text>, branch-delete-confirm,
// branch-dialog-cancel. A command reaches every shown copy, so create, name and confirm
// are only obeyed for a repository with `gittools.scripted` set (ui.js scriptedRepo) or
// when the dialog was opened from a Log tab on a chosen folder (`chosen`).

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { checkBranchName, createBranch, deleteBranch } from "./git-branch.js";
import { openDialog, dialogFrame, button, checkbox, close, scriptedRepo, askOwner, serveRequest, writeBlock, scrollText, sentence } from "./ui.js";

const NAME_COMMAND = "branch-new-name:";

// serveBranch(panel, e, cx) → true when it took the request
//   The Log panel's side: "branch-create" { name, from, checkout } and "branch-delete"
//   { name } (the confirmed delete of a branch with unmerged commits) in e.args.root,
//   under the write lock (ui.js serveRequest). `panel` is the Log panel (view-log.js):
//   a delete tells it panel.noteDeleted.
export function serveBranch(panel, e, cx) {
  const a = e.args ?? {}, name = typeof a.name === "string" ? a.name : "";
  if (e.action === "branch-create") {
    serveRequest(panel, e, { key: "dialogs.branch.creating" }, (repo) => createBranch(makeGit(exec, repo.on), repo.root,
      { name, from: typeof a.from === "string" ? a.from : null, checkout: a.checkout !== false }), cx);
  } else if (e.action === "branch-delete") {
    // The panel shows the Restore notice for it, as for a delete without the question.
    // Its label is the Branch tree's own: the tree's delete button spins while the lock
    // holds exactly that text.
    serveRequest(panel, e, { key: "log.deleting" }, async (repo) => {
      const r = await deleteBranch(makeGit(exec, repo.on), repo.root, name, { confirmed: true });
      if (r.ok) panel.noteDeleted(repo, r.deleted);
      return r;
    }, cx);
  } else return false;
  return true;
}

// openBranchNew({ root, on, from, label, name, chosen, owner, lang })
//   Opens the New Branch dialog.
//   root, on: the repository and its machine (null: this computer).
//   from: where the branch starts: a full ref name ("refs/heads/x", "refs/remotes/origin/x")
//   or a full commit hash; null or omitted → HEAD. createBranch refuses a short name.
//   label: how to name that start point in the title ("HEAD", "feature/login", "a1b2c3d").
//   name: optional text the name input starts with.
//   chosen: true when the opener is a Log tab on a chosen folder (props.folder): script
//   commands are obeyed then, as in that tab.
//   owner: the opening Log panel's bus id; that copy creates the branch (serveBranch).
//   After creating the branch the screens on that repository are told
//   { type: "changed", root } and the dialog closes itself.
//   lang: the opener's language ("en" | "ko"), so the dialog draws in it from the start
//   (ui.js openDialog). Pass `lang: this.lang`.
export function openBranchNew({ root, on = null, from = null, label = "HEAD", name = "", chosen = false, owner = null, lang } = {}) {
  return openDialog("branch-new", { root, on, from, label, name, chosen, owner, lang }, { width: 420, height: 214 });
}

// openBranchDelete({ root, on, name, unmerged, chosen, owner, lang })
//   Asks before deleting local branch `name`, which has `unmerged` commits nothing else
//   has (git-branch.js `deleteBranch` refused it and said how many). Delete has the
//   owner delete it, the screens are told "changed" the same way, and it closes; Cancel
//   changes nothing. lang: as for openBranchNew.
export function openBranchDelete({ root, on = null, name, unmerged, chosen = false, owner = null, lang } = {}) {
  return openDialog("branch-new", { mode: "delete", root, on, name, unmerged, chosen, owner, lang }, { width: 420, height: 190 });
}

export default class BranchNewView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null; // the Log panel copy that runs Create and Delete
    this.git = makeGit(exec, this.on);
    this.deleting = p.mode === "delete";
    this.waiting = false; // asked the owner, no answer yet
    this.error = null; // git's words when Create or Delete failed
    this.handle = cx.focus_handle();
    this.scripted = p.chosen === true; // script commands that write are obeyed
    if (!this.scripted && this.root) {
      cx.spawn(async (cx) => { if (await scriptedRepo(this.git, this.root)) { this.scripted = true; cx.notify(); } });
    }
    if (this.deleting) {
      this.name = String(p.name ?? "");
      this.unmerged = Number(p.unmerged) || 0;
      this.handle.focus();
      return;
    }
    this.from = p.from ?? null;
    this.label = p.label ?? "HEAD";
    this.switch = true; // "Checkout branch"
    this.verdict = { name: "", ok: false, reason: "" }; // checkBranchName's answer for `name`
    this.turn = 0;
    this.input = InputState.new({ placeholder: this.t("dialogs.branch.namePlaceholder"), value: String(p.name ?? "") });
    this.input.on("change", (_e, cx) => { this.error = null; this.check(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.create(cx));
    this.input.focus();
    // The dialog takes the keyboard as it opens; ask for it once more after that.
    cx.timer.after(300, () => { if (!this.waiting) this.input.focus(); });
    this.check(cx);
  }

  wanted() { return this.input.value().trim(); }

  // Asks git about the name as typed. Create stays off until the answer for exactly
  // this text is in.
  check(cx) {
    const name = this.wanted(), turn = ++this.turn;
    if (!name) { this.verdict = { name, ok: false, reason: "" }; return; }
    cx.spawn(async (cx) => {
      const r = await checkBranchName(this.git, this.root, name);
      if (turn !== this.turn) return;
      this.verdict = { name, ok: r.ok, reason: r.reason, msg: r.msg };
      cx.notify();
    });
  }

  // Another write on the repository, or null. This dialog's own runs under `waiting`.
  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  ready() { const name = this.wanted(); return Boolean(name) && !this.waiting && !this.writing() && this.verdict.ok && this.verdict.name === name; }

  create(cx) {
    if (!this.ready() || !this.root) return;
    this.waiting = true; this.error = null;
    cx.notify();
    const args = { root: this.root, on: this.on, name: this.wanted(), from: this.from, checkout: this.switch };
    askOwner(this, "branch-create", args, "ui.logPanel", cx, (r, cx) => {
      this.waiting = false;
      if (r.ok) { close(this.overlay); return; }
      // git refused (changes in the way of the checkout, a start point that is gone):
      // its words stay in the dialog and nothing was made.
      this.error = sentence(this.t, r.msg, r.err);
      this.check(cx);
    });
  }

  confirmDelete(cx) {
    if (this.waiting || !this.root || this.writing()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, "branch-delete", { root: this.root, on: this.on, name: this.name }, "ui.logPanel", cx, (r, cx) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err);
    });
  }

  // Not while the owner runs git: the dialog shows how it ends. (Esc closes it anyway,
  // Herdr's doing; the panel still finishes and shows a failure.)
  shut() { if (!this.waiting) close(this.overlay); }

  command(name, cx) {
    if (name === "branch-dialog-cancel") this.shut();
    else if (name === "branch-new-toggle-checkout") { if (!this.deleting && !this.waiting) this.switch = !this.switch; }
    else if (!this.scripted) return;
    else if (this.deleting) { if (name === "branch-delete-confirm") this.confirmDelete(cx); }
    else if (name === "branch-new-create") this.create(cx);
    else if (name.startsWith(NAME_COMMAND)) { if (!this.waiting) { this.input.set_value(name.slice(NAME_COMMAND.length)); this.error = null; this.check(cx); } }
  }

  shell(id, title, t, body, footer) {
    return dialogFrame(id, title, t, { body, footer, onClose: () => this.shut() })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.shut();
        else if (e.key === "enter" && this.deleting) this.confirmDelete(cx);
        else return;
        cx.stop_propagation();
      });
  }

  renderDelete(t) {
    const n = this.unmerged, shut = () => this.shut(), writing = this.writing(), said = this.error ?? writing;
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(8)
      .child(div().w_full().child(this.t("dialogs.branch.unmergedLost", { n, name: this.name })))
      .child(div().w_full().text_size(12).text_color(t.muted).child(this.t("dialogs.branch.noOtherHas", { n })))
      .when(Boolean(said), (el) => el.child(scrollText("branch-delete-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return this.shell("branch-delete", this.t("dialogs.branch.deleteTitle"), t, body, [
      button("branch-delete-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: shut }),
      button("branch-delete-ok", this.t("dialogs.branch.delete"), t, { kind: "primary", disabled: Boolean(writing), busy: this.waiting, onClick: (_e, cx) => this.confirmDelete(cx) }),
    ]);
  }

  render() {
    const t = theme();
    if (this.deleting) return this.renderDelete(t);
    const shut = () => this.shut(), name = this.wanted();
    // Why Create is off: git's refusal after a try, another write on the repository, or
    // what is wrong with the name typed.
    const writing = this.writing();
    const verdict = this.verdict;
    const reason = this.error ?? writing ?? (name && verdict.name === name && !verdict.ok ? sentence(this.t, verdict.msg, verdict.reason) : "");
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(8)
      .child(div().id("branch-new-name").w_full().min_w(0).h(30).px(9).flex().items_center().rounded(6).border_1()
        .border_color(reason ? t.ansi1 : t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
        .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(t.foreground)))
      .child(div().id("branch-new-reason").w_full().h(32).overflow_y_scrollbar().text_size(12).text_color(t.ansi1).child(reason))
      .child(h_flex().id("branch-new-checkout-row").flex_none().gap(7).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.switch = !this.switch; cx.notify(); })
        .child(checkbox("branch-new-checkout", this.switch, t, { onClick: (_e, cx) => { this.switch = !this.switch; cx.notify(); } }))
        .child(this.t("dialogs.branch.checkout")));
    return this.shell("branch-new", this.t("dialogs.branch.newTitle", { label: this.label }), t, body, [
      button("branch-new-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: shut }),
      button("branch-new-create", this.t("dialogs.branch.create"), t, { kind: "primary", disabled: !this.ready() && !this.waiting, busy: this.waiting, onClick: (_e, cx) => this.create(cx) }),
    ]);
  }
}
