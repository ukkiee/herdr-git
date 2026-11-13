// New Worktree dialog: Source branch ▾ (with a warning when another worktree has it
// checked out), ☐ New branch [field], Location [path] with a line on what it is, Cancel
// and Create Worktree and Open. The location follows the branch (git-worktree.js
// worktreePath) until it is edited.
//
// The dialog runs no git that writes: it asks the screen copy that opened it
// (props.owner) to make the worktree under the repository's write lock
// ("worktree-create" in serve-actions.js), and that copy opens the new space on the
// folder, on the space's machine. Herdr closes a dialog on Esc even while it waits; the
// opener still finishes and opens the space.
//
// props: { view: "worktree", root, on, source: { name, scope } | null, owner, lang, who, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, run, pickFolder } from "herdr";
import { makeGit } from "./git.js";
import { worktreeSources, worktreePath, createWorktree } from "./git-worktree.js";
import { openDialog, openMenu, dialogFrame, button, checkbox, iconButton, uiGlyph, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

// openNewWorktree(host, repo, source, who): New Worktree… from the VCS widget popup
// (source null: the current branch) or a branch's menu (source { name, scope }). host:
// the opening screen (its bus, lang); repo: { root, on }; who: the host's name key for the
// words when it doesn't answer. Nothing while another write runs.
export function openNewWorktree(host, repo, source, who = "ui.logPanel") {
  if (!repo || writeBlock(host, repo)) return;
  const from = source && (source.scope === "local" || source.scope === "remote") && source.name ? { name: source.name, scope: source.scope } : null;
  openDialog("worktree", { root: repo.root, on: repo.on ?? null, source: from, owner: host.bus.id, lang: host.lang, who }, { width: 520, height: 300 });
}

// The opener's side of "worktree-create" { source, newBranch, path, on } (serve-actions.js):
// makes the worktree, then a new space on its folder on the same machine.
export async function runWorktreeCreate(git, root, args) {
  const source = args.source && typeof args.source.name === "string" ? { name: args.source.name, scope: args.source.scope === "remote" ? "remote" : "local" } : null;
  const r = await createWorktree(git, root, {
    source, newBranch: typeof args.newBranch === "string" ? args.newBranch : "", path: typeof args.path === "string" ? args.path : "",
  });
  if (r.ok) {
    const on = typeof args.on === "string" ? args.on : null;
    run("space.new", { folder: r.path, machine: on ?? "", name: (typeof args.newBranch === "string" && args.newBranch.trim()) || source.name });
  }
  return r;
}

const LABEL_W = 110;

export default class NewWorktree {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.logPanel";
    this.wanted = p.source ?? null;
    this.sources = null;
    this.source = null;
    this.makeBranch = false;
    this.waiting = false;
    this.error = null;
    this.suggested = "";
    this.handle = cx.focus_handle();
    this.branchInput = InputState.new({ value: "" });
    this.branchInput.on("change", (_e, cx) => {
      if (this.branchInput.value().trim()) this.makeBranch = true;
      this.error = null; this.follow(); cx.notify();
    });
    this.branchInput.on("submit", (_e, cx) => this.ok(cx));
    this.pathInput = InputState.new({ value: "" });
    this.pathInput.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.pathInput.on("submit", (_e, cx) => this.ok(cx));
    this.read(cx);
  }

  read(cx) {
    if (!this.root) return;
    cx.spawn(async (cx) => {
      const r = await worktreeSources(makeGit(exec, this.on), this.root);
      if (!r.ok) { this.error = r.err; this.sources = []; cx.notify(); return; }
      this.sources = r.branches;
      const w = this.wanted;
      this.source = (w && r.branches.find((b) => b.name === w.name && b.scope === w.scope))
        ?? r.branches.find((b) => b.scope === "local" && b.name === r.current) ?? r.branches[0] ?? null;
      this.follow();
      cx.notify();
    });
  }

  // The location follows the branch while it still shows what was suggested.
  follow() {
    if (!this.root) return;
    const branch = (this.makeBranch && this.branchInput.value().trim()) || this.source?.name || "";
    const next = branch ? worktreePath(this.root, branch) : "";
    const now = this.pathInput.value();
    if (now === this.suggested && next !== now) this.pathInput.set_value(next);
    this.suggested = next;
  }

  // Another write on the repository, or null. This dialog's own runs under `waiting`.
  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  ready() { return Boolean(this.source) && Boolean(this.pathInput.value().trim()) && (!this.makeBranch || Boolean(this.branchInput.value().trim())) && !this.waiting && !this.writing(); }

  ok(cx) {
    if (!this.ready()) return;
    this.waiting = true; this.error = null;
    cx.notify();
    const args = {
      root: this.root, on: this.on, source: { name: this.source.name, scope: this.source.scope },
      newBranch: this.makeBranch ? this.branchInput.value().trim() : "", path: this.pathInput.value().trim(),
    };
    askOwner(this, "worktree-create", args, this.who, cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  // The Source branch list, opened where it was pressed (at: window coordinates).
  pickSource(cx, at) {
    if (this.waiting || this.listOpen || !this.sources?.length) return;
    this.listOpen = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const items = [];
      this.sources.forEach((b, i) => {
        items.push({ label: b.name, value: String(i), hint: b === this.source ? "✓" : "", rule: i > 0 && b.scope !== this.sources[i - 1].scope });
      });
      const picked = await openMenu(this.bus, items, { width: 300, at, lang: this.lang });
      this.listOpen = false;
      const b = picked == null ? null : this.sources[Number(picked)];
      if (!this.waiting && b) { this.source = b; this.error = null; this.follow(); }
      cx.notify();
    });
  }

  // The system's folder picker is on this computer only.
  pickPath(cx) {
    if (this.waiting || this.on) return;
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: this.t("worktree.pickFolder") });
      if (folder) { this.pathInput.set_value(folder); this.error = null; }
      cx.notify();
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  label(t, text) { return div().w(LABEL_W).flex_none().text_color(t.muted).child(text); }

  field(id, state, t, { disabled = false } = {}) {
    return div().id(id).flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1()
      .border_color(t.input).bg(t.background).cursor_text().when(disabled, (el) => el.opacity(0.5))
      .on_mouse_down("left", (_e, cx) => { if (!disabled) state.focus(); cx.stop_propagation(); })
      .child(Input.new(state).w_full().h_full().text_size(13).text_color(t.foreground));
  }

  render() {
    const t = theme(), said = this.error ?? this.writing(), b = this.source;
    const name = this.sources === null ? "…" : b ? b.name : this.t("worktree.noSources");
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(10).text_size(12.5)
      .child(h_flex().w_full().items_center().child(this.label(t, this.t("worktree.source")))
        .child(h_flex().id("worktree-source").flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(6).border_1()
          .border_color(this.listOpen ? t.accent : t.input).bg(t.background).cursor_pointer()
          .on_mouse_down("left", (e, cx) => { this.pickSource(cx, e.position); cx.stop_propagation(); })
          .child(div().flex_1().min_w(0).truncate().child(name))
          .child(uiGlyph("chevron-down").text_color(t.muted))))
      .when(Boolean(b?.checkedOut), (el) => el.child(h_flex().w_full().pl(LABEL_W).gap(6).items_center().text_color(t.ansi3)
        .child(div().flex_1().min_w(0).child(`⚠ ${this.t("worktree.checkedOut")}`))))
      .child(h_flex().w_full().items_center()
        .child(h_flex().w(LABEL_W).flex_none().gap(6).items_center()
          .child(checkbox("worktree-new-branch", this.makeBranch, t, { disabled: this.waiting, onClick: (_e, cx) => { this.makeBranch = !this.makeBranch; this.error = null; this.follow(); if (this.makeBranch) this.branchInput.focus(); cx.notify(); } }))
          .child(div().text_color(t.muted).child(this.t("worktree.newBranch"))))
        .child(this.field("worktree-branch", this.branchInput, t, { disabled: !this.makeBranch })))
      .child(h_flex().w_full().gap(6).items_center().child(this.label(t, this.t("worktree.location")))
        .child(this.field("worktree-path", this.pathInput, t))
        .when(!this.on, (el) => el.child(iconButton("worktree-pick", "folder", t, { title: this.t("worktree.pickFolder"), disabled: this.waiting, onClick: (_e, cx) => this.pickPath(cx) }))))
      .child(div().w_full().pl(LABEL_W).text_size(11.5).text_color(t.dim).child(this.t("worktree.locationHint")))
      .when(Boolean(said), (el) => el.child(scrollText("worktree-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("worktree", this.t("worktree.title"), t, {
      body, onClose: () => this.shut(),
      footer: [
        button("worktree-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("worktree-ok", this.t("worktree.create"), t, { kind: "primary", disabled: !this.ready() && !this.waiting, busy: this.waiting, onClick: (_e, cx) => this.ok(cx) }),
      ],
    }).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      this.shut();
      cx.stop_propagation();
    });
  }
}
