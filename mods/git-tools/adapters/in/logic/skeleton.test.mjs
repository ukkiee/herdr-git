// node skeleton.test.mjs: where a skeleton list's rows and their pieces go (no app, no git).
import assert from "node:assert/strict";
import { skeletonRows, skeletonCount, skeletonFills, skeletonSize, checkSize, HEIGHT, ROOM, LEAD } from "./skeleton.js";
import { letGo } from "./let-go.js";

const sum = (rows) => rows.reduce((n, r) => n + r.height, 0);

// ---- no description: the plain shape, one name bar per 24px row, filling the height
{
  const rows = skeletonRows();
  assert.ok(sum(rows) >= HEIGHT && sum(rows) <= HEIGHT + 24, `height ${sum(rows)}`);
  for (const r of rows) {
    assert.equal(r.height, 24);
    assert.equal(r.left, 12);
    assert.equal(r.right, 8);
    assert.equal(r.gap, 6);
    assert.equal(r.pieces.length, 1);
    const [name] = r.pieces;
    assert.equal(name.shape.kind, "bar");
    assert.equal(name.shape.height, 8);
    // A name bar is cut in a narrow column rather than push the row wider.
    assert.equal(name.shrink, true);
  }
  // Names differ from row to row, so the list doesn't read as one block.
  assert.notEqual(rows[0].pieces[0].shape.width, rows[1].pieces[0].shape.width);
  // An empty description is the same shape.
  assert.deepEqual(skeletonRows([{}]), rows);
  assert.deepEqual(skeletonRows({}), rows);
}

// ---- a described row: fixed places before the name, per-depth indent, depth overrides
{
  const spec = {
    indent: [8, 16], depth: [0, 1, 2],
    lead: ["slot", "check", "icon"], cols: [{ name: true }, { fit: 40 }],
    at: { 0: { lead: ["slot", "check"] } },
  };
  const rows = skeletonRows(spec);
  assert.deepEqual(rows.slice(0, 4).map((r) => r.left), [8, 24, 40, 8]); // the depths repeat
  // Depth 0: no icon.
  assert.deepEqual(rows[0].pieces.map((p) => p.width), [LEAD.slot.width, LEAD.check.width, rows[0].pieces[2].width, 40]);
  assert.equal(rows[0].pieces[0].shape, null); // the arrow's place is empty
  assert.equal(rows[0].pieces[1].shape.kind, "box");
  // Depth 1: the icon too.
  assert.deepEqual(rows[1].pieces.slice(0, 3).map((p) => p.width), [16, 14, 16]);
  assert.equal(rows[1].pieces[2].shape.kind, "box");
  assert.equal(rows[1].pieces[3].shape.kind, "bar");
  // A fit column is a short bar of exactly that width.
  assert.deepEqual(rows[1].pieces[4].shape, { kind: "bar", width: 40, height: 8 });
}

// ---- columns: the rest of the row, a fixed-width cell, a gap that stretches
{
  const [r] = skeletonRows({ rows: 1, cols: [{ grow: true }, { px: 120, bar: 44 }, { px: 30, bar: 99 }, { spacer: true }] });
  const [grow, cell, small, spacer] = r.pieces;
  assert.equal(grow.grow, true);
  assert.equal(grow.shape.kind, "bar");
  assert.equal(cell.width, 120);
  assert.equal(cell.shape.width, 44);
  // A bar never sticks out of its cell.
  assert.equal(small.shape.width, 30);
  assert.equal(spacer.grow, true);
  assert.equal(spacer.shape, null);
  // One bar across the row: the VCS widget before its first answer.
  const [fill] = skeletonRows({ rows: 1, cols: [{ fill: true }] })[0].pieces;
  assert.equal(fill.grow, true);
  assert.deepEqual(fill.shape, { kind: "bar", width: null, height: 8 });
}

// ---- the graph place: as wide as its lanes, a dot in the middle of the first
{
  const [r] = skeletonRows({ rows: 1, lead: ["graph"], graph: 1 });
  assert.equal(r.pieces[0].width, 24);
  assert.deepEqual(r.pieces[0].shape, { kind: "dot", width: 8, height: 8 });
  assert.equal(r.pieces[0].center, true);
  const [wide] = skeletonRows({ rows: 1, lead: ["graph"], graph: 3 });
  assert.equal(wide.pieces[0].width, 10 + 3 * 14);
}

