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

// ---- Create Patch

// The empty tree, what a first commit's changes start from, by object format.
const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};
// The person's git config must not change the patch (colors, an external diff, textconv,
// other prefixes). Binary changes go in whole so the patch applies.
const PATCH = ["--no-color", "--no-ext-diff", "--no-textconv", "--binary", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

const slash = (path) => String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

// patchBase(root, base) → { args } | { err, msg }: the diff arguments that make a patch's
// paths start at `base` (Base Path). The root itself: none. A folder below it:
// --relative (files outside it are left out). A folder above it: the folders between go
// before every path. Paths are compared as written.
export function patchBase(root, base) {
  const r = slash(root), b = slash(base);
  if (!b || b === r) return { args: [] };
  if (r.startsWith(`${b}/`)) {
    const between = r.slice(b.length + 1);
    return { args: [`--src-prefix=a/${between}/`, `--dst-prefix=b/${between}/`] };
  }
  if (b.startsWith(`${r}/`)) return { args: [`--relative=${b.slice(r.length + 1)}`] };
  return { err: `The base path ${base} neither holds the repository nor is inside it.`, msg: { key: "revision.baseOutside", args: { path: String(base) } } };
}

// Where the commits' changes start: the oldest one's first parent, or the empty tree.
async function before(git, root, oldest) {
  const r = await git.read(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${oldest}^1`]);
  if (r.ok && r.out.trim()) return { ok: true, rev: r.out.trim() };
  const format = await git.read(root, ["rev-parse", "--show-object-format"]);
  const tree = EMPTY_TREE[format.ok ? format.out.trim() : "sha1"];
  return tree ? { ok: true, rev: tree } : { ...format, ok: false };
}

// createPatch(git, root, { commits, paths?, reverse?, base?, file? }) → { ok, code, out, err, msg?, text }
//   The changes `commits` made (newest first, as the Log hands them: from before the
//   oldest to the newest) as a git patch. paths: only these files (repository paths).
//   reverse: the patch that undoes them. base: see patchBase (default the root).
//   file: git writes the patch there, on the repository's machine (an absolute path; its
//   folder must exist) and text is ""; without it text holds the patch.
export async function createPatch(git, root, { commits = [], paths = [], reverse = false, base = null, file = null } = {}) {
  if (!commits.length) return { ok: false, code: -1, out: "", err: "No commits to make a patch of.", msg: { key: "revision.noCommits", args: {} }, text: "" };
  const place = patchBase(root, base ?? root);
  if (!place.args) return { ok: false, code: -1, out: "", err: place.err, msg: place.msg, text: "" };
  const from = await before(git, root, commits[commits.length - 1]);
  if (!from.ok) return { ...from, text: "" };
  const args = [LITERAL, "diff", ...PATCH, ...place.args, ...(reverse ? ["-R"] : []), ...(file ? [`--output=${file}`] : []),
    "--end-of-options", from.rev, String(commits[0]), "--", ...paths];
  const r = file ? await git(root, args) : await git.read(root, args);
  return { ...r, out: "", text: r.ok && !file ? r.out : "" };
}

// patchFileName(branch, subject) → the name the patch file is offered under:
// "<branch>__<subject>.patch", every run of characters a file name shouldn't hold made one
// "_" (letters of any script stay). No branch (a detached HEAD): the subject alone.
export function patchFileName(branch, subject) {
  const clean = (text) => String(text ?? "").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "");
  const name = [clean(branch), clean(subject)].filter(Boolean).join("__").slice(0, 110) || "changes";
  return `${name}.patch`;
}

// ---- Go to Hash/Branch/Tag

// findCommit(git, root, text) → { ok, code, out, err, msg?, hash }
//   The commit a typed full or short hash, branch, remote branch or tag names (an
//   annotated tag: its commit). Space around the text is not part of it. hash: null when
//   nothing is named that way; msg says so.
export async function findCommit(git, root, text) {
  const typed = String(text ?? "").trim();
  const missing = { ok: false, code: 1, out: "", err: `Nothing named ${typed}.`, msg: { key: "revision.notFound", args: { text: typed } }, hash: null };
  if (!typed) return missing;
  const r = await git.read(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${typed}^{commit}`]);
  const hash = r.ok ? r.out.trim() : "";
  if (hash) return { ...r, out: "", hash };
  // --quiet: "no such name" says nothing; anything git does say is a real failure.
  return r.err ? { ...r, hash: null } : missing;
}

// ---- Go to Parent / Child Commit

// What the Log shows when it isn't limited to a branch (git-log.js readLog).
const SHOWN = ["--branches", "--remotes", "--tags", "HEAD"];
const SUBJECTS = ["%H", "%s"].join("%x1f");

// relatives(git, root, rev, { branch? }) → { ok, code, out, err, parents, children }
//   The commits next to `rev` in the graph: [{ hash, subject }]. parents in git's order
//   (the first parent first); children among what the Log shows: every branch, remote
//   branch and tag and HEAD, or only what `branch` (a ref name) reaches.
export async function relatives(git, root, rev, { branch = null } = {}) {
  const at = await commitOf(git, root, rev);
  if (!at.ok) return { ...at, parents: [], children: [] };
  const own = await git.read(root, ["rev-list", "--parents", "-n", "1", at.hash, "--"]);
  if (!own.ok) return { ...own, parents: [], children: [] };
  const parentHashes = own.out.trim().split(/\s+/).slice(1);
  let parents = [];
  if (parentHashes.length) {
    const p = await git.read(root, ["log", "-z", "--no-walk=unsorted", `--format=${SUBJECTS}`, ...parentHashes, "--"]);
    if (!p.ok) return { ...p, parents: [], children: [] };
    const subject = new Map(p.out.split("\0").filter(Boolean).map((e) => e.replace(/^\n/, "").split("\x1f")));
    parents = parentHashes.map((hash) => ({ hash, subject: subject.get(hash) ?? "" }));
  }
  // Only commits rev doesn't reach can have it as a parent.
  const scope = branch ? ["--end-of-options", branch] : SHOWN;
  const c = await git.read(root, ["log", "-z", `--format=${["%H", "%P", "%s"].join("%x1f")}`, `^${at.hash}`, ...scope, "--"]);
  if (!c.ok) return { ...c, parents, children: [] };
  const children = [];
  for (const entry of c.out.split("\0")) {
    const [hash, ps, subject] = entry.replace(/^\n/, "").split("\x1f");
    if (hash && ps?.split(" ").includes(at.hash)) children.push({ hash, subject: subject ?? "" });
  }
  return { ok: true, code: 0, out: "", err: "", parents, children };
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
