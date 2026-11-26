// node focus-repo.test.mjs: which folder the Log and Commit panels follow, from Herdr's
// live data (no app, no git).
import assert from "node:assert/strict";
import { whereFocused, rememberTab, newPanes, registerTab, forgetTab, isTabScreen } from "./focus-repo.js";

const space = { id: "s1", active: true, folder: "/home/me/practice", machine: null };
const term = (pane, cwd, extra = {}) => ({ pane, terminal: `t-${pane}`, tab: "tab1", cwd, ...extra });
const tab = (pane) => ({ pane, terminal: null, mod: "git-tools", tab: `tab-${pane}`, cwd: null });

// A terminal: its live folder. Nothing focused: the space's folder.
{
  const panes = [term("p1", "/work/other")];
  assert.deepEqual(whereFocused({ space, focused: { pane: "p1" }, panes, tabs: {} }), { folder: "/work/other", on: null, space: "s1" });
  assert.deepEqual(whereFocused({ space, focused: null, panes, tabs: {} }), { folder: "/home/me/practice", on: null, space: "s1" });
}

// A git-tools tab (Update Info, a Diff, a comparison): the repository it was opened on,
// not the space's folder; on another machine, that machine.
{
  const panes = [term("p1", "/work/other"), tab("p2"), tab("p3")];
  const tabs = { p2: { root: "/work/other", on: null }, p3: { root: "/srv/repo", on: "box" } };
  assert.deepEqual(whereFocused({ space, focused: { pane: "p2" }, panes, tabs }), { folder: "/work/other", on: null, space: "s1" });
  assert.deepEqual(whereFocused({ space, focused: { pane: "p3" }, panes, tabs }), { folder: "/srv/repo", on: "box", space: "s1" });
  // Back on a terminal in another repository: that terminal again.
  const back = whereFocused({ space, focused: { pane: "p1" }, panes: [term("p1", "/work/third"), tab("p2")], tabs });
  assert.deepEqual(back, { folder: "/work/third", on: null, space: "s1" });
}

// A git-tools tab nobody recorded (another mod's pane too): the space's folder, as before.
{
  const panes = [tab("p9"), { pane: "p8", terminal: null, mod: "files", tab: "t8", cwd: null }];
  assert.equal(whereFocused({ space, focused: { pane: "p9" }, panes, tabs: {} }).folder, "/home/me/practice");
  assert.equal(whereFocused({ space, focused: { pane: "p8" }, panes, tabs: { p8: { root: "/x", on: null } } }).folder, "/home/me/practice");
}

// A layout terminal block (no pane): its own folder and the machine in its address.
{
  assert.deepEqual(whereFocused({ space, focused: { pane: null, terminal: "box/t7", cwd: "/srv/b" }, panes: [], tabs: {} }), { folder: "/srv/b", on: "box", space: "s1" });
  assert.deepEqual(whereFocused({ space: { ...space, machine: "m2" }, focused: { pane: "p1" }, panes: [term("p1", "/w")], tabs: {} }), { folder: "/w", on: "m2", space: "s1" });
}

// The record: the panes a tab.new added, and the map kept to the panes still there.
{
  const before = [term("p1", "/a"), tab("p2")];
  const after = [...before, tab("p5"), term("p6", "/b")];
  assert.deepEqual(newPanes(before, after), ["p5"]);
  assert.deepEqual(newPanes(after, after), []);
  const kept = rememberTab({ p2: { root: "/r2", on: null }, gone: { root: "/old", on: null } }, ["p5"], { root: "/r5", on: "box" }, after);
  assert.deepEqual(kept, { p2: { root: "/r2", on: null }, p5: { root: "/r5", on: "box" } });
  // Nothing new (tab.new didn't apply yet): only the pruning.
  assert.deepEqual(rememberTab({ gone: { root: "/old", on: null } }, [], { root: "/r", on: null }, after), {});
  // A tab without a repository (root null) is noted as having none; no root given at
  // all notes nothing.
  assert.deepEqual(rememberTab({}, ["p5"], { root: null, on: "box" }, after), { p5: { root: null, on: null } });
  assert.deepEqual(rememberTab({}, ["p5"], {}, after), {});
  // Bad stored values are dropped, not trusted.
  assert.deepEqual(rememberTab("junk", [], {}, after), {});
  assert.deepEqual(rememberTab({ p2: { root: 3 } }, [], {}, after), {});
}

