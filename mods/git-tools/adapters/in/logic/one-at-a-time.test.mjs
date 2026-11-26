// node one-at-a-time.test.mjs: a slow read asked for once per step runs one at a time, and of
// the asks that piled up meanwhile only the newest runs (no app, no git).
import assert from "node:assert/strict";
import { oneAtATime } from "./one-at-a-time.js";

const settle = () => new Promise((go) => setImmediate(go));

// A run that ends when the test says: `ran` lists what it was asked, `end(value)` ends the
// oldest one still going with that answer (or `fail(error)`).
const controlled = () => {
  const ran = [], going = [];
  const run = (arg) => { ran.push(arg); return new Promise((ok, no) => going.push({ ok, no })); };
  return { run, ran, end: (value) => going.shift().ok(value), fail: (error) => going.shift().no(error) };
};

// Arrowing through three commits while the first walk runs: the first ends with its own
// answer, the second is passed over (undefined, never run), the third runs next.
{
  const c = controlled();
  const ask = oneAtATime(c.run);
  const a = ask("a"), b = ask("b"), d = ask("d");
  await settle();
  assert.deepEqual(c.ran, ["a"]);
  assert.equal(await b, undefined);
  c.end("A");
  assert.equal(await a, "A");
  await settle();
  assert.deepEqual(c.ran, ["a", "d"]);
  c.end("D");
  assert.equal(await d, "D");
}

// Nothing going: an ask runs at once. A run that fails fails its own ask, and the next runs.
{
  const c = controlled();
  const ask = oneAtATime(c.run);
  const x = ask("x"), y = ask("y");
  await settle();
  c.fail(new Error("boom"));
  await assert.rejects(x, /boom/);
  await settle();
  assert.deepEqual(c.ran, ["x", "y"]);
  c.end("Y");
  assert.equal(await y, "Y");
  const z = ask("z");
  await settle();
  assert.deepEqual(c.ran, ["x", "y", "z"]);
  c.end("Z");
  assert.equal(await z, "Z");
}

// Each made one has its own turn: two screens never wait on each other.
{
  const c1 = controlled(), c2 = controlled();
  const one = oneAtATime(c1.run), two = oneAtATime(c2.run);
  one("p"); two("q");
  await settle();
  assert.deepEqual([c1.ran, c2.ran], [["p"], ["q"]]);
}

console.log("ok");
