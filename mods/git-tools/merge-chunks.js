// Merge chunks: three texts of one conflicted file (base, ours, theirs) cut into chunks,
// each chunk's decision per side, and the result text those decisions make. Pure: no
// "herdr", so node tests it as is.
//
// A line keeps its own line end ("a\r\n", "a\n", or "a" for a last line without one), so
// a result made of whole lines has the line ends and the missing last newline of the
// lines it took. Two lines that differ only in their end are different lines.
//
// The result starts as the base. A state is never changed: every function returns a new one.

// The cap on a diff's edit distance. A diff costs memory by its square, so two texts that
// differ in more lines than this are compared as one changed block.
const MAX_EDITS = 2000;

// splitLines(text) → [line], each with its line end.
function splitLines(text) {
  return String(text ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// The first line end in the texts, "\n" when none has one: what a line that lost its end
// at the end of a file gets back when another line is put after it.
function lineEnd(...texts) {
  for (const text of texts) {
    const m = /\r?\n/.exec(String(text ?? ""));
    if (m) return m[0];
  }
  return "\n";
}

// diff(a, b) → Int32Array: for each line of a, the index of the same line in b, or -1.
// Myers' diff on interned lines, after the common start and end are taken off.
function diff(a, b) {
  const ids = new Map(), id = (line) => { let v = ids.get(line); if (v === undefined) { v = ids.size; ids.set(line, v); } return v; };
  const x = a.map(id), y = b.map(id);
  const n = x.length, m = y.length, match = new Int32Array(n).fill(-1);
  let pre = 0;
  while (pre < n && pre < m && x[pre] === y[pre]) { match[pre] = pre; pre++; }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && x[n - 1 - suf] === y[m - 1 - suf]) { match[n - 1 - suf] = m - 1 - suf; suf++; }
  const A = x.slice(pre, n - suf), B = y.slice(pre, m - suf), N = A.length, M = B.length;
  if (!N || !M) return match;
  const max = N + M, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let j = i - k;
      while (i < N && j < M && A[i] === B[j]) { i++; j++; }
      v[off + k] = i;
      if (i >= N && j >= M) {
        // Walk back from the end through each step's snapshot, marking the diagonals.
        let px = N, py = M;
        for (let e = d; e > 0; e--) {
          const s = trace[e], at = (kk) => s[kk + e], kk = px - py;
          const prev = kk === -e || (kk !== e && at(kk - 1) < at(kk + 1)) ? kk + 1 : kk - 1;
          const sx = at(prev), sy = sx - prev;
          while (px > sx && py > sy) { px--; py--; match[pre + px] = pre + py; }
          px = sx; py = sy;
        }
        while (px > 0 && py > 0) { px--; py--; match[pre + px] = pre + py; }
        return match;
      }
    }
  }
  return match;
}

// hunks(base, side) → [{ s, e, lines }]: base lines [s, e) are replaced by `lines`.
function hunks(base, side) {
  const match = diff(base, side), out = [];
  let i = 0, j = 0;
  while (i < base.length || j < side.length) {
    if (i < base.length && match[i] === j) { i++; j++; continue; }
    const s = i, from = j;
    while (i < base.length && match[i] < 0) i++;
    const to = i < base.length ? match[i] : side.length;
    out.push({ s, e: i, lines: side.slice(from, to) });
    j = to;
  }
  return out;
}

const same = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

// A conflict is simple when the two sides change different lines of it: then it merges
// line by line. Two changes overlap when their base lines overlap, or when both add lines
// at the same place (which comes first is a choice). → merged lines, or null.
function simpleMerge(base, ours, theirs) {
  const mine = hunks(base, ours), other = hunks(base, theirs);
  for (const a of mine) for (const b of other) {
    if ((a.s < b.e && b.s < a.e) || (a.s === a.e && b.s === b.e && a.s === b.s)) return null;
  }
  const all = [...mine, ...other].sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  let i = 0;
  for (const h of all) { out.push(...base.slice(i, h.s), ...h.lines); i = h.e; }
  out.push(...base.slice(i));
  return out;
}

