// Update Project dialog (VCS widget popup and VCS Operations popup: Update Project…):
// merge incoming changes into the current branch, or rebase it on top of them; Reset to
// the Remote Branch (asked first: local commits are dropped); Cancel, OK. It shows every
// time; the method last used is an app setting (app-files.js) the dialog starts on.
//
// Also the screen side of every remote request (git-remote.js does the git part): the
// panels' and the VCS widget's menu items (Update, Checkout and Update, Pull into …,
// Update Selected) run as the screen's own write, and the Pull and Update Project dialogs
// ask the panel that opened them ("remote-pull", "remote-update", "remote-reset",
// serve-actions.js → runRemote). Either way, what came of it is said where the person
// sees it: the Smart dialog for local changes in the way, the Conflicts dialog for a
// stop, a notification for a failure (with the credential hint when the fetch failed) or
// for nothing to update, and the Update Info tab for what came in.
//
// props: { view: "update-project", root, on, owner, who, overlay }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, notify } from "herdr";
import { makeGit } from "./git.js";
import { pull, updateProject, resetToRemote, updateBranch, updateBranches, checkoutAndUpdate, splitRemoteBranch, readTracking } from "./git-remote.js";
import { operationName } from "./git-operation.js";
import { appSetting, saveAppSetting } from "./app-files.js";
import { offerSmart, tellUnstaged } from "./view-smart.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { openUpdateInfo } from "./view-update-info.js";
import { radio } from "./view-reset.js";
import { openDialog, dialogFrame, button, close, askOwner, writeBlock, scrollText, sentence, broadcast, copyId } from "./ui.js";

const COPY_KEY = "commit.copy";
// App settings (app-files.js).
export const METHOD_KEY = "updateProject.method";
const methodOf = (value) => (value === "rebase" ? "rebase" : "merge");
const str = (value) => (typeof value === "string" ? value : "");

// ---- what came of a request

// The words for a failure: git's (or the module's) sentence, then the credential hint
// when the fetch itself failed.
function failure(t, r) {
  const said = sentence(t, r.msg, r.err) || t("ui.gitFailed");
  return r.fetchFailed ? `${said}\n\n${t("remote.credentialHint")}` : said;
}

// tellRemote(r, { root, on, panel, who, title, quietFailure }): says what came of a
// remote request where the person sees it. panel: the serving copy ({ bus, lang, t }).
// title: the failure notification's title key. quietFailure: a dialog shows the failure
// itself. A result of updateBranches ({ results }) is told branch by branch.
export function tellRemote(r, { root, on = null, panel, who = "ui.commitPanel", title = "remote.failed", quietFailure = false } = {}) {
  const t = panel?.t ?? ((key) => key), args = { root, on, owner: panel?.bus?.id ?? null, lang: panel?.lang, who };
  tellUnstaged(r, t);
  if (Array.isArray(r?.results)) {
    const bad = r.results.filter((x) => x.outcome === "failed" || x.outcome === "refused");
    if (bad.length) notify({ title: t(bad.some((x) => x.outcome === "failed") ? title : "remote.notUpdated"), body: bad.map((x) => t("remote.branchSaid", { name: x.name, text: x.outcome === "failed" ? failure(t, x) : sentence(t, x.msg, x.err) })).join("\n"), level: "warning" });
    else if (r.results.every((x) => x.outcome === "empty")) notify({ title: t("remote.nothing"), level: "info" });
    const moved = r.results.find((x) => x.updated);
    if (moved) openUpdateInfo(t, { root, on, ...moved.updated });
    return;
  }
  if (r.outcome === "refused" && offerSmart(r, { ...args, request: r.request })) return;
  if (r.outcome === "stopped") {
    if (!openConflictsIfStopped(r, args)) {
      const name = operationName(r.operation);
      if (name) notify({ title: t(name.key, name.args), body: t("remote.stoppedBody", { op: t(name.key, name.args) }), level: "warning" });
    }
    return;
  }
  if (r.outcome === "failed") { if (!quietFailure) notify({ title: t(title), body: failure(t, r), level: "error" }); return; }
  if (r.outcome === "refused") { if (!quietFailure) notify({ title: t("remote.notUpdated"), body: sentence(t, r.msg, r.err), level: "warning" }); return; }
  if (r.outcome === "empty") { notify({ title: t("remote.nothing"), level: "info" }); return; }
  if (r.updated) openUpdateInfo(t, { root, on, ...r.updated });
}

