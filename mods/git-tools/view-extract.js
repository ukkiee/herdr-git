// Extract Selected Changes to Separate Commit dialog (Commit details' file menu), and the
// Log panel's side of the edits that work on part of a commit:
//   Fixup… and Squash Into… (Commit list): checked first, then the Commit panel is shown
//     and told the target commit over the bus ("rewrite-target"); the panel's form
//     (commit-form.js) commits the checked changes into it.
//   Extract Selected Changes to Separate Commit…: this dialog, for the commit's message.
//   Drop Selected Changes: no dialog; written at once under the repository's write lock.
// view-log.js ACTIONS calls the *Here functions; serve-actions.js calls the serve*
// functions when this dialog asks the panel to write.
//
// Each item reads the edit facts again first and checks them (rebase-plan.js editCheck),
// as log-rewrite.js does: the menu was worded on what the panel knew when it opened. When
// the commit is the first one of the history, this dialog asks first (mode "drop" and
// "target" are only that question).
//
// props: { view: "extract", mode: "extract" | "drop" | "target", root, on, owner, commit
//   (hash), paths, squash (target), pushed, initial, overlay }.

import { div } from "gpui-kit";
import { v_flex, TextareaState } from "gpui-base";
import { theme, notify } from "herdr";
import { readEditFacts, extractChanges, dropChanges } from "./git-rewrite.js";
import { editCheck } from "./rebase-plan.js";
import { openDialog, dialogFrame, button, close, writeBlock, scrollText, textBox, broadcast, sentence, openCommitPanel } from "./ui.js";
import { forcePushNote, askRewrite } from "./view-reword.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { offerRewriteSmart, serveRewrite, servedWhere } from "./log-rewrite.js";

const SHORT = 8;
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const text = (value) => (typeof value === "string" ? value : "");

// openExtract({ mode, root, on, owner, commit, paths, squash, pushed, initial, lang })
export function openExtract({ mode = "extract", root, on = null, owner = null, commit = "", paths = [], squash = false, pushed = false, initial = false, lang } = {}) {
  const size = mode === "extract" ? { width: 560, height: 320 } : { width: 420, height: 150 };
  return openDialog("extract", { mode, root, on, owner, commit, paths, squash, pushed, initial, lang }, size);
}

// tellRewrite(r, where, done): what a rewrite that ended says. A replay that stopped on
// conflicts opens the Conflicts dialog; one that stopped otherwise says so; one that
// ended says `done` ({ key, args }) when given.
//   where: { root, on, owner, lang, t } of the screen that ran it.
export function tellRewrite(r, where, done) {
  const { t } = where;
  if (r.outcome === "stopped") {
    if (openConflictsIfStopped(r, { root: where.root, on: where.on, owner: where.owner, lang: where.lang, who: "ui.logPanel" })) {
      notify({ title: t("ops.stopped"), body: r.operation?.current?.subject ?? "", level: "warning" });
    } else {
      notify({ title: t("rewrite.stoppedTitle"), body: t("rewrite.stoppedBody"), level: "warning" });
    }
  } else if (r.outcome === "done" && done) {
    notify({ title: t(done.key, done.args), body: "", level: "info" });
  }
}

// aimCommitPanel(target): shows the Commit panel and tells it the commit the checked
// changes go into. target: { root, on, commit, squash, pushed }. Every Commit panel copy
// showing that repository takes it (view-commit.js event).
export function aimCommitPanel({ root, on = null, commit, squash = false, pushed = false }) {
  openCommitPanel();
  broadcast({ type: "rewrite-target", root, on, commit, squash: Boolean(squash), pushed: Boolean(pushed) });
}

// ---- the Log panel's side (view-log.js ACTIONS)

const whereOf = (host, repo) => ({ root: repo.root, on: repo.on ?? null, owner: host.bus.id, lang: host.lang, t: host.t });

// Reads the facts for `hash` and checks `action` on them (files: editCheck's); then(facts,
// initial) goes on when it is on.
function prepare(host, hash, action, files, cx, then) {
  const repo = host.repo;
  if (!repo || !hash || host.writeBlock()) return;
  cx.spawn(async (cx) => {
    const facts = await readEditFacts(repo.git, repo.root, [hash]);
    if (!host.shows(repo)) return;
    if (!facts.ok) { host.failedOn(repo, sentence(host.t, facts.msg, facts.err), cx); return; }
    const check = editCheck(action, facts, 1, files);
    if (check.why) { host.fail(host.t(check.why.key, check.why.args), cx); return; }
    then(repo, facts, Boolean(check.confirm));
    cx.notify();
  });
}

// Fixup… and Squash Into…: the Commit panel takes the commit as its target.
export function aimHere(host, commits, squash, cx) {
  const list = Array.isArray(commits) ? commits : [commits];
  const hash = list.length === 1 ? list[0]?.hash : null;
  if (list.length !== 1) { host.fail(host.t("log.selectOneCommit"), cx); return; }
  prepare(host, hash, squash ? "squashInto" : "fixup", null, cx, (repo, facts, initial) => {
    const target = { root: repo.root, on: repo.on ?? null, commit: hash, squash, pushed: facts.pushed };
    if (initial) openExtract({ ...target, mode: "target", owner: host.bus.id, initial, lang: host.lang });
    else aimCommitPanel(target);
  });
}

// The commit Commit details shows and the paths of file row `m` (a renamed file is its two
// paths), or null when it shows several commits or none.
function picked(host, m) {
  const info = host.details?.info;
  if (!info?.ok || info.many || !info.hash || !m?.path || m.folder) return null;
  return { hash: info.hash, paths: [m.path, m.item?.from].filter((p) => typeof p === "string" && p), total: info.files?.length ?? 0 };
}

