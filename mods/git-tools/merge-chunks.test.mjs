// node merge-chunks.test.mjs: the merge chunks of three texts (base, ours, theirs), what
// each accept, ignore and add makes of the result, the simple conflicts, and the chunks
// found again in a result edited by hand. Expected texts are written out by hand.
import assert from "node:assert/strict";
import { merge, decide, resultText, counts, resolveSimple, applyNonConflicting, edit, resolved } from "./merge-chunks.js";

const kinds = (state) => state.chunks.map((c) => c.kind);
// The index of the first chunk of `kind`.
const at = (state, kind, from = 0) => state.chunks.findIndex((c, i) => i >= from && c.kind === kind);

// Chunks: unchanged lines, a change on one side only, the same change on both sides, and a
// conflict. The result starts as the base, and the counts say what is left to do.
{
  const base = "a\nb\nc\nd\ne\nf\ng\n";
  const ours = "a\nB\nc\nD\ne\nF1\ng\n";
  const theirs = "a\nb\nc\nD\ne\nF2\ng\n";
  const s = merge(base, ours, theirs);
  assert.deepEqual(kinds(s), ["same", "ours", "same", "both", "same", "conflict", "same"]);
  assert.deepEqual(s.chunks[1].ours, ["B\n"]);
  assert.deepEqual(s.chunks[1].base, ["b\n"]);
  assert.deepEqual(s.chunks[5].theirs, ["F2\n"]);
  assert.equal(s.chunks[5].simple, false);
  assert.equal(resultText(s), base);
  assert.deepEqual(counts(s), { changes: 2, conflicts: 1 });
  assert.equal(resolved(s), false);

  // Accepting a one-sided change takes it; ignoring keeps the base. Either way it is done.
  let t = decide(s, 1, "ours", "accept");
  t = decide(t, 3, "theirs", "ignore");
  assert.equal(resultText(t), "a\nB\nc\nd\ne\nf\ng\n");
  assert.deepEqual(counts(t), { changes: 0, conflicts: 1 });
  // The state given is never changed.
  assert.equal(resultText(s), base);

  // A conflict: accepting one side is not the end of it, the other side is still open.
  let u = decide(t, 5, "theirs", "accept");
  assert.equal(resultText(u), "a\nB\nc\nd\ne\nF2\ng\n");
  assert.deepEqual(counts(u), { changes: 0, conflicts: 1 });
  // Adding the other side puts it after what is there, and closes the conflict.
  const added = decide(u, 5, "ours", "add");
  assert.equal(resultText(added), "a\nB\nc\nd\ne\nF2\nF1\ng\n");
  assert.deepEqual(counts(added), { changes: 0, conflicts: 0 });
  assert.equal(resolved(added), true);
  // Ignoring the other side keeps the first one alone.
  const ignored = decide(u, 5, "ours", "ignore");
  assert.equal(resultText(ignored), "a\nB\nc\nd\ne\nF2\ng\n");
  assert.equal(resolved(ignored), true);
  // Ignoring both sides of a conflict leaves the base.
  const neither = decide(decide(t, 5, "ours", "ignore"), 5, "theirs", "ignore");
  assert.equal(resultText(neither), "a\nB\nc\nd\ne\nf\ng\n");
  assert.equal(resolved(neither), true);
  // A decided side doesn't change again; an unknown chunk or action changes nothing.
  assert.equal(resultText(decide(ignored, 5, "theirs", "ignore")), resultText(ignored));
  assert.equal(resultText(decide(t, 0, "ours", "accept")), resultText(t));
  assert.equal(resultText(decide(t, 99, "ours", "accept")), resultText(t));
  assert.equal(resultText(decide(t, 5, "ours", "eat")), resultText(t));
}

// Applying non-conflicting changes: one side's, or both; conflicts stay open.
{
  const base = "1\n2\n3\n4\n5\n6\n7\n";
  const ours = "1\nA\n3\n4\n5\n6\nX\n";
  const theirs = "1\n2\n3\nB\n5\n6\nY\n";
  const s = merge(base, ours, theirs);
  assert.deepEqual(kinds(s), ["same", "ours", "same", "theirs", "same", "conflict"]);
  assert.equal(resultText(applyNonConflicting(s, "ours")), "1\nA\n3\n4\n5\n6\n7\n");
  assert.equal(resultText(applyNonConflicting(s, "theirs")), "1\n2\n3\nB\n5\n6\n7\n");
  const all = applyNonConflicting(s, "all");
  assert.equal(resultText(all), "1\nA\n3\nB\n5\n6\n7\n");
  assert.deepEqual(counts(all), { changes: 0, conflicts: 1 });
}

// Simple conflicts: both sides change lines next to each other but not the same line, so
// they merge line by line. Only those are resolved; a real conflict stays.
{
  const base = "a\nb\nc\nd\ne\nf\n";
  const ours = "A\nb\nc\nd\ne\nF1\n";
  const theirs = "a\nB\nc\nd\ne\nF2\n";
  const s = merge(base, ours, theirs);
  assert.deepEqual(kinds(s), ["conflict", "same", "conflict"]);
  assert.equal(s.chunks[0].simple, true);
  assert.equal(s.chunks[2].simple, false);
  const r = resolveSimple(s);
  assert.equal(resultText(r), "A\nB\nc\nd\ne\nf\n");
  assert.deepEqual(counts(r), { changes: 0, conflicts: 1 });

  // A line added by one side right before a line the other side changed is simple too.
  const ins = merge("x\ny\n", "new\nx\ny\n", "X\ny\n");
  assert.deepEqual(kinds(ins), ["conflict", "same"]);
  assert.equal(ins.chunks[0].simple, true);
  assert.equal(resultText(resolveSimple(ins)), "new\nX\ny\n");

  // Both sides adding different lines at the same place is not: the order is a choice.
  const both = merge("x\n", "x\n1\n", "x\n2\n");
  assert.deepEqual(kinds(both), ["same", "conflict"]);
  assert.equal(both.chunks[1].simple, false);
  assert.equal(resultText(resolveSimple(both)), "x\n");
}

