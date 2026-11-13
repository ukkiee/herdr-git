// Push dialog: what is about to be pushed, and the Push ▾ button.
//
// Left: `branch → remote : target` and under it the commits the remote doesn't have.
// Right: the files they change (click a commit to see only its own). Bottom: Cancel and
// Push; the ▾ next to Push holds Force Push, which is --force-with-lease (git-push.js)
// and is disabled on a Protected branch.
// The dialog doesn't run git push itself: it asks the Commit panel copy that opened it
// (props.owner), which pushes under the repository's write lock (servePush, ui.js
// serveRequest). Herdr closes a dialog on Esc even while it waits, and the push, the
// "changed" and git's error must not go with it: the panel reads again afterwards and
// shows a failure in its own error strip.
// Push pushes what the dialog shows or nothing: the panel reads the plan again right
// before `git push`, and when the branch, remote, target or newest commit differ from
// what the dialog showed, nothing is pushed and the dialog reads and shows the new plan
// with a note.
// A failed push keeps the dialog open with git's output in it; a successful one closes it.
//
// props: { view: "push", root, on, owner, overlay, upTo?, branch? }. upTo: a commit hash,
// Push All up to Here: the plan stops there and the line reads `<hash> → origin : target`.
// branch: a local branch to push instead of the current one.
//
// Commands (`git-tools.<name>`, for scripts): refresh (reads the plan again), push-run,
// push-force, push-menu (opens ▾), push-next / push-prev / push-all (the commit
// selection), push-cancel.
// A command reaches every shown copy of the mod, so a script could push whatever dialog
// happens to be open. They are therefore only obeyed for a repository that opted in:
//   git config --local gittools.scripted true
// (a practice repository). Everywhere else pushing takes a click.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { PROTECTED, readPushPlan, readPushFiles, push } from "./git-push.js";
import { formatTime } from "./i18n.js";
import { buildRows } from "./tree.js";
import { tip, openDialog, openMenu, dialogFrame, button, notice, errorStrip, row,icon, uiGlyph, ICON, fileGlyph, folderGlyph, darkLook, close, scriptedRepo, WindowedList, askOwner, serveRequest, writeBlock, sentence } from "./ui.js";

// openPush({ root, on, owner, lang })
//   Opens the Push dialog for the repository's current branch. commit-form.js calls it
//   after a successful Commit and Push…, never before.
//   root, on: the repository and its machine (null: this computer).
//   owner: the opening Commit panel's bus id; that copy runs the push (servePush).
//   lang: the opener's language ("en" | "ko"), so the dialog draws in it from the start
//   (ui.js openDialog). Pass `lang: this.lang`.
//   After a push every screen on the repository is told "changed" and the dialog closes.
//   upTo, branch: optional, as in props above.
export function openPush({ root, on = null, owner = null, lang, upTo = null, branch = null } = {}) {
  return openDialog("push", { root, on, owner, lang, upTo, branch }, { width: 760, height: 480 });
}

// pushUpTo(host, repo, commit): Push All up to Here… on a commit row (commit: { hash }).
// pushBranch(host, repo, b): Push… on a local branch row (b: { name, scope, current }).
// host: the opening panel (its bus, lang), which runs the push; repo: { root, on }.
export function pushUpTo(host, repo, commit) {
  if (repo && commit?.hash) openPush({ root: repo.root, on: repo.on, owner: host.bus.id, lang: host.lang, upTo: commit.hash });
}
export function pushBranch(host, repo, b) {
  if (repo && b?.scope === "local") openPush({ root: repo.root, on: repo.on, owner: host.bus.id, lang: host.lang, branch: b.current ? null : b.name });
}

// The plan's source as the dialog and the panel pass it on: only strings count.
const sourceOf = (a) => ({
  upTo: typeof a?.upTo === "string" && a.upTo ? a.upTo : null,
  branch: typeof a?.branch === "string" && a.branch ? a.branch : null,
});

