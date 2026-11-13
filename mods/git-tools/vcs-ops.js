// The VCS Operations popup's model (cmd-shift-v, view-vcs-ops.js): every item it will
// have, in the menu bar Git menu's order, with the separators between groups, and which
// copy opens it. No `herdr` import: node tests it (vcs-ops.test.mjs).
//
// An item is an id; its name is `vcs-ops.<id>` (messages-vcs-ops.js). The screen keeps
// what each id does (view-vcs-ops.js VCS_ACTIONS); an id with nothing there never shows,
// so a new operation is one line in that table. A group ({ group, items }) is a ▸ item
// that opens its own list, and shows while any of its items does.

const RULE = "|";

export const VCS_OPS = [
  "commit", "push", "updateProject", "pull", "fetch", RULE,
  "merge", "rebase", RULE,
  "branches", "newBranch", "newTag", "resetHead", RULE,
  "newWorktree", RULE,
  "showLog",
  { group: "patch", items: ["createPatch", "applyPatch", "applyPatchFromClipboard"] },
  { group: "uncommitted", items: ["stash", "unstash", "rollback"] }, RULE,
  "manageRemotes", "console",
];

// The reference product numbers the first ten rows 1 … 9, 0.
const NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

// vcsOpsItems(handled, group?) → [{ id, key, rule, sub, number }] in order.
//   handled(id): whether the opening copy can do that item now.
//   group: a group's id for that group's own list; omitted for the top list.
//   rule: a separator goes above it (never first, never last, never two in a row).
//   sub: a ▸ item; picking it opens its group's list.
//   number: "1" … "0" for the first ten shown, else null.
export function vcsOpsItems(handled, group) {
  const list = group === undefined ? VCS_OPS : VCS_OPS.find((it) => typeof it === "object" && it.group === group)?.items ?? [];
  const out = [];
  let ruled = false;
  for (const it of list) {
    if (it === RULE) { ruled = out.length > 0; continue; }
    const sub = typeof it === "object";
    const id = sub ? it.group : it;
    if (sub ? !it.items.some((child) => handled(child)) : !handled(id)) continue;
    out.push({ id, key: `vcs-ops.${id}`, rule: ruled, sub, number: NUMBERS[out.length] ?? null });
    ruled = false;
  }
  return out;
}

// The index of the item a typed digit picks, or -1.
export const numberedPick = (items, char) => items.findIndex((it) => it.number !== null && it.number === char);

// takesVcsOps(kind, { commitShown, logShown, folder }) → whether this copy opens the
// popup. The key is a mod command, which reaches every shown copy at once, so exactly
// one takes it: the Commit panel while it shows, else the Log panel block. A copy on a
// chosen folder (a tab) never does: the popup is about the focused space's work.
export function takesVcsOps(kind, { commitShown = false, logShown = false, folder = null } = {}) {
  if (folder) return false;
  if (kind === "commit") return commitShown;
  if (kind === "log") return logShown && !commitShown;
  return false;
}

const findNode = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
};

// Whether the shown layout (Herdr's layout()) has the Commit panel up: the side panel
// shows and its stack's active child is `changes` (ui.js openCommitPanel).
export function commitPanelShown(tree) {
  const panel = findNode(tree, "panel"), stack = findNode(panel, "panel-body");
  return Boolean(panel && !panel.hidden && stack?.active === "changes");
}