// A tab's screen records itself: Herdr names its pane in props().pane, and the tab's
// repository is its own props.root and props.on.
{
  const panes = [term("p1", "/a"), tab("p2"), tab("p5")];
  const got = registerTab({ p2: { root: "/r2", on: null }, gone: { root: "/old", on: null } }, { props: { view: "diff", root: "/r5", on: "box", pane: "p5" }, focused: { pane: "p1" }, panes });
  assert.deepEqual(got, { pane: "p5", record: { p2: { root: "/r2", on: null }, p5: { root: "/r5", on: "box" } } });
  // Already recorded the same: nothing to store.
  assert.equal(registerTab({ p5: { root: "/r5", on: "box" } }, { props: { view: "diff", root: "/r5", on: "box", pane: "p5" }, focused: null, panes }), null);
  // Herdr's word wins over a guess another copy stored.
  assert.deepEqual(registerTab({ p5: { root: "/x", on: null } }, { props: { view: "diff", root: "/r5", pane: "p5" }, focused: null, panes }).record, { p5: { root: "/r5", on: null } });
}

// Not a tab's screen: a dialog (overlay), a layout block (no root).
{
  const panes = [tab("p5")], focused = { pane: "p5" };
  assert.equal(registerTab({}, { props: { view: "push", root: "/r", overlay: "o1" }, focused, panes }), null);
  assert.equal(registerTab({}, { props: { view: "log" }, focused, panes }), null);
  assert.equal(isTabScreen({ view: "push", root: "/r", overlay: "o1" }), false);
  assert.equal(isTabScreen({ view: "console", overlay: "o1" }), false);
  assert.equal(isTabScreen({ view: "log" }), false);
  assert.equal(isTabScreen(undefined), false);
  assert.equal(isTabScreen({ view: "update-info", root: "/r", on: null }), true);
}

// A Commit panel or Log tab opened on a chosen folder (props.folder, props.on) is a tab
// of that repository too: while it has the focus the side panels follow its folder, not
// the space's. A dialog opened from one is not a tab.
{
  const panes = [term("p1", "/a"), tab("p5")];
  assert.equal(isTabScreen({ view: "commit", folder: "/work/hooks" }), true);
  assert.equal(isTabScreen({ view: "log", folder: "/work/hooks", on: "box" }), true);
  assert.equal(isTabScreen({ view: "rollback", folder: "/work/hooks", overlay: "o1" }), false);
  const got = registerTab({}, { props: { view: "commit", folder: "/work/hooks", on: "box" }, focused: { pane: "p5" }, panes });
  assert.deepEqual(got, { pane: "p5", record: { p5: { root: "/work/hooks", on: "box" } } });
  assert.deepEqual(whereFocused({ space, focused: { pane: "p5" }, panes, tabs: got.record }), { folder: "/work/hooks", on: "box", space: "s1" });
}

// A tab with no repository (the Git console, the icon sheet) records itself as having
// none, so a tab opened next never takes its pane for its own; the panels follow the
// folder there as before.
{
  const panes = [term("p1", "/a"), tab("p4"), tab("p5")];
  assert.equal(isTabScreen({ view: "console" }), true);
  assert.equal(isTabScreen({ view: "icon-sheet" }), true);
  const own = registerTab({}, { props: { view: "console" }, focused: { pane: "p4" }, panes });
  assert.deepEqual(own, { pane: "p4", record: { p4: { root: null, on: null } } });
  // Kept by the next record, and skipped by a guess.
  const props = { view: "diff", root: "/r5", on: null };
  assert.equal(registerTab(own.record, { props, focused: { pane: "p4" }, panes }), null);
  assert.deepEqual(rememberTab(own.record, ["p5"], { root: "/r5", on: null }, panes), { p4: { root: null, on: null }, p5: { root: "/r5", on: null } });
  assert.deepEqual(whereFocused({ space, focused: { pane: "p4" }, panes, tabs: own.record }), { folder: "/home/me/practice", on: null, space: "s1" });
  // Recorded already: nothing to store.
  assert.equal(registerTab(own.record, { props: { view: "console" }, focused: { pane: "p4" }, panes }), null);
}

