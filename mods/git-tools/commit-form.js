// The bottom of the Commit panel: Amend, the message, Commit and
// Commit and Push….
//
// A part: the Commit panel (view-commit.js) makes one, calls init once and render on
// every render. `host` is the panel:
//   host.t, host.lang        the panel's words and language (main.js)
//   host.repo                { git, root, on, folder }, or null outside a repository
//   host.hasHead             false while the repository has no commit (nothing to amend)
//   host.detached            HEAD is on no branch: the form says so above the message
//   host.included()          [{ path, status }]: the files checked for the next commit
//   host.busy                null, or the work of the git write running now
//                            ({ key: "commit.committing" }, ui.js takeWrite)
//   host.held                { root, on }: the repository host.busy runs on, which may no
//                            longer be host.repo (the panel follows the focused pane)
//   host.setBusy(work, cx)   takes the repository's write lock → false when it can't
//                            (another write runs); null releases it
//   host.writeBlock()        why no write may start now (host.busy, the panel's write on
//                            another repository, or another copy's
//                            "Another git operation is running: …"), or null
//   host.bus                 the panel's side of the bus: the Push dialog's owner
//   host.committed(cx, repo) after a commit on `repo`: clears Included and reads the list
//                            again, if the panel still shows `repo`
//   host.refresh(cx)         reads the list again
//   host.amendChanged(cx)    Amend was turned on or off: the panel shows or drops the
//                            Last commit group
//   host.writeFailed(t, cx)  shows a write's failure in the panel's write strip: a commit
//                            that fails after the panel left its repository
//
// Commands the panel passes on (`git-tools.<name>`, for scripts; only a copy opened with
// props.folder obeys them, see command()):
//   commit (what cmd-enter in the message does), commit-and-push, commit-amend (the
//   Amend checkbox), commit-message (puts the keyboard in the message).

import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState } from "gpui-base";
import { theme, props } from "herdr";
import { commit, lastMessage, headIsPushed } from "./git-commit.js";
import { openPush } from "./view-push.js";
import { broadcast, button, checkbox, errorStrip, textBox, writingOn, fromRepo, sentence } from "./ui.js";
import { sameRepo } from "./lock.js";

// The repository a message and Amend belong to.
const place = (repo) => JSON.stringify([repo.on, repo.root]);

// Words come from host.t (the panel's, main.js), asked again on every use: the panel's
// language can change after the form is made.
export default class CommitForm {
  init(host, cx) {
    this.host = host;
    this.amend = false;
    this.pushed = false; // the last commit is on a remote: shown while Amend is on
    this.running = null; // "commit" | "push": which button started the commit running now
    // A failed commit's output on the shown repository is kept here, not in the panel's
    // read strip (host.fail): the panel clears that strip on its next successful read, and
    // a commit attempt always causes one (it writes under .git), so the output would be
    // gone within a second.
    this.error = null;
    this.where = null; // the repository the message belongs to
    this.drafts = new Map();
    this.typing = false;
    this.text = this.makeText("");
    this.handle = cx.focus_handle();
  }

  // The message box. Its placeholder is fixed when it is made, so a panel whose language
  // changed since gets a new box holding the same text (render).
  makeText(value) {
    this.textLang = this.host.lang;
    const text = TextareaState.new({ placeholder: this.host.t("commit.messagePlaceholder"), value, rows: 4 });
    // Typing changes whether Commit is enabled.
    text.on("change", (_e, cx) => cx.notify());
    text.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    text.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // Enter is a new line. If the textarea reports cmd-enter as a submit instead of
    // passing the key on, this catches it; the key handler in render catches the other
    // case. Both end in run(), which the busy lock makes safe to reach twice.
    text.on("submit", (e, cx) => { if (e?.secondary) this.run(false, cx); });
    return text;
  }

  // The old box isn't released: a handler of it may still be on its way, and using a
  // released state throws.
  relabel(cx) {
    if (this.textLang === this.host.lang) return;
    const typing = this.typing;
    this.text = this.makeText(this.text.value());
    if (typing) this.text.focus();
    cx.notify();
  }

