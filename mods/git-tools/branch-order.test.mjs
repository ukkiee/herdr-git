// node branch-order.test.mjs: the Branch tree's and the VCS widget popup's order, the
// favorites (main and master by default, until unmarked), and the Branch tree's settings.
import assert from "node:assert/strict";
import { isFavorite, nextFavorites, orderBranches, orderTreeRows, treeSettings, treeSettingsMenu, toggleTreeSetting } from "./branch-order.js";
import { buildRows } from "./tree.js";
import { popupRows } from "./git-heads.js";

const none = { favorite: [], unfavorite: [] };
const names = (list) => list.map((b) => b.name);
const local = (...list) => list.map((name) => ({ name }));

// ---- favorites: main and master are, anything marked is, anything unmarked isn't
{
  assert.equal(isFavorite("refs/heads/main", none), true);
  assert.equal(isFavorite("refs/heads/master", none), true);
  assert.equal(isFavorite("refs/heads/topic", none), false);
  // Only the name main itself: not a folder of that name, not a longer name.
  assert.equal(isFavorite("refs/heads/main/x", none), false);
  assert.equal(isFavorite("refs/heads/mainline", none), false);
  // A remote's main and master, whatever the remote.
  assert.equal(isFavorite("refs/remotes/origin/main", none), true);
  assert.equal(isFavorite("refs/remotes/upstream/master", none), true);
  assert.equal(isFavorite("refs/remotes/origin/feature/main", none), false);
  assert.equal(isFavorite("refs/remotes/origin/topic", none), false);
  // Marked, unmarked.
  assert.equal(isFavorite("refs/heads/topic", { favorite: ["refs/heads/topic"], unfavorite: [] }), true);
  assert.equal(isFavorite("refs/heads/main", { favorite: [], unfavorite: ["refs/heads/main"] }), false);
  assert.equal(isFavorite("refs/remotes/origin/main", { favorite: [], unfavorite: ["refs/heads/main"] }), true);
  // A tag is never one.
  assert.equal(isFavorite("refs/tags/main", none), false);
}

// nextFavorites(prefs, ref, on) → the two lists after marking or unmarking `ref`.
{
  // Marking a plain branch adds it; unmarking takes it out again.
  const marked = nextFavorites(none, "refs/heads/topic", true);
  assert.deepEqual(marked, { favorite: ["refs/heads/topic"], unfavorite: [] });
  assert.deepEqual(nextFavorites(marked, "refs/heads/topic", false), none);
  // Unmarking main keeps it in unfavorite; marking it again takes it out of there.
  const unmain = nextFavorites(none, "refs/heads/main", false);
  assert.deepEqual(unmain, { favorite: [], unfavorite: ["refs/heads/main"] });
  assert.equal(isFavorite("refs/heads/main", unmain), false);
  assert.deepEqual(nextFavorites(unmain, "refs/heads/main", true), none);
  // What is already so changes nothing, and nothing is listed twice.
  assert.deepEqual(nextFavorites(marked, "refs/heads/topic", true), marked);
  assert.deepEqual(nextFavorites(none, "refs/heads/main", true), none);
  assert.deepEqual(nextFavorites(none, "refs/heads/topic", false), none);
  // A remote branch is kept by its own full name.
  assert.deepEqual(nextFavorites(none, "refs/remotes/origin/main", false), { favorite: [], unfavorite: ["refs/remotes/origin/main"] });
}

// ---- order: the current branch, then favorites, then by name
{
  const list = local("topic", "old-history", "main", "feature", "aaa-sort");
  // As the reference product showed it: feature (current) → ★main → the rest by name.
  assert.deepEqual(names(orderBranches(list, { scope: "local", current: "feature", prefs: none })),
    ["feature", "main", "aaa-sort", "old-history", "topic"]);
  // Two favorites by name, the current one first even when it is one.
  const prefs = { favorite: ["refs/heads/topic"], unfavorite: [] };
  assert.deepEqual(names(orderBranches(list, { scope: "local", current: "main", prefs })),
    ["main", "topic", "aaa-sort", "feature", "old-history"]);
  // main unmarked: by name with the rest. No current branch (a detached HEAD).
  assert.deepEqual(names(orderBranches(list, { scope: "local", current: null, prefs: { favorite: [], unfavorite: ["refs/heads/main"] } })),
    ["aaa-sort", "feature", "main", "old-history", "topic"]);
  // By name: any case together, then the raw order.
  assert.deepEqual(names(orderBranches(local("b", "B", "a", "C"), { scope: "local", current: null, prefs: none })), ["a", "B", "b", "C"]);
  // A copy: the list handed in keeps its order.
  assert.deepEqual(names(list), ["topic", "old-history", "main", "feature", "aaa-sort"]);
}

