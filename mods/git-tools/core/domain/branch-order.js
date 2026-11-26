// The order branches show in, in the Branch tree and the VCS widget popup alike: the
// current branch, then the favorites, then by name. Favorites are main and master until
// unmarked, and whatever was marked. Also the Branch tree's own settings (its ⋮ popup)
// and its rows (treeRows). No `herdr` import: node tests it (branch-order.test.mjs).
//
// Favorites are kept by full ref name ("refs/heads/main", "refs/remotes/origin/main"): a
// local branch may be called "origin/main" too. prefs: { favorite, unfavorite }, two
// lists of full ref names, as git-branch.js readFavorites reads them from the repository's
// own git config (gittools.favorite, gittools.unfavorite).

import { buildRows } from "./tree.js";

const HEADS = "refs/heads/", REMOTES = "refs/remotes/";
const DEFAULT = new Set(["main", "master"]);

// Case-insensitive first, then the raw compare so the order is the same on every run
// (tree.js sorts folders and names the same way). Compares positions in `names`, each
// lowered once before sorting rather than twice per comparison (see tree.js).
function nameOrder(names) {
  const lows = names.map((n) => n.toLowerCase());
  return (a, b) => (lows[a] !== lows[b] ? (lows[a] < lows[b] ? -1 : 1) : names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0);
}

// "origin/feature/x" → ["origin", "feature/x"]. Cut at the first slash, as the popup and
// the tree group remote branches by it.
function splitRemote(name) {
  const cut = name.indexOf("/");
  return cut < 0 ? ["", name] : [name.slice(0, cut), name.slice(cut + 1)];
}

// A favorite by default: a local main or master, or a remote's.
function byDefault(ref) {
  if (ref.startsWith(HEADS)) return DEFAULT.has(ref.slice(HEADS.length));
  if (ref.startsWith(REMOTES)) return DEFAULT.has(splitRemote(ref.slice(REMOTES.length))[1]);
  return false;
}

const has = (list, ref) => (list ?? []).includes(ref);

// isFavorite(ref, prefs) → whether the branch with that full ref name shows a star.
export function isFavorite(ref, prefs) {
  if (has(prefs?.favorite, ref)) return true;
  return byDefault(ref) && !has(prefs?.unfavorite, ref);
}

// nextFavorites(prefs, ref, on) → { favorite, unfavorite } after marking (on) or
// unmarking `ref`. A default favorite unmarked goes in unfavorite, and marking it again
// only takes it out of there.
export function nextFavorites(prefs, ref, on) {
  let favorite = [...(prefs?.favorite ?? [])], unfavorite = [...(prefs?.unfavorite ?? [])];
  if (on) {
    unfavorite = unfavorite.filter((r) => r !== ref);
    if (!byDefault(ref) && !favorite.includes(ref)) favorite.push(ref);
  } else {
    favorite = favorite.filter((r) => r !== ref);
    if (byDefault(ref) && !unfavorite.includes(ref)) unfavorite.push(ref);
  }
  return { favorite, unfavorite };
}

// The full ref name of a branch of that scope ("local" | "remote").
export const refOf = (scope, name) => (scope === "remote" ? REMOTES : HEADS) + name;

// 0: the current branch, 1: a favorite, 2: the rest; with favoritesFirst the favorites
// come before the current branch (one that is both is a favorite).
function rank(name, { scope, current, prefs, favoritesFirst }) {
  const isCurrent = scope === "local" && current && name === current;
  const favorite = isFavorite(refOf(scope, name), prefs);
  if (favoritesFirst) return favorite ? 0 : isCurrent ? 1 : 2;
  if (isCurrent) return 0;
  return favorite ? 1 : 2;
}

// orderBranches(list, { scope, current, prefs, favoritesFirst }) → a sorted copy of `list`
// ([{ name, … }]).
//   scope: "local" | "remote"; current: the branch HEAD is on, or null.
//   favoritesFirst: the VCS widget popup's order, the favorites above the current branch.
//   Remote branches stay together by remote (the remotes by name), each with its own
//   favorites first.
export function orderBranches(list, { scope = "local", current = null, prefs, favoritesFirst = false } = {}) {
  const how = { scope, current, prefs, favoritesFirst };
  const byName = nameOrder(list.map((b) => b.name));
  const byRemote = nameOrder(list.map((b) => (scope === "remote" ? splitRemote(b.name)[0] : "")));
  const ranks = list.map((b) => rank(b.name, how));
  return list.map((_, i) => i).sort((x, y) => byRemote(x, y) || ranks[x] - ranks[y] || byName(x, y)).map((i) => list[i]);
}