// Line ends: CRLF lines stay CRLF, a last line without a newline stays without one, and
// adding the other side of a conflict at the end of the file keeps the lines apart.
{
  const base = "a\r\nb\r\nm\r\nc";
  const ours = "a\r\nB\r\nm\r\nc";
  const theirs = "a\r\nb\r\nm\r\nC";
  const s = merge(base, ours, theirs);
  assert.deepEqual(kinds(s), ["same", "ours", "same", "theirs"]);
  const all = applyNonConflicting(s, "all");
  assert.equal(resultText(all), "a\r\nB\r\nm\r\nC");
  assert.equal(resolved(all), true);

  const end = merge("x\r\ny", "x\r\nY1", "x\r\nY2");
  assert.deepEqual(kinds(end), ["same", "conflict"]);
  const both = decide(decide(end, 1, "ours", "accept"), 1, "theirs", "add");
  assert.equal(resultText(both), "x\r\nY1\r\nY2");

  // Adding a newline to the last line is a change of its own.
  const nl = merge("x\ny", "x\ny\n", "x\ny");
  assert.deepEqual(kinds(nl), ["same", "ours"]);
  assert.equal(resultText(applyNonConflicting(nl, "all")), "x\ny\n");
}

// Edge files: all empty, one side only changed, everything in conflict.
{
  const empty = merge("", "", "");
  assert.deepEqual(empty.chunks, []);
  assert.equal(resultText(empty), "");
  assert.equal(resolved(empty), true);

  const added = merge("", "new\n", "");
  assert.deepEqual(kinds(added), ["ours"]);
  assert.equal(resultText(applyNonConflicting(added, "all")), "new\n");

  const one = merge("a\nb\n", "a\nb\nc\n", "a\nb\n");
  assert.deepEqual(kinds(one), ["same", "ours"]);
  assert.deepEqual(counts(one), { changes: 1, conflicts: 0 });

  const whole = merge("a\nb\n", "1\n2\n", "x\ny\n");
  assert.deepEqual(kinds(whole), ["conflict"]);
  assert.equal(whole.chunks[0].simple, false);
  assert.equal(resultText(decide(whole, 0, "ours", "accept")), "1\n2\n");
}

// Edited by hand: a chunk whose text the person changed counts as resolved, a chunk they
// left alone keeps its state, and the unchanged lines around them stay unchanged lines.
{
  const base = "a\nb\nc\nd\ne\n";
  const ours = "a\nB1\nc\nD1\ne\n";
  const theirs = "a\nB2\nc\nD2\ne\n";
  const s = merge(base, ours, theirs);
  assert.deepEqual(kinds(s), ["same", "conflict", "same", "conflict", "same"]);
  const e = edit(s, "a\nmine\nc\nd\ne\n");
  assert.deepEqual(kinds(e), ["same", "conflict", "same", "conflict", "same"]);
  assert.equal(resultText(e), "a\nmine\nc\nd\ne\n");
  assert.deepEqual(counts(e), { changes: 0, conflicts: 1 });
  // The open conflict still takes a side.
  const after = decide(e, 3, "ours", "accept");
  assert.equal(resultText(after), "a\nmine\nc\nD1\ne\n");

  // An edit inside unchanged lines joins them with the chunks around into one hand-made,
  // resolved chunk; the text is exactly what was written.
  const e2 = edit(s, "a\nb\nC!\nd\ne\n");
  assert.equal(resultText(e2), "a\nb\nC!\nd\ne\n");
  assert.deepEqual(counts(e2), { changes: 0, conflicts: 0 });

  // The same text again changes nothing.
  const same = edit(s, resultText(s));
  assert.deepEqual(counts(same), counts(s));
  assert.equal(resultText(same), base);

  // CRLF survives an edit.
  const crlf = merge("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n", "a\r\nb\r\nc\r\n");
  const ec = edit(crlf, "a\r\nb2\r\nc\r\n");
  assert.equal(resultText(ec), "a\r\nb2\r\nc\r\n");
  assert.deepEqual(counts(ec), { changes: 0, conflicts: 0 });
}

// Many lines: the diff stays fast enough for one call (a few thousand lines).
{
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`);
  const base = lines.join("");
  const ours = lines.map((l, i) => (i % 100 === 0 ? `ours ${i}\n` : l)).join("");
  const theirs = lines.map((l, i) => (i % 100 === 50 ? `theirs ${i}\n` : l)).join("");
  const started = Date.now();
  const s = merge(base, ours, theirs);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(counts(s), { changes: 100, conflicts: 0 });
  const all = applyNonConflicting(s, "all");
  assert.equal(resultText(all), lines.map((l, i) => (i % 100 === 0 ? `ours ${i}\n` : i % 100 === 50 ? `theirs ${i}\n` : l)).join(""));
}

console.log("ok");
