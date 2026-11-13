// The Commit list's graph options (how commits are read and laid out) and display options
// (what a row shows and which commits stand out): their values, defaults and the items of
// the two toolbar popups. Kept app-wide in the settings file under OPTIONS_KEY
// (app-files.js). Pure: no git, no herdr (log-options.test.mjs).
//
// options: {
//   sort: "date" | "topo"      commit date order, or topological order
//   firstParent, noMerges      follow first parents only; leave merge commits out
//   compactRefs                a branch and its remote twins as one label, few labels
//   tagNames                   tags by name; off, a commit's tags are one unnamed label
//   longEdges                  draw edges that run a long way down in full
//   commitTimestamp            the time column shows the commit date, not the author date
//   refsLeft                   Ref labels before the subject
//   columns: { author, date, hash }
//   highlight: { mine, merges, current, notPicked }
// }

export const OPTIONS_KEY = "log.options";

const DEFAULTS = {
  sort: "date",
  firstParent: false,
  noMerges: false,
  compactRefs: true,
  tagNames: false,
  longEdges: false,
  commitTimestamp: false,
  refsLeft: false,
  columns: { author: true, date: true, hash: false },
  highlight: { mine: true, merges: true, current: true, notPicked: false },
};
const SORTS = ["date", "topo"];
const FLAGS = ["firstParent", "noMerges", "compactRefs", "tagNames", "longEdges", "commitTimestamp", "refsLeft"];
const GROUPS = ["columns", "highlight"];

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const flag = (v, fallback) => (typeof v === "boolean" ? v : fallback);

// readOptions(saved) → full options: each value saved that has the right type, else its
// default (a missing file, an older build's file, a hand edit).
export function readOptions(saved) {
  const s = isObject(saved) ? saved : {};
  const out = { sort: SORTS.includes(s.sort) ? s.sort : DEFAULTS.sort };
  for (const name of FLAGS) out[name] = flag(s[name], DEFAULTS[name]);
  for (const group of GROUPS) {
    const g = isObject(s[group]) ? s[group] : {};
    out[group] = {};
    for (const name of Object.keys(DEFAULTS[group])) out[group][name] = flag(g[name], DEFAULTS[group][name]);
  }
  return out;
}

// toggleOption(options, id) → new options after picking the popup item `id`: a sort item
// sets the sort, any other item flips its value. An unknown id changes nothing.
export function toggleOption(options, id) {
  const o = readOptions(options);
  if (id.startsWith("sort.")) {
    const sort = id.slice(5);
    if (SORTS.includes(sort)) o.sort = sort;
  } else if (FLAGS.includes(id)) o[id] = !o[id];
  else {
    const [prefix, name] = id.split(".");
    const group = prefix === "column" ? "columns" : prefix;
    if (GROUPS.includes(group) && name in o[group]) o[group][name] = !o[group][name];
  }
  return o;
}

// readArgs(options) → what reading the commits takes from them (git-log.js readLog).
export function readArgs(options) {
  const o = readOptions(options);
  return { order: o.sort, firstParent: o.firstParent, noMerges: o.noMerges };
}

// ---- the popups' items, in the reference's order
//   { header: true, key }                                a group's name
//   { id, key, checked, disabled?, more? }               an item; more: opens a list

const header = (key) => ({ header: true, key });
const item = (id, key, checked, extra = {}) => ({ id, key, checked: Boolean(checked), ...extra });

// graphMenu(options, { collapsed }) → the graph options popup. collapsed: linear branches
// are folded now (collapse is off then, expand is off when they are not).
export function graphMenu(options, { collapsed = false } = {}) {
  const o = readOptions(options);
  return [
    header("graph.sort"),
    item("sort.date", "graph.byDate", o.sort === "date"),
    item("sort.topo", "graph.topological", o.sort === "topo"),
    header("graph.options"),
    item("firstParent", "graph.firstParent", o.firstParent),
    item("noMerges", "graph.noMerges", o.noMerges),
    header("graph.branchActions"),
    item("collapseLinear", "graph.collapseLinear", false, { disabled: collapsed }),
    item("expandLinear", "graph.expandLinear", false, { disabled: !collapsed }),
  ];
}

// displayMenu(options) → the display options popup.
export function displayMenu(options) {
  const o = readOptions(options);
  return [
    header("graph.show"),
    item("compactRefs", "graph.compactRefs", o.compactRefs),
    item("tagNames", "graph.tagNames", o.tagNames),
    item("longEdges", "graph.longEdges", o.longEdges),
    item("commitTimestamp", "graph.commitTimestamp", o.commitTimestamp),
    item("refsLeft", "graph.refsLeft", o.refsLeft),
    item("columns", "graph.columns", false, { more: true }),
    header("graph.highlight"),
    item("highlight.mine", "graph.myCommits", o.highlight.mine),
    item("highlight.merges", "graph.mergeCommits", o.highlight.merges),
    item("highlight.current", "graph.currentBranch", o.highlight.current),
    item("highlight.notPicked", "graph.notPicked", o.highlight.notPicked),
  ];
}

// ---- Commit details' View Options (its toolbar's eye), kept under DETAILS_KEY
//   { groupByDirectory }   the commit's files in their folders; off, one flat list

export const DETAILS_KEY = "log.detailsOptions";
const DETAILS_DEFAULTS = { groupByDirectory: true };

// readDetailsOptions(saved) → full options, each wrong or missing value its default.
export function readDetailsOptions(saved) {
  const s = isObject(saved) ? saved : {};
  return Object.fromEntries(Object.keys(DETAILS_DEFAULTS).map((name) => [name, flag(s[name], DETAILS_DEFAULTS[name])]));
}

// toggleDetailsOption(options, id) → new options with item `id` flipped (unknown: none).
export function toggleDetailsOption(options, id) {
  const o = readDetailsOptions(options);
  if (Object.prototype.hasOwnProperty.call(DETAILS_DEFAULTS, id)) o[id] = !o[id];
  return o;
}

// detailsMenu(options) → the View Options popup's items.
export function detailsMenu(options) {
  const o = readDetailsOptions(options);
  return [item("groupByDirectory", "commit.groupByDirectory", o.groupByDirectory)];
}

// columnsMenu(options) → the Columns list the display popup's Columns ▸ opens.
export function columnsMenu(options) {
  const o = readOptions(options);
  return [
    item("column.author", "graph.columnAuthor", o.columns.author),
    item("column.date", "graph.columnDate", o.columns.date),
    item("column.hash", "graph.columnHash", o.columns.hash),
  ];
}