// No pane id from Herdr: the focused pane, when it is the only screen of this mod in its
// tab and nobody recorded it yet (a tab just opened takes the focus).
{
  const panes = [term("p1", "/a"), tab("p2"), tab("p5")];
  const props = { view: "diff", root: "/r5", on: null };
  assert.deepEqual(registerTab({ p2: { root: "/r2", on: null } }, { props, focused: { pane: "p5" }, panes }),
    { pane: "p5", record: { p2: { root: "/r2", on: null }, p5: { root: "/r5", on: null } } });
  // The focus is still on another tab's recorded screen, or on a terminal: no guess.
  assert.equal(registerTab({ p2: { root: "/r2", on: null } }, { props, focused: { pane: "p2" }, panes }), null);
  assert.equal(registerTab({}, { props, focused: { pane: "p1" }, panes }), null);
  assert.equal(registerTab({}, { props, focused: null, panes }), null);
  // Two screens of this mod in the focused tab: which one is this copy is not known.
  const split = [tab("p5"), { ...tab("p6"), tab: "tab-p5" }];
  assert.equal(registerTab({}, { props, focused: { pane: "p5" }, panes: split }), null);
  // A tab that holds a terminal too was split by hand: no tab this mod opens looks so.
  const mixed = [tab("p5"), term("p7", "/a", { tab: "tab-p5" })];
  assert.equal(registerTab({}, { props, focused: { pane: "p5" }, panes: mixed }), null);
}

// Tabs opened one right after another (Show Changes to Parents on a merge commit: one tab
// per parent): the focus is on the last one while each screen records itself, so a
// screen opened by newTab finds its pane by its tab's name (props.tabName), never takes
// the focused pane of another tab, and the earlier tab is recorded too.
{
  const named = (pane, tabId) => ({ pane, terminal: null, mod: "git-tools", tab: tabId, cwd: null });
  const panes = [term("p1", "/a"), named("p5", "t5"), named("p6", "t6")];
  const tabs = [{ id: "tab1", name: "1" }, { id: "t5", name: "8ea89cf → f4d7f02" }, { id: "t6", name: "15adeb4 → f4d7f02" }];
  const first = { view: "diff", root: "/r38", on: null, tabName: "8ea89cf → f4d7f02" };
  const second = { view: "diff", root: "/r38", on: null, tabName: "15adeb4 → f4d7f02" };
  const focused = { pane: "p6" };
  const a = registerTab({}, { props: first, focused, panes, tabs });
  assert.equal(a.pane, "p5");
  const b = registerTab(a.record, { props: second, focused, panes, tabs });
  assert.deepEqual(b, { pane: "p6", record: { p5: { root: "/r38", on: null }, p6: { root: "/r38", on: null } } });
  // The first tab's pane isn't listed yet: no guess at all, not the focused second tab.
  assert.equal(registerTab({}, { props: first, focused, panes: [term("p1", "/a"), named("p6", "t6")], tabs }), null);
  // Two unrecorded tabs of the same name: the focused one, else none.
  const twins = [named("p5", "t5"), named("p6", "t6")], same = [{ id: "t5", name: "x" }, { id: "t6", name: "x" }];
  assert.equal(registerTab({}, { props: { ...first, tabName: "x" }, focused: { pane: "p6" }, panes: twins, tabs: same }).pane, "p6");
  assert.equal(registerTab({}, { props: { ...first, tabName: "x" }, focused: { pane: "p1" }, panes: [term("p1", "/a"), ...twins], tabs: same }), null);
}

// A tab's screen that closes takes its entry out; nothing to take: nothing to store.
{
  const record = { p2: { root: "/r2", on: null }, p5: { root: "/r5", on: "box" } };
  assert.deepEqual(forgetTab(record, "p5"), { p2: { root: "/r2", on: null } });
  assert.equal(forgetTab(record, "p9"), null);
  assert.equal(forgetTab(record, null), null);
  assert.equal(forgetTab("junk", "p5"), null);
}

console.log("ok");
