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
//   host.operation()         the operation in progress and the files in conflict
//                            (git-operation.js readOperation), or null when not read
//
// Fixup… and Squash Into… in the Log panel give the form a target commit (aim): then its
// line with Cancel and Commit and Rebase… take the place of Amend and the commit buttons.
//
// While an operation is in progress Commit goes on with it (git-commit.js), Amend is off,
// the message box holds the operation's message until the person writes their own, and
// a line above it names the operation with its Abort and Skip. While any file is in
// conflict Commit is off and says why.
//
// Commands the panel passes on (`git-tools.<name>`, for scripts; only a copy opened with
// props.folder obeys them, see command()):
//   commit (what cmd-enter in the message does), commit-and-push, commit-amend (the
//   Amend checkbox), commit-message (puts the keyboard in the message).

import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState } from "gpui-base";
import { theme, props, notify } from "herdr";
import { commit, lastMessage, headIsPushed } from "./git-commit.js";
import { abortOperation, skipOperation, operationName } from "./git-operation.js";
import { openPush } from "./view-push.js";
import { broadcast, button, checkbox, errorStrip, textBox, writingOn, fromRepo, sentence } from "./ui.js";
import { askAbort } from "./view-vcs-popup.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { sameRepo } from "./lock.js";
import { fixupInto, readMessages } from "./git-rewrite.js";
import { tellRewrite } from "./log-rewrite.js";

