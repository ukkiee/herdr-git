// Which folder the Log and Commit panels follow: the focused terminal's, or, when the
// focus is on a tab this mod opened (Update Info, a Diff, a comparison), the repository
// that tab was opened on. No `herdr` import: node tests it (focus-repo.test.mjs).
//
// Herdr tells a mod which pane has the focus but not a mod pane's props, so the tabs are
// recorded when they open: openTab (ui.js) notes which pane tab.new added and keeps
// { pane: { root, on } } in a shared value. Without the record a tab has no folder of its
// own, and the panels would follow the space's folder: the wrong repository once the
// terminals have moved to another one.

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

// rememberTab(record, added, { root, on }, panes) → the record to store: entries for panes
// that are gone dropped, malformed ones too, and each added pane noted with the tab's
// repository (none when the tab has no root).
export function rememberTab(record, added, { root, on } = {}, panes = []) {
  const live = new Set(panes.map((p) => p.pane)), out = {};
  for (const [pane, v] of Object.entries(record && typeof record === "object" ? record : {})) {
    if (live.has(pane) && v && str(v.root)) out[pane] = { root: v.root, on: str(v.on) };
  }
  if (str(root)) for (const pane of added) out[pane] = { root, on: str(on) };
  return out;
}