// servePush(panel, e, cx)
//   The Commit panel's side: runs the dialog's request { force, shown } (shown: planOf
//   of the plan on screen) on e.args.root under the write lock (ui.js serveRequest).
export function servePush(panel, e, cx) {
  const { force = false, shown = null } = e.args ?? {}, source = sourceOf(e.args);
  // Runs outside the panel's own call: its words come from panel.t.
  const t = panel.t;
  serveRequest(panel, e, { key: force === true ? "dialogs.push.forcePushing" : "dialogs.push.pushing" }, async (repo) => {
    const git = makeGit(exec, repo.on);
    // git-push.js pushes the branch checked out at that moment, which may not be the
    // one the dialog showed (a checkout elsewhere since it opened).
    const moved = planMoved(shown, planOf(await readPushPlan(git, repo.root, source)));
    if (moved) {
      return {
        ok: false, moved: true, err: `Nothing was pushed: ${moved.text}. Check the commits shown and push again.`,
        // why is worded here already: the dialog words the sentence around it.
        msg: { key: "dialogs.push.moved", args: { why: sentence(t, moved.msg, moved.text) } },
      };
    }
    return push(git, repo.root, { force: force === true, ...source });
  }, cx);
}

// { one, other } in English: `n` picks.
const countOf = (t, key, n) => t(key, { n });
// The app runtime's toLocaleString doesn't group digits.
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");
const stop = (_e, cx) => cx.stop_propagation();

// What Push would send, small enough to travel with the request: the dialog sends the
// plan on screen, the panel compares it with a plan read right before pushing.
const planOf = (plan) => (plan ? {
  ok: Boolean(plan.ok), err: plan.err ?? "", ...(plan.msg ? { msg: plan.msg } : {}), branch: plan.branch ?? null,
  remote: plan.remote ?? null, target: plan.target ?? null, top: plan.commits?.[0]?.hash ?? null,
} : null);

// null when the two agree, else a few words on what moved: { text (English), msg }.
function planMoved(shown, now) {
  if (!shown || typeof shown !== "object" || !now) return { text: "the plan could not be read", msg: { key: "dialogs.push.movedUnread", args: {} } };
  if (shown.ok !== now.ok) {
    return now.ok ? { text: "there is something to push now", msg: { key: "dialogs.push.movedSomething", args: {} } } : { text: now.err, msg: now.msg };
  }
  if (shown.branch !== now.branch) {
    return now.branch
      ? { text: `the current branch is ${now.branch} now`, msg: { key: "dialogs.push.movedBranch", args: { branch: now.branch } } }
      : { text: "the current branch is a detached HEAD now", msg: { key: "dialogs.push.movedDetached", args: {} } };
  }
  if (shown.remote !== now.remote || shown.target !== now.target) {
    return { text: `it goes to ${now.remote}/${now.target} now`, msg: { key: "dialogs.push.movedTarget", args: { remote: now.remote, target: now.target } } };
  }
  if (shown.top !== now.top) return { text: "the newest commit to push is a different one now", msg: { key: "dialogs.push.movedTop", args: {} } };
  return null;
}

function statusColor(status, t) {
  return { modified: t.ansi4, added: t.ansi2, deleted: t.muted }[status] ?? t.foreground;
}

