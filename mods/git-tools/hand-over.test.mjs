// node hand-over.test.mjs: what the VCS widget has read reaches the popup it opens, so the
// popup draws its list at once and reads again behind it (no app, no git).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handOver, takeOver } from "./hand-over.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(join(here, name), "utf8");

// Taken once, by the popup it was handed to; nothing stays held.
{
  const kept = { heads: { local: [] } };
  handOver("a", kept);
  assert.equal(takeOver("b"), null, "another popup's");
  assert.equal(takeOver("a"), kept);
  assert.equal(takeOver("a"), null, "taken");
}

// A newer popup's replaces the one nobody took.
{
  handOver("a", 1);
  handOver("b", 2);
  assert.equal(takeOver("a"), null);
  assert.equal(takeOver("b"), 2);
}

// The widget hands over only a whole read: what it recalls of a folder has no branch lists.
{
  const widget = source("view-vcs-widget.js");
  assert.match(widget, /const kept = this\.heads\?\.ok && this\.heads\.local \? \{ heads: this\.heads, prefs: this\.prefs \} : null/);
  assert.match(widget, /readFavorites\(repo\.git, repo\.root\)/);
}

// The popup shows what it was handed, and still reads: firstLook goes by its own read.
{
  const popup = source("view-vcs-popup.js");
  assert.match(popup, /const kept = takeOver\(p\.key\)/);
  assert.match(popup, /firstLook\(cx\) \{\s*if \(!this\.fresh\) this\.reload\(cx\);/);
}

console.log("hand-over: ok");
