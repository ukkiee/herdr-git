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

export const SERVE_ACTIONS = {
  "conflicts-accept": { work: "conflicts.accepting", run: (git, root, args) => acceptRequest(git, root, args) },
  "conflicts-unresolve": { work: "conflicts.unresolving", run: (git, root, args) => unresolveRequest(git, root, args) },
  "conflicts-resolve-simple": { work: "conflicts.resolvingSimple", run: (git, root, args) => resolveSimpleRequest(git, root, args, writerOn(typeof args.on === "string" ? args.on : null)) },
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
