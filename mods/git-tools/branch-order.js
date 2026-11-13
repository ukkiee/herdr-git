// The order branches show in, in the Branch tree and the VCS widget popup alike: the
// current branch, then the favorites, then by name. Favorites are main and master until
// unmarked, and whatever was marked. Also the Branch tree's own settings (its ⋮ popup).
// No `herdr` import: node tests it (branch-order.test.mjs).
//
// Favorites are kept by full ref name ("refs/heads/main", "refs/remotes/origin/main"): a
// local branch may be called "origin/main" too. prefs: { favorite, unfavorite }, two
// lists of full ref names, as git-branch.js readFavorites reads them from the repository's
// own git config (gittools.favorite, gittools.unfavorite).

const HEADS = "refs/heads/", REMOTES = "refs/remotes/";
const DEFAULT = new Set(["main", "master"]);

// Case-insensitive first, then the raw compare so the order is the same on every run
// (tree.js sorts folders and names the same way).
function byName(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
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

// 0: the current branch, 1: a favorite, 2: the rest.
function rank(name, { scope, current, prefs }) {
  if (scope === "local" && current && name === current) return 0;
  return isFavorite(refOf(scope, name), prefs) ? 1 : 2;
}

// orderBranches(list, { scope, current, prefs }) → a sorted copy of `list` ([{ name, … }]).
//   scope: "local" | "remote"; current: the branch HEAD is on, or null.
//   Remote branches stay together by remote (the remotes by name), each with its own
//   favorites first.
export function orderBranches(list, { scope = "local", current = null, prefs } = {}) {
  const how = { scope, current, prefs };
  const keyed = list.map((b) => ({ b, remote: scope === "remote" ? splitRemote(b.name)[0] : "", rank: rank(b.name, how) }));
  keyed.sort((x, y) => byName(x.remote, y.remote) || x.rank - y.rank || byName(x.b.name, y.b.name));
  return keyed.map((k) => k.b);
}

// orderTreeRows(rows, { scope, current, prefs }) → a copy of tree.js buildRows' grouped
// rows (items { path, branch }) with the branches under each folder in this order. The
// folders keep the tree's own place and order.
export function orderTreeRows(rows, how) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) run = orderBranches(run.map((r) => ({ name: r.path, row: r })), { scope: how.scope, current: how.current, prefs: how.prefs }).map((x) => x.row);
    out.push(...run);
    run = [];
  };
  for (const r of rows) {
    if (r.folder || (run.length && (run[0].depth !== r.depth || run[0].dir !== r.dir))) flush();
    if (r.folder) out.push(r); else run.push(r);
  }
  flush();
  return out;
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
