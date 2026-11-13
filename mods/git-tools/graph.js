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
//
// The graph options (log-options.js):
//   firstParent: a commit's line goes to its first parent only.
//   through: [[hash, hash it leads to]] for commits left out of the list (git-log.js
//   readLog's merges under noMerges): a line to one goes on to where it leads, also a
//   lane carried from the batch before.
// A commit from collapseLinear may have folded: { parent: count }: its lines to those
// parents pass over commits folded away and are marked folded: true, as far as the dot.
export function layoutGraph(commits, carry = null, { firstParent = false, through = [] } = {}) {
  const lead = leadsTo(through);
  const lanes = carry ? carry.lanes.map((lane) => (lane ? { ...lane, hash: lead(lane.hash) } : null)) : [];
  let next = carry ? carry.next : 0;
  const free = () => { const at = lanes.indexOf(null); return at < 0 ? lanes.length : at; };
  const mark = (line, lane) => (lane.folded ? { ...line, folded: true } : line);
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
      if (lanes[i].hash === commit.hash) { lines.push(mark({ from: i, to: null, color: lanes[i].color }, lanes[i])); lanes[i] = null; }
      else lines.push(mark({ from: i, to: i, color: lanes[i].color }, lanes[i]));
    }
    const seen = new Set();
    for (const parent of graphParents(commit, firstParent, lead)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const folded = Boolean(commit.folded?.[parent]);
      let to;
      if (seen.size === 1) { to = lane; lanes[lane] = laneFor(parent, color, folded); }
      else {
        // A merged branch that already has a lane is joined there, else it opens one.
        to = lanes.findIndex((l) => l?.hash === parent);
        if (to < 0) { to = free(); lanes[to] = laneFor(parent, next++, folded); }
      }
      lines.push(mark({ from: null, to, color: lanes[to].color }, { folded }));
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    cols = Math.max(cols, lanes.length);
    rows.push({ lane, color, cols, lines });
  }
  return { rows, carry: { lanes, next } };
}

// A lane's state: folded only when its line passes over folded commits.
const laneFor = (hash, color, folded) => (folded ? { hash, color, folded: true } : { hash, color });

// leadsTo(through) → hash → the commit a line to `hash` ends on: followed on while it is
// one left out (a chain of merges left out ends on a commit that is listed).
function leadsTo(through) {
  if (!through?.length) return (hash) => hash;
  const map = new Map(through);
  return (hash) => {
    let at = hash;
    for (let i = 0; i <= map.size && map.has(at); i++) at = map.get(at);
    return at;
  };
}

// The parents a commit's lines go to: the first only with firstParent, each led on past
// commits left out.
function graphParents(commit, firstParent, lead) {
  const parents = firstParent ? commit.parents.slice(0, 1) : commit.parents;
  return parents.map(lead);
}

// collapseLinear(commits, { firstParent, through }) → the commits the graph shows with
// linear branches folded: a commit with one parent, one child among `commits` and no Ref
// label is left out. Each commit kept gets parents: where its lines lead now, and
// folded: { parent: how many commits its line to that parent passes over } when any.
// Branch tips, forks, merges, labelled commits and roots stay. New objects: the commits
// handed in are not changed. The graph options apply as in layoutGraph (whose
// firstParent and through the answer has already taken in).
export function collapseLinear(commits, { firstParent = false, through = [] } = {}) {
  const lead = leadsTo(through);
  const parentsOf = new Map(), children = new Map();
  for (const c of commits) {
    const parents = [...new Set(graphParents(c, firstParent, lead))];
    parentsOf.set(c.hash, parents);
    for (const p of parents) children.set(p, (children.get(p) ?? 0) + 1);
  }
  const folds = (c) => parentsOf.get(c.hash).length === 1 && children.get(c.hash) === 1 && !(c.refs?.length);
  const hidden = new Set(commits.filter(folds).map((c) => c.hash));
  const out = [];
  for (const c of commits) {
    if (hidden.has(c.hash)) continue;
    const parents = [], folded = {};
    for (const first of parentsOf.get(c.hash)) {
      let at = first, n = 0;
      while (hidden.has(at)) { at = parentsOf.get(at)[0]; n++; }
      if (parents.includes(at)) continue;
      parents.push(at);
      if (n) folded[at] = n;
    }
    out.push(Object.keys(folded).length ? { ...c, parents, folded } : { ...c, parents });
  }
  return out;
}