export function extractHere(host, m, cx) {
  const at = picked(host, m);
  if (!at) return;
  prepare(host, at.hash, "extractChanges", { picked: 1, total: at.total }, cx, (repo, facts, initial) => {
    openExtract({ mode: "extract", root: repo.root, on: repo.on ?? null, owner: host.bus.id, commit: at.hash, paths: at.paths, pushed: facts.pushed, initial, lang: host.lang });
  });
}

export function dropChangesHere(host, m, cx) {
  const at = picked(host, m);
  if (!at) return;
  prepare(host, at.hash, "dropChanges", { picked: 1, total: at.total }, cx, (repo, facts, initial) => {
    if (initial) { openExtract({ mode: "drop", root: repo.root, on: repo.on ?? null, owner: host.bus.id, commit: at.hash, paths: at.paths, initial, lang: host.lang }); return; }
    if (!host.setBusy({ key: "rewrite.droppingChanges" }, cx, repo)) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await dropChanges(repo.git, repo.root, { commit: at.hash, paths: at.paths }); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      // Released first: the panel skips reads while a write runs.
      host.setBusy(null, cx);
      if (r.ok || r.changed) broadcast({ type: "changed", root: repo.root });
      const done = { key: "rewrite.droppedChanges" };
      if (r.ok) tellRewrite(r, whereOf(host, repo), done);
      else if (!offerRewriteSmart(r, whereOf(host, repo), { type: "drop-changes", commit: at.hash, paths: at.paths, done })) host.failedOn(repo, sentence(host.t, r.msg, r.err) || host.t("ui.gitFailed"), cx);
      cx.notify();
    });
  });
}

// ---- what this dialog asks (serve-actions.js): (git, root, args, panel) → a result

export async function serveExtract(git, root, args, panel) {
  const request = { type: "extract-changes", commit: text(args.commit), paths: strings(args.paths), message: text(args.message) };
  return serveRewrite(await extractChanges(git, root, request), servedWhere(root, args, panel), request, { key: "rewrite.extracted" });
}

export async function serveDropChanges(git, root, args, panel) {
  const request = { type: "drop-changes", commit: text(args.commit), paths: strings(args.paths) };
  return serveRewrite(await dropChanges(git, root, request), servedWhere(root, args, panel), request, { key: "rewrite.droppedChanges" });
}

// ---- the dialog

export default class ExtractView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.mode = ["extract", "drop", "target"].includes(p.mode) ? p.mode : "extract";
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.commit = typeof p.commit === "string" ? p.commit : "";
    this.paths = strings(p.paths);
    this.squash = Boolean(p.squash);
    this.pushed = Boolean(p.pushed);
    this.initial = Boolean(p.initial);
    this.text = TextareaState.new({ value: "", rows: 6 });
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  // OK: on the first-commit question, go on to the message (extract), ask the panel to
  // drop (drop), or hand the target to the Commit panel (target).
  run(cx) {
    if (this.waiting || !this.root || !this.commit) return;
    if (this.mode === "target") {
      aimCommitPanel({ root: this.root, on: this.on, commit: this.commit, squash: this.squash, pushed: this.pushed });
      close(this.overlay);
      return;
    }
    if (this.mode === "extract" && this.initial) { this.initial = false; this.handle.focus(); cx.notify(); return; }
    if (this.writing()) return;
    if (this.mode === "drop") { askRewrite(this, "rewrite-drop-changes", { commit: this.commit, paths: this.paths }, cx); return; }
    const message = this.text.value();
    if (!message.trim()) { this.error = this.t("commit.noMessage"); cx.notify(); return; }
    askRewrite(this, "rewrite-extract", { commit: this.commit, paths: this.paths, message }, cx);
  }

  shut() { if (!this.waiting) close(this.overlay); }

  keys(el) {
    return el.track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      // Enter makes a new line in the message; Cmd/Ctrl+Enter is OK. On the question,
      // Enter is OK.
      else if (e.key === "enter" && (this.mode !== "extract" || this.initial || e.modifiers?.platform || e.modifiers?.control)) this.run(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const writing = this.writing(), said = this.error ?? writing;
    const footer = (okDisabled) => [
      button("extract-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
      button("extract-ok", this.t("rewrite.ok"), t, {
        kind: "primary", disabled: okDisabled, busy: this.waiting, title: writing ?? undefined,
        onClick: (_e, cx) => this.run(cx),
      }),
    ];
    if (this.mode !== "extract" || this.initial) {
      const body = v_flex().px(14).py(12).gap(8)
        .child(div().child(this.t("rewrite.initialBody")))
        .when(Boolean(said), (el) => el.child(scrollText("extract-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
      return this.keys(dialogFrame("extract-initial", this.t("rewrite.initialTitle"), t, {
        body, onClose: () => this.shut(),
        note: this.waiting ? this.t("rewrite.droppingChanges") : "",
        footer: footer(this.mode === "drop" && (Boolean(writing) || !this.root)),
      }));
    }
    const body = v_flex().size_full().min_h(0).px(14).py(10).gap(8)
      .child(div().w_full().truncate().child(this.t("rewrite.extractDescription", { n: this.paths.length, hash: this.commit.slice(0, SHORT) })))
      .child(textBox("extract-message", this.text, t, { focused: true }))
      .when(this.pushed, (el) => el.child(forcePushNote(this, t)))
      .when(Boolean(said), (el) => el.child(scrollText("extract-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return this.keys(dialogFrame("extract", this.t("rewrite.extractTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("rewrite.extracting") : "",
      footer: footer(Boolean(writing) || !this.root),
    }));
  }
}
