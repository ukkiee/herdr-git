// Git Remotes dialog (view "remotes"): the VCS Operations popup's Manage Remotes…. A table
// of the remotes, Name │ URL, a toolbar Add / Remove / Edit, and OK, which only closes:
// every change is written when it is made.
//
// Edit opens the Define Remote dialog and Remove its question (view-remote.js), both
// owned by the panel that opened this one (props.owner), which runs their writes. The
// table reads again whenever the repository changes. Add has no dialog to open: the
// Define Remote dialog edits a remote that is there.
//
// props: { view: "remotes", root, on, owner, lang, overlay }.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readRemotes, readRemote } from "./git-refs.js";
import { openRemoteEdit, openRemoteRemove } from "./view-remote.js";
import { openDialog, dialogFrame, button, iconButton, row, notice, errorStrip, close, WindowedList, writeBlock, sentence } from "./ui.js";

// openRemotes(panel, repo): Manage Remotes… in the panel's copy.
export function openRemotes(panel, repo) {
  if (!repo) return;
  openDialog("remotes", { root: repo.root, on: repo.on ?? null, owner: panel.bus.id, lang: panel.lang }, { width: 560, height: 360 });
}

const NAME_WIDTH = 140;

export default class RemotesView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.remotes = []; this.read = false; this.error = null;
    this.selected = null; // the selected remote's name
    this.seq = 0;
    this.list = new WindowedList("remotes-list");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  // The remotes and their URLs, by name.
  load(cx) {
    const seq = ++this.seq;
    cx.spawn(async (cx) => {
      const git = makeGit(exec, this.on);
      const names = this.root ? await readRemotes(git, this.root) : { ok: false, err: "" };
      let remotes = [], error = null;
      if (names.ok) {
        remotes = await Promise.all(names.remotes.map(async (name) => {
          const r = await readRemote(git, this.root, name);
          return { name, url: r.ok ? r.url : "" };
        }));
      } else error = sentence(this.t, names.msg, names.err) || this.t("ui.gitFailed");
      if (seq !== this.seq) return;
      this.remotes = remotes; this.error = error; this.read = true;
      if (!remotes.some((r) => r.name === this.selected)) this.selected = remotes[0]?.name ?? null;
      cx.notify();
    });
  }

  event(e, cx) {
    if (e?.type === "changed" && e.root === this.root) this.load(cx);
  }

  at() { return this.remotes.findIndex((r) => r.name === this.selected); }

  move(by) {
    const n = this.remotes.length;
    if (!n) return;
    const i = Math.min(n - 1, Math.max(0, this.at() + by));
    this.selected = this.remotes[i].name;
    this.list.reveal(i, n);
  }

  // Edit and Remove, on the selected remote. Not while a write runs on the repository.
  can() { return Boolean(this.root && this.selected && !writeBlock(this, { root: this.root, on: this.on })); }

  edit() {
    if (!this.can()) return;
    openRemoteEdit({ root: this.root, on: this.on, name: this.selected, owner: this.owner, lang: this.lang });
  }

  remove() {
    if (!this.can()) return;
    openRemoteRemove({ root: this.root, on: this.on, name: this.selected, owner: this.owner, lang: this.lang });
  }

  renderRow(i, t) {
    const r = this.remotes[i];
    return row(`remotes-row-${i}`, t, { selected: r.name === this.selected })
      .on_click((e, cx) => {
        this.handle.focus();
        this.selected = r.name;
        if (e.click_count === 2) this.edit();
        cx.notify();
      })
      .child(div().w(NAME_WIDTH).flex_none().truncate().child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.url));
  }

  render() {
    const t = theme(), can = this.can(), writing = this.root ? writeBlock(this, { root: this.root, on: this.on }) : null;
    const head = h_flex().h(26).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(div().w(NAME_WIDTH).flex_none().child(this.t("patch.remoteName")))
      .child(div().flex_1().min_w(0).child(this.t("patch.remoteUrl")));
    const rows = !this.read ? notice(this.t("ui.loading"), t, { busy: true })
      : this.remotes.length ? this.list.render(this.remotes.length, (i) => this.renderRow(i, t), t)
        : notice(this.t("patch.noRemotes"), t);
    const body = v_flex().size_full().min_h(0)
      .child(h_flex().h(32).flex_none().px(10).gap(2).items_center()
        .child(iconButton("remotes-add", "plus", t, { title: this.t("patch.addUnavailable"), disabled: true }))
        .child(iconButton("remotes-remove", "branch-delete", t, { title: writing ?? this.t("patch.removeRemote"), disabled: !can, onClick: (_e, cx) => { this.remove(); cx.notify(); } }))
        .child(iconButton("remotes-edit", "settings", t, { title: writing ?? this.t("patch.editRemote"), disabled: !can, onClick: (_e, cx) => { this.edit(); cx.notify(); } })))
      .child(v_flex().id("remotes-table").flex_1().min_h(0).mx(12).rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden()
        .child(head).child(div().flex_1().min_h(0).child(rows)))
      .child(div().h(8).flex_none())
      .when(Boolean(this.error), (el) => el.child(errorStrip("remotes-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
    return dialogFrame("remotes", this.t("patch.remotesTitle"), t, {
      body, onClose: () => close(this.overlay), note: writing ?? "",
      footer: [button("remotes-ok", this.t("patch.ok"), t, { kind: "primary", onClick: () => close(this.overlay) })],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape" || e.key === "enter") close(this.overlay);
      else if (e.keystroke === "up") this.move(-1);
      else if (e.keystroke === "down") this.move(1);
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }
}