// ---- sections: fixed rows first, then the last fills what is left
{
  const rows = skeletonRows([{ rows: 1, rowHeight: 28, cols: [{ fit: 40 }] }, { depth: [1], indent: [8, 16] }]);
  assert.equal(rows[0].height, 28);
  assert.equal(rows[1].height, 24);
  assert.equal(rows[1].left, 24);
  assert.ok(sum(rows) >= HEIGHT && sum(rows) <= HEIGHT + 24, `height ${sum(rows)}`);
  // Fixed rows alone draw just those.
  assert.equal(skeletonRows({ rows: 3 }).length, 3);
}

// ---- the column's measured height: just the rows it shows, plus one for the part-row
{
  // Before the column is measured: the default height.
  assert.equal(skeletonRows().length, Math.floor(HEIGHT / 24) + 1);
  // A tall column is filled to its bottom, not cut at a fixed height.
  const tall = skeletonRows({}, { height: 1800 });
  assert.ok(sum(tall) >= 1800 && sum(tall) <= 1800 + 24, `height ${sum(tall)}`);
  // A short one draws only what shows: 100px of 24px rows is 4 whole and one part.
  assert.equal(skeletonRows({}, { height: 100 }).length, 5);
  // Exactly 20 rows high still gets the extra row, as the windowed list does.
  assert.equal(skeletonRows({}, { height: 480 }).length, 21);
  // Fixed rows come first and the filling section takes what is left.
  const push = skeletonRows([{ rows: 1, rowHeight: 28 }, {}], { height: 268 });
  assert.equal(push.length, 1 + 11);
  // Fixed rows alone don't follow the height.
  assert.equal(skeletonRows({ rows: 1 }, { height: 1800 }).length, 1);
  // The count without the pieces, for deciding whether a new height needs a redraw.
  for (const h of [0, 23, 24, 100, 480, 1800]) {
    assert.equal(skeletonCount([{ rows: 1, rowHeight: 28 }, { rowHeight: 26 }], h),
      skeletonRows([{ rows: 1, rowHeight: 28 }, { rowHeight: 26 }], { height: h }).length, `height ${h}`);
  }
  assert.equal(skeletonCount({}, 100), skeletonCount({}, 110)); // a few px more: no new row
  assert.notEqual(skeletonCount({}, 100), skeletonCount({}, 130));
  // Only a filling section needs the height measured.
  assert.equal(skeletonFills({}), true);
  assert.equal(skeletonFills([{ rows: 1 }, {}]), true);
  assert.equal(skeletonFills({ rows: 1 }), false);
}

// ---- a long bar leaves room before what follows it in the row
{
  const [r] = skeletonRows({ rows: 1, cols: [{ grow: true }], trail: ["mark"] });
  assert.equal(r.pieces[0].room, ROOM);
  assert.ok(ROOM >= 16, `room ${ROOM}`);
  // The widget's one bar across its block is the whole row, nothing follows it.
  const [w] = skeletonRows({ rows: 1, cols: [{ fill: true }] });
  assert.equal(w.pieces[0].room ?? 0, 0);
}

// ---- trailing places and the row's own settings
{
  const [r] = skeletonRows({ rows: 1, gap: 5, padRight: 4, rowHeight: 26, trail: ["mark"], cols: [{ grow: true }] });
  assert.equal(r.gap, 5);
  assert.equal(r.right, 4);
  assert.equal(r.height, 26);
  assert.equal(r.pieces.at(-1).width, LEAD.mark.width);
}

// ---- a misspelled place is an error, not a silently different row
{
  assert.throws(() => skeletonRows({ lead: ["icn"] }), /icn/);
  assert.throws(() => skeletonRows({ cols: [{ wide: true }] }), /column/);
}

// ---- the size a screen keeps for its list comes from skeletonSize, and nothing else passes
{
  const size = skeletonSize("a-wait");
  assert.equal(size.id, "a-wait");
  assert.equal(size.height, undefined);
  assert.equal(checkSize(size), size);
  assert.equal(checkSize(undefined), undefined);
  assert.notEqual(skeletonSize("a-wait"), size);
  assert.throws(() => skeletonSize(""), /id/);
  assert.throws(() => skeletonSize(undefined), /id/);
  // A field main.js sets on every screen (this.wait, the copy's clock) taken for the size:
  // the error names the mistake instead of a list drawn with no id.
  assert.throws(() => checkSize((ms) => ms), /function/);
  assert.throws(() => checkSize({ id: "a-wait" }), /skeletonSize/);
  assert.throws(() => checkSize(null), /skeletonSize/);
  // A closed screen's fields are emptied (let-go.js); the size survives it as it is.
  const screen = { size, waits: { a: skeletonSize("b-wait") } };
  letGo(screen);
  assert.equal(screen.size, size);
  assert.equal(checkSize(screen.waits.a).id, "b-wait");
}

console.log("skeleton: ok");