// merge(base, ours, theirs) → state { eol, chunks }. A chunk:
//   kind: "same" (no side changed it), "ours" or "theirs" (that side only), "both" (both
//     the same way), "conflict" (both, differently), "edit" (lines written by hand over
//     several chunks, see edit)
//   base, ours, theirs: its lines in each text; baseStart, oursStart, theirsStart: the
//     line number (from 0) of its first line in each text
//   simple: a conflict that merges line by line; merged: those lines
//   sides: { ours, theirs }, each null, "accepted" or "ignored"
//   content: its lines in the result; edited: changed by hand
export function merge(baseText, oursText, theirsText) {
  const base = splitLines(baseText), ours = splitLines(oursText), theirs = splitLines(theirsText);
  const mo = diff(base, ours), mt = diff(base, theirs), chunks = [];
  const push = (kind, b, o, t, at) => {
    const last = chunks[chunks.length - 1];
    if (kind === "same" && last?.kind === "same") { last.base.push(...b); last.ours.push(...o); last.theirs.push(...t); last.content.push(...b); return; }
    const chunk = { kind, base: b, ours: o, theirs: t, baseStart: at[0], oursStart: at[1], theirsStart: at[2], sides: { ours: null, theirs: null }, content: [...b] };
    if (kind === "conflict") {
      const merged = simpleMerge(b, o, t);
      chunk.simple = !!merged;
      if (merged) chunk.merged = merged;
    }
    chunks.push(chunk);
  };
  let i = 0, j = 0, k = 0;
  while (i < base.length || j < ours.length || k < theirs.length) {
    let d = 0;
    while (i + d < base.length && mo[i + d] === j + d && mt[i + d] === k + d) d++;
    if (d) {
      push("same", base.slice(i, i + d), ours.slice(j, j + d), theirs.slice(k, k + d), [i, j, k]);
      i += d; j += d; k += d;
      continue;
    }
    let o = i;
    while (o < base.length && (mo[o] < 0 || mt[o] < 0)) o++;
    const oe = o < base.length ? mo[o] : ours.length, te = o < base.length ? mt[o] : theirs.length;
    const b = base.slice(i, o), x = ours.slice(j, oe), y = theirs.slice(k, te);
    const changedOurs = !same(b, x), changedTheirs = !same(b, y);
    const kind = !changedOurs && !changedTheirs ? "same" : !changedTheirs ? "ours" : !changedOurs ? "theirs" : same(x, y) ? "both" : "conflict";
    push(kind, b, x, y, [i, j, k]);
    i = o; j = oe; k = te;
  }
  return { eol: lineEnd(oursText, theirsText, baseText), chunks };
}

// Whether a chunk still waits for a decision.
function open(chunk) {
  if (chunk.kind === "same" || chunk.kind === "edit" || chunk.edited) return false;
  const { ours, theirs } = chunk.sides;
  if (chunk.kind === "conflict") return !ours || !theirs;
  return !ours && !theirs;
}

// Lines a and then b, with a line end given to a's last line when it had none.
function join(a, b, eol) {
  if (!a.length || !b.length || a[a.length - 1].endsWith("\n")) return [...a, ...b];
  return [...a.slice(0, -1), a[a.length - 1] + eol, ...b];
}

const replace = (state, index, chunk) => ({ ...state, chunks: state.chunks.map((c, i) => (i === index ? chunk : c)) });

// decide(state, index, side, action) → state. side: "ours" | "theirs". action:
//   "accept": the chunk's result becomes that side's lines
//   "ignore": that side is left out, the result stays as it is
//   "add": that side's lines go after the result (accept when no side is in it yet)
// A chunk with a change on one side or the same change on both is done with one decision
// on a changed side. A conflict is done when both sides are decided. A side already
// decided, a side that changed nothing, or an unknown chunk or action changes nothing.
export function decide(state, index, side, action) {
  const chunk = state.chunks[index];
  if (!chunk || !open(chunk) || (side !== "ours" && side !== "theirs") || chunk.sides[side]) return state;
  if (chunk.kind === (side === "ours" ? "theirs" : "ours")) return state;
  const lines = chunk[side], other = side === "ours" ? "theirs" : "ours";
  let content;
  if (action === "accept") content = [...lines];
  else if (action === "ignore") content = chunk.content;
  else if (action === "add") content = chunk.sides[other] === "accepted" ? join(chunk.content, lines, state.eol) : [...lines];
  else return state;
  return replace(state, index, { ...chunk, content, sides: { ...chunk.sides, [side]: action === "ignore" ? "ignored" : "accepted" } });
}

