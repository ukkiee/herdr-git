// Deleted Branches dialog: the branches deleted in this repository that git still keeps
// (git-branch.js readDeletedBranches, newest first), one checkbox row each, and Restore
// for the checked ones. A row that can't be restored (a branch of its name is at another
// commit now) is dimmed, can't be checked, and says why. After Restore the dialog stays
// open with how many came back and why the others didn't.
//
// The dialog doesn't write itself: it asks the Log panel copy that opened it
// (props.owner) to restore under the repository's write lock (serveDeletedBranches,
// ui.js serveRequest), so the branches, the "changed" and the result outlive a dialog
// Herdr closes on Esc. Which rows can be picked and why not is git-branch.js's call.
//
// props: { view: "deleted-branches", root, on, owner, chosen, overlay } (see
// openDeletedBranches).
//
// Commands (`git-tools.<name>`, for scripts): refresh (reads the list again),
// deleted-branches-toggle-all, deleted-branches-run, deleted-branches-cancel. A command
// reaches every shown copy of the mod, so deleted-branches-run is only obeyed for a
// repository that opted in (`git config --local gittools.scripted true`) or a dialog
// opened from a Log tab on a chosen folder (`chosen`).

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readDeletedBranches, restoreBranches } from "./git-branch.js";
import { formatTime } from "./i18n.js";
import { checkState } from "./tree.js";
import { openDialog, dialogFrame, button, checkbox, row, notice, errorStrip, scrollText, icon, close, scriptedRepo, sentence, WindowedList, askOwner, serveRequest, writeBlock } from "./ui.js";

const SHORT = 7; // a hash as the Branch tree's HEAD row shows it

// openDeletedBranches({ root, on, owner, chosen, lang })
//   Opens the Deleted Branches dialog. root, on: the repository and its machine (null:
//   this computer). owner: the opening Log panel's bus id; that copy runs the restore
//   (serveDeletedBranches). chosen: true when the panel is a Log tab on a chosen folder
//   (props.folder): script commands that write are obeyed. lang: the opener's language
//   (pass this.lang).
export function openDeletedBranches({ root, on = null, owner = null, chosen = false, lang } = {}) {
  return openDialog("deleted-branches", { root, on, owner, chosen, lang }, { width: 760, height: 480 });
}

// The request's branches as restoreBranches takes them; anything else is left out.
function requested(list) {
  const upstream = (u) => (u && typeof u.remote === "string" && typeof u.merge === "string" ? { remote: u.remote, merge: u.merge } : null);
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && typeof b.name === "string" && b.name && typeof b.hash === "string" && b.hash)
    .map((b) => ({ name: b.name, hash: b.hash, upstream: upstream(b.upstream) }));
}

// serveDeletedBranches(panel, e, cx) → true when it took the request
//   The Log panel's side: "branches-restore" { branches: [{ name, hash, upstream }] } in
//   e.args.root, under the write lock (ui.js serveRequest). The answer's msg is worded
//   here, in the panel's language: it travels without the skipped list, so the dialog
//   can't word each reason itself. A restore that brought some back counts as a change
//   even when others were skipped, so every screen reads the branches again.
export function serveDeletedBranches(panel, e, cx) {
  if (e.action !== "branches-restore") return false;
  const branches = requested(e.args?.branches);
  serveRequest(panel, e, { key: "branches.restoring" }, async (repo) => {
    if (!branches.length) return { ok: false, err: "No branches to restore.", msg: { key: "branches.noneChecked" } };
    const r = await restoreBranches(makeGit(exec, repo.on), repo.root, branches);
    if (r.ok) return r;
    const list = r.skipped.map((s) => `${s.name}: ${sentence(panel.t, s.msg, s.reason)}`).join("\n");
    return { ...r, changed: r.restored.length > 0, msg: r.msg ? { key: r.msg.key, args: { ...r.msg.args, list } } : r.msg };
  }, cx);
  return true;
}

const key = (b) => `${b.name}\0${b.hash}`;

