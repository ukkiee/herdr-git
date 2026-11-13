// What changed in the working tree, for the Commit panel.

// One porcelain v2 entry's path: the text after `fields` space-separated fields (a path
// may itself hold spaces, so it can't be split off the end).
function pathAfter(entry, fields) {
  let at = 0;
  for (let i = 0; i < fields; i++) at = entry.indexOf(" ", at) + 1;
  return entry.slice(at);
}

// X is HEAD → index, Y is index → work tree. "added" wins over "deleted": a file that
// isn't in HEAD has nothing to be restored from, whatever happened to it since
// (`git add` then `rm`), and Rollback treats the two differently.
function statusOf(xy) {
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

// readStatus(git, root) → { ok, err, hasHead, head, detached, changes, unversioned }
//   git: from makeGit (git.js). root: the repository root.
//   changes: [{ path, status, xy }]: tracked files that differ from HEAD; status is
//   "modified" | "added" | "deleted" | "conflict". "added" also covers a file only
//   registered with `git add --intent-to-add`. xy: porcelain v2's two letters as git
//   wrote them: X the index against HEAD, Y the work tree against the index ("." for no
//   change); for a conflict, our side and their side (UU, AA, AU, UA, DU, UD, DD).
//   unversioned: [{ path, status: "unversioned" }]: untracked and not ignored.
//   hasHead: false in a repository without commits. head: the commit HEAD is on (full
//   hash), null without commits.
//   detached: HEAD is on a commit and no branch (a commit made there is on no branch).
//   Paths are relative to root, in git's order (by path). An untracked folder that is
//   itself a repository comes as one path ending in "/".
//   Reads only (git.read): nothing under .git is written. One git call, so a space on
//   another machine pays for one round trip per refresh.
//   When git fails: { ok: false, err: git's words } with empty lists; when git said
//   nothing, err is the mod's sentence and msg its key (i18n.js).
export async function readStatus(git, root) {
  const r = await git.read(root, ["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]);
  if (!r.ok) {
    const why = r.err ? { err: r.err } : { err: "git status failed", msg: { key: "commit.statusFailed" } };
    return { ok: false, ...why, hasHead: false, head: null, detached: false, changes: [], unversioned: [] };
  }
  const changes = [], unversioned = [];
  let hasHead = true, head = null, detached = false;
  for (const entry of r.out.split("\0")) {
    const kind = entry[0];
    if (kind === "#") {
      if (entry.startsWith("# branch.oid ")) { hasHead = entry !== "# branch.oid (initial)"; head = hasHead ? entry.slice(13) : null; }
      // git writes the same line on a branch someone named "(detached)": that one
      // branch reads as detached here too.
      else if (entry === "# branch.head (detached)") detached = true;
    }
    else if (kind === "1") changes.push({ path: pathAfter(entry, 8), status: statusOf(entry.slice(2, 4)), xy: entry.slice(2, 4) });
    else if (kind === "u") changes.push({ path: pathAfter(entry, 10), status: "conflict", xy: entry.slice(2, 4) });
    else if (kind === "?") unversioned.push({ path: entry.slice(2), status: "unversioned" });
  }
  return { ok: true, err: "", hasHead, head, detached, changes, unversioned };
}