  // The message is a draft for one repository. When the panel moves to another one
  // (the focused pane changed folder), this one's draft is put away and that one's comes
  // back, so a message is never committed to the repository it wasn't written for.
  follow() {
    const repo = this.host.repo;
    if (!repo) return;
    const where = place(repo);
    if (where === this.where) return;
    if (this.where !== null) this.drafts.set(this.where, this.text.value());
    this.where = where;
    this.amend = false; this.pushed = false; this.error = null;
    this.text.set_value(this.drafts.get(where) ?? "");
  }

  // Amend only counts while there is a commit to amend.
  amending() { return this.amend && Boolean(this.host.hasHead); }

  // Whether Amend is on for `repo` ({ root, on }). False for a repository the form hasn't
  // followed to yet: the panel's read reaches a new repository before the next render's
  // follow() turns Amend off there.
  amendsIn(repo) { return this.amend && Boolean(repo) && place(repo) === this.where; }

  // Why Commit can't run now, or null when it can.
  blocked(count = this.host.included().length) {
    const host = this.host;
    if (!host.repo) return host.t("commit.notRepository");
    const writing = host.writeBlock();
    if (writing) return writing;
    if (!count && !this.amending()) return host.t("commit.selectFiles");
    if (!this.text.value().trim()) return host.t("commit.specifyMessage");
    return null;
  }

  toggleAmend(cx) {
    const host = this.host, repo = host.repo;
    if (!repo || !host.hasHead || host.writeBlock()) return;
    this.amend = !this.amend;
    this.pushed = false;
    host.amendChanged(cx);
    cx.notify();
    if (!this.amend) return;
    const where = this.where;
    cx.spawn(async (cx) => {
      const [last, remote] = await Promise.all([lastMessage(repo.git, repo.root), headIsPushed(repo.git, repo.root)]);
      // Unchecked again, or the panel moved on, while git was answering.
      if (!this.amend || this.where !== where) return;
      // Only into an empty box: what the person typed is never replaced.
      if (last.ok && !this.text.value().trim()) this.text.set_value(last.message);
      this.pushed = remote.ok && remote.pushed;
      cx.notify();
    });
  }

  // Commit, and for Commit and Push… open the Push dialog once the commit is made.
  run(push, cx) {
    const host = this.host, repo = host.repo;
    this.follow();
    const files = host.included();
    if (this.blocked(files.length)) return;
    const message = this.text.value(), amend = this.amending(), where = this.where;
    // What other copies show while this runs ("Another git operation is running: …"), each
    // in its own language.
    if (!host.setBusy({ key: amend ? "commit.amending" : "commit.committing" }, cx)) return;
    this.error = null;
    this.running = push ? "push" : "commit";
    cx.spawn(async (cx) => {
      let r;
      try { r = await commit(repo.git, repo.root, { files, message, amend }); }
      catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      this.running = null;
      // The panel may have moved to another repository meanwhile: then the message box,
      // Amend and Included are that repository's and stay as they are.
      if (r.ok) {
        // The one to clear then is the put-away draft.
        if (this.where === where) {
          const was = this.amend;
          this.text.set_value(""); this.amend = false; this.pushed = false;
          if (was) host.amendChanged(cx);
        } else this.drafts.delete(where);
        // Included is cleared before the lock goes, so the read that follows is one read.
        host.committed(cx, repo);
        host.setBusy(null, cx);
        broadcast({ type: "changed", root: repo.root });
        // Even from another repository: the dialog names the branch and where it goes.
        if (push) openPush({ root: repo.root, on: repo.on, owner: host.bus.id, lang: host.lang });
      } else {
        // The message and Included stay as they are for another try. The form shows the
        // error only while the panel still shows that repository; otherwise (moved on, or
        // still finding where it moved, which hides the form and clears it on arrival)
        // it goes to the panel's write strip with the repository's folder name.
        const err = sentence(host.t, r.msg, r.err) || host.t("commit.commitFailed");
        if (sameRepo(repo, host.repo)) this.error = err;
        else host.writeFailed(fromRepo(host, repo, err), cx);
        host.setBusy(null, cx);
        // A hook may have rewritten files before failing.
        host.refresh(cx);
      }
      cx.notify();
    });
  }

