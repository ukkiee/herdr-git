// What the Conflicts dialog shows and allows, from the operation in progress
// (git-operation.js readOperation): the heading, the two columns and which side of git's
// each one is, the files unresolved and resolved, which buttons are on, and whether a
// file was already edited by hand. Pure: no "herdr", so node tests it.
//
// Words come back as { key, args } for messages-conflicts.js (the dialog words them in
// its own language) or { text } for what is shown as it is (a commit's subject).

import { merge } from "./merge-chunks.js";
import { acceptSide, unresolve, resolveSimpleAll } from "./git-conflict.js";

// A commit as the heading names it.
const short = (hash) => String(hash ?? "").slice(0, 8);

// heading(op, { branch, stash }) → [{ key, args } | { text }], one per line.
//   branch: the branch HEAD is on (null when detached). stash: the stash a conflicted
//   unstash came from, when the opener knows it.
export function heading(op, { branch = null, stash = null } = {}) {
  const current = op?.current;
  const who = current ? { hash: short(current.hash), author: current.author ?? "" } : null;
  const subject = current?.subject ? [{ text: current.subject }] : [];
  switch (op?.kind) {
    case "merge":
      return [{ key: "conflicts.headMerge", args: { from: op.target ?? short(current?.hash), into: branch ?? "HEAD" } }];
    case "rebase":
      return [
        { key: "conflicts.headRebase", args: { branch: op.rebasing ?? "HEAD", onto: op.target ?? "" } },
        ...(who ? [{ key: "conflicts.headCurrent", args: who }, ...subject] : []),
      ];
    case "cherry-pick":
      if (who) return [{ key: "conflicts.headCherryPick", args: who }, ...subject];
      break;
    case "revert":
      if (who) return [{ key: "conflicts.headRevert", args: who }, ...subject];
      break;
    default:
      if (stash) return [{ key: "conflicts.headUnstash", args: { stash } }];
  }
  return [{ key: "conflicts.headDefault", args: {} }];
}

// What the theirs column is named after, by operation: the branch merged in or rebased
// onto, else the operation itself.
const THEIRS_NAME = { "cherry-pick": "cherry-pick", revert: "revert" };

// columns(op, { branch, stash }) → { yours: { side, label }, theirs: { side, label } }
//   side: git's side the column stands for, "ours" (stage 2) or "theirs" (stage 3).
//   In a rebase git's ours is what the commits go onto, so "Yours" is git's theirs: the
//   commits being replayed, which are the person's.
//   label: { key, args }, "Yours (main)", or plain "Yours" when no name is known.
export function columns(op, { branch = null, stash = null } = {}) {
  const rebase = op?.kind === "rebase";
  const yoursName = rebase ? op.rebasing : branch;
  const theirsName = rebase || op?.kind === "merge" ? op.target : THEIRS_NAME[op?.kind] ?? (op?.kind ? null : stash);
  const label = (column, name) => (name
    ? { key: `conflicts.${column}On`, args: { name } }
    : { key: `conflicts.${column}`, args: {} });
  return {
    yours: { side: rebase ? "theirs" : "ours", label: label("yours", yoursName) },
    theirs: { side: rebase ? "ours" : "theirs", label: label("theirs", theirsName) },
  };
}

// A side's state as a column shows it: a file both sides added counts as modified.
const shown = (state) => (state === "deleted" ? "deleted" : "modified");

