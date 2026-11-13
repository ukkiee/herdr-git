// Define Remote dialog (Edit Remote on a remote's folder in the Branch tree): Name, URL,
// "Fetch from the remote" (on at first), Cancel and OK. And, with props.mode "remove", the
// question before Remove Remote. git removes the remote's branches with it.
//
// Neither runs git that writes: they ask the panel copy that opened them (props.owner),
// "remote-edit" and "remote-remove" in serve-actions.js, under the repository's write lock.
//
// props: { view: "remote", mode: "edit" | "remove", root, on, name, owner, lang, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readRemote, editRemote, fetchRemote, removeRemote } from "./git-refs.js";
import { openDialog, dialogFrame, button, checkbox, close, askOwner, writeBlock, scrollText, sentence, notice } from "./ui.js";

// openRemoteEdit({ root, on, name, owner, lang }) / openRemoteRemove(…): name: the remote.
export function openRemoteEdit({ root, on = null, name, owner = null, lang } = {}) {
  return openDialog("remote", { mode: "edit", root, on, name, owner, lang }, { width: 520, height: 240 });
}
export function openRemoteRemove({ root, on = null, name, owner = null, lang } = {}) {
  return openDialog("remote", { mode: "remove", root, on, name, owner, lang }, { width: 420, height: 160 });
}

// remoteDialog(host, repo, name, mode): Edit Remote ("edit") and Remove Remote ("remove")
// on a remote's folder. Nothing while another write runs.
export function remoteDialog(host, repo, name, mode) {
  if (!repo || !name || writeBlock(host, repo)) return;
  (mode === "remove" ? openRemoteRemove : openRemoteEdit)({ root: repo.root, on: repo.on, name, owner: host.bus.id, lang: host.lang });
}

const text = (v) => (typeof v === "string" ? v : "");

// The panel's side of "remote-edit" { name, to, url, fetch }: the edit, then a fetch from
// the remote under its new name when asked. A failed fetch after a done edit still says
// the repository changed.
export async function runRemoteEdit(git, root, args) {
  const to = text(args.to).trim();
  const r = await editRemote(git, root, { name: text(args.name), to, url: text(args.url) });
  if (!r.ok || args.fetch !== true) return r;
  const fetched = await fetchRemote(git, root, to);
  return fetched.ok ? fetched : { ...fetched, changed: true };
}

// The panel's side of "remote-remove" { name }.
export function runRemoteRemove(git, root, args) {
  return removeRemote(git, root, text(args.name));
}

export default class RemoteView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.name = text(p.name);
    this.owner = p.owner ?? null;
    this.removing = p.mode === "remove";
    this.waiting = false;
    this.error = null;
    this.handle = cx.focus_handle();
    if (this.removing) { this.handle.focus(); return; }
    this.fetch = true;
    this.read = false;
    this.url = "";
    this.nameInput = InputState.new({ value: this.name });
    this.urlInput = InputState.new({ value: "" });
    for (const input of [this.nameInput, this.urlInput]) {
      input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      input.on("submit", (_e, cx) => this.ok(cx));
    }
    this.urlInput.focus();
    cx.spawn(async (cx) => {
      const r = this.root ? await readRemote(makeGit(exec, this.on), this.root, this.name) : { ok: false, err: "" };
      this.read = true;
      if (r.ok) { this.url = r.url; this.urlInput.set_value(r.url); }
      else this.error = sentence(this.t, r.msg, r.err);
      this.urlInput.focus();
      cx.notify();
    });
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  ready() {
    if (this.waiting || this.writing() || !this.name) return false;
    if (this.removing) return true;
    return this.read && Boolean(this.nameInput.value().trim()) && Boolean(this.urlInput.value().trim());
  }

  ok(cx) {
    if (!this.ready()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    const args = this.removing
      ? { root: this.root, on: this.on, name: this.name }
      : { root: this.root, on: this.on, name: this.name, to: this.nameInput.value().trim(), url: this.urlInput.value().trim(), fetch: this.fetch };
    askOwner(this, this.removing ? "remote-remove" : "remote-edit", args, "ui.logPanel", cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err);
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  field(id, label, input, t) {
    return h_flex().w_full().min_w(0).gap(8).items_center()
      .child(div().w(52).flex_none().text_size(12.5).child(label))
      .child(div().id(id).flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(6).border_1()
        .border_color(t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { input.focus(); cx.stop_propagation(); })
        .child(Input.new(input).w_full().h_full().text_size(13).text_color(t.foreground)));
  }

  renderRemove(t, said) {
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(8)
      .child(div().w_full().child(this.t("refs.removeAsk", { name: this.name })))
      .when(Boolean(said), (el) => el.child(scrollText("remote-remove-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return this.frame("remote-remove", this.t("refs.removeTitle"), t, body, this.t("refs.remove"));
  }

  frame(id, title, t, body, okLabel) {
    return dialogFrame(id, title, t, {
      body, onClose: () => this.shut(),
      footer: [
        button(`${id}-cancel`, this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button(`${id}-ok`, okLabel, t, { kind: "primary", disabled: !this.ready() && !this.waiting, busy: this.waiting, onClick: (_e, cx) => this.ok(cx) }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") this.shut();
      else if (e.key === "enter" && this.removing) this.ok(cx);
      else return;
      cx.stop_propagation();
    });
  }

  render() {
    const t = theme(), said = this.error ?? this.writing();
    if (this.removing) return this.renderRemove(t, said);
    const toggle = (_e, cx) => { this.fetch = !this.fetch; cx.notify(); };
    const body = !this.read ? notice(this.t("ui.loading"), t, { busy: true })
      : v_flex().size_full().min_h(0).px(14).py(12).gap(8)
        .child(this.field("remote-name", this.t("refs.remoteName"), this.nameInput, t))
        .child(this.field("remote-url", this.t("refs.remoteUrl"), this.urlInput, t))
        .child(h_flex().id("remote-fetch-row").flex_none().gap(7).items_center().cursor_pointer().on_click(toggle)
          .child(checkbox("remote-fetch", this.fetch, t, { onClick: toggle }))
          .child(this.t("refs.fetchRemote")))
        .when(Boolean(said), (el) => el.child(scrollText("remote-edit-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return this.frame("remote-edit", this.t("refs.remoteTitle"), t, body, this.t("refs.ok"));
  }
}
