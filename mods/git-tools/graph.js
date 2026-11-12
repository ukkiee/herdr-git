// Where each commit's dot and lines go in the commit graph, and how much of a Commit
// list row the graph and the Ref labels get. Pure: no git, no herdr (graph.test.mjs).

import { shortenMiddle } from "./git-log.js";

// layoutGraph(commits, carry) → { rows, carry }
//   commits: one batch from git-log.js, newest first, children before their parents.
//   carry: the lane state the previous batch returned (null for the first), so lanes run
//   on across batches. It is not changed.
//   rows[i] belongs to commits[i]: { lane, color, cols, lines }
//     lane: the column of the commit's dot (0 is leftmost). color: a color number, to be
//     taken modulo the palette; a lane keeps its color from row to row.
//     cols: how many columns this row uses.
//     lines: [{ from, to, color }]: what the row draws, top edge to bottom edge.
//       from: a lane at the row's top edge, or null: the line starts at the dot.
//       to: a lane at the row's bottom edge, or null: the line ends at the dot.
//       So { from: 2, to: 2 } passes through, { from: 1, to: null } runs into the dot
//       and { from: null, to: 0 } leaves it for a parent.
//
// A lane waits for one commit: the next dot on it. A lane never moves sideways and is
// reused only once its commit is drawn, so lines can't overlap. A commit's first parent
// stays in the commit's lane; every lane waiting for a commit bends into its dot.
export function layoutGraph(commits, carry = null) {
  const lanes = carry ? carry.lanes.map((lane) => (lane ? { ...lane } : null)) : [];
  let next = carry ? carry.next : 0;
  const free = () => { const at = lanes.indexOf(null); return at < 0 ? lanes.length : at; };
  const rows = [];
  for (const commit of commits) {
    const waiting = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i]?.hash === commit.hash) waiting.push(i);
    const lane = waiting.length ? waiting[0] : free();
    const color = waiting.length ? lanes[lane].color : next++;
    const lines = [];
    let cols = Math.max(lanes.length, lane + 1);
    for (let i = 0; i < lanes.length; i++) {
      if (!lanes[i]) continue;
      if (lanes[i].hash === commit.hash) { lines.push({ from: i, to: null, color: lanes[i].color }); lanes[i] = null; }
      else lines.push({ from: i, to: i, color: lanes[i].color });
    }
    const seen = new Set();
    for (const parent of commit.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      let to;
      if (seen.size === 1) { to = lane; lanes[lane] = { hash: parent, color }; }
      else {
        // A merged branch that already has a lane is joined there, else it opens one.
        to = lanes.findIndex((l) => l?.hash === parent);
        if (to < 0) { to = free(); lanes[to] = { hash: parent, color: next++ }; }
      }
      lines.push({ from: null, to, color: lanes[to].color });
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    cols = Math.max(cols, lanes.length);
    rows.push({ lane, color, cols, lines });
  }
  return { rows, carry: { lanes, next } };
}

// ---- the Commit list's row on screen (px, still pure)

// fitLabels(labels, room, { char, pad, gap, most }) → { shown, rest }
//   The Ref labels (labelRefs) a row has `room` px for: whole labels from the first, at
//   most `most`, and `rest` left out (drawn as "+N"). There is no text measuring in a
//   mod, so a label is `pad` + `char` per character: `char` must not be less than the
//   font's real average, or the last label overflows. A first label too long on its own
//   loses its middle (shortenMiddle) rather than being cut at an edge.
const MIN_TEXT = 4;
export function fitLabels(labels, room, { char, pad, gap, most }) {
  const width = (text) => pad + text.length * char;
  const count = (n) => (n > 0 ? gap + `+${n}`.length * char : 0);
  const shown = [];
  let used = 0;
  for (const label of labels.slice(0, most)) {
    const next = used + (shown.length ? gap : 0) + width(label.text);
    if (next + count(labels.length - shown.length - 1) > room) break;
    shown.push(label);
    used = next;
  }
  if (!shown.length && labels.length) {
    const fit = Math.floor((room - count(labels.length - 1) - pad) / char);
    if (fit >= MIN_TEXT) shown.push({ ...labels[0], text: shortenMiddle(labels[0].text, fit) });
  }
  return { shown, rest: labels.length - shown.length };
}

// ---- the graph part on screen

// graphWindow({ widest, listWidth, left }) → { room, left, max }
//   widest: px the widest row's graph needs. listWidth: px the Commit list has.
//   room: px the graph part gets, at most half the list. max: how far it scrolls
//   sideways (0 when everything fits). left: the asked position, kept inside 0..max.
export function graphWindow({ widest, listWidth, left }) {
  const room = Math.max(0, Math.min(widest, Math.floor(listWidth / 2)));
  const max = Math.max(0, widest - room);
  return { room, left: Math.max(0, Math.min(left, max)), max };
}

// indexSegments(segments) → { list, reach }
//   A row's lines ({ x1, x2, … }) sorted by their left end, with the widest line's span.
//   Made once per row when the commits arrive, so segmentsIn hands over only what is in
//   view: a row with hundreds of lanes costs what its visible part costs.
export function indexSegments(segments) {
  const list = segments.map((s) => ({ s, lo: Math.min(s.x1, s.x2), hi: Math.max(s.x1, s.x2) })).sort((a, b) => a.lo - b.lo);
  let reach = 0;
  for (const e of list) reach = Math.max(reach, e.hi - e.lo);
  return { list, reach };
}

// segmentsIn(index, from, to) → the lines that touch the px range from..to.
// A line starting more than `reach` left of `from` can't get there; the scan stops at the
// first line starting right of `to`.
export function segmentsIn({ list, reach }, from, to) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].lo < from - reach) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < list.length && list[i].lo <= to; i++) if (list[i].hi >= from) out.push(list[i].s);
  return out;
}
