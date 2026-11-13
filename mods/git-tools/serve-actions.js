// The writes a dialog may ask its panel to run (ui.js askOwner → the panel's serve →
// serveAction), by action name. Each line: the work's message key (the lock shows it,
// the asking button spins on it) and run(git, root, args, panel) → { ok, err, msg?,
// changed?, … } (ui.js serveRequest). A new dialog write is one line here and the
// import of its git module; the Commit panel and the Log panel both serve every action
// in the table.
//   "stash-create": { work: "stash.stashing", run: (git, root, args) => createStash(git, root, args) },
// args: the request's plain JSON, from the dialog; check each value's type before use.

import { exec } from "herdr";
import { makeGit } from "./git.js";
import { serveRequest } from "./ui.js";
import { acceptRequest, unresolveRequest, resolveSimpleRequest } from "./conflicts-model.js";
import { writerOn } from "./view-conflicts.js";
import { runReset } from "./view-reset.js";
import { applySnapshot } from "./git-snapshot.js";
import { createPatch } from "./git-revision.js";
import { saveRequest } from "./merge-revisions-model.js";
import { placerOn } from "./view-merge-revisions.js";
import { runStashCreate, runStashDrop, runStashClear } from "./view-stash.js";
import { runUnstash } from "./view-unstash.js";
import { createBranch } from "./git-branch.js";
import { serveReword, serveSquash, serveDrop } from "./log-rewrite.js";

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const text = (value) => (typeof value === "string" && value ? value : null);

export const SERVE_ACTIONS = {
  "conflicts-accept": { work: "conflicts.accepting", run: (git, root, args) => acceptRequest(git, root, args) },
  "conflicts-unresolve": { work: "conflicts.unresolving", run: (git, root, args) => unresolveRequest(git, root, args) },
  "conflicts-resolve-simple": { work: "conflicts.resolvingSimple", run: (git, root, args) => resolveSimpleRequest(git, root, args, writerOn(typeof args.on === "string" ? args.on : null)) },
  "reset": { work: "reset.running", run: (git, root, args, panel) => runReset(git, root, args, panel) },
  "restore-3way": { work: "restore.running", run: (git, root, args) => applySnapshot(git, root, { snapshot: typeof args.snapshot === "string" ? args.snapshot : "" }) },
  "patch-create": { work: "revision.creating", run: (git, root, args) => (text(args.file)
    ? createPatch(git, root, { commits: strings(args.commits), paths: strings(args.paths), reverse: args.reverse === true, base: text(args.base), file: args.file })
    : { ok: false, err: "No patch file.", msg: { key: "revision.needFile", args: {} } }) },
  "conflicts-save": { work: "conflicts.saving", run: (git, root, args) => saveRequest(git, root, args, placerOn(typeof args.on === "string" ? args.on : null)) },
  "stash-create": { work: "stash.stashing", run: (git, root, args) => runStashCreate(git, root, args) },
  "stash-apply": { work: "stash.applying", run: (git, root, args, panel) => runUnstash(git, root, args, panel) },
  "stash-drop": { work: "stash.dropping", run: (git, root, args) => runStashDrop(git, root, args) },
  "stash-clear": { work: "stash.clearing", run: (git, root) => runStashClear(git, root) },
  // The New Branch dialog opened from the VCS Operations popup over the Commit panel; the
  // Log panel's own chain takes it first (view-branch-new.js serveBranch).
  "branch-create": { work: "dialogs.branch.creating", run: (git, root, args) => createBranch(git, root, { name: text(args.name) ?? "", from: text(args.from), checkout: args.checkout !== false }) },
  "rewrite-reword": { work: "rewrite.rewording", run: (git, root, args, panel) => serveReword(git, root, args, panel) },
  "rewrite-squash": { work: "rewrite.squashing", run: (git, root, args, panel) => serveSquash(git, root, args, panel) },
  "rewrite-drop": { work: "rewrite.dropping", run: (git, root, args, panel) => serveDrop(git, root, args, panel) },
};

// serveAction(panel, e, cx) → true when the table has e.action and the panel now runs
// it under the repository's lock; false leaves the request to the next server in the
// panel's chain.
export function serveAction(panel, e, cx) {
  const entry = Object.prototype.hasOwnProperty.call(SERVE_ACTIONS, e.action) ? SERVE_ACTIONS[e.action] : null;
  if (!entry) return false;
  const args = e.args ?? {};
  serveRequest(panel, e, { key: entry.work }, (repo) => entry.run(makeGit(exec, repo.on), repo.root, args, panel), cx);
  return true;
}
