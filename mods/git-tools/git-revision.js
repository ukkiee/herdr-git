// One revision and where it sits: the files a commit has (Show Repository at Revision), the
// history up to it (History up to Here), a patch of its changes (Create Patch), the commit
// a typed hash, branch or tag names (Go to Hash/Branch/Tag), and its parents and children
// (Go to Parent / Child Commit).
// Every function takes `git` from makeGit (git.js) and the repository root, and returns
// a result instead of throwing. No `herdr` import: node tests it (git-revision.test.mjs).

// A path is a path, not a pattern: `app/[id]/page.tsx` must not be read as a glob.
const LITERAL = "--literal-pathspecs";

// Fields split on 0x1f, commits on NUL (-z): a subject holds neither.
const FIELDS = ["%H", "%P", "%aN", "%aE", "%at", "%s"].join("%x1f");

function parseCommits(out) {
  return out.split("\0").filter((entry) => entry.trim()).map((entry) => {
    const [hash, parents, author, email, time, subject] = entry.replace(/^\n/, "").split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], author, email, time: Number(time), subject: subject ?? "" };
  });
}

async function commitOf(git, root, rev) {
  const r = await git.read(root, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]);
  return r.ok ? { ...r, hash: r.out.trim() } : { ...r, hash: null };
}

// ---- Show Repository at Revision

const KINDS = { "120000": "link", "160000": "submodule" };

// revisionTree(git, root, rev) → { ok, code, out, err, hash, files }
//   Every file commit `rev` has, the whole tree whatever folder asks: [{ path, kind }],
//   kind "file" | "link" (a symbolic link) | "submodule". hash: the commit's full hash.
export async function revisionTree(git, root, rev) {
  const at = await commitOf(git, root, rev);
  if (!at.ok) return { ...at, files: [] };
  const r = await git.read(root, ["ls-tree", "-r", "-z", "--full-tree", at.hash]);
  if (!r.ok) return { ...r, hash: at.hash, files: [] };
  const files = [];
  for (const entry of r.out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const mode = entry.slice(0, entry.indexOf(" "));
    files.push({ path: entry.slice(tab + 1), kind: KINDS[mode] ?? "file" });
  }
  return { ...r, out: "", hash: at.hash, files };
}

// ---- History up to Here

// historyUpTo(git, root, { rev, path?, skip?, max? }) → { ok, code, out, err, commits, more }
//   The commits reachable from `rev`, newest first; with `path` only those that changed
//   that file, followed back over renames. `max` at a time from `skip`; more: there are
//   others after these. Each: { hash, parents, author, email, time (unix seconds), subject }.
export async function historyUpTo(git, root, { rev, path = null, skip = 0, max = 1000 } = {}) {
  const args = [LITERAL, "log", "-z", `--format=${FIELDS}`, `--skip=${Math.max(0, skip | 0)}`, `--max-count=${Math.max(1, max | 0) + 1}`,
    ...(path ? ["--follow"] : []), "--end-of-options", String(rev), "--", ...(path ? [path] : [])];
  const r = await git.read(root, args);
  if (!r.ok) return { ...r, commits: [], more: false };
  const commits = parseCommits(r.out), more = commits.length > max;
  return { ...r, out: "", commits: more ? commits.slice(0, max) : commits, more };
}
