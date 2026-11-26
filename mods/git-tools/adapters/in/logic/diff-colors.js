// The Diff tab's row colors, from the theme's own colors. Pure: no herdr import
// (diff-colors.test.mjs).
//
// A row takes the hue of the theme's red or blue at full saturation, very dark on a dark
// background and very pale on a light one. A theme color laid over the background at an
// alpha would mix in the background's gray: themes with soft colors (graphite's #dc8c95 and
// #96b2d7) would give a dull rose and a gray blue that hardly stand apart.

// Lightness of a row (HSL, 0–1). On a dark background 0.12 is about as deep as a row can be
// and still read as colored (pure red gives #3d0000); 0.92 is its pale twin on a light one.
export const DARK_ROW = 0.12;
export const LIGHT_ROW = 0.92;

// rowColor(color, dark) → "#rrggbb": `color`'s hue at full saturation and the row lightness
// for a dark (`true`) or light background. A gray stays gray. `color` is "#rgb", "#rrggbb",
// "#rrggbbaa" (the alpha is ignored) or "rgb(a)(r, g, b…)"; anything else gives null.
export function rowColor(color, dark) {
  const rgb = parse(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => Math.min(255, v) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return hsl((h * 60 + 360) % 360, d ? 1 : 0, dark ? DARK_ROW : LIGHT_ROW);
}

function parse(color) {
  const s = String(color ?? "").trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1].slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  const rgb = fn?.slice(1, 4).map(Number);
  return rgb && rgb.every(Number.isFinite) ? rgb : null;
}

function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}