// applyNonConflicting(state, which) → state: every open change that is not a conflict
// accepted. which: "ours", "theirs" or "all" (a change both sides made counts for each).
export function applyNonConflicting(state, which) {
  let next = state;
  state.chunks.forEach((chunk, i) => {
    if (!open(chunk) || chunk.kind === "conflict") return;
    if (chunk.kind === "both" || which === "all" || chunk.kind === which) {
      next = decide(next, i, chunk.kind === "theirs" ? "theirs" : "ours", "accept");
    }
  });
  return next;
}

// resolveSimple(state) → state: every open simple conflict that no side was decided on yet
// takes its line-by-line merge. Other conflicts stay open.
export function resolveSimple(state) {
  return {
    ...state,
    chunks: state.chunks.map((chunk) => (chunk.kind === "conflict" && chunk.simple && !chunk.sides.ours && !chunk.sides.theirs && open(chunk)
      ? { ...chunk, content: [...chunk.merged], sides: { ours: "accepted", theirs: "accepted" } }
      : chunk)),
  };
}

// resultText(state) → the result text.
export function resultText(state) {
  return state.chunks.map((chunk) => chunk.content.join("")).join("");
}

// counts(state) → { changes, conflicts }: open changes that are not conflicts, open conflicts.
export function counts(state) {
  let changes = 0, conflicts = 0;
  for (const chunk of state.chunks) if (open(chunk)) chunk.kind === "conflict" ? conflicts++ : changes++;
  return { changes, conflicts };
}

// resolved(state): nothing is left to decide.
export function resolved(state) {
  const c = counts(state);
  return !c.changes && !c.conflicts;
}

// edit(state, text) → state for a result written by hand. Unchanged chunks whose lines are
// still there in one piece anchor the rest; the text between two anchors belongs to the
// chunk between them. A chunk whose text changed counts as decided by hand (edited); one
// whose text is the same keeps its decisions. When an unchanged chunk's lines were edited
// too, it and the chunks between the anchors around it become one chunk of kind "edit".
export function edit(state, text) {
  const now = state.chunks.flatMap((c) => c.content), lines = splitLines(text), match = diff(now, lines);
  const chunks = [];
  let group = [], from = 0, at = 0;
  const flush = (to) => {
    const region = lines.slice(from, to);
    const before = group.flatMap((c) => c.content);
    if (same(before, region)) chunks.push(...group);
    else if (group.length === 1 && group[0].kind !== "same") chunks.push({ ...group[0], content: region, edited: true });
    else {
      const sum = (key) => group.flatMap((c) => c[key]), first = group[0];
      chunks.push({
        kind: "edit", base: sum("base"), ours: sum("ours"), theirs: sum("theirs"),
        baseStart: first?.baseStart ?? 0, oursStart: first?.oursStart ?? 0, theirsStart: first?.theirsStart ?? 0,
        sides: { ours: null, theirs: null }, content: region, edited: true,
      });
    }
    group = [];
  };
  for (const chunk of state.chunks) {
    const start = at, n = chunk.content.length;
    at += n;
    const to = match[start];
    const whole = chunk.kind === "same" && n > 0 && to >= from && chunk.content.every((_, i) => match[start + i] === to + i);
    if (!whole) { group.push(chunk); continue; }
    flush(to);
    chunks.push(chunk);
    from = to + n;
  }
  flush(lines.length);
  return { ...state, chunks: chunks.filter((c) => c.kind !== "edit" || c.content.length || c.base.length || c.ours.length || c.theirs.length) };
}
