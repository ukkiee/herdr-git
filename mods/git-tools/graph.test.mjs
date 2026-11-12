// node graph.test.mjs: where the commit graph puts dots and lines (pure, no git).
import assert from "node:assert/strict";
import { layoutGraph, graphWindow, indexSegments, segmentsIn, fitLabels } from "./graph.js";

// Commits as git-log.js gives them, newest first: [hash, ...parents].
const commits = (...list) => list.map(([hash, ...parents]) => ({ hash, parents }));
const line = (from, to, color) => ({ from, to, color });
// `from`: the lane at the row's top edge, `to`: the lane at its bottom edge; null is the
// row's own dot. What a row draws, without the bookkeeping fields.
const drawn = (rows) => rows.map((r) => ({ lane: r.lane, color: r.color, lines: r.lines }));

// A straight line: one lane, one color, every dot joined to the next.
{
  const { rows, carry } = layoutGraph(commits(["a", "b"], ["b", "c"], ["c"]));
  assert.deepEqual(drawn(rows), [
    { lane: 0, color: 0, lines: [line(null, 0, 0)] },
    { lane: 0, color: 0, lines: [line(0, null, 0), line(null, 0, 0)] },
    { lane: 0, color: 0, lines: [line(0, null, 0)] },
  ]);
  assert.deepEqual(carry.lanes, [], "nothing is left open after the root commit");
  assert.deepEqual(rows.map((r) => r.cols), [1, 1, 1]);
}

// A branch: two tips on the same parent. The second tip gets its own lane and color,
// and both lanes run into the parent's dot.
{
  const { rows } = layoutGraph(commits(["a", "c"], ["b", "c"], ["c"]));
  assert.deepEqual(drawn(rows), [
    { lane: 0, color: 0, lines: [line(null, 0, 0)] },
    { lane: 1, color: 1, lines: [line(0, 0, 0), line(null, 1, 1)] },
    { lane: 0, color: 0, lines: [line(0, null, 0), line(1, null, 1)] },
  ]);
  assert.deepEqual(rows.map((r) => r.cols), [1, 2, 2]);
}

// A merge: the first parent stays in the merge's lane, the second opens a lane in a
// new color, which its commits keep until they reach the fork.
{
  const { rows, carry } = layoutGraph(commits(["m", "a", "b"], ["a", "c"], ["b", "c"], ["c"]));
  assert.deepEqual(drawn(rows), [
    { lane: 0, color: 0, lines: [line(null, 0, 0), line(null, 1, 1)] },
    { lane: 0, color: 0, lines: [line(0, null, 0), line(1, 1, 1), line(null, 0, 0)] },
    { lane: 1, color: 1, lines: [line(0, 0, 0), line(1, null, 1), line(null, 1, 1)] },
    { lane: 0, color: 0, lines: [line(0, null, 0), line(1, null, 1)] },
  ]);
  assert.deepEqual(carry.lanes, []);
}

// A merge whose second parent already has a lane (another branch is on its way there):
// the merge's line joins that lane instead of opening a third.
{
  const { rows } = layoutGraph(commits(["x", "p"], ["m", "a", "p"], ["a", "p"], ["p"]));
  assert.deepEqual(drawn(rows), [
    { lane: 0, color: 0, lines: [line(null, 0, 0)] },
    { lane: 1, color: 1, lines: [line(0, 0, 0), line(null, 1, 1), line(null, 0, 0)] },
    { lane: 1, color: 1, lines: [line(0, 0, 0), line(1, null, 1), line(null, 1, 1)] },
    { lane: 0, color: 0, lines: [line(0, null, 0), line(1, null, 1)] },
  ]);
}

// Several branches that cross: a lane that ends is free for the next branch, and a
// lane in use is never given to another commit.
{
  // lanes:  a(0) b(1) c(2); b ends at d, then e takes lane 1 again.
  const { rows } = layoutGraph(commits(["a", "d"], ["b", "d"], ["c", "f"], ["d", "f"], ["e", "f"], ["f"]));
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 2, 0, 1, 0]);
  assert.deepEqual(rows.map((r) => r.color), [0, 1, 2, 0, 3, 0]);
  assert.deepEqual(rows[3].lines, [line(0, null, 0), line(1, null, 1), line(2, 2, 2), line(null, 0, 0)]);
  assert.deepEqual(rows[5].lines, [line(0, null, 0), line(1, null, 3), line(2, null, 2)]);
  assert.deepEqual(rows.map((r) => r.cols), [1, 2, 3, 3, 3, 3]);
}

