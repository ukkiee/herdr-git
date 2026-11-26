// node git-port.test.mjs: the shape of the git runner the use cases share (no app, no git).
import assert from "node:assert/strict";
import { chunks, ASK_IN_C, outsideRepo } from "./git-port.js";

// A long list of paths is split so each part fits one command: at most 1,000 paths and
// 60,000 bytes (three bytes a character, the most UTF-8 takes for these, plus one between),
// in order, nothing lost. A cost says what else a caller puts around each path.
{
  assert.deepEqual(chunks([]), []);
  assert.deepEqual(chunks(["a", "b"]), [["a", "b"]]);
  const many = Array.from({ length: 2500 }, (_, i) => `f${i}`);
  const parts = chunks(many);
  assert.deepEqual(parts.map((part) => part.length), [1000, 1000, 500]);
  assert.deepEqual(parts.flat(), many);
  // 100 characters cost 301 bytes: 199 fit in 60,000.
  const long = Array.from({ length: 400 }, (_, i) => String(i).padStart(100, "x"));
  assert.deepEqual(chunks(long).map((part) => part.length), [199, 199, 2]);
  assert.deepEqual(chunks(long).flat(), long);
  // A path too long for the limit by itself still goes, alone.
  const huge = "h".repeat(30000);
  assert.deepEqual(chunks(["a", huge, "b"]), [["a"], [huge], ["b"]]);
  assert.deepEqual(chunks(many.slice(0, 600), () => 200).map((part) => part.length), [300, 300]);
}

// Outside a repository is told by git's words in the C locale, never by the exit code alone.
{
  assert.deepEqual(ASK_IN_C, { LC_ALL: "C" });
  assert.equal(outsideRepo({ code: 128, err: "fatal: not a git repository (or any of the parent directories): .git" }), true);
  assert.equal(outsideRepo({ code: 128, err: "fatal: cannot change to '/gone': No such file or directory" }), false);
  assert.equal(outsideRepo({ code: -1, err: "not a git repository" }), false, "a runner failure (code -1) is not git's answer");
  assert.equal(outsideRepo({ code: 0, err: "" }), false);
}

console.log("ok");
