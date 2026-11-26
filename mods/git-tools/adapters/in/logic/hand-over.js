// What a screen has already read, handed to the popup it opens. Pure: no herdr import
// (hand-over.test.mjs).
//
// A branch list is too big for overlay props (a big repository has tens of thousands of tags),
// and the copies of this mod share their modules, so the popup takes the opener's own object:
// nothing is copied. One slot, emptied when taken, so nothing stays held for a popup that
// never came. Where the copies don't share the module the popup finds nothing here and reads
// as it would anyway.

let held = null;

// handOver(key, value): for the popup opened under `key`.
export function handOver(key, value) { held = { key, value }; }

// takeOver(key) → what was handed to the popup `key`, once; null otherwise.
export function takeOver(key) {
  if (held?.key !== key) return null;
  const { value } = held;
  held = null;
  return value;
}