// orderTreeRows(rows, { scope, current, prefs }) → a copy of tree.js buildRows' grouped
// rows (items { path, branch }) reordered at each level, the top and inside every folder:
// the current branch, the favorites, the folders (in the tree's own order, by name), then
// the other branches by name. A folder's own rows follow it, ordered the same way.
// buildRows has each level by name already (and one folder's branches are all one
// remote's), so the branches are only split by kind, each kind keeping its order.
export function orderTreeRows(rows, how) {
  const walk = { rows, i: 0, at: { scope: how.scope, current: how.current, prefs: how.prefs } };
  const out = [];
  while (walk.i < rows.length) for (const r of levelRows(walk, rows[walk.i].depth)) out.push(r);
  return out;
}

// The rows from walk.i on that sit at `depth` or deeper, as one level in order; walk.i
// moves past them. A function of the module, handed the walk: a closure inside
// orderTreeRows that called itself would hold itself, and the rows with it, in a cycle,
// and the app's JS engine frees no cycles.
function levelRows(walk, depth) {
  const { rows, at } = walk;
  const kinds = [[], [], []], folders = [];
  while (walk.i < rows.length && rows[walk.i].depth >= depth) {
    const r = rows[walk.i++];
    if (r.folder) {
      folders.push(r);
      for (const x of levelRows(walk, r.depth + 1)) folders.push(x);
    } else kinds[rank(r.path, at)].push(r);
  }
  return kinds[0].concat(kinds[1], folders, kinds[2]);
}

// ---- the Branch tree's settings (⋮ Branches Pane Settings), and its toggles

// click: what a single click on a branch does: "filter" (limit the Commit list to it) or
// "navigate" (select its head commit). grouped: "/" in a name makes folders. tags: the
// Tags group shows. mine: Show My Branches. hidden: Hide Git Branches.
const DEFAULTS = { click: "filter", grouped: true, tags: true, mine: false, hidden: false };
const CLICKS = new Set(["filter", "navigate"]);
const FLAGS = ["grouped", "tags", "mine", "hidden"];

// treeSettings(saved) → the settings, saved values over the defaults.
export function treeSettings(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const out = { click: CLICKS.has(s.click) ? s.click : DEFAULTS.click };
  for (const key of FLAGS) out[key] = typeof s[key] === "boolean" ? s[key] : DEFAULTS[key];
  return out;
}

// treeSettingsMenu(settings) → the ⋮ popup: a group name ({ header, key }), then items
// { id, key, checked, rule? }. rule: a separator line goes above it.
export function treeSettingsMenu(settings) {
  const s = treeSettings(settings);
  return [
    { header: true, key: "branch-tree.singleClick" },
    { id: "click:filter", key: "branch-tree.updateFilter", checked: s.click === "filter" },
    { id: "click:navigate", key: "branch-tree.navigateLog", checked: s.click === "navigate" },
    { id: "grouped", key: "branch-tree.groupByDirectory", checked: s.grouped, rule: true },
    { id: "tags", key: "branch-tree.showTags", checked: s.tags },
  ];
}

// toggleTreeSetting(settings, id) → the settings after picking `id` (a menu item, or
// "mine", "hidden" for the toolbar's two toggles).
export function toggleTreeSetting(settings, id) {
  const s = treeSettings(settings);
  if (id.startsWith("click:") && CLICKS.has(id.slice(6))) return { ...s, click: id.slice(6) };
  if (FLAGS.includes(id)) return { ...s, [id]: !s[id] };
  return s;
}

// ---- the Branch tree's rows

const GROUPS = [["local", "log.local"], ["remote", "log.remote"]];
const NO_ROWS = { length: 0, row: () => undefined, index: () => -1, parent: () => -1 };

