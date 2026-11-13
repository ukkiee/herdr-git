// Pull dialog (VCS Operations popup: Pull…), titled "Pull to <branch>": `git pull`, the
// remote ▾ and its branch ▾, Modify options ▾ (the options picked show under the row; a
// click takes one off), Cancel and Pull. It starts on the branch picked last time for this
// branch of this repository while that still exists, else the tracked branch
// (git-remote.js pullDefault); a branch picked other than the tracked one is remembered
// in the app settings (app-files.js). No option is picked at first: git then does as the
// person's settings say.
//
// The dialog doesn't write itself: it asks the panel copy that opened it ("remote-pull",
// serve-actions.js → view-update-project.js runRemote), which tells what came of it.
//
// props: { view: "pull", root, on, owner, who, overlay }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readPullTargets, pullDefault, togglePullOption, PULL_OPTIONS } from "./git-remote.js";
import { appSetting, saveAppSetting } from "./app-files.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, openMenu, uiGlyph, darkLook, notice } from "./ui.js";

// App setting: { "<machine>\t<root>\t<branch>": "<remote>/<branch>" }.
const MEMORY_KEY = "pull.branches";
const memoryOf = (on, root, branch) => `${on ?? ""}\t${root}\t${branch ?? ""}`;
const str = (value) => (typeof value === "string" ? value : "");

// Each option's words in the Add Pull Options list, written out so i18n.test.mjs finds them.
const OPTION_WORDS = {
  "--rebase": (t) => t("remote.optRebase"),
  "--ff-only": (t) => t("remote.optFfOnly"),
  "--no-ff": (t) => t("remote.optNoFf"),
  "--squash": (t) => t("remote.optSquash"),
  "--no-commit": (t) => t("remote.optNoCommit"),
  "--no-verify": (t) => t("remote.optNoVerify"),
};

// openPull({ root, on, owner, lang, who })
export function openPull({ root, on = null, owner = null, lang, who = "ui.commitPanel" } = {}) {
  return openDialog("pull", { root, on, owner, who, lang }, { width: 560, height: 230 });
}

