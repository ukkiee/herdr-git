// node diff-colors.test.mjs: the Diff tab's row colors from theme colors (no app, no git).
import assert from "node:assert/strict";
import { rowColor, DARK_ROW, LIGHT_ROW } from "./diff-colors.js";

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const [r, g, b] = rgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hue = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => v / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

// The color's hue at full saturation: a deep shade on a dark background, a pale one on a light.
assert.equal(rowColor("#ff0000", true), "#3d0000");
assert.equal(rowColor("#0000ff", true), "#00003d");
assert.equal(rowColor("#ff0000", false), "#ffd6d6");
assert.equal(rowColor("#0000ff", false), "#d6d6ff");
assert.equal(DARK_ROW, 0.12);
assert.equal(LIGHT_ROW, 0.92);

// A soft theme color keeps its hue but loses the gray an alpha tint would mix in.
for (const color of ["#dc8c95", "#96b2d7", "#c62a2a", "#1f62d0"]) {
  for (const dark of [true, false]) {
    const row = rowColor(color, dark);
    assert.match(row, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(hue(row) - hue(color)) < 3, `${color} → ${row} keeps the hue`);
    const [r, g, b] = rgb(row), max = Math.max(r, g, b), min = Math.min(r, g, b);
    assert.ok(dark ? min <= 1 : max >= 254, `${row} is at full saturation`);
  }
}

// Other spellings of a color, and what isn't one.
assert.equal(rowColor("#f00", true), "#3d0000");
assert.equal(rowColor("#ff0000cc", true), "#3d0000");
assert.equal(rowColor("rgb(255, 0, 0)", true), "#3d0000");
assert.equal(rowColor("#808080", true), "#1f1f1f", "a gray stays gray");
for (const nothing of [undefined, null, "", "red", "#12", "rgb(a, b, c)"]) assert.equal(rowColor(nothing, true), null);

// Herdr's graphite and paper and the shipped atom-one-dark: the text stays readable on both rows,
// and the `+`/`-` signs and line numbers (the theme's own red and blue) stand out from them.
const THEMES = [
  { name: "graphite", dark: true, background: "#17191d", foreground: "#d2d4d9", red: "#dc8c95", blue: "#96b2d7" },
  { name: "paper", dark: false, background: "#ffffff", foreground: "#25272c", red: "#c62a2a", blue: "#1f62d0" },
  { name: "atom-one-dark", dark: true, background: "#21252b", foreground: "#abb2bf", red: "#e06c75", blue: "#61afef" },
];
for (const t of THEMES) {
  for (const mark of [t.red, t.blue]) {
    const row = rowColor(mark, t.dark);
    assert.ok(contrast(t.foreground, row) >= 7, `${t.name}: text on ${row} is ${contrast(t.foreground, row).toFixed(1)}:1`);
    assert.ok(contrast(mark, row) >= 3, `${t.name}: ${mark} on ${row} is ${contrast(mark, row).toFixed(1)}:1`);
    assert.notEqual(row, t.background);
  }
  assert.notEqual(rowColor(t.red, t.dark), rowColor(t.blue, t.dark));
}

console.log("ok");
