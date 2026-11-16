// node branch-order.test.mjs: the Branch tree's and the VCS widget popup's order, the
// favorites (main and master by default, until unmarked), and the Branch tree's settings.
import assert from "node:assert/strict";
import { isFavorite, nextFavorites, orderBranches, orderTreeRows, treeSettings, treeSettingsMenu, toggleTreeSetting, treeRows } from "./branch-order.js";
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

// The VCS widget popup's order: the favorites on top (the current branch among them when
// it is one), then the current branch, then by name; each remote's favorites first.
{
  const list = local("topic", "old-history", "main", "feature", "aaa-sort");
  const popup = { scope: "local", favoritesFirst: true };
  assert.deepEqual(names(orderBranches(list, { ...popup, current: "feature", prefs: none })),
    ["main", "feature", "aaa-sort", "old-history", "topic"]);
  const prefs = { favorite: ["refs/heads/topic"], unfavorite: [] };
  assert.deepEqual(names(orderBranches(list, { ...popup, current: "topic", prefs })),
    ["main", "topic", "aaa-sort", "feature", "old-history"]);
  assert.deepEqual(names(orderBranches(list, { ...popup, current: "aaa-sort", prefs })),
    ["main", "topic", "aaa-sort", "feature", "old-history"]);
  const remote = local("origin/topic", "origin/main", "origin/aaa", "up/x", "up/master");
  assert.deepEqual(names(orderBranches(remote, { scope: "remote", favoritesFirst: true, current: "topic", prefs: none })),
    ["origin/main", "origin/aaa", "origin/topic", "up/master", "up/x"]);
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

// ---- the Branch tree's rows
{
  const t = (key) => ({ "log.headCurrent": "HEAD (Current Branch)", "log.local": "Local", "log.remote": "Remote", "vcs.tags": "Tags", "vcs.detachedHead": "Detached HEAD" })[key] ?? key;
  const data = {
    head: { branch: "topic", hash: "0123456789abcdef" },
    local: [{ name: "topic", current: true }, { name: "feature/b" }, { name: "main" }, { name: "feature/a" }],
    remote: [{ name: "origin/main" }, { name: "origin/feature/a" }, { name: "origin/zeta" }],
    tags: ["v1.0", "v2.0", "release/3"],
  };
  const settings = treeSettings(null);
  const all = (rows) => Array.from({ length: rows.length }, (_, i) => rows.row(i));
  const look = (rows) => all(rows).map((r) => `${"  ".repeat(r.depth)}${r.kind}:${r.label}${r.count !== undefined ? ` (${r.count})` : ""}`);

  // HEAD, then Local and Remote with "/" making folders (folders first, then the current
  // branch, the favorites, the rest by name), then the tags in the order read.
  const rows = treeRows(data, { settings, prefs: none, t });
  assert.deepEqual(look(rows), [
    "head:HEAD (Current Branch)",
    "group:Local (4)", "  folder:feature (2)", "    branch:a", "    branch:b", "  branch:topic", "  branch:main",
    "group:Remote (3)", "  folder:origin (3)", "    folder:feature (1)", "      branch:a", "    branch:main", "    branch:zeta",
    "group:Tags (3)", "  tag:v1.0", "  tag:v2.0", "  tag:release/3",
  ]);
  // Keys as the screen uses them; a branch row carries its readBranches entry, a tag row its name.
  assert.deepEqual(all(rows).map((r) => r.key), [
    "head", "local", "local:feature/", "local:feature/a", "local:feature/b", "local:topic", "local:main",
    "remote", "remote:origin/", "remote:origin/feature/", "remote:origin/feature/a", "remote:origin/main", "remote:origin/zeta",
    "tags", "tags:v1.0", "tags:v2.0", "tags:release/3",
  ]);
  assert.equal(rows.row(5).branch, data.local[0]);
  assert.deepEqual(rows.row(16), { key: "tags:release/3", kind: "tag", scope: "tags", depth: 1, label: "release/3", branch: { name: "release/3" } });
  assert.equal(rows.row(17), undefined);
  // index: by key, tags included; parent: the row one sits under.
  assert.equal(rows.index("remote:origin/zeta"), 12);
  assert.equal(rows.index("tags:v2.0"), 15);
  assert.equal(rows.index("tags:nope"), -1);
  assert.equal(rows.index("local:nope"), -1);
  assert.equal(rows.parent(15), 13);
  assert.equal(rows.parent(10), 9);
  assert.equal(rows.parent(1), -1);

  // Folded: a group or a folder hides what is under it and keeps its count.
  const folded = treeRows(data, { settings, prefs: none, t, collapsed: new Set(["tags", "remote:origin/", "local"]) });
  assert.deepEqual(look(folded), ["head:HEAD (Current Branch)", "group:Local (4)", "group:Remote (3)", "  folder:origin (3)", "group:Tags (3)"]);
  assert.equal(folded.index("tags:v1.0"), -1);
  assert.equal(folded.row(5), undefined);

  // Words: matching names only, unfolded whatever was folded, groups without one dropped.
  const typed = treeRows(data, { settings, prefs: none, t, words: "a", collapsed: new Set(["tags", "local"]) });
  assert.deepEqual(look(typed), [
    "head:HEAD (Current Branch)",
    "group:Local (3)", "  folder:feature (2)", "    branch:a", "    branch:b", "  branch:main",
    "group:Remote (3)", "  folder:origin (3)", "    folder:feature (1)", "      branch:a", "    branch:main", "    branch:zeta",
    "group:Tags (1)", "  tag:release/3",
  ]);
  assert.deepEqual(look(treeRows(data, { settings, prefs: none, t, words: "v2" })), ["group:Tags (1)", "  tag:v2.0"]);

  // Show Tags off, Group by Directory off; a detached HEAD, during a rebase too.
  const flat = treeRows({ ...data, head: { branch: null, hash: "0123456789abcdef" } }, { settings: { ...settings, grouped: false, tags: false }, prefs: none, t });
  assert.deepEqual(look(flat), [
    "head:HEAD (0123456)",
    "group:Local (4)", "  branch:main", "  branch:feature/a", "  branch:feature/b", "  branch:topic",
    "group:Remote (3)", "  branch:origin/main", "  branch:origin/feature/a", "  branch:origin/zeta",
  ]);
  assert.equal(treeRows({ ...data, head: { branch: null, hash: "0123456789abcdef" }, rebasing: true }, { settings, prefs: none, t }).row(0).label, "⚠ Detached HEAD");

  // Show My Branches: only those holding a commit of the person's; none before that is read.
  const mine = treeRows(data, { settings: { ...settings, mine: true, tags: false }, prefs: none, t, mine: { refs: new Set(["refs/heads/main", "refs/remotes/origin/zeta"]) } });
  assert.deepEqual(look(mine), ["head:HEAD (Current Branch)", "group:Local (1)", "  branch:main", "group:Remote (1)", "  folder:origin (1)", "    branch:zeta"]);
  assert.deepEqual(look(treeRows(data, { settings: { ...settings, mine: true, tags: false }, prefs: none, t, mine: null })), ["head:HEAD (Current Branch)"]);

  // Nothing read yet: no rows.
  assert.equal(treeRows(null, { settings, prefs: none, t }).length, 0);
}

// A repository with tens of thousands of tags: making the rows reads none of them, and a
// row is made for a tag only when it is asked for, so the tree costs the same with 30,000
// tags as with none. (QuickJS gives a render about 50 ms; 30,000 row objects took 90.)
{
  const reads = { n: 0 };
  const names = Array.from({ length: 30000 }, (_, i) => `v${i}`);
  const tags = new Proxy(names, { get: (list, key) => { if (typeof key === "string" && /^\d+$/.test(key)) reads.n++; return Reflect.get(list, key); } });
  const rows = treeRows({ head: { branch: "main", hash: "abc" }, local: [{ name: "main", current: true }], remote: [], tags }, { settings: treeSettings(null), prefs: none });
  assert.equal(reads.n, 0);
  // HEAD, Local and main, Remote (empty), Tags, the tags.
  assert.equal(rows.length, 1 + 2 + 1 + 1 + 30000);
  assert.equal(rows.row(rows.length - 1).label, "v29999");
  assert.equal(reads.n, 1);
  assert.equal(rows.parent(rows.length - 1), 4);
  assert.equal(reads.n, 1);
}

console.log("ok");
