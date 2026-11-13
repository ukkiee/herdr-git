// Create Patch dialog (view "create-patch"): the VCS Operations popup's Patch ▸ Create
// Patch… on local changes. The changed files as a checkbox tree (at first what the
// Commit panel has checked, or every file), how many of each kind are checked, the commit
// message (the Commit panel's draft), Cancel and Create Patch….
//
// Create Patch… asks the panel that opened it (props.owner, "patch-local" in
// serve-actions.js) to make a commit of the checked files (git-patch.js changesCommit,
// under the write lock: it writes objects and a scratch index) and to open the Patch File
// Settings dialog on that commit, the dialog Create Patch… on a commit opens. So the
// patch, to a file or the clipboard, comes out the same way as a commit's.
//
// props: { view: "create-patch", root, on, owner, who, checked, message, lang, overlay }.
//
// CheckedFiles is the checkbox tree the Apply Patch dialog draws too (view-apply-patch.js).

import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readStatus } from "./git-status.js";
import { changesCommit } from "./git-patch.js";
import { openPatch } from "./view-patch.js";
import { buildRows, checkState, toggleIncluded, folderKeys, parentIndex } from "./tree.js";
import { openDialog, dialogFrame, button, iconButton, checkbox, row, notice, errorStrip, uiGlyph, ICON, fileGlyph, folderGlyph, darkLook, close, WindowedList, askOwner, writeBlock, sentence, textBox } from "./ui.js";

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const text = (value) => (typeof value === "string" ? value : "");
const stop = (_e, cx) => cx.stop_propagation();

// createPatchFrom(panel, repo, who, kind): the VCS Operations popup's Create Patch… in the
// panel's copy. kind "commit": the Commit panel's checked files and message draft go in.
export function createPatchFrom(panel, repo, who, kind) {
  if (!repo) return;
  const commit = kind === "commit";
  openDialog("create-patch", {
    root: repo.root, on: repo.on ?? null, owner: panel.bus.id, who, lang: panel.lang,
    checked: commit ? (panel.included?.() ?? []).map((f) => f.path) : [],
    message: commit ? panel.form?.text?.value?.() ?? "" : "",
  }, { width: 600, height: 560 });
}

// The panel's side of "patch-local" { paths, message }: the commit of those files, then the
// Patch File Settings dialog on it, owned by this panel. The file is offered under the
// branch's name and the message's first line.
export async function runPatchLocal(git, root, args, panel) {
  const paths = strings(args.paths), message = text(args.message);
  const r = await changesCommit(git, root, { paths, message });
  if (!r.ok) return r;
  const on = typeof args.on === "string" ? args.on : null;
  // openPatch's host: where, the branch for the file's name, and who serves the write.
  const host = { repo: { root, on }, branches: { data: { head: { branch: r.branch } } }, bus: panel.bus, lang: panel.lang };
  openPatch(host, { commits: [{ hash: r.hash, subject: message.split("\n")[0].trim() }], paths });
  return { ok: true, code: 0, out: "", err: "" };
}

// ---- the checkbox tree both patch dialogs draw

// Same colors as the Commit panel's rows.
export function statusColor(status, t) {
  return { modified: t.ansi4, added: t.ansi2, unversioned: t.ansi1, renamed: t.ansi4, deleted: t.muted, conflict: t.ansi9 ?? t.ansi1 }[status] ?? t.foreground;
}

// files: [{ path, status, … }]; picked: the checked paths. Rows are built when the files
// or the folding change, never in render. Keep one per dialog, made in init.
export class CheckedFiles {
  constructor(id) {
    this.id = id;
    this.files = []; this.picked = new Set();
    this.grouped = true; this.collapsed = new Set();
    this.rows = []; this.at = -1; this.selected = null;
    this.list = new WindowedList(id);
  }

  // checked: the paths to check; none of them listed → every file.
  set(files, checked = []) {
    this.files = files;
    const listed = new Set(files.map((f) => f.path));
    const asked = checked.filter((path) => listed.has(path));
    this.picked = new Set(asked.length ? asked : listed);
    this.collapsed = new Set();
    this.rebuild();
  }

