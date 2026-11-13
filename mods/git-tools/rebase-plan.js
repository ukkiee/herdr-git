// The rebase plan and the edit check, as pure functions. No `herdr` import: node tests it
// (rebase-plan.test.mjs).
//
// Every edit of history (Edit Commit Message on an older commit, Drop Commits, Squash
// Commits, and the rest built on them) replays the current branch from the oldest commit
// it touches. The screen's list of actions becomes git's to-do list here (todoList), and
// git-rewrite.js hands that list to `git rebase -i` in place of the editor.
//
// editCheck says why an edit item is off for the commits picked, in the words of the
// message tables (messages-rewrite.js): the Log panel's menu shows it on hover, and the
// write checks it again on what it reads just before running.

// The variables the exec lines read the messages from: GITTOOLS_MSG_0, GITTOOLS_MSG_1, …
// A message never goes into the line itself: the line is one line of shell, and a
// message has newlines, quotes and `$`.
export const MESSAGE_VAR = "GITTOOLS_MSG_";
export const ACTIONS = ["pick", "reword", "edit", "squash", "fixup", "drop"];
// What Commit details' file menu does to one commit: a pick followed by exec lines.
export const FILE_ACTIONS = ["extractChanges", "dropChanges"];
// The variables the exec lines read the paths from: one per step, a path per line.
export const PATHS_VAR = "GITTOOLS_PATHS_";
const MELDS = new Set(["squash", "fixup"]);

const refuse = (err, key, args = {}) => ({ ok: false, err, msg: { key, args }, lines: [], env: {}, groups: [] });
const badPlan = (why) => refuse(`The rebase plan is not valid: ${why}`, "rewrite.badPlan", { why });
const blank = (text) => !String(text ?? "").trim();

