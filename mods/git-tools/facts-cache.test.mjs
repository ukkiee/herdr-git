// node facts-cache.test.mjs: the edit facts a commit menu last read, kept per commits picked
// and refs state (no app, no git).
import assert from "node:assert/strict";
import { factsCache, factsKey, sameFacts, menuFacts, CACHE_MAX } from "./facts-cache.js";
import { MENUS, menuItems } from "./log-menus.js";

const facts = (head, more = {}) => ({ ok: true, head, branch: "main", operation: null, commits: [{ hash: "a", parents: 1, onBranch: true }], localChanges: false, ...more });

// Kept for the refs state it was read at: another state, or none known, finds nothing.
{
  const cache = factsCache();
  const key = factsKey({ root: "/r", on: null }, ["a"]);
  assert.equal(cache.get(key, "refs-1"), null);
  cache.put(key, "refs-1", facts("h1"));
  assert.deepEqual(cache.get(key, "refs-1"), facts("h1"));
  assert.equal(cache.get(key, "refs-2"), null, "a ref or HEAD moved since");
  assert.equal(cache.get(key, null), null, "the refs' state isn't known");
  cache.put(key, null, facts("h1"));
  assert.equal(cache.get(key, null), null, "nothing is kept without a refs state");
  cache.put(key, "refs-2", facts("h2"));
  assert.deepEqual(cache.get(key, "refs-2"), facts("h2"), "a newer read replaces the older");
  assert.equal(cache.get(key, "refs-1"), null);
}

// Only facts that were read: a failed read is not kept.
{
  const cache = factsCache();
  const key = factsKey({ root: "/r" }, ["a"]);
  cache.put(key, "refs", { ok: false, err: "fatal" });
  assert.equal(cache.get(key, "refs"), null);
  cache.put(key, "refs", undefined);
  assert.equal(cache.get(key, "refs"), null);
}

// The key: the repository (and its machine) and the commits picked, in their order.
{
  const here = { root: "/r", on: null }, there = { root: "/r", on: "box" };
  assert.notEqual(factsKey(here, ["a"]), factsKey(there, ["a"]));
  assert.notEqual(factsKey(here, ["a"]), factsKey({ root: "/s" }, ["a"]));
  assert.notEqual(factsKey(here, ["a", "b"]), factsKey(here, ["b", "a"]));
  assert.equal(factsKey(here, ["a", "b"]), factsKey({ root: "/r" }, ["a", "b"]));
  assert.equal(factsKey(here, []), null, "no commits: nothing to keep");
  assert.equal(factsKey(null, ["a"]), null);
}

// clear() forgets everything: git-tools wrote to the repository (an operation began, files
// changed) in ways the refs' state doesn't show.
{
  const cache = factsCache();
  const key = factsKey({ root: "/r" }, ["a"]);
  cache.put(key, "refs", facts("h"));
  cache.clear();
  assert.equal(cache.get(key, "refs"), null);
}

// At most CACHE_MAX sets of commits; the one used longest ago goes first.
{
  const cache = factsCache(3);
  const k = (h) => factsKey({ root: "/r" }, [h]);
  for (const h of ["a", "b", "c"]) cache.put(k(h), "refs", facts(h));
  assert.ok(cache.get(k("a"), "refs"), "a is used: b is now the oldest");
  cache.put(k("d"), "refs", facts("d"));
  assert.equal(cache.get(k("b"), "refs"), null);
  for (const h of ["a", "c", "d"]) assert.ok(cache.get(k(h), "refs"), h);
  assert.equal(cache.size(), 3);
  assert.ok(CACHE_MAX >= 8 && CACHE_MAX <= 64);
}

// menuFacts: what the menu shows while its facts are read.
{
  const handled = new Set(Object.values(MENUS).flat());
  const off = (ctx) => menuItems("commit", handled, { count: 1, current: "main", ...ctx }).filter((it) => it.disabled).map((it) => it.id).sort();
  const commit = { hash: "a".repeat(40), parents: 1, onBranch: true, pushedProtected: false };
  const partial = { ok: true, head: commit.hash, branch: "main", operation: null, protected: null, mergeAbove: false, pushed: false, oldest: commit.hash, commits: [commit] };
  const whole = { ...partial, localChanges: true };

  // Kept facts: settled from the start; the same facts read again change nothing.
  const kept = menuFacts(whole);
  const start = kept.now();
  assert.deepEqual(start, { edit: whole });
  assert.equal(kept.first(partial), start, "kept facts are whole already");
  assert.equal(kept.late(), start);
  assert.equal(kept.done({ ...whole, out: "x" }), start, "the same facts: no redraw");
  assert.deepEqual(kept.done({ ...whole, localChanges: false }), { edit: { ...whole, localChanges: false } }, "a change shows");
  const failed = menuFacts(whole);
  assert.equal(failed.done({ ok: false, err: "fatal" }), failed.now(), "a failed read keeps the kept facts");

  // None kept: waiting, then the first facts, then the whole.
  const cold = menuFacts(null);
  assert.deepEqual(cold.now(), { editPending: true });
  assert.ok(off(cold.now()).includes("commit.cherryPick"));
  assert.deepEqual(cold.first(partial), { edit: partial, editPending: true });
  assert.deepEqual(off(cold.now()), ["commit.cherryPick", "commit.fixup", "commit.rebaseOnto", "commit.squashInto"], "fixup and squash wait for git status");
  assert.deepEqual(cold.done(whole), { edit: whole });
  assert.deepEqual(off(cold.now()), ["commit.cherryPick", "commit.rebaseOnto"]);
  assert.equal(cold.late(), cold.now(), "too late to matter once read");

  // git status still running after FACTS_WAIT: nothing waits any more, what is known holds.
  const slow = menuFacts(null);
  slow.first(partial);
  assert.deepEqual(slow.late(), { edit: partial });
  assert.deepEqual(off(slow.now()), ["commit.cherryPick", "commit.rebaseOnto"], "fixup and squash on, checked when picked");
  assert.deepEqual(slow.done(whole), { edit: whole }, "the whole facts still land");

  // Nothing at all after FACTS_WAIT: every item on, checked when picked.
  const silent = menuFacts(null);
  assert.deepEqual(silent.late(), {});
  assert.deepEqual(off(silent.now()), []);
  assert.deepEqual(menuFacts(null).done({ ok: false }), {}, "a failed read: the items check when picked");
}

// sameFacts: whether a newer read changes anything the menu shows.
{
  assert.equal(sameFacts(facts("h"), facts("h")), true);
  assert.equal(sameFacts(facts("h"), facts("h2")), false);
  assert.equal(sameFacts(facts("h"), facts("h", { localChanges: true })), false);
  assert.equal(sameFacts(facts("h"), facts("h", { operation: "merge" })), false);
  assert.equal(sameFacts(facts("h", { out: "", err: "" }), facts("h", { out: "x", err: "y" })), true, "git's own words don't count");
  assert.equal(sameFacts(null, facts("h")), false);
  assert.equal(sameFacts(null, null), true);
}

console.log("ok");
