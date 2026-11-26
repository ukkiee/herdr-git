// node let-go.test.mjs: a closed screen's data fields are emptied in kind, its parts too,
// and what holds no data stays (no app needed).
import assert from "node:assert/strict";
import { letGo } from "./let-go.js";

class Part {
  constructor(host) { this.host = host; this.rows = [1, 2, 3]; this.byHash = new Map([["a", 1]]); this.top = 7; }
}
class List { constructor() { this.top = 3; } }
// A screen is an object of a class, as main.js makes one.
class Screen { constructor(fields) { Object.assign(this, fields); } }

// Data goes, in kind: a later read of a field finds the shape it had.
{
  const repo = { git: () => {}, root: "/repo", on: null };
  const turns = { start: () => 1, use: () => true };
  const screen = new Screen({
    refs: "r".repeat(5000), folder: "/repo", error: null,
    rows: [{ id: 1 }], picked: new Set(["a"]), seen: new Map([["k", { rows: [1] }]]),
    heads: { local: [1, 2], tags: ["v1"], current: "main", head: { branch: "main" } },
    repo, turns, list: new List(), closed: true, count: 3, wait: () => {},
  });
  screen.part = new Part(screen);
  const { part, list, wait } = screen;
  letGo(screen);

  assert.equal(screen.refs, "", "a long string is data");
  assert.equal(screen.folder, "/repo", "a short string is a name");
  assert.deepEqual(screen.rows, []);
  assert.ok(screen.picked instanceof Set && screen.picked.size === 0);
  assert.ok(screen.seen instanceof Map && screen.seen.size === 0);
  // A plain object: a copy, its own data fields emptied, one level deep.
  assert.deepEqual(screen.heads, { local: [], tags: [], current: "main", head: { branch: "main" } });
  // A record is another object from then on: work that compares it takes it for changed.
  assert.notEqual(screen.repo, repo);
  assert.deepEqual([screen.repo.root, screen.repo.git], [repo.root, repo.git]);
  assert.equal(repo.root, "/repo", "the record others may still hold is not touched");
  // An object made of functions still works.
  assert.equal(screen.turns.use(), true);
  // What holds no data stays as it is.
  assert.deepEqual([screen.error, screen.closed, screen.count], [null, true, 3]);
  assert.equal(screen.list, list);
  assert.equal(screen.wait, wait);
  // A part is emptied in place: it is still the screen's part, holding nothing.
  assert.equal(screen.part, part);
  assert.equal(part.host, screen);
  assert.deepEqual(part.rows, []);
  assert.equal(part.byHash.size, 0);
  assert.equal(part.top, 7);
}

// An object with a `host` that is not this screen is someone else's: left alone.
{
  const other = new Screen({}), screen = new Screen({ helper: new Part(other) });
  const { helper } = screen;
  letGo(screen);
  assert.equal(screen.helper, helper);
  assert.deepEqual(helper.rows, [1, 2, 3]);
}

console.log("ok");