// sortFiles(op, columns, seen) → { unresolved, resolved, seen }
//   unresolved: [{ path, yours, theirs }] in conflict now, by path; yours and theirs are
//     "modified" | "deleted", taken from the side each column stands for.
//   resolved: [path] of `seen` not in conflict any more, by path.
//   seen: every path in conflict since the dialog opened (keep it for the next call).
export function sortFiles(op, cols, seen = []) {
  const now = [...(op?.conflicts ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const conflicted = new Set(now.map((c) => c.path));
  const all = [...new Set([...seen, ...conflicted])].sort();
  return {
    unresolved: now.map((c) => ({ path: c.path, yours: shown(c[cols.yours.side]), theirs: shown(c[cols.theirs.side]) })),
    resolved: all.filter((path) => !conflicted.has(path)),
    seen: all,
  };
}

// controls(files, { selected, busy, loaded }) → which controls are on:
//   accept (a column's Accept on an unresolved row), resolveSimple, resolveManually (the
//   selected file is unresolved), finish (nothing left unresolved), unresolve (the
//   selected file is resolved), allResolved (the heading says so).
//   busy: a write runs. loaded: the files were read at least once.
export function controls(files, { selected = null, busy = false, loaded = false } = {}) {
  const open = files.unresolved.length > 0, free = loaded && !busy;
  const allResolved = loaded && !open;
  return {
    accept: free && open,
    resolveSimple: free && open,
    resolveManually: free && files.unresolved.some((f) => f.path === selected),
    finish: free && allResolved,
    unresolve: free && files.resolved.includes(selected),
    allResolved,
  };
}

// The text with every conflict block taken to one side: { ours, theirs }, or null when
// there is no block or the markers don't pair up. A block is git's
//   <<<<<<< label / ours lines / [||||||| label / base lines] / ======= / theirs lines / >>>>>>> label
const MARK = { open: /^<{7}(?: |\r?\n|$)/, base: /^\|{7}(?: |\r?\n|$)/, middle: /^={7}\r?\n?$/, close: /^>{7}(?: |\r?\n|$)/ };
function takeSides(text) {
  const lines = String(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out = { ours: "", theirs: "" };
  let at = "out", blocks = 0;
  for (const line of lines) {
    if (at === "out" && MARK.open.test(line)) { at = "ours"; blocks++; }
    else if (at === "ours" && MARK.base.test(line)) at = "base";
    else if ((at === "ours" || at === "base") && MARK.middle.test(line)) at = "theirs";
    else if (at === "theirs" && MARK.close.test(line)) at = "out";
    else if (at === "out") { out.ours += line; out.theirs += line; }
    else if (at === "ours") out.ours += line;
    else if (at === "theirs") out.theirs += line;
    else if (at !== "base") return null;
  }
  return at === "out" && blocks ? out : null;
}

// The merge with every conflict taken to `side` and every other change applied: what the
// file reads as when each of git's conflict blocks is taken to that side.
function mergedTo(state, side) {
  return state.chunks.map((c) => (c.kind === "conflict" ? c[side] : c.kind === "theirs" ? c.theirs : c.kind === "same" ? c.base : c.ours).join("")).join("");
}

// Line ends and a last newline aside: git ends the last line of a block with one.
const sameText = (a, b) => String(a).replace(/\r/g, "").replace(/\n$/, "") === String(b).replace(/\r/g, "").replace(/\n$/, "");

// editedSince(versions) → true when the file on disk isn't what git left: accepting a side
// would lose what the person wrote. versions: git-conflict.js readVersions with `read`
// (base, ours, theirs, worktree, binary).
//   Both sides kept: git left conflict blocks; the file is as git left it when taking every
//   block to one side gives the merge taken to that side, for both sides. A file without
//   blocks was written by the person (git writes blocks into every text conflict; a file
//   with merge=binary in .gitattributes is the exception and asks needlessly).
//   One side deleted: git left the other side's version.
//   A binary file can't be compared as text and counts as not edited.
//   The merge here is merge-chunks.js's, not git's: where the two cut a change differently,
//   a file as git left it counts as edited, and the dialog asks once more than it must.
export function editedSince(v) {
  if (!v || v.binary) return false;
  const disk = typeof v.worktree === "string" ? v.worktree : null;
  if (v.ours === null || v.theirs === null) return disk !== null && !sameText(disk, v.ours ?? v.theirs ?? "");
  if (disk === null) return true;
  const sides = takeSides(disk);
  if (!sides) return true;
  const state = merge(v.base ?? "", v.ours, v.theirs);
  return !(sameText(sides.ours, mergedTo(state, "ours")) && sameText(sides.theirs, mergedTo(state, "theirs")));
}

// stoppedOnConflicts(result) → true when a request (git-operation.js runOperation, or one
// that starts an operation) stopped with files in conflict: the screen that ran it opens
// the Conflicts dialog. A stop without conflicts (a rebase's edit) doesn't open it.
export function stoppedOnConflicts(result) {
  return result?.outcome === "stopped" && (result.operation?.conflicts?.length ?? 0) > 0;
}

// ---- the panel's side of the dialog's requests (serve-actions.js)
// args come from the dialog as plain JSON: each value is checked before use.

const badRequest = () => ({ ok: false, code: 1, out: "", err: "The request names no conflicted file.", msg: { key: "conflicts.badRequest" } });
const pathOf = (args) => (typeof args?.path === "string" && args.path ? args.path : null);

// acceptRequest(git, root, { path, side }) → git-conflict.js acceptSide's result.
//   side: git's ("ours" | "theirs"), the column's `side` (columns above).
export function acceptRequest(git, root, args) {
  const path = pathOf(args);
  return path ? acceptSide(git, root, path, args.side) : badRequest();
}

// unresolveRequest(git, root, { path }) → git-conflict.js unresolve's result.
export function unresolveRequest(git, root, args) {
  const path = pathOf(args);
  return path ? unresolve(git, root, path) : badRequest();
}

// resolveSimpleRequest(git, root, { paths? }, write) → resolveSimpleAll's result, over the
// paths given (the unresolved files the dialog shows), or every conflicted file.
export function resolveSimpleRequest(git, root, args, write) {
  const paths = Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === "string" && p) : undefined;
  return resolveSimpleAll(git, root, { write, paths });
}

// pick(files, selected) → the path to select: `selected` while it is shown, else the first
// unresolved file, else the first resolved one, else null.
export function pick(files, selected) {
  if (files.unresolved.some((f) => f.path === selected) || files.resolved.includes(selected)) return selected;
  return files.unresolved[0]?.path ?? files.resolved[0] ?? null;
}
