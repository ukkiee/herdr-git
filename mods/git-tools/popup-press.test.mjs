// node popup-press.test.mjs: a press on the VCS widget while its popup is open only closes the
// popup (no app, no git). Herdr closes a popup on a press outside it and hands the same press
// to the widget, and a popup opened by that press gets no answer to the read its init starts
// (docs/herdr-mod-platform.md): it stayed on its skeleton.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { popupPress, SAME_PRESS } from "./popup-press.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(join(here, name), "utf8");

// Nothing open: the press opens the popup.
{
  assert.equal(popupPress().opens(), true);
}

// Open: the press closes it, whether the popup's answer comes after the press or never.
{
  const p = popupPress();
  p.opened();
  assert.equal(p.opens(), false, "the popup is open: this press closes it");
  assert.equal(p.opens(), true, "a popup whose answer never comes costs one press, not the widget");
}

// The popup's answer lands after the press that closed it: the next press opens, at once.
{
  let now = 1000;
  const p = popupPress({ now: () => now });
  const shown = p.opened();
  assert.equal(p.opens(), false);
  p.closed(shown);
  now += 1;
  assert.equal(p.opens(), true, "the third press of a quick run opens again");
}

// The popup's answer lands first, in the same press: that press still only closes it, once.
{
  let now = 1000;
  const p = popupPress({ now: () => now });
  p.closed(p.opened());
  now += SAME_PRESS - 1;
  assert.equal(p.opens(), false, "the press that closed the popup");
  assert.equal(p.opens(), true, "the press after it opens");
}

// Closed some time ago (Esc, a pick): the press opens.
{
  let now = 1000;
  const p = popupPress({ now: () => now });
  p.closed(p.opened());
  now += SAME_PRESS;
  assert.equal(p.opens(), true);
}

// An older popup's answer says nothing about the one open now.
{
  const p = popupPress();
  const first = p.opened();
  p.opened();
  p.closed(first);
  assert.equal(p.opens(), false, "the newer popup is still open");
}

// The widget asks before it opens the popup, and tells it what was opened and closed.
{
  const widget = source("view-vcs-widget.js");
  assert.match(widget, /on_mouse_down\("left", \(e, cx\) => \{ cx\.stop_propagation\(\); if \(this\.presses\.opens\(\)\) this\.open\(e, cx\); \}\)/);
  assert.match(widget, /this\.presses\.opened\(\)/);
  assert.match(widget, /this\.presses\.closed\(/);
}

// The popup starts its first read from a timer, the one place the gap doesn't reach.
{
  const popup = source("view-vcs-popup.js");
  const init = popup.slice(popup.indexOf("export default class VcsPopup"), popup.indexOf("firstLook(cx) {"));
  assert.match(init, /cx\.timer\.after\(0, \(cx\) => \{ this\.reload\(cx\); cx\.notify\(\); \}\)/);
  assert.doesNotMatch(init.replace(/cx\.timer\.after\(0, \(cx\) => \{ this\.reload\(cx\); cx\.notify\(\); \}\);/, ""), /this\.reload\(cx\)/, "init reads directly");
}

console.log("popup-press: ok");
