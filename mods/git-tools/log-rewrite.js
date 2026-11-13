// The Log panel's side of the history edits on the Commit list: Undo Commit…, Edit Commit
// Message…, Drop Commits and Squash Commits…. view-log.js ACTIONS calls the *Here
// functions with the commits picked (newest first); serve-actions.js calls the serve*
// functions when a dialog (view-reword.js, view-squash.js, view-drop-commits.js) asks this
// panel to write.
//
// Each item first reads the edit facts again and checks them (rebase-plan.js editCheck):
// the menu was worded on what the panel knew when it opened, the repository may have
// moved since. A reason goes to the panel's error strip. Then the item opens its dialog,
// or (Undo Commit, and Drop Commits once Don't ask again was checked) writes at once under
// the repository's write lock.
//
// After a write: a replay that stopped on conflicts opens the Conflicts dialog; one that
// stopped otherwise (a commit that came out empty) says so in a notification, as does an
// edit that ended (Dropped N commits, Commits Squashed, Commit Message Edited).

import { notify } from "herdr";
import { readEditFacts, readMessages, undoCommit, editMessage, dropCommits, squashCommits } from "./git-rewrite.js";
import { editCheck } from "./rebase-plan.js";
import { appSetting, saveAppSetting } from "./app-files.js";
import { broadcast, sentence } from "./ui.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { openReword } from "./view-reword.js";
import { openSquash } from "./view-squash.js";
import { openDropCommits } from "./view-drop-commits.js";

// The app setting that turns the Drop Commits confirmation off (app-files.js).
export const DONT_ASK_DROP = "rewrite.dropDontAsk";

const hashesOf = (commits) => (Array.isArray(commits) ? commits : [commits]).map((c) => c?.hash).filter((h) => typeof h === "string" && h);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const text = (value) => (typeof value === "string" ? value : "");

// What a write that ended says, and the Conflicts dialog when it stopped on conflicts.
//   r: the git-rewrite.js result. where: { root, on, owner, lang, t } of the panel.
//   done: the notification's title key when the edit ended, with its args.
function finish(r, where, done) {
  const { t } = where;
  if (r.outcome === "stopped") {
    if (openConflictsIfStopped(r, { root: where.root, on: where.on, owner: where.owner, lang: where.lang, who: "ui.logPanel" })) {
      notify({ title: t("ops.stopped"), body: r.operation?.current?.subject ?? "", level: "warning" });
    } else {
      notify({ title: t("rewrite.stoppedTitle"), body: t("rewrite.stoppedBody"), level: "warning" });
    }
  } else if (r.outcome === "done" && done) {
    notify({ title: t(done.key, done.args), body: "", level: "info" });
  }
}

const whereOf = (host, repo) => ({ root: repo.root, on: repo.on ?? null, owner: host.bus.id, lang: host.lang, t: host.t });

// Reads the facts for the commits picked and checks `action` on them; then(facts, initial)
// goes on when it is on (initial: the first commit is among them, to be asked about).
function prepare(host, commits, action, cx, then) {
  const repo = host.repo, hashes = hashesOf(commits);
  if (!repo || !hashes.length || host.writeBlock()) return;
  cx.spawn(async (cx) => {
    const facts = await readEditFacts(repo.git, repo.root, hashes);
    if (!host.shows(repo)) return;
    if (!facts.ok) { host.failedOn(repo, sentence(host.t, facts.msg, facts.err), cx); return; }
    const check = editCheck(action, facts, hashes.length);
    if (check.why) { host.fail(host.t(check.why.key, check.why.args), cx); return; }
    await then(facts, Boolean(check.confirm), cx);
    cx.notify();
  });
}

