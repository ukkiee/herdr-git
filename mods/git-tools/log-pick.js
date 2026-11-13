// The Log panel's side of Cherry-Pick, Revert Commit, Revert Selected Changes and
// Cherry-Pick Selected Changes. view-log.js ACTIONS calls these with the commits picked
// (newest first) or Commit details' file row; each writes at once, no dialog, under the
// repository's write lock, then tells every screen the repository changed.
//
// How a write ended is said where the person looks: a revert that was committed, and a
// commit that had nothing left to cherry-pick, in a notification; files left in conflict
// in the Conflicts dialog; local changes in the way in the Smart dialog (whole commits)
// or the panel's error strip (some files); any other failure in the error strip.

import { notify } from "herdr";
import { runOperation } from "./git-operation.js";
import { revertChanges, cherryPickChanges } from "./git-changes.js";
import { readEditFacts } from "./git-rewrite.js";
import { menuItems } from "./log-menus.js";
import { broadcast, sentence } from "./ui.js";
import { openConflictsIfStopped } from "./view-conflicts.js";
import { offerSmart } from "./view-smart.js";

const SHORT = 8; // a hash as the notifications show it
const short = (hash) => String(hash ?? "").slice(0, SHORT);
const listOf = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean);
const where = (host, repo) => ({ root: repo.root, on: repo.on ?? null, owner: host.bus.id, lang: host.lang, who: "ui.logPanel" });

// Runs write() as this panel's work on repo; then(r) says how it ended.
function runHere(host, repo, work, write, then, cx) {
  if (!host.setBusy(work, cx, repo)) return;
  cx.spawn(async (cx) => {
    let r;
    try { r = await write(); } catch (error) { r = { ok: false, outcome: "failed", err: String(error?.message ?? error) }; }
    // Released first: the panel skips reads while a write runs.
    host.setBusy(null, cx);
    // A refusal changed nothing; anything else may have (a sequence that failed half way).
    if (r.outcome !== "refused") broadcast({ type: "changed", root: repo.root });
    then(r, cx);
    cx.notify();
  });
}

// The commits already in that a cherry-pick skipped, each in its own notification.
function sayNothingToPick(host, skipped = []) {
  for (const hash of skipped) notify({ title: host.t("pick.nothingTitle"), body: host.t("pick.nothingBody", { hash: short(hash) }), level: "info" });
}

// What a Cherry-Pick or Revert Commit ended in, for the commits asked (newest first).
function finishCommits(host, repo, request, commits, r, cx) {
  const at = where(host, repo);
  sayNothingToPick(host, request.type === "cherry-pick" ? r.skipped : []);
  if (r.outcome === "done" && request.type === "revert") {
    notify({ title: host.t("pick.revertDone"), body: commits.map((c) => `${short(c.hash)} ${c.subject ?? ""}`.trim()).join("\n"), level: "info" });
  } else if (r.outcome === "stopped") {
    if (!openConflictsIfStopped(r, at)) notify({ title: host.t("ops.stopped"), body: r.operation?.current?.subject ?? "", level: "warning" });
  } else if (r.outcome === "refused") {
    if (!offerSmart(r, { ...at, request })) host.failedOn(repo, sentence(host.t, r.msg, r.err) || host.t("ui.gitFailed"), cx);
  } else if (!r.ok) {
    host.failedOn(repo, sentence(host.t, r.msg, r.err) || host.t("ui.gitFailed"), cx);
  }
}

// Cherry-Pick or Revert Commit on the commits picked. The item was worded on what the
// menu knew; the facts are read again, as the repository may have moved since (and the
// Log toolbar's button has none to start with).
function commitsHere(host, commits, type, cx) {
  const repo = host.repo, list = listOf(commits).filter((c) => typeof c.hash === "string");
  if (!repo || !list.length || host.writeBlock()) return;
  const id = type === "cherry-pick" ? "commit.cherryPick" : "commit.revert";
  cx.spawn(async (cx) => {
    const facts = await readEditFacts(repo.git, repo.root, list.map((c) => c.hash));
    if (!host.shows(repo)) return;
    const [it] = menuItems("commit", new Set([id]), { count: list.length, ...(facts.ok ? { edit: facts } : {}) });
    if (it?.why) { host.fail(it.why.text ?? host.t(it.why.key, it.why.args), cx); return; }
    const request = { type, commits: list.map((c) => c.hash) };
    const work = { key: type === "cherry-pick" ? "pick.picking" : "pick.reverting" };
    runHere(host, repo, work, () => runOperation(repo.git, repo.root, request), (r, cx) => finishCommits(host, repo, request, list, r, cx), cx);
    cx.notify();
  });
}

// ---- the items (view-log.js ACTIONS)

export const cherryPickHere = (host, commits, cx) => commitsHere(host, commits, "cherry-pick", cx);
export const revertHere = (host, commits, cx) => commitsHere(host, commits, "revert", cx);
// The Log toolbar's Cherry-Pick: the commits picked in the Commit list.
export const cherryPickPicked = (host, cx) => commitsHere(host, host.pickedCommits(), "cherry-pick", cx);

// The commit and paths of Commit details' file rows (a row, or several): the commit a
// file's change is shown from, and a rename's two paths. Folders are skipped.
function filesOf(host, rows) {
  const files = listOf(rows).filter((m) => !m.folder && typeof m.path === "string");
  const commit = files.map((m) => m.item?.commit).find(Boolean) ?? host.details?.info?.hash ?? null;
  const paths = files.flatMap((m) => [m.path, m.item?.from]).filter((p) => typeof p === "string" && p);
  return { commit, paths };
}

// Revert Selected Changes and Cherry-Pick Selected Changes on Commit details' file rows.
function changesHere(host, rows, type, cx) {
  const repo = host.repo, { commit, paths } = filesOf(host, rows);
  if (!repo || !commit || !paths.length) return;
  const revert = type === "revert";
  const work = { key: revert ? "pick.revertingChanges" : "pick.pickingChanges" };
  const write = () => (revert ? revertChanges : cherryPickChanges)(repo.git, repo.root, { commit, paths });
  runHere(host, repo, work, write, (r, cx) => {
    if (r.outcome === "empty") {
      if (revert) notify({ title: host.t("pick.nothingToRevert"), body: host.t("pick.nothingToRevertBody", { hash: short(commit) }), level: "info" });
      else sayNothingToPick(host, [commit]);
    } else if (r.outcome === "stopped") {
      openConflictsIfStopped(r, where(host, repo));
    } else if (!r.ok) {
      host.failedOn(repo, sentence(host.t, r.msg, r.err) || host.t("ui.gitFailed"), cx);
    }
  }, cx);
}

export const revertChangesHere = (host, rows, cx) => changesHere(host, rows, "revert", cx);
export const cherryPickChangesHere = (host, rows, cx) => changesHere(host, rows, "cherry-pick", cx);
