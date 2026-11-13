// Tags, branch names and remotes: a new tag, renaming a branch, editing and removing a
// remote, pushing a tag. Every function takes `git` from makeGit (git.js) and the
// repository root and returns { ok, code, out, err, msg? } instead of throwing. No `herdr`
// import: node tests it against real repositories (git-refs.test.mjs).
//
// Names the person typed go to git as they are, after --end-of-options: git itself
// refuses a taken or malformed name, and its words are what the dialog shows. A name
// like "-f" stays a name.

// createTag(git, root, { name, commit }) → { ok, code, out, err }
//   A lightweight tag `name` on `commit` (a hash). A tag of that name already there, or
//   a name git won't take, fails with git's words and nothing changes.
export async function createTag(git, root, { name, commit }) {
  return git(root, ["tag", "--end-of-options", String(name ?? ""), String(commit ?? "")]);
}

// renameBranch(git, root, { from, to }) → { ok, code, out, err }
//   Renames the local branch `from`, the current one too (HEAD follows). git moves its
//   tracking setting and reflog with it; the remote branch keeps its name. A name taken by
//   another branch, or one git won't take, fails with git's words and nothing changes.
export async function renameBranch(git, root, { from, to }) {
  return git(root, ["branch", "-m", "--end-of-options", String(from ?? ""), String(to ?? "")]);
}

const refuse = (err, msg) => ({ ok: false, code: -1, out: "", err, msg });
// Fetching waits on the network: as long as the Log panel's Fetch. A push also waits on
// the remote's hooks: exec's cap, as git-push.js. Neither ever stops to ask for a password
// nobody could type: that is an error instead.
const FETCH = { timeout: 300000, env: { GIT_TERMINAL_PROMPT: "0" } };
const PUSH = { timeout: 600000, env: { GIT_TERMINAL_PROMPT: "0" } };

// readRemotes(git, root) → { ok, code, out, err, remotes: [name] } by name.
export async function readRemotes(git, root) {
  const r = await git.read(root, ["remote"]);
  return { ...r, remotes: r.ok ? r.out.split("\n").filter(Boolean).sort() : [] };
}

// readRemote(git, root, name) → { ok, err, msg?, name, url }
//   url: where it fetches from, as configured (no insteadOf rewriting).
export async function readRemote(git, root, name) {
  const list = await readRemotes(git, root);
  if (!list.ok) return { ...list, name, url: "" };
  if (!list.remotes.includes(name)) return { ...refuse(`There is no remote named "${name}".`, { key: "refs.noSuchRemote", args: { name } }), name, url: "" };
  const url = await git.read(root, ["config", "--get", `remote.${name}.url`]);
  return { ok: true, code: 0, out: "", err: "", name, url: url.ok ? url.out.trim() : "" };
}

// editRemote(git, root, { name, to, url }) → { ok, code, out, err, msg? }
//   The Define Remote dialog's OK: renames `name` to `to` when they differ (git moves its
//   remote branches and every branch's tracking setting along), then sets the URL when it
//   differs. An empty name or URL is refused before anything changes; a taken name fails
//   with git's words, also before anything changes. A failed URL after a rename leaves
//   the rename done.
export async function editRemote(git, root, { name, to, url }) {
  const next = String(to ?? "").trim(), where = String(url ?? "").trim();
  if (!next) return refuse("The remote name is empty.", { key: "refs.remoteNameEmpty", args: {} });
  if (!where) return refuse("The remote URL is empty.", { key: "refs.remoteUrlEmpty", args: {} });
  const now = await readRemote(git, root, name);
  if (!now.ok) return now;
  if (next !== name) {
    const r = await git(root, ["remote", "rename", "--end-of-options", name, next]);
    if (!r.ok) return r;
  }
  if (where === now.url) return { ok: true, code: 0, out: "", err: "" };
  return git(root, ["remote", "set-url", "--end-of-options", next, where]);
}

// addRemote(git, root, { name, url }) → { ok, code, out, err, msg? }
//   The Define Remote dialog's OK when it adds: a new remote fetching from `url`. An
//   empty name or URL is refused before anything changes; a taken name or one git won't
//   take fails with git's words.
export async function addRemote(git, root, { name, url }) {
  const next = String(name ?? "").trim(), where = String(url ?? "").trim();
  if (!next) return refuse("The remote name is empty.", { key: "refs.remoteNameEmpty", args: {} });
  if (!where) return refuse("The remote URL is empty.", { key: "refs.remoteUrlEmpty", args: {} });
  return git(root, ["remote", "add", "--end-of-options", next, where]);
}

// fetchRemote(git, root, name) → { ok, code, out, err }: fetches that one remote and
// prunes its remote branches that are gone, as the Log panel's Fetch does for all.
export async function fetchRemote(git, root, name) {
  return git(root, ["fetch", "--prune", "--end-of-options", name], FETCH);
}

// removeRemote(git, root, name) → { ok, code, out, err }
//   git removes the remote's branches and the tracking settings that named it too.
export async function removeRemote(git, root, name) {
  return git(root, ["remote", "remove", "--end-of-options", name]);
}

// pushTag(git, root, { tag, remote }) → { ok, code, out, err }
//   Pushes the tag to that remote under the same name. The full ref names on both sides
//   keep a branch of the same name out of it. A tag the remote already has with another
//   commit is refused by git (no force).
export async function pushTag(git, root, { tag, remote }) {
  return git(root, ["push", "--end-of-options", remote, `refs/tags/${tag}:refs/tags/${tag}`], PUSH);
}
