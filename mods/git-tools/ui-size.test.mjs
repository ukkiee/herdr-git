// node ui-size.test.mjs: how wide a popup menu is drawn for its labels, and where the
// VCS widget's popup and a branch row's menu go.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { textWidth, menuWidth, belowSpot, pressSpot, sideOf, dialogFills, dialogRoom, ERROR_BOX, ERROR_ROOM, widgetBlockWidth } from "./ui-size.js";

// ---- text: a Hangul syllable is as wide as the font size, Latin letters narrower
{
  assert.equal(textWidth("", 12), 0);
  assert.equal(textWidth("가나다", 10), 30);
  const latin = textWidth("checkout", 10);
  assert.ok(latin > 30 && latin < 80, `latin width ${latin}`);
  // Narrow letters take less than wide ones.
  assert.ok(textWidth("iiii", 10) < textWidth("mmmm", 10));
}

// ---- menus: as wide as the longest label needs, between a floor and a ceiling
{
  const short = [{ label: "Checkout" }, { label: "Delete" }];
  assert.equal(menuWidth(short), 220);
  assert.equal(menuWidth(short, { min: 300 }), 300);

  // A long branch name in the label: the whole label fits, the action word included.
  const name = "'fix/widget-stud…le-inputs-main'";
  const long = [{ label: "체크아웃" }, { label: `${name}에서 새 브랜치…` }, { label: `체크아웃하고 ${name}에 리베이스` }];
  const w = menuWidth(long);
  assert.ok(w > 220, `width ${w}`);
  assert.ok(w >= textWidth(`체크아웃하고 ${name}에 리베이스`, 12.8) + 26, `width ${w} holds the longest label and the row padding`);
  // Never wider than the ceiling: the menu stays inside the window and the label is cut.
  assert.equal(menuWidth([{ label: "가".repeat(200) }], { max: 560 }), 560);
  // A hint on the right (a key) takes room too.
  assert.ok(menuWidth([{ label: "가".repeat(20), hint: "⌥⌘N" }]) > menuWidth([{ label: "가".repeat(20) }]));
  // Whole pixels.
  assert.equal(w, Math.ceil(w));
}

// ---- the widget's popup: right under the widget, its left edge on the widget's
{
  // pressed: the press's window position and its place inside the widget.
  const at = belowSpot({ position: { x: 900, y: 14 }, local: { x: 20, y: 9 }, height: 26 }, { width: 380 });
  assert.deepEqual(at, { x: 880, y: 5 + 26 + 2 });
  // Held left of a right limit (the widget's block ends there): the popup moves left.
  assert.deepEqual(belowSpot({ position: { x: 900, y: 14 }, local: { x: 20, y: 9 }, height: 26 }, { width: 380, right: 1100 }), { x: 720, y: 33 });
  // Never past the window's left edge.
  assert.deepEqual(belowSpot({ position: { x: 100, y: 14 }, local: { x: 20, y: 9 }, height: 26 }, { width: 380, right: 300 }), { x: 0, y: 33 });
  // Without the inside place (not measured yet): under the pointer.
  assert.deepEqual(belowSpot({ position: { x: 900, y: 14 }, height: 26 }, { width: 380 }), { x: 900, y: 14 + 26 + 2 });
}

// ---- the VCS widget's popup from a press, or from no press (opened by a menu item):
// no spot then, and the popup takes the middle of the window
{
  const press = { position: { x: 900, y: 14 }, local_position: { x: 20, y: 9 }, bounds: { height: 26 } };
  const seen = [];
  const right = (origin) => { seen.push(origin); return 1100; };
  assert.deepEqual(pressSpot(press, { width: 380, right }), { x: 720, y: 33 });
  assert.deepEqual(seen, [{ x: 880, y: 5 }]);
  assert.deepEqual(pressSpot({ position: { x: 900, y: 14 } }, { width: 380 }), { x: 900, y: 14 + 26 + 2 });
  assert.equal(pressSpot(null, { width: 380, right }), undefined);
  assert.equal(pressSpot(undefined, { width: 380 }), undefined);
}

// ---- a branch row's menu: on the right of the popup, or on the left when the popup
// sits at the window's right edge
{
  assert.equal(sideOf("right"), "right");
  assert.equal(sideOf("left"), "left");
  assert.equal(sideOf(undefined), "right");
  assert.equal(sideOf("up"), "right");
}

// ---- dialogs: a form is as tall as what it holds; a dialog built around a list or panes
// fills the room it was opened with, as do the questions drawn inside one of those
{
  for (const id of ["update-project", "branch-new", "rename-branch", "tag", "remote", "stash", "unstash", "reset", "reset-head",
    "reword", "squash", "drop-commits", "extract", "extract-initial", "merge", "rebase", "pull", "worktree", "patch",
    "vcs-abort", "conflicts-overwrite", "ir-cancel", "ir-noop", "reword-initial"]) {
    assert.equal(dialogFills(id), false, id);
  }
  for (const id of ["conflicts", "deleted-branches", "interactive-rebase", "merge-revisions", "restore", "push", "rollback", "smart",
    "create-patch", "apply-patch", "remotes", "mr-overwrite", "mr-unresolved"]) {
    assert.equal(dialogFills(id), true, id);
  }
}

// ---- a form dialog's room: what it was opened with plus room for its error text, so an
// error under the rows grows the card instead of squeezing it or cutting the buttons
{
  assert.equal(dialogRoom("reset", 390), 390 + ERROR_ROOM);
  assert.equal(dialogRoom("pull", 230), 230 + ERROR_ROOM);
  assert.ok(ERROR_ROOM >= ERROR_BOX + 16, "the box, the gap above it and its padding");
  // A dialog that fills its room keeps it: its list gives way to the error.
  assert.equal(dialogRoom("conflicts", 460), 460);
  assert.equal(dialogRoom("smart", 440), 440);
  // A share of the window (up to 1) is left as it is.
  assert.equal(dialogRoom("reset", 0.8), 0.8);
  assert.equal(dialogRoom("reset", undefined), undefined);
}

// Every form dialog's error text stays within the room openDialog keeps for it.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const tall = [];
  for (const name of readdirSync(here).filter((n) => /^view-.*\.js$/.test(n))) {
    const text = readFileSync(join(here, name), "utf8");
    for (const m of text.matchAll(/scrollText\("([\w-]+-error)"[^\n]*?maxHeight:\s*(\d+)/g)) {
      if (Number(m[2]) > ERROR_BOX) tall.push(`${name} ${m[1]} ${m[2]}`);
    }
  }
  assert.deepEqual(tall, [], `error text taller than ERROR_BOX (${ERROR_BOX})`);
}

// ---- the VCS widget's block: as wide as the widget plus its padding, whole pixels,
// never 0; null when it already is (no layout.resize then)
{
  // 2px of padding each side.
  assert.equal(widgetBlockWidth(151.3, 0, 2), 156);
  assert.equal(widgetBlockWidth(151.3, 156, 2), null);
  assert.equal(widgetBlockWidth(0, 240, 2), 4, "no widget (not a repository): the padding only");
  assert.equal(widgetBlockWidth(NaN, 240, 2), null, "not measured: left alone");
  assert.equal(widgetBlockWidth(80, 240, 2), 84);
}

console.log("ok");
