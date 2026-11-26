// What a closed screen held is let go of. Pure: no herdr import (let-go.test.mjs).
//
// A screen and the handlers it gave the app point at each other, and the app's JS engine
// frees no cycles: a closed copy's screen stays in memory for good, with everything its
// fields still hold. A big repository's commit list, ref list and rows are megabytes, and
// all mods share one heap. So a closing copy empties its screen: the husk stays, the data
// goes.

// A string this long is data (a ref list, a file's text), not a name or a key.
const LONG = 1000;

const isPlain = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

// The same kind of value, holding nothing; what holds no data comes back as it is.
function emptied(v) {
  if (typeof v === "string") return v.length > LONG ? "" : v;
  if (Array.isArray(v)) return [];
  if (v instanceof Map) return new Map();
  if (v instanceof Set) return new Set();
  return v;
}

// letGo(screen): every field of `screen` that holds data gets an empty value of the same
// kind: "" for a long string, [] for an array, a new Map or Set, and for a plain object a
// copy whose own fields are emptied the same way (one level deep). The shapes stay, so
// work of the copy that still ends in the moment after its close finds what it expects;
// a record such as the repository is another object from then on, so that work takes the
// repository for changed and stops. The screen's parts (objects whose `host` it is) are
// emptied the same way. Numbers and flags, functions and objects of a class (lists, the
// app's handles) stay.
export function letGo(screen) {
  for (const key of Object.keys(screen)) {
    const v = screen[key];
    if (isPlain(v)) {
      const copy = {};
      for (const k of Object.keys(v)) copy[k] = emptied(v[k]);
      screen[key] = copy;
    } else if (v !== null && typeof v === "object" && v.host === screen) letGo(v);
    else screen[key] = emptied(v);
  }
}
