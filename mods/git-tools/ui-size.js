// Sizes and places the screens work out before they draw: how wide a popup menu must be
// for its labels, and where the VCS widget's popup and a branch row's menu go.
// No `herdr` import: node tests it (ui-size.test.mjs).
//
// A popup overlay gets its width when it opens and can't measure its text first, so the
// width comes from an estimate of the text. It errs wide: a menu a little wider than its
// longest label reads fine, one a little narrower cuts the label's end, which is the part
// that names the action ("…에 리베이스").

// Hangul, CJK and full-width forms: one em each.
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;
const NARROW = new Set([..."iljt.,:;'|!()[]{} `fIr"]);
const BROAD = new Set([..."mwMW@%"]);

// textWidth(text, size) → about how many px `text` takes at font size `size`.
export function textWidth(text, size) {
  let em = 0;
  for (const ch of String(text ?? "")) {
    if (WIDE.test(ch)) em += 1;
    else if (ch.charCodeAt(0) > 0x7f) em += 0.9;
    else if (NARROW.has(ch)) em += 0.34;
    else if (BROAD.has(ch)) em += 0.86;
    else if (ch >= "A" && ch <= "Z") em += 0.7;
    else em += 0.6;
  }
  return em * size;
}

// The menu screen's (view-menu.js) row: the menu's padding on both sides, the row's own,
// the gap before a hint, and a little room so an estimate short by a few px still fits.
export const MENU_TEXT = 12.8, HINT_TEXT = 11;
const MENU_SIDES = 2 * 5 + 2 * 8 + 12, HINT_GAP = 9;

// menuWidth(items, { min, max }) → the menu's width in whole px: the longest row's need
// ([{ label, hint? }]), at least `min` and at most `max` (past it the label is cut).
export function menuWidth(items, { min = 220, max = 560 } = {}) {
  let need = 0;
  for (const it of items ?? []) {
    const hint = it?.hint ? HINT_GAP + textWidth(it.hint, HINT_TEXT) : 0;
    need = Math.max(need, textWidth(it?.label ?? "", MENU_TEXT) + hint);
  }
  return Math.ceil(Math.min(max, Math.max(min, need + MENU_SIDES)));
}

// belowSpot({ position, local, height }, { width, right }) → { x, y }: where a popup of
// `width` opens right under the element that was pressed, its left edge on the element's.
//   position: the press in the window; local: the press inside the element (absent before
//   the element is measured: the popup then goes under the pointer); height: the element's.
//   right: the rightmost px the popup may reach, or none; the popup moves left to keep it.
// It opens 2 px below the element, so the element stays in sight.
export function belowSpot({ position, local, height = 0 }, { width = 0, right } = {}) {
  const x0 = position.x - (local?.x ?? 0), y0 = position.y - (local?.y ?? 0);
  let x = x0;
  if (Number.isFinite(right)) x = Math.min(x, right - width);
  return { x: Math.max(0, x), y: y0 + height + 2 };
}

// Dialogs built around a list or panes: they need the room they were opened with, since
// a list's height comes from its container. Every other dialog is a form.
const FILLING = new Set([
  "conflicts", "deleted-branches", "interactive-rebase", "merge-revisions", "restore", "push", "rollback", "smart",
  "create-patch", "apply-patch", "remotes",
]);

// dialogFills(id) → whether the dialog frame `id` (ui.js dialogFrame) fills the room it
// was opened with; false: it is as tall as what it holds. The Merge Revisions dialog's
// questions ("mr-…") sit in a card of their own inside it and fill that card.
export const dialogFills = (id) => FILLING.has(id) || String(id).startsWith("mr-");

// sideOf(side) → which side of the popup a branch row's menu opens on: "right" as the
// reference product does, or "left" when the popup sits at the window's right edge.
export const sideOf = (side) => (side === "left" ? "left" : "right");
