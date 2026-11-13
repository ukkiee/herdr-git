// Rebasing Commits dialog (Commit list: Interactively Rebase from Here…). The commit
// picked and every one after it on the current branch, oldest at the top, each with what
// the rebase does to it: Pick, Stop to Edit, Reword, Squash, Fixup or Drop, in an order
// the person may change. Toolbar: Move Up and Down, the actions, Undo and Redo. Left the
// commits with a graph of which ones meld together; right the selected commit's files
// and details. Reset (a link) puts everything back. Cancel and Start Rebasing.
//
// The list and the undo record live here, in the dialog; the to-do list and its groups
// come from rebase-plan.js todoList, so a plan it refuses can't start (its reason shows).
// The rebase is git-rewrite.js interactiveRebase, run by the Log panel copy that opened
// the dialog (props.owner, serve-actions.js "rebase-interactive"), like every dialog
// write. A rebase that stops at a Stop to Edit leaves a rebase in progress (Continue and
// Abort live where every operation in progress does) and says so in a notification; one
// that stops on conflicts opens the Conflicts dialog.
//
// Gotchas:
// - Herdr closes a dialog on Esc by itself: the Discard question shows for the close
//   button and Cancel, and for Esc only when the key reaches the dialog first.
// - A squash keeps both messages, as git does: the plan gets the group's joined
//   message (the head's, then each squashed commit's) so no editor is needed and a
//   message line starting with "#" stays.
//
// props: { view: "interactive-rebase", root, on, owner, commit (the hash picked),
//   commits: [{ hash, subject, message, author, time }] oldest first, pushed, initial,
//   overlay }.

import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState } from "gpui-base";
import { theme, exec, notify } from "herdr";
import { tip, openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, textBox, row, spacer, notice, WindowedList, fileGlyph, darkLook, strokePath, openMenu, ROW } from "./ui.js";
import { makeGit } from "./git.js";
import { readCommit } from "./git-show.js";
import { readEditFacts, readRebaseCommits, interactiveRebase } from "./git-rewrite.js";
import { editCheck, todoList } from "./rebase-plan.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { openDiff } from "./view-diff.js";
import { initialStep, forcePushNote } from "./view-reword.js";
import { offerRewriteSmart, servedWhere } from "./log-rewrite.js";
import { formatDateTime } from "./i18n.js";

const SHORT = 8;
const MELDS = new Set(["squash", "fixup"]);
const GRAPH = 28, LANE = 9, MELD_LANE = 19, DOT = 7;
// The action column's color: what stays as it is is plain, what changes stands out.
const TONE = { pick: "muted", edit: "ansi3", reword: "ansi4", squash: "ansi5", fixup: "ansi5", drop: "ansi1" };

// ---- the list as data (pure)

const pickAll = (commits) => commits.map((c) => ({ hash: c.hash, action: "pick", message: null }));
const copyRows = (rows) => rows.map((r) => ({ ...r }));
const sameRows = (a, b) => a.length === b.length && a.every((r, i) => r.hash === b[i].hash && r.action === b[i].action && r.message === b[i].message);

// The plan's steps: each row as a step; a group with squashed commits gets the joined
// message of its head and squashed commits on its first squash (see the top of the file).
export function stepsOf(rows, messages) {
  const steps = rows.map((r) => ({ hash: r.hash, action: r.action, ...(r.message != null ? { message: r.message } : {}) }));
  for (let i = 0; i < steps.length; i++) {
    if (MELDS.has(steps[i].action) || steps[i].action === "drop") continue;
    let j = i + 1;
    const squashes = [];
    for (; j < steps.length && MELDS.has(steps[j].action); j++) if (steps[j].action === "squash") squashes.push(j);
    if (squashes.length) {
      const parts = [steps[i].message ?? messages[steps[i].hash] ?? "", ...squashes.map((k) => messages[steps[k].hash] ?? "")];
      steps[squashes[0]] = { ...steps[squashes[0]], message: parts.join("\n\n") };
    }
    i = j - 1;
  }
  return steps;
}