  // A command reaches every shown copy of the mod at once. The side panel follows
  // whatever repository the person is working in, so a script must never be able to
  // commit there: these only act in a copy opened on a chosen folder (props.folder).
  // In the side panel the same things are a click or cmd-enter.
  command(name, cx) {
    if (!props()?.folder) return;
    if (name === "commit") this.run(false, cx);
    else if (name === "commit-and-push") this.run(true, cx);
    else if (name === "commit-amend") this.toggleAmend(cx);
    else if (name === "commit-message") this.text.focus();
  }

  render(cx) {
    this.follow();
    const t = theme(), host = this.host;
    // A new message box can't be made while drawing; the next turn makes it.
    if (this.textLang !== host.lang && !this.relabeling) {
      this.relabeling = true;
      cx.timer.after(0, (cx) => { this.relabeling = false; this.relabel(cx); });
    }
    // This panel's commit on the shown repository shows as the spinner on the button that
    // started it. Any other write that blocks this one is named under the buttons:
    // another copy's here, this panel's on another repository, or this panel's that has
    // no button here (a dialog's Push or Rollback).
    const writing = host.writeBlock(), spinning = this.running && writingOn(host, host.repo) ? this.running : null;
    const elsewhere = writing && !spinning ? writing : null;
    const canAmend = Boolean(host.hasHead) && !writing;
    const why = this.blocked(), amending = this.amending();
    const whyNoAmend = canAmend ? null : host.hasHead ? writing : host.t("commit.noCommitsToAmend");
    const amendRow = h_flex().id("commit-amend").flex_none().gap(6).items_center()
      .child(checkbox("commit-amend-check", this.amending(), t, { disabled: !canAmend, onClick: (_e, cx) => this.toggleAmend(cx) }))
      .child(div().text_color(canAmend ? t.foreground : t.dim).child(host.t("commit.amend")));
    return v_flex().id("commit-form").flex_none().w_full().min_w(0).border_t(1).border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke !== "cmd-enter") return;
        cx.stop_propagation();
        this.run(false, cx);
      })
      .child(v_flex().w_full().min_w(0).gap(6).p(8)
        .child(h_flex().w_full().min_w(0).items_center()
          .child(canAmend ? amendRow.cursor_pointer().on_click((_e, cx) => this.toggleAmend(cx))
            : whyNoAmend ? amendRow.tooltip(whyNoAmend) : amendRow))
        // Under the checkbox, not beside it: at the panel's 280px the sentence needs the
        // whole width to be read.
        .when(this.amending() && this.pushed, (el) => el.child(
          div().id("commit-amend-warning").w_full().min_w(0).text_size(12).text_color(t.ansi3).child(host.t("commit.amendWarning"))))
        // No second confirmation: the sentence is on screen for as long as HEAD is detached,
        // and Commit stays one press.
        .when(Boolean(host.detached), (el) => el.child(
          div().id("commit-detached-warning").w_full().min_w(0).text_size(12).text_color(t.ansi3).child(host.t("commit.detachedWarning"))))
        .child(textBox("commit-message", this.text, t, { focused: this.typing }))
        // With Amend on the labels are longer: "Amend Commit" and "Amend Commit and Push…"
        // don't fit side by side at the panel's 280px, so the second one wraps under the
        // first instead of running over it.
        .child(h_flex().w_full().min_w(0).flex_wrap().gap(8).items_center()
          .child(button("commit-run", host.t(amending ? "commit.amendCommit" : "commit.commit"), t, {
            kind: "primary", disabled: Boolean(why), busy: spinning === "commit", title: why ?? host.t(amending ? "commit.amendCommitTitle" : "commit.commitTitle"),
            onClick: (_e, cx) => this.run(false, cx),
          }))
          .child(button("commit-run-push", host.t(amending ? "commit.amendCommitAndPush" : "commit.commitAndPush"), t, {
            disabled: Boolean(why), busy: spinning === "push", title: why ?? host.t(amending ? "commit.amendCommitAndPushTitle" : "commit.commitAndPushTitle"),
            onClick: (_e, cx) => this.run(true, cx),
          })))
        .when(Boolean(elsewhere), (el) => el.child(
          div().id("commit-form-running").w_full().min_w(0).text_size(12).text_color(t.muted).child(elsewhere ?? ""))))
      .when(Boolean(this.error), (el) => el.child(
        errorStrip("commit-form-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }
}
