// Rebase dialog (VCS Operations popup: Rebase…, title "Rebase"): `git rebase`, the branch
// or hash to rebase onto (typed or picked from ▾), Modify options with the options picked
// shown under it, Cancel and Rebase (off without a target). Two options change the row:
// --onto gives a new base field before the target, which then is the old base; Select
// another branch to rebase gives a field for that branch after it. --root needs no target.
//
// The dialog doesn't write itself: it asks the panel copy that opened it (props.owner) to
// run "rebase-start" (serve-actions.js → view-merge.js serveOperation).
// props: { view: "rebase", root, on, owner, who, overlay }.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { exec, theme } from "herdr";
import { makeGit } from "./git.js";
import { readBranches } from "./git-branch.js";
import { requestProblem } from "./git-operation.js";
import { branchField, optionChips, modifyOptions } from "./view-merge.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence } from "./ui.js";

// "--onto" and OTHER are the dialog's own: they add a field rather than a flag.
const OTHER = "other-branch";
const REBASE_OPTIONS = [
  { flag: "--onto", key: "merge.optOnto" },
  { flag: OTHER, key: "merge.optOtherBranch", hint: "" },
  { flag: "--rebase-merges", key: "merge.optRebaseMerges" },
  { flag: "--keep-empty", key: "merge.optKeepEmpty" },
  { flag: "--root", key: "merge.optRoot" },
  { flag: "--update-refs", key: "merge.optUpdateRefs" },
];
const FIELDS = new Set(["--onto", OTHER]);

// openRebase({ root, on, owner, who, lang }): as view-merge.js openMerge.
export function openRebase({ root, on = null, owner = null, who = "ui.commitPanel", lang } = {}) {
  return openDialog("rebase", { root, on, owner, who, lang }, { width: 640, height: 280 });
}

export default class RebaseView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = typeof p.who === "string" ? p.who : "ui.commitPanel";
    this.git = makeGit(exec, this.on);
    this.names = [];
    this.local = [];
    this.picked = [];
    this.waiting = false;
    this.error = null;
    this.target = InputState.new({ placeholder: this.t("merge.branchOrHash") });
    this.onto = InputState.new({ placeholder: this.t("merge.newBase") });
    this.branch = InputState.new({ placeholder: this.t("merge.branchToRebase") });
    for (const input of [this.target, this.onto, this.branch]) {
      input.on("change", (_e, cx) => this.changed(cx));
      input.on("submit", (_e, cx) => this.run(cx));
    }
    this.target.focus();
    if (this.root) {
      cx.spawn(async (cx) => {
        const r = await readBranches(this.git, this.root);
        if (r.ok) {
          this.local = r.local.map((b) => b.name);
          this.names = [...r.local.filter((b) => !b.current).map((b) => b.name), ...r.remote.map((b) => b.name)];
        }
        cx.notify();
      });
    }
  }

  changed(cx) { this.error = null; cx.notify(); }

  has(flag) { return this.picked.includes(flag); }

  request() {
    return {
      type: "rebase",
      target: this.has("--root") ? "" : this.target.value().trim(),
      options: this.picked.filter((o) => !FIELDS.has(o)),
      ...(this.has("--onto") ? { onto: this.onto.value().trim() } : {}),
      ...(this.has(OTHER) ? { branch: this.branch.value().trim() } : {}),
    };
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  run(cx) {
    if (this.waiting || !this.root || this.writing() || requestProblem(this.request())) return;
    this.waiting = true; this.error = null;
    askOwner(this, "rebase-start", { root: this.root, on: this.on, who: this.who, request: this.request() }, this.who, cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  pick(flag, cx) {
    if (!this.has(flag)) this.picked = [...this.picked, flag];
    if (flag === "--onto") this.onto.focus();
    if (flag === OTHER) this.branch.focus();
    this.changed(cx);
  }

  render() {
    const t = theme(), writing = this.writing(), problem = requestProblem(this.request());
    const said = this.error ?? writing;
    const label = (o) => (o === OTHER ? this.t("merge.optOtherBranch") : o);
    // Once a new base is given the target is the old base: its ▾ says so.
    const line = h_flex().w_full().gap(8).items_center()
      .child(div().flex_none().text_color(t.muted).child("git rebase"))
      .when(this.has("--onto"), (el) => el.child(div().flex_none().text_color(t.muted).child("--onto"))
        .child(branchField(this, "rebase-onto", this.onto, t, { names: this.names, placeholder: this.t("merge.newBase") })))
      .when(!this.has("--root"), (el) => el.child(branchField(this, "rebase-target", this.target, t, { names: this.names, placeholder: this.t(this.has("--onto") ? "merge.oldBase" : "merge.branchOrHash") })))
      .when(this.has(OTHER), (el) => el.child(branchField(this, "rebase-branch", this.branch, t, { names: this.local, placeholder: this.t("merge.branchToRebase") })));
    const body = v_flex().size_full().min_h(0).px(14).py(12).gap(10)
      .child(line)
      .child(h_flex().w_full().items_center()
        .child(modifyOptions(this, "rebase-options", t, {
          options: REBASE_OPTIONS, picked: this.picked, title: this.t("merge.modifyOptions"),
          pick: (flag, cx) => this.pick(flag, cx),
        })))
      .when(this.picked.length > 0, (el) => el.child(optionChips("rebase-picked", this.picked, t, {
        label, removeTitle: this.t("merge.remove"),
        onRemove: (o, cx) => { this.picked = this.picked.filter((x) => x !== o); this.changed(cx); },
      })))
      .when(Boolean(said), (el) => el.child(scrollText("rebase-error", said ?? "", t, { maxHeight: 48, color: this.error ? t.ansi1 : t.muted })));
    return dialogFrame("rebase", this.t("merge.rebaseTitle"), t, {
      body, onClose: () => this.shut(),
      note: this.waiting ? this.t("merge.rebasing") : "",
      footer: [
        button("rebase-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("rebase-run", this.t("merge.rebase"), t, {
          kind: "primary", disabled: Boolean(writing) || !this.root || Boolean(problem), busy: this.waiting, title: writing ?? undefined,
          onClick: (_e, cx) => this.run(cx),
        }),
      ],
    }).on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      this.shut();
      cx.stop_propagation();
    });
  }
}