// Moves the selected rows one place (by -1 up, 1 down); a selected row only passes a row
// that isn't selected, so a block moves as one.
function moved(rows, selected, by) {
  const out = copyRows(rows);
  const order = by < 0 ? out.map((_r, i) => i) : out.map((_r, i) => out.length - 1 - i);
  for (const i of order) {
    const j = i + by;
    if (!selected.has(out[i].hash) || j < 0 || j >= out.length || selected.has(out[j].hash)) continue;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Squash or Fixup on the selection: one row melds into the row above it; several meld
// into the first of them, the others moving up under it in their order.
function melded(rows, selected, action) {
  const picked = rows.filter((r) => selected.has(r.hash));
  if (picked.length < 2) return rows.map((r) => (selected.has(r.hash) ? { ...r, action, message: null } : { ...r }));
  const [first, ...rest] = picked;
  const out = [];
  for (const r of rows) {
    if (r.hash === first.hash) {
      out.push({ ...r, action: r.action === "drop" ? "pick" : r.action });
      for (const m of rest) out.push({ ...m, action, message: null });
    } else if (!selected.has(r.hash)) out.push({ ...r });
  }
  return out;
}

// ---- opening it (the Log panel: view-log.js ACTIONS "commit.interactiveRebase")

// interactiveHere(host, commits, cx): reads the edit facts again and checks them (the
// menu was worded on what the panel knew when it opened), then the branch's commits from
// the one picked, then opens the dialog. A reason goes to the panel's error strip.
export function interactiveHere(host, commits, cx) {
  const repo = host.repo;
  const hash = (Array.isArray(commits) ? commits : [commits]).map((c) => c?.hash).filter((h) => typeof h === "string" && h);
  if (!repo || !hash.length || host.writeBlock()) return;
  cx.spawn(async (cx) => {
    const facts = await readEditFacts(repo.git, repo.root, hash);
    if (!host.shows(repo)) return;
    if (!facts.ok) { host.failedOn(repo, sentence(host.t, facts.msg, facts.err), cx); cx.notify(); return; }
    const check = editCheck("interactiveRebase", facts, hash.length);
    if (check.why) { host.fail(host.t(check.why.key, check.why.args), cx); cx.notify(); return; }
    const r = await readRebaseCommits(repo.git, repo.root, hash[0]);
    if (!host.shows(repo)) return;
    if (!r.ok) { host.failedOn(repo, sentence(host.t, r.msg, r.err), cx); cx.notify(); return; }
    openInteractiveRebase({ root: repo.root, on: repo.on, owner: host.bus.id, commit: hash[0], commits: r.commits, pushed: facts.pushed, initial: Boolean(check.confirm), lang: host.lang });
    cx.notify();
  });
}

// openInteractiveRebase({ root, on, owner, commit, commits, pushed, initial, lang })
export function openInteractiveRebase({ root, on = null, owner = null, commit, commits = [], pushed = false, initial = false, lang } = {}) {
  return openDialog("interactive-rebase", { root, on, owner, commit, commits, pushed, initial, lang }, { width: 960, height: 600 });
}

// ---- what the dialog asks (serve-actions.js "rebase-interactive")

// serveInteractive(git, root, args, panel) → a result. args: { commit, steps, on }.
export async function serveInteractive(git, root, args, panel) {
  const steps = Array.isArray(args.steps) ? args.steps.filter((s) => s && typeof s === "object") : [];
  const request = { type: "interactive-rebase", commit: typeof args.commit === "string" ? args.commit : "", steps };
  const r = await interactiveRebase(git, root, request);
  const t = panel?.t ?? ((key) => key);
  const on = typeof args.on === "string" ? args.on : null;
  // Local changes in the way: the Smart dialog carries on, and this dialog closes.
  if (!r.ok && offerRewriteSmart(r, servedWhere(root, args, panel), { ...request, done: { key: "interactive.done" } })) return { ok: true };
  if (r.outcome === "stopped") {
    const where = { root, on, owner: panel?.bus?.id ?? null, lang: panel?.lang, who: "ui.logPanel" };
    const subject = r.operation?.current?.subject ?? "";
    if (openConflictsIfStopped(r, where)) notify({ title: t("ops.stopped"), body: subject, level: "warning" });
    else notify({ title: t("interactive.stoppedTitle"), body: t("interactive.stoppedBody", { subject }), level: "warning" });
  } else if (r.outcome === "done") notify({ title: t("interactive.done"), body: "", level: "info" });
  return r;
}

// ---- the dialog

export default class InteractiveRebaseView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.commit = typeof p.commit === "string" ? p.commit : "";
    this.commits = Array.isArray(p.commits) ? p.commits.filter((c) => c && typeof c.hash === "string") : [];
    this.byHash = new Map(this.commits.map((c) => [c.hash, c]));
    this.messages = Object.fromEntries(this.commits.map((c) => [c.hash, c.message ?? c.subject ?? ""]));
    this.pushed = Boolean(p.pushed);
    this.initial = Boolean(p.initial);
    this.start = pickAll(this.commits);
    this.rows = copyRows(this.start);
    this.past = []; this.future = [];
    this.selected = new Set(this.rows.length ? [this.rows[this.rows.length - 1].hash] : []);
    this.cursor = this.rows.length ? this.rows[this.rows.length - 1].hash : null;
    this.anchor = this.cursor;
    // Reword in progress: { hash, state (TextareaState), was (the text it opened with) }.
    this.editing = null;
    // A question over the dialog: "cancel" (Discard?), "reword" (Cancel Reword?), "noop".
    this.asking = null;
    this.list = new WindowedList("ir-rows");
    this.fileList = new WindowedList("ir-files");
    this.files = new Map(); // hash → readCommit result
    this.fileAt = -1;
    this.git = makeGit(exec, this.on);
    this.dark = darkLook();
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.readFiles(cx);
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  // ---- state

  changed() { return !sameRows(this.rows, this.start); }

  plan() { return this.rows.length ? todoList(stepsOf(this.rows, this.messages)) : { ok: false, err: "", groups: [] }; }

  change(next) {
    if (sameRows(next, this.rows)) return;
    this.past.push(this.rows);
    this.future = [];
    this.rows = next;
    this.error = null;
  }

  undo() { if (this.past.length) { this.future.push(this.rows); this.rows = this.past.pop(); } }
  redo() { if (this.future.length) { this.past.push(this.rows); this.rows = this.future.pop(); } }
  reset() { this.change(copyRows(this.start)); }

  index(hash) { return this.rows.findIndex((r) => r.hash === hash); }
  picked() { return this.rows.filter((r) => this.selected.has(r.hash)); }

  // What each toolbar button may do now: null when it can, else the reason (may be "").
  can() {
    const n = this.selected.size, idx = this.rows.map((r, i) => (this.selected.has(r.hash) ? i : -1)).filter((i) => i >= 0);
    const busy = this.waiting || this.editing;
    const none = !n || busy;
    const firstPicked = idx[0] === 0;
    return {
      up: none || firstPicked && idx.every((i, k) => i === k),
      down: none || idx.every((i, k) => i === this.rows.length - idx.length + k),
      pick: none, edit: none, drop: none,
      reword: none || n !== 1,
      meld: none || (n === 1 && firstPicked),
      undo: busy || !this.past.length,
      redo: busy || !this.future.length,
      reset: busy || !this.changed(),
    };
  }

  act(name, cx) {
    const off = this.can();
    if (name === "up" && !off.up) this.change(moved(this.rows, this.selected, -1));
    else if (name === "down" && !off.down) this.change(moved(this.rows, this.selected, 1));
    else if (["pick", "edit", "drop"].includes(name) && !off[name]) this.change(this.rows.map((r) => (this.selected.has(r.hash) ? { ...r, action: name, message: name === "drop" ? null : r.message } : { ...r })));
    else if ((name === "squash" || name === "fixup") && !off.meld) this.change(melded(this.rows, this.selected, name));
    else if (name === "reword" && !off.reword) this.beginReword(this.picked()[0]);
    else if (name === "undo" && !off.undo) this.undo();
    else if (name === "redo" && !off.redo) this.redo();
    else if (name === "reset" && !off.reset) this.reset();
    else return;
    this.readFiles(cx);
    cx.notify();
  }

  // ---- rewording

  beginReword(r) {
    if (!r || this.waiting) return;
    const text = r.message ?? this.messages[r.hash] ?? "";
    this.editing = { hash: r.hash, was: text, state: TextareaState.new({ value: text, rows: 4 }) };
    this.selected = new Set([r.hash]); this.cursor = r.hash; this.anchor = r.hash;
  }

  applyReword() {
    const e = this.editing;
    if (!e) return;
    const text = e.state.value();
    this.editing = null;
    if (!text.trim() || text === (this.rows.find((r) => r.hash === e.hash)?.message ?? this.messages[e.hash])) return;
    this.change(this.rows.map((r) => (r.hash === e.hash ? { ...r, action: "reword", message: text } : { ...r })));
  }

  // Esc or a click elsewhere while rewording: asks first when the text was changed.
  leaveReword() {
    const e = this.editing;
    if (!e) return;
    if (e.state.value() !== e.was) this.asking = "reword";
    else this.editing = null;
  }

  // ---- selection

  choose(hash, { shift = false, toggle = false } = {}) {
    if (this.editing && this.editing.hash !== hash) { this.leaveReword(); if (this.editing) return; }
    if (shift && this.anchor) {
      const [a, b] = [this.index(this.anchor), this.index(hash)].sort((x, y) => x - y);
      this.selected = new Set(this.rows.slice(a, b + 1).map((r) => r.hash));
    } else if (toggle) {
      const next = new Set(this.selected);
      if (next.has(hash) && next.size > 1) next.delete(hash); else next.add(hash);
      this.selected = next; this.anchor = hash;
    } else { this.selected = new Set([hash]); this.anchor = hash; }
    this.cursor = hash;
    this.fileAt = -1;
  }

  step(by, shift) {
    const at = this.index(this.cursor);
    const next = this.rows[Math.max(0, Math.min(this.rows.length - 1, (at < 0 ? 0 : at + by)))];
    if (!next) return;
    this.choose(next.hash, { shift });
    this.list.reveal(this.index(next.hash), this.rows.length);
  }

  // The files of the commit under the cursor, read once per commit.
  readFiles(cx) {
    const hash = this.selected.size === 1 ? this.cursor : null;
    if (!hash || !this.root || this.files.has(hash)) return;
    this.files.set(hash, null);
    cx.spawn(async (cx) => {
      const r = await readCommit(this.git, this.root, hash);
      this.files.set(hash, r);
      cx.notify();
    });
  }

  // ---- closing and starting

  shut() {
    if (this.waiting) return;
    if (this.editing) { this.leaveReword(); if (this.editing) return; }
    if (this.changed()) this.asking = "cancel";
    else close(this.overlay);
  }

  run(cx, { noopAsked = false } = {}) {
    if (this.waiting || !this.root || this.writing()) return;
    if (this.editing) this.applyReword();
    const plan = this.plan();
    if (!plan.ok) { this.error = sentence(this.t, plan.msg, plan.err); cx.notify(); return; }
    if (!noopAsked && this.rows.every((r) => r.action === "drop")) { this.asking = "noop"; cx.notify(); return; }
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, "rebase-interactive", { root: this.root, on: this.on, commit: this.commit, steps: stepsOf(this.rows, this.messages) }, "ui.logPanel", cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  // ---- drawing

  question(t) {
    const q = this.asking;
    const frame = (id, title, body, footer) => dialogFrame(id, title, t, { body: div().px(14).py(12).child(body), onClose: (_e, cx) => { this.asking = null; this.handle.focus(); cx.notify(); }, footer });
    if (q === "cancel") {
      return frame("ir-cancel", this.t("interactive.cancelTitle"), this.t("interactive.cancelBody"), [
        button("ir-cancel-discard", this.t("interactive.discard"), t, { onClick: () => close(this.overlay) }),
        button("ir-cancel-continue", this.t("interactive.continueRebasing"), t, { kind: "primary", onClick: (_e, cx) => { this.asking = null; this.handle.focus(); cx.notify(); } }),
      ]);
    }
    if (q === "reword") {
      return frame("ir-reword-cancel", this.t("interactive.cancelRewordTitle"), this.t("interactive.cancelRewordBody"), [
        button("ir-reword-discard", this.t("interactive.discard"), t, { onClick: (_e, cx) => { this.asking = null; this.editing = null; this.handle.focus(); cx.notify(); } }),
        button("ir-reword-keep", this.t("interactive.keepEditing"), t, { kind: "primary", onClick: (_e, cx) => { this.asking = null; cx.notify(); } }),
      ]);
    }
    if (q === "noop") {
      return frame("ir-noop", this.t("interactive.noopTitle"), this.t("interactive.noopBody"), [
        button("ir-noop-cancel", this.t("dialogs.cancel"), t, { onClick: (_e, cx) => { this.asking = null; this.handle.focus(); cx.notify(); } }),
        button("ir-noop-ok", this.t("interactive.noopOk"), t, { kind: "primary", onClick: (_e, cx) => { this.asking = null; this.run(cx, { noopAsked: true }); } }),
      ]);
    }
    return null;
  }

  tool(id, label, t, { off, title, onClick }) {
    let el = h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(4).text_size(12.5)
      .text_color(off ? t.dim : t.foreground);
    el = tip(el, title);
    if (off) return el.child(label);
    return el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); })
      .child(label);
  }

  toolbar(t) {
    const off = this.can(), tool = (name, label, title) => this.tool(`ir-tool-${name}`, label, t, { off: off[name], title, onClick: (_e, cx) => this.act(name, cx) });
    const meldOff = off.meld;
    const fixupMenu = this.tool("ir-tool-squash-more", "▾", t, {
      off: meldOff, title: this.t("interactive.fixup"),
      onClick: (e, cx) => {
        const at = e?.position;
        cx.spawn(async (cx) => {
          const v = await this.openFixupMenu(at);
          if (v === "fixup") this.act("fixup", cx);
          cx.notify();
        });
      },
    });
    const rule = () => div().w(1).h(16).mx(4).flex_none().bg(t.border);
    return h_flex().w_full().h(34).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .child(tool("up", "↑", this.t("interactive.up")))
      .child(tool("down", "↓", this.t("interactive.down")))
      .child(rule())
      .child(tool("pick", this.t("interactive.pick")))
      .child(tool("edit", this.t("interactive.edit")))
      .child(tool("reword", this.t("interactive.reword")))
      .child(this.tool("ir-tool-squash", this.t("interactive.squash"), t, { off: meldOff, onClick: (_e, cx) => this.act("squash", cx) }))
      .child(fixupMenu)
      .child(tool("drop", this.t("interactive.drop")))
      .child(rule())
      .child(tool("undo", "↶", this.t("interactive.undo")))
      .child(tool("redo", "↷", this.t("interactive.redo")));
  }

  openFixupMenu(at) {
    return openMenu(this.bus, [{ label: this.t("interactive.fixup"), value: "fixup" }], { width: 180, at, lang: this.lang });
  }

  // The graph cell: one lane down the left with a dot per commit; a commit that melds
  // into the one above sits on a second lane joined to it; a dropped one is hollow.
  graphCell(i, r, inGroup, t) {
    const meld = inGroup.has(r.hash), last = i === this.rows.length - 1;
    const x = meld ? MELD_LANE : LANE, mid = ROW / 2;
    const color = r.action === "drop" ? t.dim : t.accent;
    let cell = div().relative().w(GRAPH).h(ROW).flex_none()
      .child(strokePath((p) => p.move_to(LANE, i === 0 ? mid : 0).line_to(LANE, last ? mid : ROW), t.border));
    if (meld) cell = cell.child(strokePath((p) => p.move_to(LANE, 0).line_to(MELD_LANE, mid), color));
    const dot = div().absolute().left(x - DOT / 2).top(mid - DOT / 2).w(DOT).h(DOT).rounded(DOT);
    return cell.child(r.action === "drop" ? dot.border_1().border_color(color).bg(t.popover) : dot.bg(color));
  }

  commitRow(i, inGroup, t) {
    const r = this.rows[i], c = this.byHash.get(r.hash) ?? {}, on = this.selected.has(r.hash);
    const subject = (r.message ?? "").split("\n")[0] || c.subject || "";
    const gray = r.action === "drop";
    return row(`ir-row-${r.hash}`, t, { selected: on })
      .on_click((e, cx) => {
        this.choose(r.hash, { shift: Boolean(e.modifiers?.shift), toggle: Boolean(e.modifiers?.platform || e.modifiers?.control) });
        if (e.click_count === 2 && !this.waiting) this.beginReword(this.rows.find((x) => x.hash === r.hash));
        this.readFiles(cx);
        this.handle.focus();
        cx.notify();
      })
      .child(this.graphCell(i, r, inGroup, t))
      .child(div().w(64).flex_none().truncate().text_size(12).text_color(t[TONE[r.action]] ?? t.muted).child(this.t(`interactive.action.${r.action}`)))
      .child(div().flex_1().min_w(0).truncate().text_color(gray ? t.dim : t.foreground).when(gray, (el) => el.line_through()).when(r.message != null, (el) => el.italic()).child(subject))
      .child(div().w(120).flex_none().truncate().text_size(12).text_color(t.muted).child(c.author ?? ""))
      .child(div().w(128).flex_none().truncate().text_size(12).text_color(t.dim).child(c.time ? formatDateTime(c.time, this.lang) : ""));
  }

  rewordBox(t) {
    const key = "⌘↩";
    return v_flex().w_full().flex_none().gap(4).px(10).py(8).border_t(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).text_color(t.muted).child(this.t("interactive.newMessage")))
      .child(textBox("ir-reword-text", this.editing.state, t, { focused: true }))
      .child(div().text_size(11.5).text_color(t.dim).child(this.t("interactive.applyHint", { key })));
  }

  fileRow(i, files, t) {
    const f = files[i], cut = f.path.lastIndexOf("/");
    const name = cut < 0 ? f.path : f.path.slice(cut + 1), dir = cut < 0 ? "" : f.path.slice(0, cut);
    const colorOf = { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted }[f.status] ?? t.foreground;
    return row(`ir-file-${i}`, t, { selected: i === this.fileAt })
      .map((el) => tip(el, f.path))
      .on_click((e, cx) => {
        this.fileAt = i;
        if (e.click_count === 2 && this.root) openDiff({ root: this.root, on: this.on, path: f.path, commit: this.cursor, oldPath: f.from ?? null });
        cx.notify();
      })
      .child(fileGlyph(f.path, { dark: this.dark }))
      .child(div().flex_initial().min_w(0).truncate().text_color(colorOf).when(f.status === "deleted", (el) => el.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(dir));
  }

  side(t) {
    const hash = this.selected.size === 1 ? this.cursor : null;
    const read = hash ? this.files.get(hash) : undefined, c = hash ? this.byHash.get(hash) : null;
    const files = read?.ok ? read.files : [];
    const filesPane = !hash ? notice(this.t("interactive.selectCommit"), t)
      : read === null || read === undefined ? notice("Loading…", t, { busy: true })
      : !read.ok ? notice(read.err || this.t("ui.gitFailed"), t)
      : !files.length ? notice(this.t("interactive.noFiles"), t)
      : this.fileList.render(files.length, (i) => this.fileRow(i, files, t), t);
    const r = hash ? this.rows.find((x) => x.hash === hash) : null;
    const message = r?.message ?? c?.message ?? "";
    const details = !c ? div() : v_flex().id("ir-details-body").size_full().min_h(0).px(10).py(8).gap(6).overflow_y_scroll()
      .child(div().w_full().child(message))
      .child(div().text_size(12).text_color(t.muted).child(`${hash.slice(0, SHORT)} · ${c.author ?? ""} · ${c.time ? formatDateTime(c.time, this.lang) : ""}`));
    return v_flex().w(320).flex_none().h_full().min_h(0).border_l(1).border_color(t.border)
      .child(div().flex_1().min_h(0).child(filesPane))
      .child(div().h(26).flex_none().px(10).flex().items_center().border_t(1).border_b(1).border_color(t.border).text_size(12).text_color(t.muted).child(this.t("interactive.details")))
      .child(div().h(180).flex_none().min_h(0).child(details));
  }

  render() {
    const t = theme();
    const first = initialStep(this, "interactive-rebase", t);
    if (first) return first;
    const asked = this.question(t);
    if (asked) return asked.track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") { this.asking = null; cx.stop_propagation(); cx.notify(); }
    });
    const plan = this.plan();
    const inGroup = new Set(plan.ok ? plan.groups.flatMap((g) => g.members.slice(1)) : this.rows.filter((r) => MELDS.has(r.action)).map((r) => r.hash));
    const why = plan.ok ? null : sentence(this.t, plan.msg, plan.err);
    const writing = this.writing(), said = this.error ?? why ?? writing;
    const off = this.can();
    const left = v_flex().flex_1().min_w(0).h_full().min_h(0)
      .child(this.toolbar(t))
      .child(div().flex_1().min_h(0).child(this.rows.length ? this.list.render(this.rows.length, (i) => this.commitRow(i, inGroup, t), t) : notice(this.t("interactive.noFiles"), t)))
      .when(Boolean(this.editing), (el) => el.child(this.rewordBox(t)));
    const body = v_flex().size_full().min_h(0)
      .child(h_flex().flex_1().min_h(0).w_full().child(left).child(this.side(t)))
      .when(this.pushed, (el) => el.child(div().px(14).py(4).child(forcePushNote(this, t))))
      .when(Boolean(said), (el) => el.child(div().px(14).py(4).child(scrollText("ir-error", said ?? "", t, { maxHeight: 48, color: this.error || why ? t.ansi1 : t.muted }))));
    const resetLink = div().id("ir-reset").flex_none().text_size(12.5)
      .text_color(off.reset ? t.dim : t.accent)
      .when(!off.reset, (el) => el.cursor_pointer().hover((s) => s.underline()).on_click((_e, cx) => { cx.stop_propagation(); this.act("reset", cx); }))
      .child(this.t("interactive.reset"));
    return dialogFrame("interactive-rebase", this.t("interactive.title"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("interactive.rebasing") : "",
      footer: [
        resetLink, spacer(),
        button("ir-cancel-button", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("ir-start", this.t("interactive.start"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root || !plan.ok, busy: this.waiting, title: writing ?? why ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (!this.keyDown(e, cx)) return;
      cx.stop_propagation();
      cx.notify();
    });
  }

  // Keys (the reference product's are unconfirmed): arrows move the cursor (Shift
  // extends), Alt+arrows move the rows, P E R S F D (and F2, Delete) the actions,
  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z undo and redo, Cmd/Ctrl+Enter applies a reword or
  // starts the rebase, Esc leaves a reword or closes.
  keyDown(e, cx) {
    const m = e.modifiers ?? {}, cmd = Boolean(m.platform || m.control), key = e.key;
    if (this.editing) {
      if (key === "escape") this.leaveReword();
      else if (key === "enter" && cmd) this.applyReword();
      else return false;
      this.handle.focus();
      return true;
    }
    if (key === "escape") this.shut();
    else if (key === "enter" && cmd) this.run(cx);
    else if ((key === "up" || key === "down") && m.alt) this.act(key, cx);
    else if (key === "up" || key === "down") { this.step(key === "up" ? -1 : 1, Boolean(m.shift)); this.readFiles(cx); }
    else if (key === "z" && cmd) this.act(m.shift ? "redo" : "undo", cx);
    else if (cmd || m.alt) return false;
    else if (key === "p") this.act("pick", cx);
    else if (key === "e") this.act("edit", cx);
    else if (key === "r" || key === "f2" || key === "enter") this.act("reword", cx);
    else if (key === "s") this.act("squash", cx);
    else if (key === "f") this.act("fixup", cx);
    else if (key === "d" || key === "delete" || key === "backspace") this.act("drop", cx);
    else return false;
    return true;
  }
}