// remoteWrite(host, repo, who, work, run, cx): a remote request as the screen's own
// write on `repo` ({ root, on }), under `work` (the lock's { key }). run(git, root) → a
// git-remote.js result, told with tellRemote. host: the screen copy (setBusy, writeBlock,
// bus, lang, t; failedOn when it has a strip).
export function remoteWrite(host, repo, who, work, run, cx, { title = "remote.failed" } = {}) {
  if (!repo?.root) return;
  const at = { root: repo.root, on: repo.on ?? null };
  if (!host.setBusy(work, cx, at)) {
    const why = writeBlock(host, at);
    if (why) notify({ title: why, level: "info" });
    return;
  }
  cx.spawn(async (cx) => {
    let r;
    try { r = await run(makeGit(exec, at.on), at.root); } catch (error) { r = { ok: false, err: String(error?.message ?? error), outcome: "failed" }; }
    host.setBusy(null, cx);
    if (r.ok || r.changed || r.results) broadcast({ type: "changed", root: at.root });
    tellRemote(r, { ...at, panel: host, who, title });
    cx.notify();
  });
}

// runRemote(git, root, args, panel): the serving copy's side of "remote-pull",
// "remote-update" and "remote-reset" (serve-actions.js). args (plain JSON): { type:
// "pull" | "update" | "reset", on, who, remote, branch, options, method }. The dialog
// shows a failure itself; anything else is told here, and the dialog closes.
export async function runRemote(git, root, args, panel) {
  const on = typeof args.on === "string" ? args.on : null, who = str(args.who) || "ui.commitPanel";
  let r;
  if (args.type === "pull") r = await pull(git, root, { remote: str(args.remote), branch: str(args.branch), options: Array.isArray(args.options) ? args.options : [] });
  else if (args.type === "reset") r = await resetToRemote(git, root, { copy: typeof panel?.copy === "string" ? panel.copy : copyId(COPY_KEY) });
  else r = await updateProject(git, root, { method: methodOf(args.method) });
  const t = panel?.t ?? ((key) => key);
  tellRemote(r, { root, on, panel, who, quietFailure: true });
  if (r.outcome === "failed" || (r.outcome === "refused" && !r.blocked?.length)) {
    return { ok: false, code: r.code, out: "", err: failure(t, r), changed: r.changed };
  }
  return { ...r, ok: true };
}

// ---- the menu items, as the Log panel (view-log.js ACTIONS) and the VCS widget
// (view-vcs-popup.js POPUP_ACTIONS) run them: (host, repo, who, b, cx), b a branch row's
// { name, scope, current }.

const savedMethod = async () => methodOf(await appSetting(METHOD_KEY, "merge"));

// "Update": a branch that isn't checked out moves forward to its tracked branch; the
// current one updates as the project does, by the saved method.
export function updateHere(host, repo, who, b, cx) {
  if (!b || b.scope === "remote") return;
  // The HEAD row on a detached HEAD: the project's update says why it can't.
  remoteWrite(host, repo, who, { key: "remote.updating" }, async (git, root) => (b.scope === "head"
    ? updateProject(git, root, { method: await savedMethod() })
    : updateBranch(git, root, { name: b.name, method: await savedMethod() })), cx);
}

// The Branch tree's "Update Selected": the cursor's local branch.
export function updateSelected(host, repo, who, b, cx) {
  if (!b || b.scope === "remote" || b.scope === "head") return;
  remoteWrite(host, repo, who, { key: "remote.updating" }, async (git, root) => updateBranches(git, root, { names: [b.name], method: await savedMethod() }), cx);
}

export function checkoutUpdateHere(host, repo, who, b, cx) {
  if (!b || b.current || b.scope !== "local") return;
  remoteWrite(host, repo, who, { key: "remote.updating" }, (git, root) => checkoutAndUpdate(git, root, { name: b.name }), cx);
}

// A remote branch's "Pull into '<current>' Using Rebase / Merge".
export function pullHere(host, repo, who, b, rebase, cx) {
  if (!b || b.scope !== "remote") return;
  remoteWrite(host, repo, who, { key: "remote.pulling" }, async (git, root) => {
    const at = await splitRemoteBranch(git, root, b.name);
    if (!at) return { ok: false, err: `'${b.name}' is not a remote branch.`, msg: { key: "log.notRemoteBranch", args: { name: b.name } }, outcome: "failed" };
    return pull(git, root, { ...at, options: [rebase ? "--rebase" : "--no-rebase"] });
  }, cx, { title: "remote.pullFailed" });
}

// startUpdateProject(host, repo, who, cx): Update Project… from the VCS widget popup or
// the VCS Operations popup: the dialog, every time.
export function startUpdateProject(host, repo, who, _cx) {
  if (!repo?.root || host.writeBlock?.()) return;
  openUpdateProject({ root: repo.root, on: repo.on ?? null, owner: host.bus.id, lang: host.lang, who });
}