// A parent outside the batch: its lane stays open in `carry`, and the next batch goes on
// in the same lane and color.
{
  const first = layoutGraph(commits(["a", "c"], ["b", "x"]));
  assert.deepEqual(first.carry.lanes, [{ hash: "c", color: 0 }, { hash: "x", color: 1 }]);
  assert.deepEqual(first.rows[1].lines, [line(0, 0, 0), line(null, 1, 1)]);
  const second = layoutGraph(commits(["x"], ["c"]), first.carry);
  assert.deepEqual(drawn(second.rows), [
    { lane: 1, color: 1, lines: [line(0, 0, 0), line(1, null, 1)] },
    { lane: 0, color: 0, lines: [line(0, null, 0)] },
  ]);
  // The carry handed in is not changed: reading the same batch again gives the same rows.
  assert.deepEqual(first.carry.lanes, [{ hash: "c", color: 0 }, { hash: "x", color: 1 }]);
  assert.deepEqual(layoutGraph(commits(["x"], ["c"]), first.carry).rows, second.rows);
}

// A bigger history with long-lived branches, merges both ways and an octopus merge.
// History is written oldest first here and reversed, as git lists it.
const history = [];
{
  let n = 0;
  const add = (...parents) => { const hash = `h${n++}`; history.push({ hash, parents }); return hash; };
  let main = add(), dev = main, fix = null;
  for (let i = 0; i < 60; i++) {
    if (i % 3 === 0) main = add(main);
    if (i % 2 === 0) dev = add(dev);
    if (i % 7 === 3) fix = add(main);
    if (i % 7 === 5 && fix) { fix = add(fix); main = add(main, fix); fix = null; }
    if (i % 10 === 9) dev = add(dev, main);
    if (i % 20 === 19) main = add(main, dev);
    if (i === 30) { const x = add(main), y = add(dev); main = add(main, x, y); }
  }
  add(main); add(dev);
  history.reverse();
}

// Lanes don't break or overlap: every line leaving a row's bottom edge is picked up at
// the next row's top edge in the same lane and color, each lane at an edge carries one
// commit's line only, and a dot sits on the lane its lines come from.
{
  const { rows, carry } = layoutGraph(history);
  assert.equal(rows.length, history.length);
  const index = new Map(history.map((c, i) => [c.hash, i]));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tops = new Map();
    for (const l of row.lines) {
      if (l.from === null) continue;
      assert.ok(!tops.has(l.from), `row ${i}: one line per lane at the top edge`);
      tops.set(l.from, l.color);
    }
    const bottoms = new Map();
    for (const l of row.lines) {
      if (l.to === null) continue;
      if (bottoms.has(l.to)) assert.equal(bottoms.get(l.to), l.color, `row ${i}: lines that share a lane share its color`);
      bottoms.set(l.to, l.color);
    }
    const next = i + 1 < rows.length ? new Map(rows[i + 1].lines.filter((l) => l.from !== null).map((l) => [l.from, l.color])) : new Map(carry.lanes.flatMap((lane, at) => (lane ? [[at, lane.color]] : [])));
    assert.deepEqual([...bottoms].sort(), [...next].sort(), `row ${i}: the bottom edge matches the next row's top edge`);
    // Lines into the dot arrive in the dot's lane or bend into it; one of them (if any) is the lane itself.
    const into = row.lines.filter((l) => l.from !== null && l.to === null);
    if (into.length) assert.ok(into.some((l) => l.from === row.lane && l.color === row.color), `row ${i}: the dot is on a lane that reaches it`);
    // One line out per parent (parents in this history are all different).
    assert.equal(row.lines.filter((l) => l.from === null).length, history[i].parents.length, `row ${i}: a line to each parent`);
    assert.ok(row.cols > Math.max(row.lane, ...row.lines.map((l) => Math.max(l.from ?? 0, l.to ?? 0))), `row ${i}: cols covers every lane drawn`);
  }
  // Every child's line really ends at its parent: follow the first parent's lane down.
  for (let i = 0; i < rows.length; i++) {
    const parent = history[i].parents[0];
    if (!parent) continue;
    let lane = rows[i].lines.find((l) => l.from === null).to;
    for (let j = i + 1; j < index.get(parent); j++) {
      const through = rows[j].lines.find((l) => l.from === lane);
      assert.ok(through && through.to === lane, `row ${j}: the lane from row ${i} passes straight through`);
    }
    assert.ok(rows[index.get(parent)].lines.some((l) => l.from === lane && l.to === null), `row ${i}: its lane ends in its parent's dot`);
  }
  // Colors: a first parent keeps its child's lane color when it is the lane the dot takes.
  assert.ok(new Set(rows.map((r) => r.color)).size > 3, "branches get colors of their own");
}

// Laid out in batches of any size, the rows are the rows of the whole.
{
  const whole = layoutGraph(history);
  for (const size of [1, 7, 50, history.length]) {
    const rows = [];
    let carry = null;
    for (let at = 0; at < history.length; at += size) {
      const part = layoutGraph(history.slice(at, at + size), carry);
      rows.push(...part.rows);
      carry = part.carry;
    }
    assert.deepEqual(rows, whole.rows, `batches of ${size}`);
    assert.deepEqual(carry, whole.carry);
  }
}