const SHORT = 8;

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
    // The operation whose message prefill() put in the box ("" for none), and that message.
    this.filledKey = ""; this.filled = null;
    // Fixup… or Squash Into… picked in the Log panel (aim): { root, on, commit, subject,
    // squash, pushed, saved (the message the box held before a Squash Into's) }, or null.
    this.target = null;
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
    // A target belongs to the repository it was picked in.
    this.dropTarget();
    if (this.where !== null) this.drafts.set(this.where, this.text.value());
    this.where = where;
    this.amend = false; this.pushed = false; this.error = null;
    this.text.set_value(this.drafts.get(where) ?? "");
    // The message put in for the last repository's operation isn't this one's.
    this.filledKey = ""; this.filled = null;
  }

  // The operation in progress on the shown repository, or null.
  inProgress() { const op = this.host.operation?.(); return op?.kind ? op : null; }
  conflictCount() { return this.host.operation?.()?.conflicts?.length ?? 0; }

  // Amend only counts while there is a commit to amend and no operation in progress.
  amending() { return this.amend && Boolean(this.host.hasHead) && !this.inProgress(); }

  // The operation's message goes into the box when it starts (or the panel first sees it),
  // unless the person has written something; it leaves with the operation if untouched.
  prefill() {
    const op = this.inProgress();
    const key = op ? `${this.where}:${op.kind}:${op.current?.hash ?? ""}` : "";
    if (key === this.filledKey) return;
    const now = this.text.value();
    if (!op) { if (this.filled !== null && now === this.filled) this.text.set_value(""); }
    else if (!now.trim() || now === this.filled) this.text.set_value(op.message);
    this.filledKey = key;
    this.filled = op ? op.message : null;
  }

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
    const conflicts = this.conflictCount();
    if (conflicts) return host.t("ops.conflictsLeft", { n: conflicts });
    // Continuing commits what the operation staged, even with nothing else checked.
    if (!count && !this.amending() && !this.inProgress()) return host.t("commit.selectFiles");
    if (!this.text.value().trim()) return host.t("commit.specifyMessage");
    return null;
  }

  toggleAmend(cx) {
    const host = this.host, repo = host.repo;
    if (!repo || !host.hasHead || host.writeBlock() || this.inProgress() || this.aimed()) return;
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

  // ---- Fixup and Squash Into: the checked changes go into an older commit

  // aim(e, cx): the Log panel's "rewrite-target" event ({ root, on, commit, squash,
  // pushed }, view-extract.js aimCommitPanel), for the repository this panel shows. The
  // form then shows the target above the message with Cancel, and Commit and Rebase…
  // instead of the commit buttons. Squash Into puts the commit's message in the box to
  // edit; Fixup keeps it, so the box goes. Amend goes off.
  aim(e, cx) {
    const host = this.host, repo = host.repo;
    if (!repo || typeof e.commit !== "string" || !e.commit) return;
    cx.spawn(async (cx) => {
      const said = await readMessages(repo.git, repo.root, [e.commit]);
      if (!sameRepo(repo, host.repo)) return;
      if (!said.ok) { this.error = sentence(host.t, said.msg, said.err); cx.notify(); return; }
      this.follow();
      this.dropTarget();
      if (this.amend) { this.amend = false; this.pushed = false; host.amendChanged(cx); }
      const message = said.messages[e.commit] ?? "";
      const squash = e.squash === true;
      this.target = { root: repo.root, on: repo.on ?? null, commit: e.commit, subject: message.split("\n")[0], squash, pushed: e.pushed === true, saved: squash ? this.text.value() : null };
      if (squash) this.text.set_value(message);
      this.error = null;
      cx.notify();
    });
  }

  // The target on the shown repository, or null.
  aimed() { return this.target && sameRepo(this.target, this.host.repo) ? this.target : null; }

  // Back to plain committing: the box gets back what it held before a Squash Into.
  dropTarget() {
    const was = this.target;
    if (!was) return;
    this.target = null;
    if (was.squash) this.text.set_value(was.saved ?? "");
  }

  // Why Commit and Rebase… can't run now, or null.
  targetBlocked(count = this.host.included().length) {
    const host = this.host, target = this.aimed();
    if (!target) return host.t("commit.notRepository");
    const writing = host.writeBlock();
    if (writing) return writing;
    const conflicts = this.conflictCount();
    if (conflicts) return host.t("ops.conflictsLeft", { n: conflicts });
    if (!count) return host.t("commit.selectFiles");
    if (target.squash && !this.text.value().trim()) return host.t("commit.specifyMessage");
    return null;
  }

  // Commit and Rebase…: the checked files go into the target commit (git-rewrite.js
  // fixupInto). The target stays for another try when it fails before anything ran.
  rebase(cx) {
    const host = this.host, repo = host.repo, target = this.aimed();
    const files = host.included();
    if (!target || this.targetBlocked(files.length)) return;
    const message = target.squash ? this.text.value() : undefined;
    if (!host.setBusy({ key: target.squash ? "rewrite.squashingInto" : "rewrite.fixingUp" }, cx)) return;
    this.error = null;
    this.running = "rebase";
    cx.spawn(async (cx) => {
      let r;
      try { r = await fixupInto(repo.git, repo.root, { commit: target.commit, files, squash: target.squash, message }); }
      catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      this.running = null;
      if (r.ok && this.target === target) this.dropTarget();
      if (r.ok) host.committed(cx, repo);
      host.setBusy(null, cx);
      if (r.ok || r.changed) broadcast({ type: "changed", root: repo.root });
      const short = target.commit.slice(0, SHORT);
      if (r.ok) tellRewrite(r, { root: repo.root, on: repo.on ?? null, owner: host.bus.id, lang: host.lang, t: host.t }, { key: target.squash ? "rewrite.squashedInto" : "rewrite.fixedUp", args: { hash: short } });
      else {
        const err = sentence(host.t, r.msg, r.err) || host.t("commit.commitFailed");
        if (sameRepo(repo, host.repo)) this.error = err;
        else host.writeFailed(fromRepo(host, repo, err), cx);
        host.refresh(cx);
      }
      cx.notify();
    });
  }

  // The target's line above the message, with Cancel.
  targetRow(target, t) {
    const host = this.host, writing = host.writeBlock();
    const words = host.t(target.squash ? "rewrite.squashTarget" : "rewrite.fixupTarget", { hash: target.commit.slice(0, SHORT), subject: target.subject });
    return h_flex().id("commit-target").w_full().min_w(0).gap(6).items_center()
      .child(div().id("commit-target-name").flex_1().min_w(0).truncate().font_semibold().tooltip(target.commit).child(words))
      .child(button("commit-target-cancel", host.t("dialogs.cancel"), t, {
        disabled: Boolean(this.running), title: writing ?? undefined,
        onClick: (_e, cx) => { if (!this.running) this.dropTarget(); cx.notify(); },
      }));
  }

  // The form while a target is set: its line with Cancel, the message for Squash Into, the
  // Force Push note for a pushed commit, and Commit and Rebase….
  renderTarget(target, t, { spinning, elsewhere }) {
    const host = this.host, why = this.targetBlocked();
    return v_flex().id("commit-form").flex_none().w_full().min_w(0).border_t(1).border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke !== "cmd-enter") return;
        cx.stop_propagation();
        this.rebase(cx);
      })
      .child(v_flex().w_full().min_w(0).gap(6).p(8)
        .child(this.targetRow(target, t))
        .when(target.pushed, (el) => el.child(
          div().id("commit-target-pushed").w_full().min_w(0).text_size(12).text_color(t.ansi3).child(host.t("rewrite.forcePush"))))
        .when(target.squash, (el) => el.child(textBox("commit-message", this.text, t, { focused: this.typing })))
        .child(h_flex().w_full().min_w(0).flex_wrap().gap(8).items_center()
          .child(button("commit-rebase", host.t("rewrite.commitAndRebase"), t, {
            kind: "primary", disabled: Boolean(why), busy: spinning === "rebase",
            title: why ?? host.t("rewrite.commitAndRebaseTitle", { hash: target.commit.slice(0, SHORT) }),
            onClick: (_e, cx) => this.rebase(cx),
          })))
        .when(Boolean(elsewhere), (el) => el.child(
          div().id("commit-form-running").w_full().min_w(0).text_size(12).text_color(t.muted).child(elsewhere ?? ""))))
      .when(Boolean(this.error), (el) => el.child(
        errorStrip("commit-form-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }

  // Commit, and for Commit and Push… open the Push dialog once the commit is made.
  run(push, cx) {
    const host = this.host, repo = host.repo;
    this.follow();
    // With a target, Cmd+Enter is Commit and Rebase….
    if (this.aimed()) { if (!push) this.rebase(cx); return; }
    const files = host.included();
    if (this.blocked(files.length)) return;
    const message = this.text.value(), amend = this.amending(), where = this.where, going = this.inProgress();
    // What other copies show while this runs ("Another git operation is running: …"), each
    // in its own language.
    if (!host.setBusy({ key: going ? "ops.continuing" : amend ? "commit.amending" : "commit.committing" }, cx)) return;
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
        // Stopped on a conflict again: the Conflicts dialog opens, as after any request.
        if (!openConflictsIfStopped(r, this.conflictArgs(repo))) this.told(r, going?.kind);
        // Even from another repository: the dialog names the branch and where it goes. Not
        // while the operation stopped again: there is nothing finished to push yet.
        if (push && r.outcome !== "stopped") openPush({ root: repo.root, on: repo.on, owner: host.bus.id, lang: host.lang });
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

  // The notification for how an operation's request ended, when it is worth one: it
  // stopped again on a conflict, or the commit was already in and was skipped.
  // kind: the operation the request was made on.
  told(r, kind) {
    const t = this.host.t, op = r.operation;
    if (r.outcome === "stopped" && op?.kind) notify({ title: t("ops.stopped"), body: this.label(op), level: "warning" });
    else if (r.outcome === "empty") notify({ title: kind === "revert" ? t("ops.emptyRevertTitle") : t("ops.emptyTitle"), body: t("ops.emptyBody"), level: "info" });
  }

  // Where the Conflicts dialog opens from the panel: its writes go to this panel.
  conflictArgs(repo) { return { root: repo.root, on: repo.on, owner: this.host.bus.id, lang: this.host.lang, who: "ui.commitPanel" }; }

  // The line above the message while an operation is in progress: "Merging main", "Rebasing
  // feature (1/2)", named as the VCS widget names it (git-operation.js operationName).
  label(op) {
    const name = operationName(op, { step: true });
    return name ? this.host.t(name.key, name.args) : "";
  }

  // Abort or Skip, under the repository's lock like a commit. Abort asks first, as the
  // VCS widget's ■ does (view-vcs-popup.js askAbort): it throws away the resolution work.
  operate(type, cx) {
    const host = this.host, repo = host.repo, op = this.inProgress();
    if (!repo || !op || host.writeBlock()) return;
    cx.spawn(async (cx) => {
      if (type === "abort" && !(await askAbort(host.bus, op.kind, host.lang))) return;
      if (!sameRepo(repo, host.repo) || !host.setBusy({ key: type === "abort" ? "ops.aborting" : "ops.skipping" }, cx)) return;
      this.error = null;
      let r;
      try { r = await (type === "abort" ? abortOperation : skipOperation)(repo.git, repo.root); }
      catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      host.setBusy(null, cx);
      // Even a refused one may have moved things (a hook after the commit): read again.
      broadcast({ type: "changed", root: repo.root });
      if (r.ok) { if (!openConflictsIfStopped(r, this.conflictArgs(repo))) this.told(r, op.kind); }
      else {
        const err = sentence(host.t, r.msg, r.err) || host.t("commit.commitFailed");
        if (sameRepo(repo, host.repo)) this.error = err;
        else host.writeFailed(fromRepo(host, repo, err), cx);
      }
      host.refresh(cx);
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
    this.prefill();
    const t = theme(), host = this.host, op = this.inProgress();
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
    const target = this.aimed();
    if (target) return this.renderTarget(target, t, { spinning, elsewhere });
    const canAmend = Boolean(host.hasHead) && !writing && !op;
    const why = this.blocked(), amending = this.amending();
    const whyNoAmend = canAmend ? null : !host.hasHead ? host.t("commit.noCommitsToAmend") : op ? host.t("ops.noAmend") : writing;
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
        // A rebase runs on a detached HEAD by design: its own line says what goes on instead.
        .when(Boolean(host.detached) && op?.kind !== "rebase", (el) => el.child(
          div().id("commit-detached-warning").w_full().min_w(0).text_size(12).text_color(t.ansi3).child(host.t("commit.detachedWarning"))))
        .when(Boolean(op), (el) => el.child(h_flex().id("commit-operation").w_full().min_w(0).flex_wrap().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.ansi3).child(op ? `⚠ ${this.label(op)}` : ""))
          .child(button("commit-op-abort", host.t({ merge: "ops.abortMerge", rebase: "ops.abortRebase", "cherry-pick": "ops.abortCherryPick", revert: "ops.abortRevert" }[op?.kind] ?? "ops.abortMerge"), t, {
            disabled: Boolean(writing), title: writing ?? undefined, onClick: (_e, cx) => this.operate("abort", cx),
          }))
          .when(Boolean(op?.canSkip), (el) => el.child(button("commit-op-skip", host.t("ops.skipCommit"), t, {
            disabled: Boolean(writing), title: writing ?? undefined, onClick: (_e, cx) => this.operate("skip", cx),
          })))))
        .child(textBox("commit-message", this.text, t, { focused: this.typing }))
        // With Amend on the labels are longer: "Amend Commit" and "Amend Commit and Push…"
        // don't fit side by side at the panel's 280px, so the second one wraps under the
        // first instead of running over it.
        .child(h_flex().w_full().min_w(0).flex_wrap().gap(8).items_center()
          .child(button("commit-run", host.t(amending ? "commit.amendCommit" : "commit.commit"), t, {
            kind: "primary", disabled: Boolean(why), busy: spinning === "commit", title: why ?? (op ? host.t("ops.continueTitle") : host.t(amending ? "commit.amendCommitTitle" : "commit.commitTitle")),
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