  rebuild() {
    this.rows = buildRows(this.files, { grouped: this.grouped, compact: true, collapsed: this.collapsed }).map((r) => ({ ...r, id: r.key }));
    this.at = this.selected ? this.rows.findIndex((r) => r.id === this.selected) : -1;
    if (this.at < 0) this.selected = null;
  }

  chosen() { return this.files.filter((f) => this.picked.has(f.path)); }

  select(i) {
    const r = this.rows[i];
    if (!r) return false;
    this.at = i; this.selected = r.id;
    this.list.reveal(i, this.rows.length);
    return true;
  }

  toggleOpen(r) {
    if (!r?.folder) return false;
    if (!this.collapsed.delete(r.key)) this.collapsed.add(r.key);
    this.rebuild();
    return true;
  }

  toggleCheck(r) {
    if (!r) return false;
    this.picked = toggleIncluded(this.picked, r.paths);
    return true;
  }

  setGrouped(grouped) { this.grouped = grouped; this.rebuild(); }
  expandAll() { this.collapsed = new Set(); this.rebuild(); }
  collapseAll() { this.collapsed = new Set(folderKeys(this.files, { compact: true })); this.rebuild(); }

  // up, down, left, right, space → whether anything changed.
  key(name) {
    const r = this.rows[this.at], n = this.rows.length;
    if (name === "up") return this.select(this.at < 0 ? n - 1 : Math.max(0, this.at - 1));
    if (name === "down") return this.select(this.at < 0 ? 0 : Math.min(n - 1, this.at + 1));
    if (!r) return false;
    if (name === "left") return r.folder && r.open ? this.toggleOpen(r) : this.select(parentIndex(this.rows, this.at));
    if (name === "right") return r.folder ? (r.open ? this.select(this.at + 1) : this.toggleOpen(r)) : false;
    if (name === "space") return this.toggleCheck(r);
    return false;
  }

  // Group by directory, Expand All, Collapse All. tr: the dialog's t.
  toolbar(t, tr, focus) {
    const redraw = (fn) => (_e, cx) => { focus(); fn(); cx.notify(); };
    const none = !this.rows.length;
    return h_flex().h(32).flex_none().px(10).gap(2).items_center()
      .child(iconButton(`${this.id}-group`, "folder", t, { title: tr("dialogs.rollback.groupByDirectory"), active: this.grouped, onClick: redraw(() => this.setGrouped(!this.grouped)) }))
      .child(iconButton(`${this.id}-expand`, "expand-all", t, { title: tr("dialogs.rollback.expandAll"), disabled: none, onClick: redraw(() => this.expandAll()) }))
      .child(iconButton(`${this.id}-collapse`, "collapse-all", t, { title: tr("dialogs.rollback.collapseAll"), disabled: none, onClick: redraw(() => this.collapseAll()) }));
  }

  // The list. label(item) → the words after a file's name ("added"), or "".
  render(t, tr, { disabled = false, empty = "", label = () => "", focus = () => {} } = {}) {
    if (!this.rows.length) return notice(empty, t);
    const dark = darkLook(t.background);
    return this.list.render(this.rows.length, (i) => this.renderRow(i, t, tr, { disabled, label, focus, dark }), t);
  }

  renderRow(i, t, tr, { disabled, label, focus, dark }) {
    const r = this.rows[i], id = `${this.id}-${i}`;
    const el = row(`${id}-row`, t, { selected: i === this.at, depth: r.depth })
      .on_click((e, cx) => {
        focus();
        this.select(i);
        if (e.click_count === 2 && r.folder) this.toggleOpen(r);
        cx.notify();
      })
      // The arrow's place is kept on file rows so checkboxes line up under their folder's.
      .child(r.folder
        ? div().id(`${id}-fold`).size(ICON).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleOpen(r); cx.notify(); })
          .child(uiGlyph(r.open ? "chevron-down" : "chevron-right"))
        : div().size(ICON).flex_none())
      .child(checkbox(`${id}-check`, checkState(r.paths, this.picked), t, { disabled, onClick: (_e, cx) => { this.toggleCheck(r); cx.notify(); } }));
    if (r.folder) {
      return el.child(folderGlyph(r.name, { open: r.open }))
        .child(div().flex_none().max_w("70%").truncate().child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(tr("dialogs.files", { n: r.count })));
    }
    const status = r.item.status, where = this.grouped ? "" : r.dir, words = label(r.item);
    return el.child(fileGlyph(r.path, { dark }))
      .child(div().flex_none().max_w("60%").truncate().text_color(statusColor(status, t)).when(status === "deleted", (el) => el.line_through()).child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child([words, where].filter(Boolean).join("  ")));
  }
}

