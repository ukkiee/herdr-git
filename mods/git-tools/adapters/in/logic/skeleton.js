// Where a skeleton list's rows and pieces go: the faint bars a screen draws in place of
// what it is still reading (ui.js skeleton draws them). Only the places that wait for
// data get one; toolbars, search boxes, filters, column frames and buttons are drawn for
// real from the start, and a split screen waits in each column separately.
//
// A screen describes its rows with the numbers its real rows use, so nothing shifts when
// the data lands. No description is the plain shape: a name bar per 24px row.
//
// skeletonRows(specs, { height }) → [{ height, left, right, gap, pieces }]
//   specs: one description or a list of them, drawn one after another. A description
//   with `rows` draws that many rows; one without fills what is left of `height`, the
//   column's measured height (HEIGHT until it is measured), with one row more for the
//   part-row at the bottom, as the windowed list does. The column cuts what sticks out.
//   A description, every field optional:
//     rowHeight   px, as the real rows (24)
//     indent      [first, perDepth]: a row's left padding is first + depth × perDepth
//     depth       the rows' depths, repeated for as many rows as are drawn
//     rows        how many rows, or none to fill
//     lead        fixed places before the text, by name (LEAD)
//     cols        the text columns: { name } a name bar, { grow } a bar in the rest of
//                 the row (ending ROOM px short of it), { px, bar } a fixed-width cell
//                 holding a bar, { fit } a bar of that width, { fill } one bar across
//                 the rest of the row, { spacer } empty stretch
//     trail       fixed places after the text, by name (LEAD)
//     at          { [depth]: fields } other lead, cols or trail for rows at that depth
//     gap, padRight, graph   the row's gap, its right padding, the graph's lanes
//   A piece: { width (null when it stretches), grow, shrink, center, room, shape }, shape
//   { kind: "bar" | "box" | "dot", width (null: the piece's whole width), height } or
//   null for an empty place. room: px kept empty at the piece's end.
// skeletonCount(specs, height) → how many rows skeletonRows draws for that height: a new
//   height redraws the list only when this changes.
// skeletonFills(specs) → whether any section fills, so the column's height is needed.
// skeletonSize(id) → what a screen keeps for one skeleton list, where the list remembers
//   its column's measured height under the element id `id`. One per list: two lists
//   sharing one would measure each other's column.
// checkSize(size) → size when it came from skeletonSize (or is left out), else an error.
//   ui.js skeleton checks what it is given, so a screen field main.js already set (this.wait,
//   the copy's clock) passed by mistake fails naming it, not as a list with no id.

// A class, not a plain object: let-go.js keeps objects of a class as they are, so a closed
// screen's last draw still finds its size.
class SkeletonSize {
  constructor(id) { this.id = id; this.height = undefined; }
}

export function skeletonSize(id) {
  if (typeof id !== "string" || !id) throw new TypeError(`skeletonSize: the id must be a non-empty string, got ${JSON.stringify(id)}`);
  return new SkeletonSize(id);
}

export function checkSize(size) {
  if (size === undefined || size instanceof SkeletonSize) return size;
  const got = typeof size === "function" ? "a function (a field main.js sets on every screen, such as this.wait?)"
    : size === null ? "null" : typeof size === "object" ? JSON.stringify(size) : String(size);
  throw new TypeError(`skeleton: size must come from skeletonSize(id), got ${got}`);
}

// The height filled before the column is measured: about a panel's list, so the first
// frame rarely shows an empty bottom and doesn't build rows no column shows.
export const HEIGHT = 720;
// The empty end of a long bar, so it doesn't run into the count or arrow after it.
export const ROOM = 24;
const BAR = 8; // a text bar's height
const LANE = 14, LANE_PAD = 5; // as the Commit list's graph (log-list.js)

