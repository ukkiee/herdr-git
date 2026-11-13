// The notifications a Cherry-Pick or Revert Commit ends with, the same whether it ran at
// once (log-pick.js) or through the Smart dialog (view-smart.js): a commit already in, and
// a revert that went through. No `herdr` import: node tests it (pick-notes.test.mjs).

const SHORT = 8; // a hash as the notifications show it
const short = (hash) => String(hash ?? "").slice(0, SHORT);

// pickNotes(type, commits, r) → [{ title, body, level }]: title a message key, body
// { key, args } or { text }.
//   type: "cherry-pick" | "revert" (anything else has none). commits: the commits asked,
//   newest first, [{ hash, subject? }]. r: runOperation's or smartRun's result
//   ({ outcome, skipped? }).
export function pickNotes(type, commits, r) {
  if (type !== "cherry-pick" && type !== "revert") return [];
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const notes = skipped.map((hash) => (type === "cherry-pick"
    ? { title: "pick.nothingTitle", body: { key: "pick.nothingBody", args: { hash: short(hash) } }, level: "info" }
    : { title: "pick.nothingToRevert", body: { key: "pick.revertedAlready", args: { hash: short(hash) } }, level: "info" }));
  const reverted = (commits ?? []).filter((c) => !skipped.includes(c.hash));
  if (type === "revert" && r?.outcome === "done" && reverted.length) {
    notes.push({ title: "pick.revertDone", body: { text: reverted.map((c) => `${short(c.hash)} ${c.subject ?? ""}`.trim()).join("\n") }, level: "info" });
  }
  return notes;
}

// commitsOf(request) → [{ hash, subject }]: a Cherry-Pick or Revert request's commits with
// the subjects sent beside them (request.subjects, same order; "" where there is none).
export function commitsOf(request) {
  const hashes = Array.isArray(request?.commits) ? request.commits.filter((h) => typeof h === "string") : [];
  const subjects = Array.isArray(request?.subjects) ? request.subjects : [];
  return hashes.map((hash, i) => ({ hash, subject: typeof subjects[i] === "string" ? subjects[i] : "" }));
}

// noteText(t, note) → { title, body, level } in t's language, for notify().
export const noteText = (t, n) => ({ title: t(n.title), body: n.body.text ?? t(n.body.key, n.body.args), level: n.level });
