// node commit-move.test.mjs: the Commit panel's first frame on a folder moved to is that
// folder's (no app, no git). Left to a timer, the move would be drawn one frame late, and
// that frame shows the folder left: its list and its folding, so a Changes group folded on
// the folder come back to opens for a moment. So
// - view-commit.js render calls this.move( before it draws (panelFrame) and before its timer,
// - move starts and stops nothing (no cx, no unwatch, no refresh): render may not,
// - recall builds no rows (no apply, rebuild, panelRows or buildRows): remember keeps them,
// - refresh stops the watches of the folder left, and starts the wait, once a move was
//   taken up (parted).
// The panel class imports gpui-kit, so node can't load it: its text is read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(join(here, name), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");

// The body of the class method `name(` at two spaces' indent, up to the next `  }` there.
function methodBody(text, name) {
  const m = text.match(new RegExp(`\\n {2}${name}\\(.*\\) \\{\\n`));
  if (!m) return "";
  const from = m.index + m[0].length;
  const end = text.indexOf("\n  }", from);
  return text.slice(from, end < 0 ? text.length : end);
}

// What is wrong with a body: `before` must come ahead of every one of `after`; none of
// `never` may appear.
export function orderProblems(name, body, { before = null, after = [], never = [] } = {}) {
  if (!body) return [`${name}: not found`];
  const problems = [];
  if (before) {
    const at = body.search(before);
    if (at < 0) problems.push(`${name}: no ${before.source}`);
    else for (const p of after) { const i = body.search(p); if (i >= 0 && i < at) problems.push(`${name}: ${p.source} before ${before.source}`); }
  }
  for (const p of never) if (p.test(body)) problems.push(`${name}: ${p.source}`);
  return problems;
}

// orderProblems on small texts.
{
  const good = "\n  render(cx) {\n    this.move(x);\n    this.moving.after(cx);\n    return panelFrame();\n  }";
  assert.deepEqual(orderProblems("render", methodBody(good, "render"), { before: /this\.move\(/, after: [/panelFrame\(/, /this\.moving\.after\(/] }), []);
  const late = "\n  render(cx) {\n    this.moving.after(cx);\n    this.move(x);\n  }";
  assert.deepEqual(orderProblems("render", methodBody(late, "render"), { before: /this\.move\(/, after: [/this\.moving\.after\(/] }), ["render: this\\.moving\\.after\\( before this\\.move\\("]);
  const starts = "\n  move(context) {\n    cx.notify();\n  }";
  assert.deepEqual(orderProblems("move", methodBody(starts, "move"), { never: [/\bcx\b/] }), ["move: \\bcx\\b"]);
  assert.deepEqual(orderProblems("move", methodBody(starts, "gone"), { never: [/x/] }), ["move: not found"]);
}

const panel = source("view-commit.js");
const problems = [
  ...orderProblems("view-commit.js render", methodBody(panel, "render"), { before: /this\.move\(/, after: [/panelFrame\(/, /this\.moving\.after\(/, /this\.refresh\(/] }),
  ...orderProblems("view-commit.js move", methodBody(panel, "move"), { never: [/\bcx\b/, /unwatch\(/, /this\.refresh\(/, /buildRows\(/, /panelRows\(/] }),
  ...orderProblems("view-commit.js recall", methodBody(panel, "recall"), { never: [/this\.apply\(/, /this\.rebuild\(/, /panelRows\(/, /buildRows\(/, /\bcx\b/] }),
  ...orderProblems("view-commit.js remember", methodBody(panel, "remember"), { never: [/this\.rebuild\(/, /panelRows\(/, /buildRows\(/] }),
];
if (!/this\.rows/.test(methodBody(panel, "recall"))) problems.push("view-commit.js recall: doesn't take the kept rows");
if (!/if \(this\.parted\) \{ this\.parted = false; this\.unwatch\(\); this\.stay\.moved\(\); \}/.test(methodBody(panel, "refresh"))) problems.push("view-commit.js refresh: doesn't stop the watches left once a move was taken up");
assert.deepEqual(problems, []);

console.log("commit-move: ok");
