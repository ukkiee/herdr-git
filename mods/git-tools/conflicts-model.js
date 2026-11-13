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
