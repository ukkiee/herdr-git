// Patch File Settings dialog (view "patch"): Create Patch… on commits or on Commit details'
// files. To a file: the Log panel that opened it (props.owner) has git write it on the
// repository's machine, under the write lock (serve-actions.js "patch-create"). To the
// clipboard: the dialog reads the patch itself (a read) and copies it.
// Encoding is UTF-8 only: git writes the bytes the files hold.
//
// props: { root, on, commits, paths, file, local, owner, lang }: commits the full hashes,
// newest first; paths the repository paths to keep (none: every file); file the path
// offered; local: the repository is on this computer (the folder buttons need it).

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, notify, pickFolder } from "herdr";
import { makeGit } from "./git.js";
import { createPatch, patchFileName } from "./git-revision.js";
import { openDialog, dialogFrame, button, checkbox, iconButton, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);

// openPatch(host, { commits, paths }): from the Log panel (view-log.js ACTIONS). commits: as
// the Log hands them, newest first.
export function openPatch(host, { commits, paths = [] }) {
  const repo = host.repo, list = (commits ?? []).filter((c) => c?.hash);
  if (!repo || !list.length) return;
  const branch = host.branches?.data?.head?.branch ?? null;
  const file = `${repo.root.replace(/[\\/]+$/, "")}/${patchFileName(branch, list[0].subject)}`;
  openDialog("patch", { root: repo.root, on: repo.on, commits: list.map((c) => c.hash), paths, file, local: !repo.on, owner: host.bus.id, lang: host.lang }, { width: 560, height: 300 });
}

// A Commit details file row: that file of its commit (and its old name when renamed).
export function openFilePatch(host, m) {
  const hash = m?.item?.commit ?? host.details?.info?.hash ?? null;
  if (!hash || !m || m.folder) return;
  const shown = host.details?.info;
  const subject = shown?.hash === hash ? (shown.message ?? "").split("\n")[0] : "";
  openPatch(host, { commits: [{ hash, subject }], paths: [m.path, ...(m.item.from ? [m.item.from] : [])] });
}

export default class PatchView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.commits = strings(p.commits); this.paths = strings(p.paths);
    this.local = p.local === true;
    this.owner = p.owner ?? null;
    this.toFile = true; this.reverse = false;
    this.waiting = false; this.error = null;
    this.handle = cx.focus_handle();
    this.fileInput = InputState.new({ value: String(p.file ?? "") });
    this.baseInput = InputState.new({ value: String(this.root ?? "") });
    for (const input of [this.fileInput, this.baseInput]) {
      input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      input.on("submit", (_e, cx) => this.confirm(cx));
    }
    this.handle.focus();
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  options() {
    return { commits: this.commits, paths: this.paths, reverse: this.reverse, base: this.baseInput.value().trim() || this.root };
  }

  confirm(cx) {
    if (this.waiting || !this.root || !this.commits.length) return;
    if (!this.toFile) { this.copy(cx); return; }
    const file = this.fileInput.value().trim();
    if (!file) { this.error = this.t("revision.needFile"); cx.notify(); return; }
    if (this.writing()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    askOwner(this, "patch-create", { root: this.root, on: this.on, ...this.options(), file }, "ui.logPanel", cx, (r, cx) => {
      this.waiting = false;
      if (r.ok) { notify({ title: this.t("revision.saved", { file }), level: "info" }); close(this.overlay); return; }
      this.error = sentence(this.t, r.msg, r.err);
    });
  }

  copy(cx) {
    this.waiting = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await createPatch(makeGit(exec, this.on), this.root, this.options()); }
      catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      this.waiting = false;
      if (r.ok) {
        cx.write_to_clipboard(r.text);
        notify({ title: this.t("revision.copied"), level: "info" });
        close(this.overlay);
      } else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      cx.notify();
    });
  }

  // Not while the panel writes: the dialog shows how it ends.
  shut() { if (!this.waiting) close(this.overlay); }

  browse(input, cx, { file = false } = {}) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: this.t(file ? "revision.toFile" : "revision.basePath") });
      if (!folder) return;
      const name = file ? `/${this.fileInput.value().trim().split(/[\\/]/).pop() || patchFileName(null, "")}` : "";
      input.set_value(`${folder.replace(/[\\/]+$/, "")}${name}`);
      this.error = null;
      cx.notify();
    });
  }

  field(id, input, t, { disabled = false, file = false } = {}) {
    return h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(div().id(id).flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .when(disabled, (el) => el.opacity(0.5))
        .on_mouse_down("left", (_e, cx) => { if (!disabled) input.focus(); cx.stop_propagation(); })
        .child(Input.new(input).w_full().h_full().text_size(12.5).text_color(t.foreground)))
      .when(this.local, (el) => el.child(iconButton(`${id}-browse`, "folder", t, { title: this.t("revision.browse"), disabled, onClick: (_e, cx) => this.browse(input, cx, { file }) })));
  }

  // A radio choice, drawn as the mark and its words.
  choice(id, on, label, t, pick) {
    return h_flex().id(id).flex_none().gap(7).items_center().cursor_pointer()
      .on_click((_e, cx) => { pick(); this.error = null; cx.notify(); })
      .child(div().size(14).flex_none().rounded(7).border_1().border_color(on ? t.accent : t.input).flex().items_center().justify_center()
        .when(on, (el) => el.child(div().size(6).rounded(3).bg(t.accent))))
      .child(label);
  }

  render() {
    const t = theme(), writing = this.writing(), said = this.error ?? writing;
    const label = (text) => div().flex_none().w(110).text_color(t.muted).child(text);
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(10)
      .child(h_flex().w_full().gap(8).items_center()
        .child(div().flex_none().w(110).child(this.choice("patch-to-file", this.toFile, this.t("revision.toFile"), t, () => { this.toFile = true; })))
        .child(this.field("patch-file", this.fileInput, t, { disabled: !this.toFile, file: true })))
      .child(this.choice("patch-to-clipboard", !this.toFile, this.t("revision.toClipboard"), t, () => { this.toFile = false; }))
      .child(h_flex().w_full().gap(8).items_center().child(label(this.t("revision.basePath"))).child(this.field("patch-base", this.baseInput, t)))
      .child(h_flex().id("patch-reverse-row").flex_none().gap(7).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.reverse = !this.reverse; cx.notify(); })
        .child(checkbox("patch-reverse", this.reverse, t, { onClick: (_e, cx) => { this.reverse = !this.reverse; cx.notify(); } }))
        .child(this.t("revision.reverse")))
      .child(h_flex().w_full().gap(8).items_center().child(label(this.t("revision.encoding")))
        .child(div().flex_none().h(28).px(10).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.muted).child("UTF-8")))
      .when(Boolean(said), (el) => el.child(scrollText("patch-error", said ?? "", t, { maxHeight: 40, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("patch", this.t("revision.patchTitle"), t, {
      body, onClose: () => this.shut(),
      footer: [
        button("patch-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("patch-ok", this.t("revision.ok"), t, { kind: "primary", disabled: Boolean(this.toFile && writing), busy: this.waiting, onClick: (_e, cx) => this.confirm(cx) }),
      ],
    }).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.shut();
        else if (e.key === "enter") this.confirm(cx);
        else return;
        cx.stop_propagation();
      });
  }
}
