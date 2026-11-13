// Apply Patch dialog (view "apply-patch"): Patch ▸ Apply Patch… and Apply Patch from
// Clipboard…. From a file: "Patch file name:" (📁 picks its folder, this computer's space
// only: the picker is this computer's). From the clipboard: its text. The patch's files as
// a checkbox tree, all checked, each with what the patch does to it; Cancel and OK.
//
// OK asks the panel that opened it (props.owner, "patch-apply" in serve-actions.js) to
// apply the checked files under the write lock (git-patch.js applyPatch): on the working
// tree, or as a 3-way merge when it doesn't fit, and the panel opens the Conflicts dialog
// when lines are left in conflict. The clipboard's text goes to the panel in a staged file
// on the repository's machine (git-conflict.js stageText), never in the request: the
// request rides in the shared value every screen redraws on.
//
// props: { view: "apply-patch", root, on, owner, who, clipboard, lang, overlay }.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, theme, notify, readTextFile, pickFolder, appHome, home } from "herdr";
import { readPatchFiles, applyPatch, readMayBeCut, homePath } from "./git-patch.js";
import { stageText, dropStaged, isStaged } from "./git-conflict.js";
import { openConflicts } from "./view-conflicts.js";
import { CheckedFiles } from "./view-create-patch.js";
import { openDialog, dialogFrame, button, iconButton, notice, errorStrip, close, askOwner, writeBlock, sentence } from "./ui.js";

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
// Typing the path reads the file once the typing stops this long.
const SETTLE = 350;
// This computer's staged files go in the app's own folder (as the Merge Revisions dialog's).
const STAGE_DIR = "git-tools";

// openApplyPatch(panel, repo, who, { clipboard }): Apply Patch… (clipboard false) and
// Apply Patch from Clipboard… (true), in the panel's copy.
export function openApplyPatch(panel, repo, who, { clipboard = false } = {}) {
  if (!repo) return;
  openDialog("apply-patch", { root: repo.root, on: repo.on ?? null, owner: panel.bus.id, who, clipboard, lang: panel.lang }, { width: 600, height: clipboard ? 460 : 500 });
}

// The panel's side of "patch-apply" { file, staged, paths, who }. A staged file
// (the clipboard's text) is removed after; a request naming any other file as staged is
// refused. Lines left in conflict open the Conflicts dialog, owned by this panel.
export async function runPatchApply(git, root, args, panel) {
  const on = typeof args.on === "string" ? args.on : null, file = typeof args.file === "string" ? args.file : "";
  const staged = args.staged === true;
  if (staged && !isStaged(file)) return { ok: false, code: -1, out: "", err: "Enter the patch file's path.", msg: { key: "patch.noFile", args: {} } };
  let r;
  try { r = await applyPatch(git, root, { file, paths: strings(args.paths) }); }
  finally { if (staged) await dropStaged(exec, on, file); }
  if (r.conflicts.length) openConflicts({ root, on, owner: panel.bus.id, lang: panel.lang, who: typeof args.who === "string" ? args.who : "ui.commitPanel" });
  else if (r.ok && r.threeWay) notify({ title: panel.t("patch.appliedThreeWay"), level: "info" });
  return r;
}

const LABELS = { added: "patch.added", modified: "patch.modified", deleted: "patch.deleted" };

