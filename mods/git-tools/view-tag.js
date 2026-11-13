// New Tag dialog: the commit's full hash as the title, one name field, Cancel and OK. The
// tag is lightweight (git-refs.js createTag). A taken or malformed name comes back as
// git's words under the field and the dialog stays open.
//
// The dialog runs no git that writes: it asks the panel copy that opened it
// (props.owner) to make the tag under the repository's write lock ("tag-create" in
// serve-actions.js). Herdr closes a dialog on Esc even while it waits; the panel still
// finishes, tells the screens "changed" and shows a failure in its own strip.
//
// props: { view: "tag", root, on, commit (full hash), owner, lang, overlay }.

import { div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { theme } from "herdr";
import { createTag, readRemotes, pushTag } from "./git-refs.js";
import { openDialog, openMenu, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

// openTag({ root, on, commit, owner, lang }): owner: the opening panel's bus id.
export function openTag({ root, on = null, commit, owner = null, lang } = {}) {
  return openDialog("tag", { root, on, commit, owner, lang }, { width: 460, height: 190 });
}

// newTagAt(host, repo, commit): New Tag… on a commit row. host: the opening panel (its bus,
// lang); repo: { root, on }; commit: { hash }. Nothing while another write runs.
export function newTagAt(host, repo, commit) {
  if (!repo || !commit?.hash || writeBlock(host, repo)) return;
  openTag({ root: repo.root, on: repo.on, commit: commit.hash, owner: host.bus.id, lang: host.lang });
}

// pushTagMenu(widget, b, at, cx): Push Tag on a tag of the VCS widget popup: one
// "Push to <remote>" per remote; the pick pushes as the widget's own write
// (view-vcs-widget.js write). b: { name } (the tag); at: where the menu opens.
export function pushTagMenu(widget, b, at, cx) {
  const host = widget.host, repo = widget.repo, tr = host.t;
  if (!repo || !b?.name) return;
  cx.spawn(async (cx) => {
    const list = await readRemotes(repo.git, repo.root);
    const rows = list.remotes.length
      ? list.remotes.map((remote) => ({ label: tr("refs.pushTo", { remote }), value: remote }))
      : [{ label: tr("refs.noRemotes"), value: "", disabled: true }];
    const remote = await openMenu(host.bus, rows, { width: 260, ...(at ? { at } : {}), lang: host.lang });
    if (remote) widget.write({ key: "refs.pushingTag" }, (repo) => pushTag(repo.git, repo.root, { tag: b.name, remote }), cx);
    cx.notify();
  });
}

// The panel's side of "tag-create" { name, commit } (serve-actions.js).
export function runTagCreate(git, root, args) {
  const text = (v) => (typeof v === "string" ? v : "");
  return createTag(git, root, { name: text(args.name).trim(), commit: text(args.commit) });
}

export default class TagView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.commit = typeof p.commit === "string" ? p.commit : "";
    this.owner = p.owner ?? null;
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.ok(cx));
    this.input.focus();
    // The dialog takes the keyboard as it opens; ask for it once more after that.
    cx.timer.after(300, () => { if (!this.waiting) this.input.focus(); });
  }

  name() { return this.input.value().trim(); }

  // Another write on the repository, or null. This dialog's own runs under `waiting`.
  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  ready() { return Boolean(this.name()) && Boolean(this.commit) && !this.waiting && !this.writing(); }

  ok(cx) {
    if (!this.ready()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, "tag-create", { root: this.root, on: this.on, name: this.name(), commit: this.commit }, "ui.logPanel", cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err);
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  render() {
    const t = theme(), said = this.error ?? this.writing();
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(6)
      .child(div().text_size(12.5).child(this.t("refs.tagLabel")))
      .child(div().id("tag-name").w_full().min_w(0).h(30).px(9).flex().items_center().rounded(6).border_1()
        .border_color(this.error ? t.ansi1 : t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
        .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(t.foreground)))
      .when(Boolean(said), (el) => el.child(scrollText("tag-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("tag", this.commit, t, {
      body, onClose: () => this.shut(),
      footer: [
        button("tag-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("tag-ok", this.t("refs.ok"), t, { kind: "primary", disabled: !this.ready() && !this.waiting, busy: this.waiting, onClick: (_e, cx) => this.ok(cx) }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      this.shut();
      cx.stop_propagation();
    });
  }
}