// A path as a line of a pathspec file: as it is, unless git would read it otherwise (a
// leading quote, a line break, a carriage return dropped at the line's end): then
// C-quoted, which git takes back apart.
const ESCAPES = { "\\": "\\\\", "\"": "\\\"", "\n": "\\n", "\t": "\\t", "\r": "\\r" };
function pathLine(path) {
  if (!/^"|[\x00-\x1f\x7f]/.test(path)) return path;
  return `"${path.replace(/[\\"\x00-\x1f\x7f]/g, (ch) => ESCAPES[ch] ?? `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

// The paths of variable `list` in the index (and the work tree) as they are in `source`:
// the parent of the commit picked last, by default, or the empty tree when that commit is
// the first one (`root`). A path the source lacks goes. Literal: `*.txt` is that file.
const restore = (list, root, where, source = root ? "\"$(git hash-object -t tree /dev/null)\"" : "HEAD~1") =>
  `printf '%s\\n' "$${list}" | GIT_LITERAL_PATHSPECS=1 git restore -q --source=${source} ${where} --pathspec-from-file=-`;
const AMEND_SAME = "git commit --amend --no-edit --allow-empty -q";

// todoList(steps, { refs }) → { ok, err?, msg?, lines, env, groups }
//   steps: [{ hash, action, message? }] in the order to replay, oldest first; action is
//   one of ACTIONS:
//   - pick: as it is. drop: left out.
//   - reword: picked, then given `message` (required).
//   - edit: picked, and the rebase stops after it (an operation in progress).
//   - squash: melded into the commit before it. Without a message both messages stay, as
//     git does; with one, that becomes the message of the melded commit.
//   - fixup: melded into the commit before it, keeping that one's message (or the
//     group's message, when a step of the group has one).
//   - dropChanges: picked, then the changes to `paths` leave it (the files go back to
//     how its parent had them, in the work tree too).
//   - extractChanges: picked, then split in two: the commit without the changes to
//     `paths` (its message), and after it a new commit of those changes with `message`
//     and the commit's author.
//   A file step whose commit is the first one of the history says `root: true`.
//   refs: { [hash]: [full ref name] } branches on commits of the range that move with
//   them (update-ref lines), each after its commit, or after the group it melds into.
//   lines: the to-do list, one command per line. env: the messages by variable name, for
//   the rebase's environment. groups: [{ head, members }] the commits melded into one.
//   A message given for a group is set after the group's last step: setting it earlier,
//   the next step melded would put its own message back.
export function todoList(steps, { refs = {} } = {}) {
  if (!Array.isArray(steps) || !steps.length) return badPlan("no steps");
  const lines = [], env = {}, groups = [];
  let group = null; // { head, members, message, refs }
  let picked = false; // a commit is there to meld into
  const close = () => {
    if (!group) return;
    if (group.message != null) {
      const name = `${MESSAGE_VAR}${Object.keys(env).length}`;
      env[name] = group.message;
      lines.push(`exec git commit --amend --allow-empty -q -m "$${name}"`);
    }
    if (group.members.length > 1) groups.push({ head: group.head, members: group.members });
    for (const ref of group.refs) lines.push(`update-ref ${ref}`);
    group = null;
  };
  for (const step of steps) {
    const { hash, action, message } = step ?? {};
    if (typeof hash !== "string" || !/^[0-9a-f]{7,64}$/.test(hash)) return badPlan("a step has no commit");
    if (!ACTIONS.includes(action) && !FILE_ACTIONS.includes(action)) return badPlan(`unknown action ${String(action)}`);
    const given = typeof message === "string" && !blank(message) ? message : null;
    if (action === "reword" && given == null) return refuse("Specify a commit message.", "commit.noMessage");
    const own = Array.isArray(refs[hash]) ? refs[hash] : [];
    if (MELDS.has(action)) {
      if (!picked || !group) return refuse(`There is no commit before ${hash.slice(0, 8)} to meld it into.`, "rewrite.nothingToMeld", { hash: hash.slice(0, 8) });
      // A message set for the group: git's squash would open the editor for it, so the
      // commit melds as a fixup and the message is set after the group.
      lines.push(`${action === "squash" && given == null && group.message == null ? "squash" : "fixup"} ${hash}`);
      group.members.push(hash);
      if (given != null) group.message = given;
      group.refs.push(...own);
      continue;
    }
    close();
    if (FILE_ACTIONS.includes(action)) {
      const paths = Array.isArray(step.paths) ? step.paths : [];
      if (!paths.length || paths.some((p) => typeof p !== "string" || !p)) return badPlan("a step has no paths");
      if (action === "extractChanges" && given == null) return refuse("Specify a commit message.", "commit.noMessage");
      const list = `${PATHS_VAR}${Object.keys(env).length}`;
      env[list] = paths.map(pathLine).join("\n");
      lines.push(`pick ${hash}`);
      if (action === "dropChanges") lines.push(`exec ${restore(list, step.root, "--staged --worktree")} && ${AMEND_SAME}`);
      else {
        const name = `${MESSAGE_VAR}${Object.keys(env).length}`;
        env[name] = given;
        lines.push(`exec c=$(git rev-parse HEAD) && ${restore(list, step.root, "--staged")} && ${AMEND_SAME}`
          + ` && ${restore(list, null, "--staged", "\"$c\"")} && git commit -q --allow-empty -C "$c"`
          + ` && git commit --amend --allow-empty -q -m "$${name}"`);
      }
      picked = true;
      group = { head: hash, members: [hash], message: null, refs: [...own] };
      continue;
    }
    if (action === "drop") {
      lines.push(`drop ${hash}`);
      for (const ref of own) lines.push(`update-ref ${ref}`);
      continue;
    }
    lines.push(`${action === "edit" ? "edit" : "pick"} ${hash}`);
    picked = true;
    group = { head: hash, members: [hash], message: action === "reword" ? given : null, refs: [...own] };
  }
  close();
  return { ok: true, err: "", lines, env, groups };
}

// ---- the edit check

// What each edit item works on: one commit, or two and more (Squash Commits).
const ONE = new Set(["undo", "editMessage", "fixup", "squashInto", "interactiveRebase", "extractChanges", "dropChanges"]);
const ALL_CHANGES = { extractChanges: "rewrite.extractAllChanges", dropChanges: "rewrite.dropAllChanges" };
const DURING = { merge: "rewrite.duringMerge", rebase: "rewrite.duringRebase", "cherry-pick": "rewrite.duringCherryPick", revert: "rewrite.duringRevert" };
const SHORT = 8;
const no = (key, args = {}) => ({ why: { key, args }, confirm: null });

// editCheck(action, facts, count?) → { why, confirm }
//   action: "undo" | "editMessage" | "fixup" | "squashInto" | "drop" | "squash" |
//     "interactiveRebase".
//   facts: git-rewrite.js readEditFacts for the commits picked: { head, operation,
//     protected, mergeAbove, localChanges?, commits: [{ hash, parents (a count),
//     onBranch, pushedProtected }] }; null while not read yet (then only `count`, the
//     number of commits picked, is checked).
//   why: null when the item is on, else { key, args } (messages-rewrite.js, log.*). In
//     order: how many commits, a merge commit, not on the current branch, an operation in
//     progress, pushed to the protected branch the current one tracks, a merge commit
//     between it and HEAD, then the item's own: Undo only on the last commit and not the
//     first one, Fixup and Squash Into only with local changes.
//   confirm: { title, body } keys when the first commit of the history is among them:
//     editing it is asked first. null otherwise.
//   files: for "extractChanges" and "dropChanges" (Commit details' file menu), { picked,
//     total }: how many of the commit's files are picked. Off for none, or for all of
//     them (the commit would be left empty), before anything the facts say.
export function editCheck(action, facts, count = facts?.commits?.length ?? 1, files = null) {
  const n = facts?.commits?.length ?? count;
  if (ONE.has(action) && n !== 1) return no("log.selectOneCommit");
  if (action === "squash" && n < 2) return no("rewrite.selectTwo");
  if (ALL_CHANGES[action] && files) {
    if (!(files.picked > 0)) return no("rewrite.selectFiles");
    if (files.picked >= files.total) return no(ALL_CHANGES[action]);
  }
  if (!facts) return { why: null, confirm: null };
  const commits = facts.commits ?? [];
  const merge = commits.find((c) => c.parents > 1);
  if (merge) return no("rewrite.parents", { n: merge.parents });
  const away = commits.find((c) => !c.onBranch);
  if (away) return no("rewrite.notInBranch", { hash: away.hash.slice(0, SHORT) });
  if (facts.operation) return no(DURING[facts.operation] ?? "rewrite.duringRebase");
  if (facts.protected && commits.some((c) => c.pushedProtected)) return no("rewrite.pushedProtected", { branch: facts.protected });
  if (facts.mergeAbove) return no("rewrite.mergeAbove");
  if (action === "undo") {
    if (commits[0]?.hash !== facts.head) return no("rewrite.notLast");
    if (commits[0].parents === 0) return no("rewrite.undoInitial");
  }
  if ((action === "fixup" || action === "squashInto") && facts.localChanges === false) return no("rewrite.nothingToCommit");
  const initial = action !== "undo" && commits.some((c) => c.parents === 0);
  return { why: null, confirm: initial ? { title: "rewrite.initialTitle", body: "rewrite.initialBody" } : null };
}