// Remote branches stay together by remote, each remote's own favorites first.
{
  const list = local("origin/topic", "upstream/zeta", "origin/main", "upstream/master", "origin/aaa", "upstream/a");
  // A local branch named like the current one is not the current branch here.
  assert.deepEqual(names(orderBranches(list, { scope: "remote", current: "topic", prefs: none })),
    ["origin/main", "origin/aaa", "origin/topic", "upstream/master", "upstream/a", "upstream/zeta"]);
  const prefs = { favorite: ["refs/remotes/upstream/zeta"], unfavorite: ["refs/remotes/origin/main"] };
  assert.deepEqual(names(orderBranches(list, { scope: "remote", current: null, prefs })),
    ["origin/aaa", "origin/main", "origin/topic", "upstream/master", "upstream/zeta", "upstream/a"]);
}

// The VCS widget popup shows them in this order, each remote under its own name once.
{
  const prefs = { favorite: ["refs/heads/topic"], unfavorite: [] };
  const heads = {
    head: { branch: "feature", hash: "1", detached: false }, current: null, recent: [], tags: [],
    local: orderBranches(local("aaa", "feature", "main", "topic"), { scope: "local", current: "feature", prefs }),
    remote: orderBranches(local("origin/topic", "origin/main", "up/x", "up/master"), { scope: "remote", current: "feature", prefs }),
  };
  const rows = popupRows({ heads, op: null, handled: () => false }, (k) => k);
  assert.deepEqual(rows.filter((r) => r.kind !== "group").map((r) => (r.kind === "folder" ? `[${r.label}]` : r.name)),
    ["feature", "main", "topic", "aaa", "[origin]", "origin/main", "origin/topic", "[up]", "up/master", "up/x"]);
}

// ---- the grouped tree: within each folder, the current branch and favorites first
{
  const items = local("topic", "feature/b", "feature/a", "main", "aaa", "feature/x/y").map((b) => ({ path: b.name, branch: b }));
  const rows = buildRows(items, { grouped: true });
  const prefs = { favorite: ["refs/heads/feature/b"], unfavorite: [] };
  const ordered = orderTreeRows(rows, { scope: "local", current: "topic", prefs });
  // Folders keep their place (the tree's own order); the branches under each are reordered.
  assert.deepEqual(ordered.map((r) => (r.folder ? `${r.key}` : r.path)),
    ["feature/", "feature/x/", "feature/x/y", "feature/b", "feature/a", "topic", "main", "aaa"]);
  // Nothing else on a row changes, and the rows handed in keep their order.
  assert.equal(ordered.length, rows.length);
  assert.deepEqual(rows.map((r) => r.path), ["feature", "feature/x", "feature/x/y", "feature/a", "feature/b", "aaa", "main", "topic"]);
}

// ---- the Branch tree's settings (⋮): saved values, read back with defaults
{
  const defaults = { click: "filter", grouped: true, tags: true, mine: false, hidden: false };
  assert.deepEqual(treeSettings(undefined), defaults);
  assert.deepEqual(treeSettings(null), defaults);
  assert.deepEqual(treeSettings("junk"), defaults);
  assert.deepEqual(treeSettings({ click: "navigate", grouped: false, tags: false, mine: true, hidden: true }),
    { click: "navigate", grouped: false, tags: false, mine: true, hidden: true });
  // A value of the wrong kind falls back to its default; unknown keys go.
  assert.deepEqual(treeSettings({ click: "double", grouped: "yes", other: 1 }), defaults);

  // The popup: "On single click" with its two choices, then the two checks.
  const items = treeSettingsMenu(defaults);
  assert.deepEqual(items, [
    { header: true, key: "branch-tree.singleClick" },
    { id: "click:filter", key: "branch-tree.updateFilter", checked: true },
    { id: "click:navigate", key: "branch-tree.navigateLog", checked: false },
    { id: "grouped", key: "branch-tree.groupByDirectory", checked: true, rule: true },
    { id: "tags", key: "branch-tree.showTags", checked: true },
  ]);
  assert.deepEqual(treeSettingsMenu({ ...defaults, click: "navigate", tags: false }).filter((it) => it.id).map((it) => it.checked), [false, true, true, false]);

  // Picking one: a choice sets the click, a check flips.
  assert.deepEqual(toggleTreeSetting(defaults, "click:navigate"), { ...defaults, click: "navigate" });
  assert.deepEqual(toggleTreeSetting({ ...defaults, click: "navigate" }, "click:filter"), defaults);
  assert.deepEqual(toggleTreeSetting(defaults, "grouped"), { ...defaults, grouped: false });
  assert.deepEqual(toggleTreeSetting(defaults, "tags"), { ...defaults, tags: false });
  assert.deepEqual(toggleTreeSetting(defaults, "mine"), { ...defaults, mine: true });
  assert.deepEqual(toggleTreeSetting(defaults, "hidden"), { ...defaults, hidden: true });
  assert.deepEqual(toggleTreeSetting(defaults, "nothing"), defaults);
}

console.log("ok");
