// node focus-repo.test.mjs: which folder the Log and Commit panels follow, from Herdr's
// live data (no app, no git).
import assert from "node:assert/strict";
import { whereFocused, rememberTab, newPanes } from "./focus-repo.js";

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
  // A tab without a repository records nothing.
  assert.deepEqual(rememberTab({}, ["p5"], { root: null, on: null }, after), {});
  // Bad stored values are dropped, not trusted.
  assert.deepEqual(rememberTab("junk", [], {}, after), {});
  assert.deepEqual(rememberTab({ p2: { root: 3 } }, [], {}, after), {});
}

console.log("ok");