export default class PushView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null; // the Commit panel copy that runs the push
    this.source = sourceOf(p); // { upTo, branch }: what is pushed, when not the current branch's tip
    this.git = makeGit(exec, this.on);
    this.plan = null; // readPushPlan's answer; null until the first one
    this.loading = false;
    this.scripted = false; // the repository opted in to script commands (see the top)
    this.selected = null; // a commit's hash, or null: everything being pushed
    this.files = null; // null while they are read
    this.fileRows = [];
    this.collapsed = new Set();
    this.turn = 0; // a newer file read makes an older one's answer void
    this.pushing = null; // "push" | "force" while git push runs
    this.error = null; // git's output from the push that failed
    this.commitList = new WindowedList("push-commits");
    this.fileList = new WindowedList("push-files");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  // ---- reading

  // A load asked for while one runs (a "changed" that arrived mid-read) runs once that
  // one ends: the answer in flight may predate the change.
  load(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const [plan, opted] = await Promise.all([readPushPlan(this.git, this.root, this.source), scriptedRepo(this.git, this.root)]);
        this.takePlan(plan);
        this.scripted = opted;
      } finally {
        this.loading = false;
      }
      if (this.again) this.load(cx);
      else this.loadFiles(cx);
      cx.notify();
    });
  }

  takePlan(plan) {
    // A dialog's language is fixed by its opener, so the times stay right once written.
    for (const commit of plan.commits) commit.when = formatTime(commit.time, this.lang);
    this.plan = plan;
    if (this.selected && !plan.commits.some((c) => c.hash === this.selected)) this.selected = null;
  }

  loadFiles(cx) {
    const plan = this.plan, turn = ++this.turn;
    if (!plan?.ok || !plan.commits.length) { this.files = []; this.fileRows = []; return; }
    const commit = this.selected ? plan.commits.find((c) => c.hash === this.selected) : null;
    this.files = null;
    cx.spawn(async (cx) => {
      const r = await readPushFiles(this.git, this.root, commit ? { from: commit.parent, to: commit.hash }
        : { to: plan.upTo ?? (this.source.branch ? `refs/heads/${this.source.branch}` : "HEAD"), branch: this.source.branch });
      if (turn !== this.turn) return;
      this.files = r.ok ? r.files : [];
      this.filesError = r.ok ? null : { err: r.err, msg: r.msg };
      this.collapsed = new Set();
      this.rebuild();
      cx.notify();
    });
  }

  rebuild() {
    this.fileRows = buildRows(this.files ?? [], { grouped: true, compact: true, collapsed: this.collapsed });
  }

  select(hash, cx) {
    if (hash === this.selected) return;
    this.selected = hash;
    const at = hash ? this.plan.commits.findIndex((c) => c.hash === hash) : -1;
    if (at >= 0) this.commitList.reveal(at, this.plan.commits.length);
    this.loadFiles(cx);
  }

  move(by, cx) {
    const commits = this.plan?.commits ?? [];
    if (!commits.length) return;
    const now = commits.findIndex((c) => c.hash === this.selected);
    // Above the first commit is the branch line: everything being pushed.
    const next = Math.min(commits.length - 1, now + by);
    this.select(next < 0 ? null : commits[next].hash, cx);
  }

  // ---- pushing

  // Why Push can't run now, or null when it can.
  blocked() {
    if (!this.root) return this.t("dialogs.push.noRepository");
    if (this.pushing) return this.t("dialogs.push.pushing");
    // Another write on the repository (this dialog's own push holds it under `pushing`).
    const writing = writeBlock(this, { root: this.root, on: this.on });
    if (writing) return writing;
    if (!this.plan) return this.t("ui.loading");
    if (!this.plan.ok) return this.planError();
    if (!this.plan.commits.length) return this.t("dialogs.push.noCommits");
    return null;
  }

  // Why there is nothing to push to, in git-push.js's words (no remote, detached HEAD).
  planError() { return sentence(this.t, this.plan.msg, this.plan.err); }

  // Why Force Push can't run now. The git module refuses a Protected branch as well.
  forceBlocked() {
    const why = this.blocked();
    if (why) return why;
    const { plan } = this;
    if (plan.protected) return this.t("dialogs.push.forceProtected", { name: PROTECTED.includes(plan.target) ? plan.target : plan.branch });
    return null;
  }

  run(force, cx) {
    if (force ? this.forceBlocked() : this.blocked()) return;
    this.pushing = force ? "force" : "push";
    this.error = null;
    cx.notify();
    const args = { root: this.root, on: this.on, force, shown: planOf(this.plan), ...this.source };
    askOwner(this, "push", args, "ui.commitPanel", cx, (r, cx) => {
      this.pushing = null;
      if (r.ok) { close(this.overlay); return; }
      // The dialog stays for another try, showing the plan as it is now (it may have
      // moved, or the push may have gone partly). The commit is made either way.
      this.error = sentence(this.t, r.msg, r.err) || this.t("dialogs.push.failed");
      this.load(cx);
    });
  }

  // The ▾ next to Push: one item. at: where the press was (window
  // coordinates), so the menu opens at the button; a script's push-menu has none.
  menu(cx, at) {
    if (this.blocked() || this.menuOpen) return;
    const why = this.forceBlocked();
    // While it is open the ▾ shows no tooltip: it would cover the menu's first item.
    this.menuOpen = true;
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.bus, [{
        label: this.t("dialogs.push.force"), value: "force", disabled: Boolean(why), title: why ?? this.t("dialogs.push.forceHelp"),
        hint: this.plan.protected ? this.t("dialogs.push.protectedHint") : "",
      }], { width: 250, at, lang: this.lang });
      this.menuOpen = false;
      if (picked === "force") this.run(true, cx);
      this.handle.focus();
      cx.notify();
    });
  }

  // Not while the push runs: the dialog shows how it ends. (Esc closes it anyway, Herdr's
  // doing; the panel still finishes the push and shows a failure.)
  shut() { if (!this.pushing) close(this.overlay); }

  command(name, cx) {
    // Reading is harmless anywhere; the rest needs the repository's opt-in.
    if (name === "refresh") { if (!this.pushing) this.load(cx); return; }
    if (!this.scripted) return;
    if (name === "push-run") this.run(false, cx);
    else if (name === "push-force") this.run(true, cx);
    else if (name === "push-menu") this.menu(cx);
    else if (name === "push-next") this.move(1, cx);
    else if (name === "push-prev") this.move(-1, cx);
    else if (name === "push-all") this.select(null, cx);
    else if (name === "push-cancel") this.shut();
  }

  // A "changed" without a root is meant for every screen.
  event(e, cx) {
    if (e.type === "changed" && (!e.root || e.root === this.root) && !this.pushing) this.load(cx);
  }

  // ---- drawing

  targetRow(t) {
    const plan = this.plan, n = plan.commits.length;
    const link = (text) => div().flex_none().max_w("32%").truncate().text_color(t.accent).child(text);
    return row("push-target", t, { selected: this.selected === null && n > 0, height: 28 })
      .when(n > 0, (el) => el.cursor_pointer().on_click((_e, cx) => { this.select(null, cx); cx.notify(); }))
      // Up to a commit: that commit's short hash stands where the branch would.
      .child(div().flex_none().max_w("32%").truncate().font_semibold().child(plan.upTo ? plan.upTo.slice(0, 8) : plan.branch ?? "HEAD"))
      .when(Boolean(plan.remote), (el) => el
        .child(div().flex_none().text_color(t.dim).child("→"))
        .child(link(plan.remote))
        .child(div().flex_none().text_color(t.dim).child(":"))
        .child(link(plan.target))
        .when(plan.ok && plan.isNew, (el) => el.child(
          div().flex_none().px(5).rounded(4).border_1().border_color(t.ansi2).text_size(11).text_color(t.ansi2).child(this.t("dialogs.push.new")))))
      .child(div().flex_1().min_w(0))
      .when(plan.ok && n > 0, (el) => el.child(
        div().flex_none().text_size(12).text_color(t.dim).child(plan.more ? this.t("dialogs.push.manyCommits", { n: grouped(n) }) : countOf(this.t, "dialogs.push.commits", n))));
  }

  commitRow(i, t) {
    const commit = this.plan.commits[i];
    return row(`push-commit-${i}`, t, { selected: commit.hash === this.selected, depth: 1 })
      .cursor_pointer()
      .on_click((_e, cx) => { this.handle.focus(); this.select(commit.hash, cx); cx.notify(); })
      .child(div().size(7).flex_none().rounded(4).bg(t.ansi4))
      .child(div().flex_1().min_w(0).truncate().child(commit.subject))
      .child(div().flex_none().max_w(96).truncate().text_size(12).text_color(t.muted).child(commit.author))
      .child(div().flex_none().text_size(12).text_color(t.dim).whitespace_nowrap().child(commit.when));
  }

  fileRow(i, t) {
    const r = this.fileRows[i];
    if (r.folder) {
      return row(`push-file-${r.key}`, t, { depth: r.depth })
        .cursor_pointer()
        .on_click((_e, cx) => {
          if (!this.collapsed.delete(r.key)) this.collapsed.add(r.key);
          this.rebuild();
          cx.notify();
        })
        .child(uiGlyph(r.open ? "chevron-down" : "chevron-right").text_color(t.muted))
        .child(folderGlyph(r.name, { open: r.open }))
        .child(div().flex_none().max_w("70%").truncate().child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(countOf(this.t, "dialogs.files", r.count)));
    }
    const status = r.item.status;
    return row(`push-file-${r.key}`, t, { depth: r.depth })
      // The arrow's place is kept so files line up under their folder's name.
      .child(div().size(ICON).flex_none())
      .child(fileGlyph(r.path, { dark: this.dark }))
      .child(div().flex_1().min_w(0).truncate().text_color(statusColor(status, t))
        .when(status === "deleted", (el) => el.line_through())
        .child(r.name));
  }

  body(t) {
    const plan = this.plan;
    if (!this.root) return notice(this.t("dialogs.push.noRepositoryDot"), t);
    if (!plan) return notice(this.t("ui.loading"), t, { busy: true });
    const commits = plan.commits.length;
    const left = v_flex().flex_1().min_w(0).min_h(0)
      .child(this.targetRow(t))
      .child(div().flex_1().min_h(0).child(
        !plan.ok ? div().id("push-plan-error").p(12).text_color(t.ansi1).child(this.planError())
          : !commits ? notice(this.t("dialogs.push.noCommits"), t)
          : this.commitList.render(commits, (i) => this.commitRow(i, t), t)));
    const files = this.files, filesError = this.filesError;
    const right = v_flex().w(290).flex_none().min_h(0).border_l(1).border_color(t.border)
      .child(h_flex().h(28).flex_none().px(10).items_center().text_size(12).text_color(t.dim)
        .child(files?.length && !filesError ? countOf(this.t, "dialogs.files", files.length) : ""))
      .child(div().flex_1().min_h(0).child(
        files === null ? notice(this.t("ui.loading"), t, { busy: true })
          : filesError ? div().p(12).text_size(12).text_color(t.ansi1).child(sentence(this.t, filesError.msg, filesError.err))
          : !files.length ? notice(plan.ok && commits ? this.t("dialogs.push.noFiles") : "", t)
          : this.fileList.render(this.fileRows.length, (i) => this.fileRow(i, t), t)));
    return v_flex().size_full().min_h(0)
      .child(h_flex().flex_1().min_h(0).items_start().child(left.h_full()).child(right.h_full()))
      .when(Boolean(this.error), (el) => el.child(
        errorStrip("push-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }

  // Push and its ▾ as one button with a line between the halves.
  pushButton(t) {
    const why = this.blocked(), on = !why, busy = Boolean(this.pushing);
    const half = (id) => h_flex().id(id).h(26).flex_none().items_center().justify_center();
    const live = (el, onClick) => el.cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", stop)
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); });
    let main = half("push-run").px(14).gap(6)
      .when(busy, (el) => el.child(svg(icon("spinner")).size(12).spin(900)))
      .child(this.t(this.pushing === "force" ? "dialogs.push.forcePushing" : busy ? "dialogs.push.pushing" : "dialogs.push.push"))
      .map((el) => tip(el, why ?? this.t("dialogs.push.pushTo", { branch: this.plan.branch, remote: this.plan.remote, target: this.plan.target })));
    let more = half("push-more").w(24).child(uiGlyph("chevron-down"));
    if (!this.menuOpen) more = tip(more, why ?? this.t("dialogs.push.more"));
    if (on) {
      main = live(main, (_e, cx) => this.run(false, cx));
      // A click carries no position: the press before it does.
      more = more.cursor_pointer().hover((s) => s.opacity(0.85))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.menuAt = e.position; })
        .on_click((_e, cx) => { cx.stop_propagation(); this.menu(cx, this.menuAt); });
    }
    return h_flex().id("push-split").h(28).flex_none().items_center().rounded(6).border_1().text_size(12.5).overflow_hidden()
      .border_color(on ? t.solid : t.input).bg(on ? t.solid : t.raised)
      .text_color(on ? t.solid_foreground : t.dim)
      .child(main)
      .child(div().w(1).h(16).flex_none().bg(on ? t.solid_foreground : t.input).opacity(0.35))
      .child(more);
  }

  render() {
    const t = theme(), busy = Boolean(this.pushing);
    // The rows sit on the dialog's popover color, not on the panels' background.
    this.dark = darkLook(t.popover);
    const writing = busy ? null : writeBlock(this, { root: this.root, on: this.on });
    const plan = this.plan;
    const note = busy ? (plan?.remote ? this.t("dialogs.push.pushingTo", { remote: plan.remote }) : this.t("dialogs.push.pushingToRemote"))
      : writing ? writing
      : plan?.ok && !plan.tracked && plan.commits.length ? this.t("dialogs.push.willTrack", { branch: plan.branch, remote: plan.remote, target: plan.target })
      : "";
    return dialogFrame("push", this.t("dialogs.push.title"), t, {
      body: this.body(t), note, onClose: () => this.shut(),
      footer: [
        button("push-cancel", this.t("dialogs.cancel"), t, { disabled: busy, onClick: () => this.shut() }),
        this.pushButton(t),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "down") this.move(1, cx);
      else if (e.key === "up") this.move(-1, cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