export default class ApplyPatchView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.clipboard = p.clipboard === true;
    this.tree = new CheckedFiles("apply-patch-files");
    this.text = null; // the patch's text as read
    this.problem = null; // why there is nothing to apply (the read or the text), worded
    this.reading = false; this.running = false; this.error = null; this.typing = false;
    this.seq = 0;
    this.handle = cx.focus_handle();
    if (this.clipboard) {
      let text = "";
      try { text = cx.read_from_clipboard() ?? ""; } catch { /* nothing to read: an empty patch */ }
      this.take(text);
      this.handle.focus();
      return;
    }
    this.pathInput = InputState.new({ value: "" });
    this.pathInput.on("change", (_e, cx) => { this.error = null; this.later(cx); cx.notify(); });
    this.pathInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.pathInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.pathInput.on("submit", (_e, cx) => this.load(cx));
    this.pathInput.focus();
  }

  // The patch's files from its text, or why there are none.
  take(text) {
    this.text = text;
    const r = readPatchFiles(text);
    this.problem = r.ok ? null : sentence(this.t, r.msg, r.err);
    this.tree.set(r.files);
  }

  // The typed path as the reader and git take it: relative to the repository, and "~" as
  // the home folder of the machine the patch is on.
  async path() {
    const typed = this.pathInput?.value().trim() ?? "";
    if (!typed) return "";
    if (typed === "~" || typed.startsWith("~/")) return homePath(typed, await this.homeFolder());
    return typed.startsWith("/") || typed.startsWith("~") ? typed : `${this.root.replace(/\/+$/, "")}/${typed}`;
  }

  // Asked once; "" when it can't be known (the "~" path then stays as typed and fails to read).
  async homeFolder() {
    if (this.home === undefined) {
      try { this.home = this.on ? (await exec("printenv", ["HOME"], { on: this.on })).stdout?.trim() ?? "" : String(await home() ?? ""); }
      catch { this.home = ""; }
    }
    return this.home;
  }

  // Reads the typed file when the typing has stopped.
  later(cx) {
    const seq = ++this.seq;
    cx.timer.after(SETTLE, (cx) => { if (seq === this.seq) this.load(cx); });
  }

  load(cx) {
    const seq = ++this.seq;
    if (!this.pathInput?.value().trim()) { this.text = null; this.problem = null; this.tree.set([]); cx.notify(); return; }
    this.reading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const file = await this.path();
      let text = null, why = null;
      try { text = await readTextFile(file, { on: this.on }); } catch (error) { why = String(error?.message ?? error); }
      if (seq !== this.seq) return;
      this.reading = false;
      if (typeof text === "string" && readMayBeCut(text)) why = this.t("patch.tooLarge");
      if (why !== null || typeof text !== "string") {
        this.text = null; this.tree.set([]);
        this.problem = this.t("patch.cantRead", { file, why: why ?? "" });
      } else this.take(text);
      cx.notify();
    });
  }

  browse(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: this.t("patch.browse") });
      if (!folder) return;
      const name = this.pathInput.value().trim().split(/[\\/]/).pop() ?? "";
      this.pathInput.set_value(`${folder.replace(/[\\/]+$/, "")}/${name}`);
      this.pathInput.focus();
      this.load(cx);
    });
  }

  writing() { return this.running || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  ready() { return Boolean(this.root && this.text !== null && !this.problem && !this.reading && this.tree.chosen().length && !this.running && !this.writing()); }

  confirm(cx) {
    if (!this.ready()) return;
    const chosen = this.tree.chosen();
    const args = { root: this.root, on: this.on, paths: chosen.map((f) => f.path), who: this.who };
    this.running = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      if (this.clipboard) {
        const staged = await stageText(exec, this.on, this.text, { dir: this.on ? null : `${appHome()}/${STAGE_DIR}` });
        if (!staged.ok) { this.running = false; this.error = staged.err || this.t("ui.gitFailed"); cx.notify(); return; }
        args.file = staged.file; args.staged = true;
      } else args.file = await this.path();
      askOwner(this, "patch-apply", args, this.who, cx, (r) => {
        this.running = false;
        // Nobody took it: the staged file is this dialog's to remove.
        if (r.unheard && args.staged) cx.spawn(async () => { await dropStaged(exec, this.on, args.file); });
        if (r.ok) close(this.overlay);
        else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      });
      cx.notify();
    });
  }

  shut() { if (!this.running) close(this.overlay); }

  label(item) {
    return item.status === "renamed" ? this.t("patch.renamed", { from: item.from }) : this.t(LABELS[item.status] ?? "patch.modified");
  }

  pathRow(t) {
    return h_flex().flex_none().px(12).pt(10).pb(4).gap(8).items_center()
      .child(div().flex_none().text_size(12.5).child(this.t("patch.fileName")))
      .child(div().id("apply-patch-path").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1()
        .border_color(this.typing ? t.accent : t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { this.pathInput.focus(); cx.stop_propagation(); })
        .child(Input.new(this.pathInput).w_full().h_full().text_size(12.5).text_color(t.foreground)))
      .when(!this.on, (el) => el.child(iconButton("apply-patch-browse", "folder", t, { title: this.t("patch.browse"), onClick: (_e, cx) => this.browse(cx) })));
  }

  render() {
    const t = theme(), writing = this.writing();
    const focus = () => this.handle.focus();
    const empty = this.reading ? this.t("patch.reading") : this.problem ?? (this.clipboard ? "" : this.t("patch.noFile"));
    const list = this.reading ? notice(this.t("patch.reading"), t, { busy: true })
      : this.tree.render(t, this.t, { disabled: this.running, empty, label: (item) => this.label(item), focus });
    const body = v_flex().size_full().min_h(0)
      .when(!this.clipboard, (el) => el.child(this.pathRow(t)))
      .child(this.tree.toolbar(t, this.t, focus))
      .child(div().id("apply-patch-list").flex_1().min_h(0).mx(12).rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(list))
      .child(div().h(8).flex_none())
      .when(Boolean(this.error), (el) => el.child(errorStrip("apply-patch-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
    return dialogFrame("apply-patch", this.t("patch.applyTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.running ? this.t("patch.applying") : writing ?? "",
      footer: [
        button("apply-patch-cancel", this.t("dialogs.cancel"), t, { disabled: this.running, onClick: () => this.shut() }),
        button("apply-patch-ok", this.t("patch.ok"), t, {
          kind: "primary", disabled: !this.ready(), busy: this.running, title: writing ?? undefined,
          onClick: (_e, cx) => { this.confirm(cx); cx.notify(); },
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") { this.shut(); cx.stop_propagation(); return; }
      if (this.typing) return;
      if (e.key === "enter") { this.confirm(cx); cx.stop_propagation(); return; }
      const name = { up: "up", down: "down", left: "left", right: "right", space: "space" }[e.keystroke];
      if (!name) return;
      this.tree.key(name);
      cx.stop_propagation();
      cx.notify();
    });
  }
}
