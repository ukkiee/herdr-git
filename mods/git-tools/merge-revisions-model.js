// What the Merge Revisions dialog shows and allows for one conflicted file: the pane
// titles, the rows of its three-pane picture, each chunk's buttons, the toolbar, the count,
// and the panel's side of saving a result. Pure apart from the save request (it takes the
// git runner): node tests it.
//
// The left pane is the person's side and the right the other one, as the Conflicts
// dialog's columns say (conflicts-model.js columns): in a rebase the person's side is git's
// theirs. The merge is made with the left text as merge-chunks.js's "ours" and the right as
// its "theirs", so "ours" below always means the left pane.
//
// Words come back as { key, args } for messages-conflicts.js.

import { merge, counts, resolved } from "./merge-chunks.js";
import { saveResult } from "./git-conflict.js";

const short = (hash) => String(hash ?? "").slice(0, 8);

// paneTitles(op, { branch, stash }) → { left, right }: each { key, args }.
//   op: git-operation.js readOperation. branch: the branch HEAD is on. stash: the stash a
//   conflicted unstash came from (an unstash leaves no operation).
export function paneTitles(op, { branch = null, stash = null } = {}) {
  const hash = short(op?.current?.hash);
  switch (op?.kind) {
    case "merge":
      return {
        left: branch ? { key: "conflicts.mrLeftBranch", args: { branch } } : { key: "conflicts.mrLeftYours", args: {} },
        right: { key: "conflicts.mrRightFrom", args: { name: op.target ?? hash } },
      };
    case "rebase":
      return {
        left: { key: "conflicts.mrLeftRebase", args: { hash, branch: op.rebasing ?? "HEAD" } },
        right: { key: "conflicts.mrRightRebase", args: { name: op.target ?? "" } },
      };
    case "cherry-pick":
      return { left: { key: "conflicts.mrLeftLocal", args: {} }, right: { key: "conflicts.mrRightCherryPick", args: { hash } } };
    case "revert":
      return { left: { key: "conflicts.mrLeftLocal", args: {} }, right: { key: "conflicts.mrRightRevert", args: { hash } } };
    default:
      if (stash) return { left: { key: "conflicts.mrLeftLocalLower", args: {} }, right: { key: "conflicts.mrRightStash", args: {} } };
      return { left: { key: "conflicts.mrLeftYours", args: {} }, right: { key: "conflicts.mrRightTheirs", args: {} } };
  }
}

// openFile(versions, cols) → { mode, state? }
//   versions: git-conflict.js readVersions. cols: conflicts-model.js columns.
//   mode: "text" (state: merge-chunks.js merge of base, left, right), "binary" or "deleted"
//   (a side has no file): those get no panes, only Accept Left and Accept Right.
export function openFile(v, cols) {
  if (v.binary) return { mode: "binary" };
  const left = v[cols.yours.side], right = v[cols.theirs.side];
  if (left === null || left === undefined || right === null || right === undefined) return { mode: "deleted" };
  return { mode: "text", state: merge(v.base ?? "", left, right) };
}

// Whether a chunk still waits for a decision (merge-chunks.js keeps its own copy private).
function open(chunk) {
  if (chunk.kind === "same" || chunk.kind === "edit" || chunk.edited) return false;
  const { ours, theirs } = chunk.sides;
  if (chunk.kind === "conflict") return !ours || !theirs;
  return !ours && !theirs;
}

// What a change does to the base: "inserted", "deleted" or "modified".
const changeColor = (base, side) => (!base.length ? "inserted" : !side.length ? "deleted" : "modified");

// The color of each pane for a chunk, null for plain.
function colors(chunk) {
  if (!open(chunk)) return { left: null, result: null, right: null };
  if (chunk.kind === "conflict") return { left: "conflict", result: "conflict", right: "conflict" };
  if (chunk.kind === "both") { const c = changeColor(chunk.base, chunk.ours); return { left: c, result: c, right: c }; }
  if (chunk.kind === "ours") { const c = changeColor(chunk.base, chunk.ours); return { left: c, result: c, right: null }; }
  const c = changeColor(chunk.base, chunk.theirs);
  return { left: null, result: c, right: c };
}

