// Patches outside the Log: Create Patch from local changes, and Apply Patch (from a file
// or the clipboard) on the working tree.
// Every git function takes `git` from makeGit (git.js) and the repository root, and
// returns { ok, code, out, err, msg?, … } instead of throwing. No `herdr` import: node
// tests it (git-patch.test.mjs).

import { chunks } from "./git.js";

// A commit the mod makes for itself needs no name the person configured.
const IDENTITY = ["-c", "user.name=git-tools", "-c", "user.email=git-tools@localhost"];
// One per worktree, in its own git folder. The panel runs this under the repository's
// write lock, so two of them never share the file.
const SCRATCH = "git-tools-patch-index";

const refuse = (err, key, args = {}) => ({ ok: false, code: -1, out: "", err, msg: { key, args } });

// ---- Create Patch from local changes

// changesCommit(git, root, { paths, message }) → { ok, code, out, err, msg?, hash }
//   A commit on HEAD (none on a repository without commits) whose tree is HEAD's with each
//   of `paths` as the working tree has it now: changed, new (untracked too) or gone. No
//   ref names it, and the index and the working tree are left as they were (the tree is
//   built in a scratch index). Its patch is what the Patch File Settings dialog writes
//   for one commit (git-revision.js createPatch), so local changes take the same way as
//   a commit's. A rename is its old and its new path, both in `paths`.
//   message: the commit's message; empty: "Local changes".
export async function changesCommit(git, root, { paths = [], message = "" } = {}) {
  const list = paths.filter((path) => typeof path === "string" && path);
  if (!list.length) return { ...refuse("No files chosen for the patch.", "patch.noFiles"), hash: null };
  const dir = await git.read(root, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return { ...dir, hash: null };
  const env = { GIT_INDEX_FILE: `${dir.out.trim()}/${SCRATCH}` };
  const head = await git.read(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok && head.err) return { ...head, hash: null };
  const parent = head.ok ? head.out.trim() : null;
  const made = await build(git, root, list, env, parent, String(message ?? ""));
  // Emptied whether or not the commit was made; a failure here leaves only a stale file.
  await git(root, ["read-tree", "--empty"], { env });
  return made;
}

async function build(git, root, paths, env, parent, message) {
  const fail = (r) => ({ ...r, ok: false, hash: null });
  const start = await git(root, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
  if (!start.ok) return fail(start);
  // --add takes a file HEAD lacks, --remove drops one the working tree lacks. Paths, not
  // pathspecs: a name like "*.ts" is that file only.
  for (const chunk of chunks(paths)) {
    const r = await git(root, ["update-index", "--add", "--remove", "--", ...chunk], { env });
    if (!r.ok) return fail(r);
  }
  const tree = await git(root, ["write-tree"], { env });
  if (!tree.ok) return fail(tree);
  // An empty -m makes commit-tree read the message from stdin, which never ends here.
  const words = message.trim() ? message : "Local changes";
  const commit = await git(root, [...IDENTITY, "commit-tree", "--no-gpg-sign", tree.out.trim(), ...(parent ? ["-p", parent] : []), "-m", words]);
  if (!commit.ok) return fail(commit);
  return { ok: true, code: 0, out: "", err: "", hash: commit.out.trim() };
}