// ---- the dialog

const KINDS = [["modified", "patch.countModified"], ["added", "patch.countAdded"], ["deleted", "patch.countDeleted"], ["unversioned", "patch.countUnversioned"], ["conflict", "patch.countConflict"]];

export default class CreatePatchView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null; this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.checked = strings(p.checked);
    this.tree = new CheckedFiles("create-patch-files");
    this.read = false; this.running = false; this.error = null; this.typing = false;
    this.text = TextareaState.new({ placeholder: "", value: text(p.message), rows: 4 });
    this.text.on("change", (_e, cx) => cx.notify());
    this.text.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.text.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      const r = this.root ? await readStatus(makeGit(exec, this.on), this.root) : { ok: false, err: "" };
      if (r.ok) this.tree.set([...r.changes, ...r.unversioned], this.checked);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      this.read = true;
      cx.notify();
    });
  }

  writing() { return this.running || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  // "1 modified, 2 added": the checked files by what they are.
  summary() {
    const chosen = this.tree.chosen();
    if (!this.tree.files.length) return this.t("patch.noChanges");
    if (!chosen.length) return this.t("patch.noFilesChecked");
    return KINDS.map(([status, key]) => [chosen.filter((f) => f.status === status).length, key]).filter(([n]) => n).map(([n, key]) => this.t(key, { n })).join(", ");
  }

  confirm(cx) {
    const paths = this.tree.chosen().map((f) => f.path);
    if (this.running || !this.root || !paths.length || this.writing()) return;
    this.running = true; this.error = null;
    askOwner(this, "patch-local", { root: this.root, on: this.on, paths, message: this.text.value() }, this.who, cx, (r) => {
      this.running = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.running) close(this.overlay); }

  render() {
    const t = theme(), writing = this.writing(), chosen = this.tree.chosen();
    const focus = () => this.handle.focus();
    const list = !this.read ? notice(this.t("ui.loading"), t, { busy: true })
      : this.tree.render(t, this.t, { disabled: this.running, empty: this.t("patch.noChanges"), focus });
    const body = v_flex().size_full().min_h(0)
      .child(this.tree.toolbar(t, this.t, focus))
      .child(div().id("create-patch-list").flex_1().min_h(0).mx(12).rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(list))
      .child(div().id("create-patch-summary").flex_none().h(26).px(14).flex().items_center().truncate().text_size(12).text_color(t.muted).child(this.read ? this.summary() : ""))
      .child(div().flex_none().px(14).pt(4).pb(4).text_size(12.5).child(this.t("patch.message")))
      .child(div().flex_none().px(12).child(textBox("create-patch-message", this.text, t, { focused: this.typing })))
      .child(div().h(8).flex_none())
      .when(Boolean(this.error), (el) => el.child(errorStrip("create-patch-error", this.error ?? "", t, (_e, cx) => { this.error = null; cx.notify(); })));
    return dialogFrame("create-patch", this.t("patch.createTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.running ? this.t("patch.preparing") : writing ?? "",
      footer: [
        button("create-patch-cancel", this.t("dialogs.cancel"), t, { disabled: this.running, onClick: () => this.shut() }),
        button("create-patch-run", this.t("patch.create"), t, {
          kind: "primary", disabled: !this.root || !chosen.length || Boolean(writing), busy: this.running, title: writing ?? undefined,
          onClick: (_e, cx) => { this.confirm(cx); cx.notify(); },
        }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key === "escape") { this.shut(); cx.stop_propagation(); return; }
      // Keys typed in the message are the message's.
      if (this.typing) return;
      const name = { up: "up", down: "down", left: "left", right: "right", space: "space" }[e.keystroke];
      if (!name) return;
      this.tree.key(name);
      cx.stop_propagation();
      cx.notify();
    });
  }
}
