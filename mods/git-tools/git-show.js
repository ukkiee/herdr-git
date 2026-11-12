// One commit in full, for Commit details: who, when, the whole message, the files it
// changed, and (read apart, it can be slow) the branches that contain it
// (git-show.test.mjs). Every function takes `git` from makeGit (git.js) and the
// repository root, and returns a result instead of throwing. No `herdr` import: node
// tests it.

// Fields are split on NUL (nothing in a commit header can hold one). The message comes
// last so it is taken whole, blank lines and all. Names and emails as .mailmap maps them
// (%aN, %cN...), as the Commit list shows them.
const FORMAT = ["%H", "%P", "%aN", "%aE", "%at", "%cN", "%cE", "%ct", "%B"].join("%x00");
const NONE = { hash: null, parents: [], message: "", author: "", email: "", authorTime: 0, committer: "", committerEmail: "", commitTime: 0, files: [] };

// The letters of `--name-status`. A type change (file ↔ symlink) is a change to the
// file; a copy (only reported when asked for, which we don't) would be a new file.
const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", C: "added" };

// "M\0path\0R100\0old\0new\0" → [{ path, status, from }]
function parseNameStatus(out) {
  const parts = out.split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length;) {
    const letter = parts[i++][0], pair = letter === "R" || letter === "C";
    const from = pair ? parts[i++] : null, path = parts[i++];
    if (!path) break;
    files.push({ path, status: STATUS[letter] ?? "modified", from: letter === "R" ? from : null });
  }
  return files;
}

// readCommit(git, root, hash)
//   hash: full or short.
//   → { ok, err, hash, parents, message, author, email, authorTime, committer,
//       committerEmail, commitTime, files }
//   hash: the full hash. parents: full hashes, first parent first.
//   message: the whole message, without the line ends git adds after it.
//   Times are unix seconds.
//   files: [{ path, status, from }] against the first parent, so a merge commit lists
//     what the merge brought into the branch it was made on. A commit without a parent:
//     every file, added. status "modified" | "added" | "deleted" | "renamed"; from is
//     the old path of a renamed file, null otherwise.
export async function readCommit(git, root, hash) {
  // --end-of-options: whatever was typed as a hash is read as a revision, never a flag.
  const show = await git.read(root, ["show", "-s", `--format=${FORMAT}`, "--end-of-options", `${hash}^{commit}`]);
  if (!show.ok) return { ok: false, err: show.err, ...NONE };
  const [full, parents, author, email, authorTime, committer, committerEmail, commitTime, ...message] = show.out.split("\0");
  const first = parents ? parents.split(" ")[0] : null;
  // -M: a moved file is one renamed file, not a deleted and an added one.
  const diff = await git.read(root, first
    ? ["diff-tree", "-r", "-M", "--name-status", "-z", first, full]
    : ["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", full]);
  if (!diff.ok) return { ok: false, err: diff.err, ...NONE };
  return {
    ok: true, err: "", hash: full, parents: parents ? parents.split(" ") : [],
    message: message.join("\0").replace(/\n+$/, ""),
    author, email, authorTime: Number(authorTime), committer, committerEmail, commitTime: Number(commitTime),
    files: parseNameStatus(diff.out),
  };
}

const HEADS = "refs/heads/", REMOTES = "refs/remotes/";

// readContaining(git, root, hash) → { ok, err, branches }
//   branches: [{ name, kind }], the branches that contain the commit: local ones first
//   ("feature/login", kind "local"), then remote ones ("origin/main", kind "remote"),
//   each by name. A remote's HEAD pointer (origin/HEAD) is not a branch and is left out.
//   A commit no branch has: ok with an empty list.
//   Slow in big repositories (git walks back from every branch): read it apart from
//   readCommit and show the rest first.
export async function readContaining(git, root, hash) {
  // The hash rides on the option itself, so it can't be read as another option.
  const r = await git.read(root, ["for-each-ref", `--contains=${hash}`, "--format=%(refname)%00%(symref)", "--sort=refname", HEADS, REMOTES]);
  if (!r.ok) return { ok: false, err: r.err, branches: [] };
  const branches = [];
  for (const line of r.out.split("\n")) {
    const [ref, symref] = line.split("\0");
    if (!ref || symref) continue;
    if (ref.startsWith(HEADS)) branches.push({ name: ref.slice(HEADS.length), kind: "local" });
    else if (ref.startsWith(REMOTES)) branches.push({ name: ref.slice(REMOTES.length), kind: "remote" });
  }
  return { ok: true, err: "", branches };
}