// Nothing to lay out.
assert.deepEqual(layoutGraph([]), { rows: [], carry: { lanes: [], next: 0 } });

// 25 branches open at once: every lane gets a column of its own, none is folded away.
{
  const tips = Array.from({ length: 25 }, (_, i) => [`t${i}`, "base"]);
  const { rows } = layoutGraph(commits(...tips, ["base"]));
  assert.deepEqual(rows.map((r) => r.lane).slice(0, 25), Array.from({ length: 25 }, (_, i) => i));
  assert.equal(rows[24].cols, 25);
  assert.equal(rows[25].lines.length, 25, "all 25 lanes run into the shared parent");
}

// The graph part's window: as wide as the widest row needs, never more than half the
// Commit list; what is left over scrolls, and the position stays inside it.
{
  // 30 lanes of 14px from 5px in = 430px; a 600px list gives the graph at most 300px.
  assert.deepEqual(graphWindow({ widest: 430, listWidth: 600, left: 0 }), { room: 300, left: 0, max: 130 });
  assert.deepEqual(graphWindow({ widest: 430, listWidth: 600, left: 500 }), { room: 300, left: 130, max: 130 });
  assert.deepEqual(graphWindow({ widest: 430, listWidth: 600, left: -20 }), { room: 300, left: 0, max: 130 });
  // Fits: nothing scrolls, and a position left from a wider list goes back to 0.
  assert.deepEqual(graphWindow({ widest: 80, listWidth: 600, left: 40 }), { room: 80, left: 0, max: 0 });
  // An odd width: whole pixels.
  assert.deepEqual(graphWindow({ widest: 430, listWidth: 601, left: 0 }), { room: 300, left: 0, max: 130 });
}

// A row's lines in a sideways window: only the ones that cross it, whichever way round
// their ends are, and a long merge line whose both ends are outside it.
{
  const seg = (name, x1, x2) => ({ name, x1, y1: 0, x2, y2: 24 });
  const lines = [
    seg("far right", 410, 410), seg("pass 0", 12, 12), seg("into window", 90, 104),
    seg("back out", 320, 290), seg("across", 12, 400), seg("left edge", 100, 100),
    seg("right edge", 300, 300), seg("just left", 99, 99), seg("just right", 301, 301),
  ];
  const index = indexSegments(lines);
  const names = (from, to) => segmentsIn(index, from, to).map((s) => s.name).sort();
  assert.deepEqual(names(100, 300), ["across", "back out", "into window", "left edge", "right edge"].sort());
  assert.deepEqual(names(0, 50), ["across", "pass 0"].sort());
  assert.deepEqual(names(500, 600), []);
  assert.deepEqual(indexSegments([]).list, []);
}

// Ref labels in the room a row leaves them: whole labels only, the rest counted as +N.
// A first label too long on its own loses its middle instead of being cut at an edge.
{
  // 6px a character, 12px of padding and border a label, 4px between: the widths below
  // are 144 ("origin & elsewhere/new"), 36 ("main"), 24 ("v1"); "+1" takes 4 + 12.
  const look = { char: 6, pad: 12, gap: 4, most: 3 };
  const labels = [{ text: "origin & elsewhere/new", kind: "local" }, { text: "main", kind: "local" }, { text: "v1", kind: "tag" }];
  const texts = (r) => ({ shown: r.shown.map((l) => l.text), rest: r.rest });
  assert.deepEqual(texts(fitLabels(labels, 400, look)), { shown: ["origin & elsewhere/new", "main", "v1"], rest: 0 });
  // 212 for all three; 184 for two plus 16 for "+1" is exactly 200.
  assert.deepEqual(texts(fitLabels(labels, 211, look)), { shown: ["origin & elsewhere/new", "main"], rest: 1 });
  assert.deepEqual(texts(fitLabels(labels, 200, look)), { shown: ["origin & elsewhere/new", "main"], rest: 1 });
  // 150: the first with "+2" needs 160. Its text gets 150 - 16 - 12 = 122px: 20 characters,
  // 10 from the front, the ellipsis, 9 from the end.
  assert.deepEqual(texts(fitLabels(labels, 150, look)), { shown: ["origin & e…where/new"], rest: 2 });
  assert.equal(fitLabels(labels, 150, look).shown[0].kind, "local", "a shortened label keeps its kind");
  // No room for even a short label: only the count.
  assert.deepEqual(texts(fitLabels(labels, 30, look)), { shown: [], rest: 3 });
  // At most `most` labels, whatever the room.
  const many = ["a", "b", "c", "d", "e"].map((text) => ({ text, kind: "local" }));
  assert.deepEqual(texts(fitLabels(many, 1000, look)), { shown: ["a", "b", "c"], rest: 2 });
  assert.deepEqual(fitLabels([], 100, look), { shown: [], rest: 0 });
}

console.log("ok");
