// Picking commits in the Commit list: one, or many with Shift (a range) and Cmd (one more,
// or one fewer), and what Commit details shows for many. No `herdr` import: node tests it
// (log-select.test.mjs).
//
// A selection is { picked: Set of hashes, anchor, lead }, never changed in place:
//   anchor  where a Shift range starts: the commit of the last plain or Cmd click
//   lead    the commit last clicked, the one the keyboard and a one-commit action work on;
//           null when nothing is picked
// Hashes, not row numbers: the list is read again (and grows) under the selection.

export const NONE = Object.freeze({ picked: new Set(), anchor: null, lead: null });

// pickCommit(sel, hash, { shift, cmd }, list) → the selection after a click on `hash`.
//   list: { at(hash) → row number or undefined, hashAt(row) → hash }.
//   Shift: the rows from the anchor to this one, in place of what was picked (with Cmd too:
//   added to it). Without an anchor in the list, Shift acts as a plain click.
//   Cmd: this one in or out; it becomes the anchor. Taken out, the lead moves to the newest
//   commit still picked.
export function pickCommit(sel, hash, mods = {}, list) {
  const from = sel.anchor !== null ? list.at(sel.anchor) : undefined, to = list.at(hash);
  if (mods.shift && from !== undefined && to !== undefined) {
    const picked = mods.cmd ? new Set(sel.picked) : new Set();
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) picked.add(list.hashAt(i));
    return { picked, anchor: sel.anchor, lead: hash };
  }
  if (mods.cmd) {
    const picked = new Set(sel.picked);
    if (!picked.has(hash)) return { picked: picked.add(hash), anchor: hash, lead: hash };
    picked.delete(hash);
    return { picked, anchor: hash, lead: picked.size ? pickedInOrder({ picked }, list.at)[0] : null };
  }
  return { picked: new Set([hash]), anchor: hash, lead: hash };
}

// A right-click: on a picked commit the menu acts on every commit picked; on another
// commit it picks that one alone.
export function pickForMenu(sel, hash) {
  if (sel.picked.has(hash)) return sel.lead === hash ? sel : { ...sel, lead: hash };
  return { picked: new Set([hash]), anchor: hash, lead: hash };
}

// keepPicked(sel, has, at?) → the selection after the list was read again: only commits
// `has(hash)` still finds. A lead that is gone gives way to the newest commit still picked
// (by `at`, the row numbers; else any); an anchor that is gone, to the lead. The same value
// back when nothing went.
export function keepPicked(sel, has, at) {
  const picked = new Set([...sel.picked].filter((h) => has(h)));
  if (picked.size === sel.picked.size && (sel.anchor === null || has(sel.anchor))) return sel;
  let lead = sel.lead !== null && picked.has(sel.lead) ? sel.lead : null;
  if (lead === null && picked.size) lead = at ? pickedInOrder({ picked }, at)[0] : [...picked][0];
  const anchor = sel.anchor !== null && has(sel.anchor) ? sel.anchor : lead;
  return { picked, anchor, lead };
}

// The picked hashes in list order, newest first. at: hash → row number (undefined: not in
// the list, left out).
export function pickedInOrder(sel, at) {
  return [...sel.picked].filter((h) => at(h) !== undefined).sort((a, b) => at(a) - at(b));
}

// combineChanges(commits) → [{ path, status, from? }] by path: the files the commits changed
// together, each as the change from before the oldest commit that touched it to after the
// newest. commits: newest first, each { files: [{ path, status, from? }] } (git-show.js
// readCommit). A file added and deleted inside the range has no change left and is not
// listed.
export function combineChanges(commits) {
  const seen = new Map(); // path → { first (oldest), last (newest) }
  for (let i = commits.length - 1; i >= 0; i--) {
    for (const f of commits[i]?.files ?? []) {
      const s = seen.get(f.path);
      if (s) s.last = f; else seen.set(f.path, { first: f, last: f });
    }
  }
  const out = [];
  for (const [path, { first, last }] of [...seen].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const before = first.status !== "added", after = last.status !== "deleted";
    if (!before && !after) continue;
    if (first.status === "renamed" && after) out.push({ path, status: "renamed", from: first.from });
    else out.push({ path, status: !before ? "added" : !after ? "deleted" : first === last ? first.status : "modified" });
  }
  return out;
}
