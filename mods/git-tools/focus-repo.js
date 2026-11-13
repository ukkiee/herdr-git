// Which folder the Log and Commit panels follow: the focused terminal's, or, when the
// focus is on a tab this mod opened (Update Info, a Diff, a comparison), the repository
// that tab was opened on. No `herdr` import: node tests it (focus-repo.test.mjs).
//
// Herdr tells a mod which pane has the focus but not a mod pane's props, so the tabs are
// recorded in a shared value, { pane: { root, on } }: each tab's screen records its own
// pane (registerTab, from main.js), and newTab (ui.js) notes which pane tab.new added.
// Without the record a tab has no folder of its own, and the panels would follow the
// space's folder: the wrong repository once the terminals have moved to another one.

const MOD = "git-tools";
const str = (v) => (typeof v === "string" && v ? v : null);

// whereFocused({ space, focused, panes, tabs }) → { folder, on, space }
//   space: the active space ({ id, folder, machine }). focused: Herdr's focused(). panes:
//   Herdr's panes(). tabs: the record ({ pane: { root, on } }).
//   folder: the recorded repository for a git-tools tab, else the focused pane's live
//   folder, else the focused layout block's, else the space's. on: the machine git runs on
//   (null: this computer): a recorded tab's own, a layout terminal block's from its
//   address, else the space's.
export function whereFocused({ space, focused, panes = [], tabs = {} } = {}) {
  const f = focused ?? null;
  const pane = f?.pane ? panes.find((p) => p.pane === f.pane) ?? null : null;
  const at = { space: space?.id ?? null };
  const tab = pane?.mod === MOD ? tabs?.[pane.pane] : null;
  if (tab && str(tab.root)) return { folder: tab.root, on: str(tab.on), ...at };
  const on = f && f.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { folder: pane?.cwd || f?.cwd || space?.folder || null, on, ...at };
}

// newPanes(before, after) → the ids of this mod's panes in `after` and not in `before`.
export function newPanes(before = [], after = []) {
  const had = new Set(before.map((p) => p.pane));
  return after.filter((p) => p.mod === MOD && !had.has(p.pane)).map((p) => p.pane);
}

// An entry: { root, on } for a tab of a repository, { root: null, on: null } for a tab of
// this mod with none (it is recorded only so no other tab takes its pane for its own).
const entryOf = (root, on) => (str(root) ? { root, on: str(on) } : root === null ? { root: null, on: null } : null);

// rememberTab(record, added, { root, on }, panes) → the record to store: entries for panes
// that are gone dropped, malformed ones too, and each added pane noted with the tab's
// repository (root null: a tab with none; undefined: not noted).
export function rememberTab(record, added, { root, on } = {}, panes = []) {
  const live = new Set(panes.map((p) => p.pane)), out = {};
  for (const [pane, v] of Object.entries(record && typeof record === "object" ? record : {})) {
    const kept = live.has(pane) && v && typeof v === "object" ? entryOf(v.root, v.on) : null;
    if (kept) out[pane] = kept;
  }
  const noted = entryOf(root, on);
  if (noted) for (const pane of added) out[pane] = { ...noted };
  return out;
}

// The screens only ever opened as a tab of their own that have no repository.
const TAB_ONLY = new Set(["console", "icon-sheet"]);

// isTabScreen(props) → whether a copy with these props is a tab's screen: no dialog or
// menu (props.overlay), and either of a repository (a root) or a tab-only screen. Layout
// blocks (the panels) have neither.
export function isTabScreen(p) {
  return Boolean(p && !p.overlay && (str(p.root) || TAB_ONLY.has(p.view)));
}

// registerTab(record, { props, focused, panes }) → { pane, record } to store for a copy
// that is a tab's screen, or null when there is nothing to store.
//   props: the copy's props(); its repository is props.root and props.on. A dialog or a
//   menu (props.overlay) and a screen without a root (a layout block, the console) are
//   no tab of a repository.
//   The copy's pane: props.pane when Herdr gives one, and that replaces whatever is
//   recorded for it. Without it, a guess: the focused pane, when it is the only pane of
//   its tab, this mod's, and nothing is recorded for it (a tab just opened has the focus).
//   Never a recorded pane: right after tab.new the focus may still be on the tab before,
//   which is why the tabs with no repository record themselves too.
export function registerTab(record, { props: p, focused, panes = [] } = {}) {
  if (!isTabScreen(p)) return null;
  const repo = entryOf(str(p.root) ? p.root : null, p.on);
  const tabs = record && typeof record === "object" ? record : {};
  const pane = str(p.pane) ?? guessPane(tabs, focused, panes);
  if (!pane) return null;
  const had = tabs[pane];
  if (had && had.root === repo.root && (had.on ?? null) === repo.on) return null;
  return { pane, record: rememberTab(tabs, [pane], repo, panes) };
}

// forgetTab(record, pane) → the record without `pane`, or null when it has no entry.
export function forgetTab(record, pane) {
  if (!str(pane) || !record || typeof record !== "object" || !(pane in record)) return null;
  const { [pane]: _gone, ...rest } = record;
  return rest;
}

function guessPane(tabs, focused, panes) {
  const f = focused?.pane ? panes.find((p) => p.pane === focused.pane) : null;
  if (!f || f.mod !== MOD || tabs[f.pane]) return null;
  return panes.filter((p) => p.tab === f.tab).length === 1 ? f.pane : null;
}
