// node log-options.test.mjs: the Commit list's graph options and display options (pure).
import assert from "node:assert/strict";
import { OPTIONS_KEY, readOptions, toggleOption, graphMenu, displayMenu, columnsMenu, readArgs } from "./log-options.js";

// Nothing saved yet: the reference's defaults. Sort by commit date, no graph option on;
// compact references, author and date columns, and three of the four highlights.
{
  const o = readOptions(undefined);
  assert.equal(OPTIONS_KEY, "log.options");
  assert.equal(o.sort, "date");
  assert.deepEqual([o.firstParent, o.noMerges], [false, false]);
  assert.deepEqual([o.compactRefs, o.tagNames, o.longEdges, o.commitTimestamp, o.refsLeft], [true, false, false, false, false]);
  assert.deepEqual(o.columns, { author: true, date: true, hash: false });
  assert.deepEqual(o.highlight, { mine: true, merges: true, current: true, notPicked: false });
  assert.deepEqual(readArgs(o), { order: "date", firstParent: false, noMerges: false });
}

// A saved value keeps what it says; anything it lacks or gets wrong falls back to the
// default one by one, so a file from an older build or edited by hand still reads.
{
  const o = readOptions({ sort: "topo", noMerges: true, tagNames: "yes", columns: { hash: true }, highlight: { mine: false }, extra: 1 });
  assert.equal(o.sort, "topo");
  assert.equal(o.noMerges, true);
  assert.equal(o.tagNames, false, "not a boolean: the default");
  assert.deepEqual(o.columns, { author: true, date: true, hash: true });
  assert.deepEqual(o.highlight, { mine: false, merges: true, current: true, notPicked: false });
  assert.equal("extra" in o, false);
  assert.deepEqual(readArgs(o), { order: "topo", firstParent: false, noMerges: true });
  assert.equal(readOptions({ sort: "sideways" }).sort, "date");
  assert.deepEqual(readOptions("nonsense"), readOptions(undefined));
  assert.deepEqual(readOptions(null), readOptions(undefined));
}

// Picking an item: sort is one of two, every other item flips. The value handed in is
// not changed, and what comes back reads back the same (it is what gets saved).
{
  const before = readOptions(undefined);
  const topo = toggleOption(before, "sort.topo");
  assert.equal(topo.sort, "topo");
  assert.equal(before.sort, "date", "not changed in place");
  assert.equal(toggleOption(topo, "sort.topo").sort, "topo", "picking the sort shown keeps it");
  assert.equal(toggleOption(topo, "sort.date").sort, "date");
  assert.equal(toggleOption(before, "firstParent").firstParent, true);
  assert.equal(toggleOption(toggleOption(before, "noMerges"), "noMerges").noMerges, false);
  assert.equal(toggleOption(before, "compactRefs").compactRefs, false);
  assert.equal(toggleOption(before, "column.hash").columns.hash, true);
  assert.equal(toggleOption(before, "highlight.notPicked").highlight.notPicked, true);
  assert.equal(before.highlight.notPicked, false);
  assert.deepEqual(toggleOption(before, "nonsense"), before);
  const saved = JSON.parse(JSON.stringify(toggleOption(before, "highlight.mine")));
  assert.deepEqual(readOptions(saved), toggleOption(before, "highlight.mine"));
}

// The graph options popup in the reference's order: Sort (by commit date, topologically),
// Options (first parent, no merges), Branch Actions (collapse, expand linear branches).
// Group names are headers; a check marks what is on. Collapse is off while collapsed,
// expand while not.
{
  const shape = (items) => items.map((it) => (it.header ? `# ${it.key}` : `${it.checked ? "✓" : " "}${it.disabled ? "-" : " "}${it.id}`));
  assert.deepEqual(shape(graphMenu(readOptions(undefined), { collapsed: false })), [
    "# graph.sort", "✓ sort.date", "  sort.topo",
    "# graph.options", "  firstParent", "  noMerges",
    "# graph.branchActions", "  collapseLinear", " -expandLinear",
  ]);
  const on = toggleOption(toggleOption(readOptions(undefined), "sort.topo"), "noMerges");
  assert.deepEqual(shape(graphMenu(on, { collapsed: true })), [
    "# graph.sort", "  sort.date", "✓ sort.topo",
    "# graph.options", "  firstParent", "✓ noMerges",
    "# graph.branchActions", " -collapseLinear", "  expandLinear",
  ]);
  for (const it of graphMenu(on, { collapsed: true })) assert.match(it.key, /^graph\./);
}

// The display options popup: Show (compact references view, tag names, long edges,
// commit timestamp, references on the left, columns ▸) and Highlight (my commits, merge
// commits, current branch, non-picked commits). Columns opens its own list.
{
  const shape = (items) => items.map((it) => (it.header ? `# ${it.key}` : `${it.checked ? "✓" : " "}${it.more ? ">" : " "}${it.id}`));
  assert.deepEqual(shape(displayMenu(readOptions(undefined))), [
    "# graph.show", "✓ compactRefs", "  tagNames", "  longEdges", "  commitTimestamp", "  refsLeft", " >columns",
    "# graph.highlight", "✓ highlight.mine", "✓ highlight.merges", "✓ highlight.current", "  highlight.notPicked",
  ]);
  assert.deepEqual(columnsMenu(readOptions(undefined)).map((it) => [it.id, it.checked]), [["column.author", true], ["column.date", true], ["column.hash", false]]);
}

console.log("ok");