// layoutRows(state) → { rows, starts }: the picture, one row per line.
//   rows: [{ chunk, first, left, result, right }]; each pane's cell is { no, text, color }
//   (no from 1) or null where that pane has fewer lines in the chunk. A chunk is as tall as
//   its tallest pane, so the panes line up chunk by chunk.
//   starts: the first row of each chunk (a chunk with no lines anywhere has none of its own).
// Made once per decision, not per frame: a big file has tens of thousands of rows.
export function layoutRows(state) {
  const rows = [], starts = [];
  let resultNo = 0;
  state.chunks.forEach((chunk, index) => {
    const c = colors(chunk);
    const height = Math.max(chunk.ours.length, chunk.content.length, chunk.theirs.length);
    starts.push(rows.length);
    for (let i = 0; i < height; i++) {
      rows.push({
        chunk: index, first: i === 0,
        left: i < chunk.ours.length ? { no: chunk.oursStart + i + 1, text: chunk.ours[i], color: c.left } : null,
        result: i < chunk.content.length ? { no: resultNo + i + 1, text: chunk.content[i], color: c.result } : null,
        right: i < chunk.theirs.length ? { no: chunk.theirsStart + i + 1, text: chunk.theirs[i], color: c.right } : null,
      });
    }
    resultNo += chunk.content.length;
  });
  return { rows, starts };
}

// chunkButtons(state, index) → { ours, theirs }: what each side's gutter shows, null for
// nothing, else { apply: "accept" | "add", ignore: true }. "add" is a conflict whose other
// side was accepted already: that side's lines go after it (Append).
export function chunkButtons(state, index) {
  const chunk = state.chunks[index];
  const none = { ours: null, theirs: null };
  if (!chunk || !open(chunk)) return none;
  const side = (name, other) => {
    if (chunk.sides[name]) return null;
    if (chunk.kind === other) return null; // only the other side changed it
    return { apply: chunk.kind === "conflict" && chunk.sides[other] === "accepted" ? "add" : "accept", ignore: true };
  };
  return { ours: side("ours", "theirs"), theirs: side("theirs", "ours") };
}

// toolbar(state) → which toolbar buttons are on:
//   applyLeft, applyAll, applyRight: Apply Non-Conflicting Changes from that side (all: both)
//   resolveSimple: an open simple conflict no side was decided on
//   conflicts: open conflicts, for Previous and Next Conflict
export function toolbar(state) {
  let left = false, right = false, simple = false, conflicts = 0;
  for (const chunk of state.chunks) {
    if (!open(chunk)) continue;
    if (chunk.kind === "conflict") {
      conflicts++;
      if (chunk.simple && !chunk.sides.ours && !chunk.sides.theirs) simple = true;
    } else {
      // A change both sides made the same way applies from either side.
      if (chunk.kind !== "theirs") left = true;
      if (chunk.kind !== "ours") right = true;
    }
  }
  return { applyLeft: left, applyAll: left || right, applyRight: right, resolveSimple: simple, conflicts };
}

// countWords(state) → [{ key, args }]: the count right of the toolbar, joined by ", ".
// Nothing left to decide: "All conflicts resolved".
export function countWords(state) {
  if (resolved(state)) return [{ key: "conflicts.allResolved", args: {} }];
  const { changes, conflicts } = counts(state);
  return [
    changes ? { key: "conflicts.mrChanges", args: { n: changes } } : { key: "conflicts.mrNoChanges", args: {} },
    conflicts ? { key: "conflicts.mrConflicts", args: { n: conflicts } } : { key: "conflicts.mrNoConflicts", args: {} },
  ];
}

// leftToDecide(state) → open changes and conflicts: more than 0 asks before saving.
export function leftToDecide(state) {
  const { changes, conflicts } = counts(state);
  return changes + conflicts;
}

// seekConflict(state, from, dir) → the index of the next open conflict after chunk `from`
// (dir 1) or before it (dir -1), or -1. from -1 with dir 1 finds the first.
export function seekConflict(state, from, dir) {
  for (let i = from + dir; i >= 0 && i < state.chunks.length; i += dir) {
    const chunk = state.chunks[i];
    if (chunk.kind === "conflict" && open(chunk)) return i;
  }
  return -1;
}

// nextFile(conflicts, path) → the conflicted path to open after `path` is resolved: the
// next one by path, else the first, else null. conflicts: readOperation's, read again.
export function nextFile(conflicts, path) {
  const paths = (conflicts ?? []).map((c) => c.path).filter((p) => p !== path).sort();
  return paths.find((p) => p > path) ?? paths[0] ?? null;
}

// ---- the panel's side of the dialog's save request (serve-actions.js)

const badRequest = () => ({ ok: false, code: 1, out: "", err: "The request names no conflicted file.", msg: { key: "conflicts.badRequest" } });

// saveRequest(git, root, { path, text }, write) → git-conflict.js saveResult's result: the
// text written to the file and the file marked resolved. write: view-conflicts.js writerOn.
export function saveRequest(git, root, args, write) {
  const path = typeof args?.path === "string" && args.path ? args.path : null;
  if (!path || typeof args.text !== "string") return badRequest();
  return saveResult(git, root, path, args.text, { write });
}
