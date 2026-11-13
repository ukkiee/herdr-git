// What the Conflicts dialog shows and allows, from the operation in progress
// (git-operation.js readOperation): the heading, the two columns and which side of git's
// each one is, the files unresolved and resolved, which buttons are on, and whether a
// file was already edited by hand. Pure: no "herdr", so node tests it.
//
// Words come back as { key, args } for messages-conflicts.js (the dialog words them in
// its own language) or { text } for what is shown as it is (a commit's subject).

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

// pick(files, selected) → the path to select: `selected` while it is shown, else the first
// unresolved file, else the first resolved one, else null.
export function pick(files, selected) {
  if (files.unresolved.some((f) => f.path === selected) || files.resolved.includes(selected)) return selected;
  return files.unresolved[0]?.path ?? files.resolved[0] ?? null;
}