export default class DeletedBranchesView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.owner = p.owner ?? null; // the Log panel copy that runs the restore
    this.scripted = p.chosen === true; // script commands that write are obeyed
    this.git = makeGit(exec, this.on);
    this.branches = null; // readDeletedBranches' list; null until the first answer
    this.listError = null;
    this.picked = new Set(); // key() of the checked rows
    this.at = -1; // the keyboard's row
    this.running = false;
    this.result = null; // { msg, err }: what the last Restore did
    this.error = null; // why the last Restore failed
    this.list = new WindowedList("deleted-branches-rows");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  // ---- reading

  load(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const [list, opted] = await Promise.all([readDeletedBranches(this.git, this.root), this.scripted || scriptedRepo(this.git, this.root)]);
        this.scripted = opted === true;
        this.listError = list.ok ? null : list.err || this.t("ui.gitFailed");
        if (list.ok) this.takeList(list.branches);
      } finally {
        this.loading = false;
      }
      if (this.again) this.load(cx);
      cx.notify();
    });
  }

  // Checks stay on the rows still listed and restorable; a restored branch leaves the list.
  takeList(branches) {
    const was = this.branches?.[this.at] ? key(this.branches[this.at]) : null;
    this.branches = branches;
    const open = new Set(branches.filter((b) => b.restorable).map(key));
    this.picked = new Set([...this.picked].filter((k) => open.has(k)));
    const kept = was ? branches.findIndex((b) => key(b) === was) : -1;
    this.at = kept >= 0 ? kept : Math.min(this.at, branches.length - 1);
  }

  // ---- checking

  open() { return (this.branches ?? []).filter((b) => b.restorable); }
  chosen() { return this.open().filter((b) => this.picked.has(key(b))); }

  toggle(b) {
    if (this.running || !b?.restorable) return false;
    const k = key(b);
    if (!this.picked.delete(k)) this.picked.add(k);
    return true;
  }

  toggleAll() {
    if (this.running) return false;
    const all = this.open().map(key);
    this.picked = all.every((k) => this.picked.has(k)) ? new Set() : new Set(all);
    return true;
  }

  move(by) {
    const n = this.branches?.length ?? 0;
    if (!n) return false;
    this.at = this.at < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, this.at + by));
    this.list.reveal(this.at, n);
    return true;
  }

  // ---- restoring

  writing() { return this.running || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    const branches = this.chosen();
    if (this.running || !branches.length || this.writing()) return false;
    this.running = true; this.result = null; this.error = null;
    const args = { root: this.root, on: this.on, branches: branches.map((b) => ({ name: b.name, hash: b.hash, upstream: b.upstream })) };
    askOwner(this, "branches-restore", args, "ui.logPanel", cx, (r, cx) => {
      this.running = false;
      // A success comes back without msg (serveRequest): every branch asked for came back.
      if (r.ok) this.result = { msg: { key: "branches.restored", args: { n: branches.length } }, err: "" };
      else if (r.msg?.key === "branches.notAllRestored") this.result = { msg: r.msg, err: r.err };
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      this.load(cx);
    });
    return true;
  }

  shut() { if (!this.running) close(this.overlay); }

  // ---- keys and commands

  command(name, cx) {
    if (name === "focus") this.handle.focus();
    else if (name === "refresh") { if (!this.running) this.load(cx); }
    else if (name === "deleted-branches-toggle-all") this.toggleAll();
    else if (name === "deleted-branches-cancel") this.shut();
    else if (name === "deleted-branches-run" && this.scripted) this.run(cx);
  }

  // A "changed" without a root is meant for every screen: a Delete adds a row, a
  // checkout or a new branch may take a name.
  event(e, cx) {
    if (e.type === "changed" && (!e.root || e.root === this.root) && !this.running) this.load(cx);
  }

  // ---- drawing

  branchRow(i, t) {
    const b = this.branches[i], k = key(b), off = !b.restorable;
    const why = off ? sentence(this.t, b.msg, b.reason) : "";
    let el = row(`deleted-branch-${i}`, t, { selected: i === this.at }).gap(8)
      .on_click((_e, cx) => { this.handle.focus(); this.at = i; this.toggle(b); cx.notify(); })
      .child(checkbox(`deleted-branch-check-${i}`, this.picked.has(k), t, {
        disabled: this.running || off, onClick: (_e, cx) => { this.at = i; this.toggle(b); cx.notify(); },
      }))
      .child(svg(icon("branch-item")).size(13).flex_none().text_color(off ? t.dim : t.ansi2))
      .child(div().flex_none().max_w("40%").truncate().text_color(off ? t.dim : t.foreground).child(b.name))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(b.hash.slice(0, SHORT)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(off ? t.ansi3 : t.muted).child(off ? why : b.subject))
      .child(div().flex_none().text_size(12).text_color(t.dim).whitespace_nowrap().child(formatTime(b.time, this.lang)));
    // The reason takes the subject's place on a row that can't be restored.
    if (off) el = el.opacity(0.6).tooltip(b.subject || why);
    return el;
  }

  body(t) {
    if (!this.root) return notice(this.t("ui.noRepository"), t);
    if (this.listError && !this.branches) return div().id("deleted-branches-list-error").p(12).text_color(t.ansi1).child(this.listError);
    if (!this.branches) return notice(this.t("ui.loading"), t, { busy: true });
    const all = this.open().map(key), checked = this.chosen().length;
    const listed = this.branches.length
      ? v_flex().size_full().min_h(0)
        .child(h_flex().id("deleted-branches-all").h(28).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
          .child(checkbox("deleted-branches-all-check", checkState(all, this.picked), t, {
            disabled: this.running || !all.length, onClick: (_e, cx) => { this.toggleAll(); cx.notify(); },
          }))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
            .child(checked ? this.t("branches.checked", { n: checked }) : this.t("branches.noneChecked"))))
        .child(div().flex_1().min_h(0).child(this.list.render(this.branches.length, (i) => this.branchRow(i, t), t)))
      : notice(this.t("branches.noneKept"), t);
    const result = this.result;
    return v_flex().size_full().min_h(0)
      .child(div().flex_1().min_h(0).child(listed))
      .when(Boolean(result), (el) => el.child(h_flex().id("deleted-branches-result").w_full().flex_none().px(10).py(6).border_t(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().min_w(0).child(scrollText("deleted-branches-result-text", sentence(this.t, result?.msg, result?.err), t, { maxHeight: 108, color: t.foreground })))))
      .when(Boolean(this.error), (el) => el.child(
        errorStrip("deleted-branches-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
  }

  render() {
    const t = theme(), writing = this.writing(), checked = this.chosen().length;
    return dialogFrame("deleted-branches", this.t("branches.dialogTitle"), t, {
      body: this.body(t), onClose: () => this.shut(),
      note: this.running ? this.t("branches.restoring") : writing ?? this.t("branches.keptNote"),
      footer: [
        button("deleted-branches-cancel", this.t("dialogs.cancel"), t, { disabled: this.running, onClick: () => this.shut() }),
        button("deleted-branches-run", this.t("branches.restore"), t, {
          kind: "primary", disabled: !checked || Boolean(writing), busy: this.running, title: writing ?? undefined,
          onClick: (_e, cx) => { this.run(cx); cx.notify(); },
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "down") this.move(1);
      else if (e.key === "up") this.move(-1);
      else if (e.key === "space") this.toggle(this.branches?.[this.at]);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