export default class PullView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = str(p.who) || "ui.commitPanel";
    this.targets = null;
    this.pick = null; // { remote, branch }
    this.options = [];
    this.waiting = false;
    this.error = null;
    if (!this.root) return;
    cx.spawn(async (cx) => {
      const targets = await readPullTargets(makeGit(exec, this.on), this.root);
      if (!targets.ok) { this.targets = { ...targets, remotes: [] }; this.error = targets.err || this.t("ui.gitFailed"); cx.notify(); return; }
      const remembered = (await appSetting(MEMORY_KEY, {})) ?? {};
      this.targets = targets;
      this.pick = pullDefault(targets, typeof remembered === "object" ? remembered[memoryOf(this.on, this.root, targets.branch)] : null);
      cx.notify();
    });
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  branchesOf(remote) { return this.targets?.remotes.find((r) => r.name === remote)?.branches ?? []; }

  chooseRemote(cx) {
    const remotes = this.targets?.remotes ?? [];
    if (!remotes.length || this.waiting) return;
    cx.spawn(async (cx) => {
      const name = await openMenu(this.bus, remotes.map((r) => ({ label: r.name, value: r.name })), { width: 220, lang: this.lang });
      if (typeof name === "string" && name !== this.pick?.remote) {
        const branches = this.branchesOf(name);
        this.pick = { remote: name, branch: branches.includes(this.pick?.branch) ? this.pick.branch : branches[0] ?? "" };
      }
      cx.notify();
    });
  }

  chooseBranch(cx) {
    const branches = this.branchesOf(this.pick?.remote);
    if (!branches.length || this.waiting) return;
    cx.spawn(async (cx) => {
      const name = await openMenu(this.bus, branches.map((b) => ({ label: b, value: b })), { width: 280, lang: this.lang });
      if (typeof name === "string") this.pick = { ...this.pick, branch: name };
      cx.notify();
    });
  }

  chooseOptions(cx) {
    if (this.waiting) return;
    cx.spawn(async (cx) => {
      const items = PULL_OPTIONS.map((o) => ({ label: `${this.options.includes(o) ? "✓ " : ""}${OPTION_WORDS[o](this.t)}`, value: o, hint: o }));
      const o = await openMenu(this.bus, items, { width: 480, lang: this.lang });
      if (typeof o === "string") this.options = togglePullOption(this.options, o);
      cx.notify();
    });
  }

  run(cx) {
    const pick = this.pick;
    if (this.waiting || !this.root || !pick?.remote || !pick?.branch || this.writing()) return;
    this.waiting = true; this.error = null;
    cx.spawn(async (cx) => {
      // Remembered for this branch when it isn't the tracked one; forgotten when it is.
      const up = this.targets?.upstream, tracked = up && up.remote === pick.remote && up.branch === pick.branch;
      const all = { ...((await appSetting(MEMORY_KEY, {})) ?? {}) }, key = memoryOf(this.on, this.root, this.targets?.branch);
      if (tracked) delete all[key]; else all[key] = `${pick.remote}/${pick.branch}`;
      await saveAppSetting(MEMORY_KEY, all);
      askOwner(this, "remote-pull", { root: this.root, on: this.on, who: this.who, type: "pull", remote: pick.remote, branch: pick.branch, options: this.options }, this.who, cx, (r) => {
        this.waiting = false;
        if (r.ok) close(this.overlay);
        else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
      });
      cx.notify();
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  picker(id, text, t, onClick) {
    const dark = darkLook(t.popover);
    return h_flex().id(id).h(28).px(8).gap(6).min_w(0).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(div().min_w(0).truncate().child(text))
      .child(uiGlyph("chevron-down", { dark, size: 12 }));
  }

  render() {
    const t = theme(), writing = this.writing(), targets = this.targets, pick = this.pick;
    const branch = targets?.branch ?? "HEAD";
    const said = this.error ?? writing;
    let body;
    if (!targets) body = notice(this.t("remote.reading"), t, { busy: true });
    else if (!pick) body = notice(this.t("remote.noRemotes"), t);
    else {
      body = v_flex().size_full().min_h(0).px(14).py(12).gap(10)
        .child(h_flex().w_full().gap(8).items_center()
          .child(div().flex_none().px(8).h(28).flex().items_center().rounded(6).bg(t.raised).text_color(t.muted).child("git pull"))
          .child(this.picker("pull-remote", pick.remote, t, (cx) => this.chooseRemote(cx)))
          .child(div().flex_1().min_w(0).child(this.picker("pull-branch", pick.branch, t, (cx) => this.chooseBranch(cx)))))
        .when(this.options.length > 0, (el) => el.child(h_flex().w_full().gap(6).flex_wrap().children(this.options.map((o) =>
          h_flex().id(`pull-option-${o.slice(2)}`).h(22).px(8).items_center().rounded(4).bg(t.raised).text_size(12).cursor_pointer()
            .tooltip(OPTION_WORDS[o](this.t))
            .on_click((_e, cx) => { if (!this.waiting) { this.options = togglePullOption(this.options, o); cx.notify(); } })
            .child(`${o} ×`)))));
    }
    if (said) body = v_flex().size_full().min_h(0).child(div().flex_1().min_h(0).child(body)).child(div().px(14).pb(8).child(scrollText("pull-error", said ?? "", t, { maxHeight: 60, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("pull", this.t("remote.pullTitle", { branch }), t, {
      body, onClose: () => this.shut(), note: this.waiting ? this.t("remote.pulling") : "",
      footer: [
        button("pull-options", `${this.t("remote.modifyOptions")} ▾`, t, { disabled: this.waiting || !pick, onClick: (_e, cx) => this.chooseOptions(cx) }),
        div().flex_1(),
        button("pull-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("pull-run", this.t("remote.pullButton"), t, {
          kind: "primary", disabled: Boolean(writing) || !pick?.branch, busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).on_key_down((e, cx) => {
      if (e.key === "escape") { this.shut(); cx.stop_propagation(); }
      else if (e.key === "enter") { this.run(cx); cx.stop_propagation(); }
    });
  }
}