// treeRows(data, { settings, prefs, mine, words, collapsed, t }) → the Branch tree's rows,
// { length, row(i), index(key), parent(i) }: how many, the row at i, the index of the row
// with that key (-1: none), the index of the row i sits under (-1: top level).
//   data: git-branch.js readBranches' answer with tags (readTags' names) and rebasing
//     (HEAD is detached by a rebase), or null before anything was read (no rows).
//   settings: treeSettings'. prefs: the favorites. mine: { refs: Set of full ref names }
//     for Show My Branches (null: not read, so no branch shows while it is on).
//   words: the filter, trimmed and lowered ("": none). It keeps the names holding it,
//     with everything unfolded, and drops the groups left empty.
//   collapsed: the folded keys ("local", "remote:origin/x/", "tags").
//   t: the translator the HEAD row and the group names are worded with.
//   A row: { key, kind, depth, label }, and by kind: group and folder { open, count },
//     branch { scope, branch } (a readBranches entry), tag { scope: "tags", branch: { name } }.
//   Order: HEAD, Local, Remote (each in this module's order, "/" making folders unless
//   settings.grouped is off), Tags by name.
//   A tag's row is made only when asked for: a repository can have tens of thousands of
//   tags, and the tree is drawn a screenful at a time.
export function treeRows(data, { settings, prefs, mine = null, words = "", collapsed = new Set(), t = (key) => key } = {}) {
  if (!data) return NO_ROWS;
  const s = treeSettings(settings), rows = [];
  const match = (name) => !words || name.toLowerCase().includes(words);
  const current = t("log.headCurrent");
  if (match(current) || (data.head.branch && match(data.head.branch))) {
    const label = data.head.branch ? current : data.rebasing ? `⚠ ${t("vcs.detachedHead")}` : data.head.hash ? `HEAD (${data.head.hash.slice(0, 7)})` : "HEAD";
    rows.push({ key: "head", kind: "head", depth: 0, label });
  }
  const shown = (scope, b) => !s.mine || Boolean(mine?.refs.has(refOf(scope, b.name)));
  for (const [scope, key] of GROUPS) {
    const how = { scope, current: data.head.branch, prefs };
    const list = (data[scope] ?? []).filter((b) => match(b.name) && shown(scope, b));
    if ((words || s.mine) && !list.length) continue;
    const open = words ? true : !collapsed.has(scope);
    rows.push({ key: scope, kind: "group", depth: 0, label: t(key), open, count: list.length });
    if (!open) continue;
    if (!s.grouped) {
      for (const b of orderBranches(list, how)) rows.push({ key: `${scope}:${b.name}`, kind: "branch", scope, depth: 1, label: b.name, branch: b });
      continue;
    }
    const folded = new Set();
    if (!words) for (const k of collapsed) if (k.startsWith(`${scope}:`)) folded.add(k.slice(scope.length + 1));
    for (const r of orderTreeRows(buildRows(list.map((b) => ({ path: b.name, branch: b })), { grouped: true, collapsed: folded }), how)) {
      rows.push(r.folder
        ? { key: `${scope}:${r.key}`, kind: "folder", depth: r.depth + 1, label: r.name, open: r.open, count: r.count }
        : { key: `${scope}:${r.path}`, kind: "branch", scope, depth: r.depth + 1, label: r.name, branch: r.item.branch });
    }
  }
  const tags = !s.tags ? [] : words ? (data.tags ?? []).filter(match) : data.tags ?? [];
  let open = false;
  if (tags.length) {
    open = words ? true : !collapsed.has("tags");
    rows.push({ key: "tags", kind: "group", depth: 0, label: t("vcs.tags"), open, count: tags.length });
  }
  const base = rows.length, length = base + (open ? tags.length : 0);
  const at = new Map(rows.map((r, i) => [r.key, i]));
  const tagRow = (name) => ({ key: `tags:${name}`, kind: "tag", scope: "tags", depth: 1, label: name, branch: { name } });
  return {
    length,
    row: (i) => (i < base ? rows[i] : i < length ? tagRow(tags[i - base]) : undefined),
    index: (key) => {
      if (at.has(key)) return at.get(key);
      const k = open && typeof key === "string" && key.startsWith("tags:") ? tags.indexOf(key.slice(5)) : -1;
      return k < 0 ? -1 : base + k;
    },
    parent: (i) => {
      if (i >= base) return i < length ? base - 1 : -1;
      const depth = rows[i]?.depth ?? 0;
      for (let j = i - 1; j >= 0; j--) if (rows[j].depth < depth) return j;
      return -1;
    },
  };
}