// reachableFrom(commits, start, { firstParent, through }) → Set of the hashes `start`
// reaches among `commits` (itself included) by the lines the graph draws: the current
// branch's commits when `start` is HEAD's. Empty without a start.
export function reachableFrom(commits, start, { firstParent = false, through = [] } = {}) {
  const lead = leadsTo(through), out = new Set();
  if (!start) return out;
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const todo = [start];
  while (todo.length) {
    const hash = todo.pop();
    if (out.has(hash) || !byHash.has(hash)) continue;
    out.add(hash);
    for (const p of graphParents(byHash.get(hash), firstParent, lead)) todo.push(p);
  }
  return out;
}

// longEdges(rows, { long, part }) → Map(row number → { hide: [line index], arrows: [{ lane, dir }] })
//   With long edges off, a line that runs `long` rows or more from its dot to its
//   parent's shows `part` rows at each end; the rows between leave its line out (hide)
//   and an arrow marks each cut: "down" on the last row of the top part, "up" on the
//   first row of the bottom part. A line still open at the end of `rows` (its parent not
//   read yet) is cut after its top part once it is that long already. rows: every row
//   read so far, from layoutGraph; only rows with something to change are in the map.
export function longEdges(rows, { long = 30, part = 1 } = {}) {
  const out = new Map();
  const at = (r) => { let e = out.get(r); if (!e) { e = { hide: [], arrows: [] }; out.set(r, e); } return e; };
  const open = []; // lane → { start, passes: [[row, index]] }
  const cut = (lane, edge, end) => {
    const last = end ?? rows.length - 1;
    if (last - edge.start < long) return;
    at(edge.start + part).arrows.push({ lane, dir: "down" });
    if (end !== null) at(end - part).arrows.push({ lane, dir: "up" });
    for (const [r, index] of edge.passes) if (r > edge.start + part && (end === null || r < end - part)) at(r).hide.push(index);
  };
  rows.forEach((row, r) => {
    row.lines.forEach((l, index) => {
      if (l.from !== null && l.to === null) { if (open[l.from]) cut(l.from, open[l.from], r); open[l.from] = null; }
      else if (l.from !== null && l.to === l.from) open[l.from]?.passes.push([r, index]);
      else if (l.from === null && l.to !== null && !open[l.to]) open[l.to] = { start: r, passes: [] };
    });
  });
  open.forEach((edge, lane) => { if (edge) cut(lane, edge, null); });
  for (const e of out.values()) e.hide.sort((a, b) => a - b);
  return out;
}

// ---- the Commit list's row on screen (px, still pure)

// fitLabels(labels, room, { char, pad, gap, most }) → { shown, rest }
//   The Ref labels (labelRefs) a row has `room` px for: whole labels from the first, at
//   most `most`, and `rest` left out (drawn as "+N"). There is no text measuring in a
//   mod, so a label is `pad` + `char` per character: `char` must not be less than the
//   font's real average, or the last label overflows. A first label too long on its own
//   loses its middle (shortenMiddle) rather than being cut at an edge.
const MIN_TEXT = 4;
//   A tag mark without a name (labelRefs' `names`) takes two characters' room.
export function fitLabels(labels, room, { char, pad, gap, most }) {
  const width = (label) => pad + (label.names ? 2 : label.text.length) * char;
  const count = (n) => (n > 0 ? gap + `+${n}`.length * char : 0);
  const shown = [];
  let used = 0;
  for (const label of labels.slice(0, most)) {
    const next = used + (shown.length ? gap : 0) + width(label);
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