// Runs write() as this panel's work on repo, then tells every screen and says how it ended.
function runHere(host, repo, work, write, done, cx) {
  if (!host.setBusy(work, cx, repo)) return;
  cx.spawn(async (cx) => {
    let r;
    try { r = await write(); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
    // Released first: the panel skips reads while a write runs.
    host.setBusy(null, cx);
    if (r.ok || r.changed) broadcast({ type: "changed", root: repo.root });
    if (r.ok) finish(r, whereOf(host, repo), done);
    else host.failedOn(repo, sentence(host.t, r.msg, r.err) || host.t("ui.gitFailed"), cx);
    cx.notify();
  });
}

// ---- the items (view-log.js ACTIONS)

// Undo Commit…: no dialog; what the commit held stays as changes not committed.
export function undoHere(host, commits, cx) {
  // The commit picked, not HEAD as read now: if HEAD moved, the undo refuses.
  const [commit] = hashesOf(commits);
  prepare(host, commits, "undo", cx, () => {
    const repo = host.repo;
    runHere(host, repo, { key: "rewrite.undoing" }, () => undoCommit(repo.git, repo.root, { commit }), null, cx);
  });
}

// Edit Commit Message…: the dialog, with the commit's whole message.
export function editMessageHere(host, commits, cx) {
  const commit = (Array.isArray(commits) ? commits : [commits])[0];
  prepare(host, commits, "editMessage", cx, async (facts, initial) => {
    const repo = host.repo;
    const r = await readMessages(repo.git, repo.root, [commit.hash]);
    if (!r.ok) { host.failedOn(repo, sentence(host.t, r.msg, r.err), cx); return; }
    openReword({ root: repo.root, on: repo.on, owner: host.bus.id, commit: { hash: commit.hash, author: commit.author ?? "", message: r.messages[commit.hash] ?? "" }, pushed: facts.pushed, initial, lang: host.lang });
  });
}

// Drop Commits: the confirmation, unless Don't ask again was checked (the first commit is
// always asked about).
export function dropHere(host, commits, cx) {
  const hashes = hashesOf(commits);
  prepare(host, commits, "drop", cx, async (facts, initial) => {
    const repo = host.repo;
    if (!initial && (await appSetting(DONT_ASK_DROP, false)) === true) {
      runHere(host, repo, { key: "rewrite.dropping" }, () => dropCommits(repo.git, repo.root, { commits: hashes }), { key: "rewrite.dropped", args: { n: hashes.length } }, cx);
      return;
    }
    openDropCommits({ root: repo.root, on: repo.on, owner: host.bus.id, commits: hashes, branch: facts.branch, pushed: facts.pushed, initial, lang: host.lang });
  });
}

// Squash Commits…: the dialog, starting from the messages of the commits picked.
export function squashHere(host, commits, cx) {
  const hashes = hashesOf(commits);
  prepare(host, commits, "squash", cx, async (facts, initial) => {
    const repo = host.repo;
    const r = await readMessages(repo.git, repo.root, hashes);
    if (!r.ok) { host.failedOn(repo, sentence(host.t, r.msg, r.err), cx); return; }
    openSquash({ root: repo.root, on: repo.on, owner: host.bus.id, commits: hashes, message: r.joined, pushed: facts.pushed, initial, lang: host.lang });
  });
}

// ---- what the dialogs ask (serve-actions.js): (git, root, args, panel) → a result

const servedWhere = (root, args, panel) => ({ root, on: typeof args.on === "string" ? args.on : null, owner: panel?.bus?.id ?? null, lang: panel?.lang, t: panel?.t ?? ((key) => key) });

export async function serveReword(git, root, args, panel) {
  const r = await editMessage(git, root, { commit: text(args.commit), message: text(args.message) });
  if (r.ok) finish(r, servedWhere(root, args, panel), { key: "rewrite.reworded" });
  return r;
}

export async function serveSquash(git, root, args, panel) {
  const r = await squashCommits(git, root, { commits: strings(args.commits), message: text(args.message) });
  if (r.ok) finish(r, servedWhere(root, args, panel), { key: "rewrite.squashed" });
  return r;
}

export async function serveDrop(git, root, args, panel) {
  const commits = strings(args.commits);
  // Saved first: the person said so whatever the drop comes to.
  if (args.dontAsk === true) await saveAppSetting(DONT_ASK_DROP, true);
  const r = await dropCommits(git, root, { commits });
  if (r.ok) finish(r, servedWhere(root, args, panel), { key: "rewrite.dropped", args: { n: commits.length } });
  return r;
}