// openUpdateProject({ root, on, owner, lang, who })
export function openUpdateProject({ root, on = null, owner = null, lang, who = "ui.commitPanel" } = {}) {
  return openDialog("update-project", { root, on, owner, who, lang }, { width: 520, height: 230 });
}

export default class UpdateProjectView {
  init(p, cx) {
    this.overlay = p.overlay;
    this.root = p.root ?? null;
    this.on = p.on ?? null;
    this.owner = p.owner ?? null;
    this.who = str(p.who) || "ui.commitPanel";
    this.method = "merge";
    this.asking = null; // the Reset to the Remote Branch question: { name, upstream }
    this.waiting = false;
    this.error = null;
    cx.spawn(async (cx) => {
      this.method = await savedMethod();
      cx.notify();
    });
  }

  writing() { return this.waiting || !this.root ? null : writeBlock(this, { root: this.root, on: this.on }); }

  ask(action, args, cx) {
    this.waiting = true; this.error = null;
    askOwner(this, action, { root: this.root, on: this.on, who: this.who, ...args }, this.who, cx, (r) => {
      this.waiting = false;
      if (r.ok) close(this.overlay);
      else this.error = sentence(this.t, r.msg, r.err) || this.t("ui.gitFailed");
    });
  }

  run(cx) {
    if (this.waiting || !this.root || this.writing()) return;
    if (this.asking) { this.ask("remote-reset", {}, cx); return; }
    const method = this.method;
    this.waiting = true;
    cx.spawn(async (cx) => {
      // Saved before the request: the next Update Project starts on it whatever comes of this one.
      await saveAppSetting(METHOD_KEY, method);
      this.waiting = false;
      this.ask("remote-update", { method }, cx);
      cx.notify();
    });
  }

  // Reset to the Remote Branch: the names for the question first.
  askReset(cx) {
    if (this.waiting || !this.root) return;
    cx.spawn(async (cx) => {
      const tr = await readTracking(makeGit(exec, this.on), this.root);
      if (!tr.ok) this.error = tr.err || this.t("ui.gitFailed");
      else if (!tr.branch) this.error = this.t("remote.detached");
      else if (!tr.upstream) this.error = this.t("remote.noTracked", { name: tr.branch });
      else { this.asking = { name: tr.branch, upstream: tr.upstream.name }; this.error = null; }
      cx.notify();
    });
  }

  shut() { if (!this.waiting) close(this.overlay); }

  choice(id, method, t) {
    return h_flex().id(`update-project-${id}`).gap(8).items_center().cursor_pointer()
      .on_click((_e, cx) => { if (!this.waiting) { this.method = method; cx.notify(); } })
      .child(radio(`update-project-radio-${id}`, this.method === method, t))
      .child(div().flex_1().min_w(0).truncate().child(this.t(method === "rebase" ? "remote.methodRebase" : "remote.methodMerge")));
  }

  render() {
    const t = theme(), writing = this.writing(), said = this.error ?? writing;
    const body = this.asking
      ? v_flex().size_full().min_h(0).px(14).py(12).gap(10)
        .child(div().w_full().child(this.t("remote.resetAsk", this.asking)))
      : v_flex().size_full().min_h(0).px(14).py(12).gap(10)
        .child(this.choice("merge", "merge", t))
        .child(this.choice("rebase", "rebase", t));
    const shown = (said ? body.child(scrollText("update-project-error", said ?? "", t, { maxHeight: 60, color: this.error ? t.ansi1 : t.muted })) : body);
    const footer = this.asking
      ? [
        button("update-project-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: (_e, cx) => { this.asking = null; this.error = null; cx.notify(); } }),
        button("update-project-reset", this.t("remote.resetButton"), t, { kind: "primary", disabled: Boolean(writing), busy: this.waiting, title: writing ?? undefined, onClick: (_e, cx) => this.run(cx) }),
      ]
      : [
        button("update-project-to-remote", this.t("remote.resetToRemote"), t, { disabled: this.waiting || !this.root, onClick: (_e, cx) => this.askReset(cx) }),
        button("update-project-cancel", this.t("dialogs.cancel"), t, { disabled: this.waiting, onClick: () => this.shut() }),
        button("update-project-ok", this.t("remote.ok"), t, { kind: "primary", disabled: Boolean(writing) || !this.root, busy: this.waiting, title: writing ?? undefined, onClick: (_e, cx) => this.run(cx) }),
      ];
    return dialogFrame("update-project", this.t("remote.updateTitle"), t, {
      body: shown, onClose: () => this.shut(), note: this.waiting ? this.t(this.asking ? "remote.resetting" : "remote.updating") : "", footer,
    }).on_key_down((e, cx) => {
      if (e.key === "escape") { this.shut(); cx.stop_propagation(); }
      else if (e.key === "enter") { this.run(cx); cx.stop_propagation(); }
    });
  }
}
