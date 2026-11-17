// node commit-press.test.mjs: a press on the Commit panel that writes at once checks, before
// it writes, that the panel has taken up where the focused pane is (no app, no git).
// render notices a move but leaves it to a timer (it may change nothing), so for one frame
// host.repo is still the repository left; and right after the move is taken up, host.repo is
// the new one while the buttons on screen are still the old one's. A press in either gap
// would write to a repository the person wasn't looking at. So each of these
// - commit-form.js run, rebase and operate: calls this.behind(cx) before it takes the lock
//   (setBusy) or writes, and run calls no follow() before it (follow would make the new
//   repository the drawn one),
// - commit-form.js behind: asks host.settled() and compares host.repo with the repository
//   the form was last drawn for (this.where), and then reads again instead,
// - commit-stash-tab.js unstash: asks host.settled() and sameRepo(repo, this.host.repo)
//   before it takes the lock or writes,
// - view-commit.js settled: is the panel's location key against the one it shows.
// The panel classes import gpui-kit, so node can't load them: their text is read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(join(here, name), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");

// The body of the class method `name(` at two spaces' indent, up to the next `  }` there.
export function methodBody(text, name) {
  // The rest of the line, up to its last `) {`: a default argument may hold a call.
  const m = text.match(new RegExp(`\\n {2}${name}\\(.*\\) \\{\\n`));
  if (!m) return "";
  const from = m.index + m[0].length;
  const end = text.indexOf("\n  }", from);
  return text.slice(from, end < 0 ? text.length : end);
}

// Where in body the first of the patterns is, or -1.
const first = (body, patterns) => Math.min(...patterns.map((p) => body.search(p)).filter((i) => i >= 0), Infinity);

// What is wrong with an entrance: its check (a pattern) must come before every write mark.
export function pressProblems(name, body, check, writes, before = []) {
  if (!body) return [`${name}: not found`];
  const at = body.search(check);
  if (at < 0) return [`${name}: no check`];
  const problems = [];
  const write = first(body, writes);
  if (write === Infinity) problems.push(`${name}: no write found`);
  else if (write < at) problems.push(`${name}: writes before the check`);
  const early = first(body, before);
  if (early < at) problems.push(`${name}: ${body.slice(early).match(/^[\w.]+/)[0]} before the check`);
  return problems;
}

// pressProblems on small texts.
{
  const good = "\n  go(cx) {\n    if (this.behind(cx)) return;\n    host.setBusy({}, cx);\n    commit(repo.git);\n  }";
  assert.deepEqual(pressProblems("go", methodBody(good, "go"), /this\.behind\(cx\)/, [/setBusy\(/, /\bcommit\(/]), []);
  const late = "\n  go(cx) {\n    host.setBusy({}, cx);\n    if (this.behind(cx)) return;\n  }";
  assert.deepEqual(pressProblems("go", methodBody(late, "go"), /this\.behind\(cx\)/, [/setBusy\(/]), ["go: writes before the check"]);
  const none = "\n  go(cx) {\n    host.setBusy({}, cx);\n  }";
  assert.deepEqual(pressProblems("go", methodBody(none, "go"), /this\.behind\(cx\)/, [/setBusy\(/]), ["go: no check"]);
  const followed = "\n  go(cx) {\n    this.follow();\n    if (this.behind(cx)) return;\n    host.setBusy({}, cx);\n  }";
  assert.deepEqual(pressProblems("go", methodBody(followed, "go"), /this\.behind\(cx\)/, [/setBusy\(/], [/this\.follow\(\)/]), ["go: this.follow before the check"]);
  assert.deepEqual(pressProblems("go", methodBody(good, "gone"), /x/, [/y/]), ["go: not found"]);
}

const form = source("commit-form.js"), stash = source("commit-stash-tab.js"), panel = source("view-commit.js");
const behind = /this\.behind\(cx\)/;
const problems = [
  ...pressProblems("commit-form.js run", methodBody(form, "run"), behind, [/setBusy\(/, /\bcommit\(/, /this\.rebase\(/], [/this\.follow\(\)/]),
  ...pressProblems("commit-form.js rebase", methodBody(form, "rebase"), behind, [/setBusy\(/, /fixupInto\(/]),
  ...pressProblems("commit-form.js operate", methodBody(form, "operate"), behind, [/setBusy\(/, /skipOperation/, /askAbort\(/]),
  ...pressProblems("commit-stash-tab.js unstash", methodBody(stash, "unstash"), /\.settled\(\)/, [/setBusy\(/, /runUnstash\(/]),
  ...pressProblems("commit-stash-tab.js unstash", methodBody(stash, "unstash"), /sameRepo\(repo, this\.host\.repo\)/, [/setBusy\(/, /runUnstash\(/]),
];
const check = methodBody(form, "behind");
if (!/host\.settled\(\)/.test(check)) problems.push("commit-form.js behind: doesn't ask host.settled()");
if (!/place\(repo\) === this\.where|place\(repo\) !== this\.where/.test(check)) problems.push("commit-form.js behind: doesn't compare host.repo with this.where");
if (!/host\.refresh\(cx\)/.test(check)) problems.push("commit-form.js behind: doesn't read again");
if (!/\n {2}settled\(\)\s*\{\s*return this\.contextKey\(\) === this\.context;\s*\}/.test(panel)) problems.push("view-commit.js: no settled() { return this.contextKey() === this.context; }");
assert.deepEqual(problems, []);

console.log("commit-press: ok");