// The fixed places: the width a real row gives them and what stands in for them.
export const LEAD = {
  slot: { width: 16, shape: null }, // a fold arrow's place
  check: { width: 14, shape: { kind: "box", width: 14, height: 14 } },
  icon: { width: 16, shape: { kind: "box", width: 14, height: 14 } }, // a UI icon (ui.js ICON)
  file: { width: 14, shape: { kind: "box", width: 14, height: 14 } }, // an Icon theme file or folder icon
  mark: { width: 16, shape: { kind: "box", width: 10, height: 10 } }, // a small trailing glyph (›)
  dot: { width: 7, shape: { kind: "dot", width: 7, height: 7 } },
};

// Name bars and the longer bars that fill a row's rest, each row taking the next.
const NAMES = [96, 64, 120, 80, 140, 56, 108, 72, 128, 88];
const LONG = [340, 260, 400, 300, 220, 380, 280, 360, 240, 320];

const DEFAULTS = {
  rowHeight: 24, indent: [12, 0], depth: [0], rows: null,
  lead: [], cols: [{ name: true }], trail: [], at: {}, gap: 6, padRight: 8, graph: 1,
};

const bar = (width) => ({ kind: "bar", width, height: BAR });

function place(name, s) {
  if (name === "graph") return { width: LANE_PAD * 2 + s.graph * LANE, grow: false, shrink: false, center: true, shape: { kind: "dot", width: 8, height: 8 } };
  const p = LEAD[name];
  if (!p) throw new Error(`skeleton: no place named "${name}"`);
  return { width: p.width, grow: false, shrink: false, center: true, shape: p.shape };
}

function column(c, i) {
  const fixed = { grow: false, shrink: false, center: false };
  if (c.name) return { ...fixed, shrink: true, width: NAMES[i % NAMES.length], shape: bar(NAMES[i % NAMES.length]) };
  if (c.grow) return { ...fixed, grow: true, shrink: true, width: null, room: ROOM, shape: bar(LONG[i % LONG.length]) };
  if (c.px) return { ...fixed, width: c.px, shape: bar(Math.min(c.px, c.bar ?? Math.round(c.px / 2))) };
  if (c.fit) return { ...fixed, shrink: true, width: c.fit, shape: bar(c.fit) };
  if (c.fill) return { ...fixed, grow: true, shrink: true, width: null, shape: bar(null) };
  if (c.spacer) return { ...fixed, grow: true, shrink: true, width: null, shape: null };
  throw new Error(`skeleton: no column like ${JSON.stringify(c)}`);
}

const sections = (specs) => (Array.isArray(specs) ? specs : [specs]).map((spec) => ({ ...DEFAULTS, ...spec }));

// A filling section's rows: whole rows in what is left, and one more for the part-row.
const fillRows = (left, rowHeight) => (left > 0 ? Math.floor(left / rowHeight) + 1 : 0);

export function skeletonCount(specs = [{}], height = HEIGHT) {
  let used = 0, n = 0;
  for (const s of sections(specs)) {
    const count = s.rows ?? fillRows(height - used, s.rowHeight);
    used += count * s.rowHeight;
    n += count;
  }
  return n;
}

export const skeletonFills = (specs = [{}]) => sections(specs).some((s) => s.rows === null);

export function skeletonRows(specs = [{}], { height = HEIGHT } = {}) {
  const out = [];
  let used = 0, n = 0;
  for (const s of sections(specs)) {
    const count = s.rows ?? fillRows(height - used, s.rowHeight);
    for (let k = 0; k < count; k++, n++) {
      const depth = s.depth[k % s.depth.length];
      const o = { ...s, ...s.at[depth] };
      out.push({
        height: s.rowHeight, left: s.indent[0] + depth * s.indent[1], right: s.padRight, gap: s.gap,
        pieces: [...o.lead.map((p) => place(p, s)), ...o.cols.map((c) => column(c, n)), ...o.trail.map((p) => place(p, s))],
      });
      used += s.rowHeight;
    }
  }
  return out;
}
