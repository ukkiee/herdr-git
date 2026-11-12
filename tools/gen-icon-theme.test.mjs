// node tools/gen-icon-theme.test.mjs: the lookup hints never answer less than the pattern, and
// regenerating the Icon theme gives the committed bytes. The second check runs only when
// ICON_THEME_SOURCE names the unpacked iconGenerator folder (see gen-icon-theme.mjs); without it
// that check is skipped, since the mod's own tests read only the committed output.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, hintOf } from "./gen-icon-theme.mjs";

// Would the mod try this rule for `name`? Filed under the whole name or the last extension
// (when it is filed at all), and holding one of the needles (when it has any).
const tried = (hint, name) => {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : undefined;
  if ((hint.names || hint.exts) && !(hint.names?.includes(name) || hint.exts?.includes(ext))) return false;
  return !hint.needles || hint.needles.some((needle) => name.includes(needle));
};

// "\s" in a pattern: a name holding any character JavaScript's \s matches (U+3000, U+2003,
// U+202F, ... besides the ASCII ones) still reaches the rule.
{
  const spaces = [];
  for (let code = 0; code <= 0xffff; code++) if (/^\s$/.test(String.fromCharCode(code))) spaces.push(String.fromCharCode(code));
  assert.ok(spaces.includes("　") && spaces.includes(" "), "JavaScript's \\s");
  for (const [pattern, around] of [["a\\sb", (c) => `a${c}b`], ["x\\s\\.md", (c) => `x${c}.md`], ["foo\\.[\\s]?txt", (c) => `foo.${c}txt`]]) {
    const hint = hintOf(pattern), re = new RegExp(`^(?:${pattern})$`);
    for (const c of spaces) {
      const name = around(c);
      assert.ok(re.test(name), `${pattern} matches ${JSON.stringify(name)}`);
      assert.ok(tried(hint, name), `${pattern} ${JSON.stringify(hint)} leaves out ${JSON.stringify(name)}`);
    }
  }
}

// A "+" after the extension is a quantifier, not part of it: ".*\.c+$" is not decided by the
// extension alone, and every name it matches still reaches the rule.
{
  for (const [pattern, names, not] of [[".*\\.c+$", ["x.c", "x.cc"], ["x.c+"]], [".*\\.(c+|h)$", ["x.c", "x.cc", "x.h"], ["x.c+"]]]) {
    const hint = hintOf(pattern), re = new RegExp(`^(?:${pattern})$`);
    assert.notEqual(hint.sure, true, `${pattern} ${JSON.stringify(hint)} is not sure`);
    for (const name of names) {
      assert.ok(re.test(name), `${pattern} matches ${name}`);
      assert.ok(tried(hint, name), `${pattern} ${JSON.stringify(hint)} leaves out ${name}`);
    }
    for (const name of not) assert.ok(!re.test(name), `${pattern} does not match ${name}`);
  }
  // Plain extensions keep the shortcut, "-" included (a literal outside a class).
  assert.deepEqual(hintOf(".*\\.(md|x-y)$"), { sure: true, exts: ["md", "x-y"] });
}

const src = process.env.ICON_THEME_SOURCE;
if (!src) {
  console.log("skip: set ICON_THEME_SOURCE to the unpacked iconGenerator folder to compare");
  console.log("ok");
  process.exit(0);
}

const committed = join(dirname(fileURLToPath(import.meta.url)), "../mods/git-tools");
const out = mkdtempSync(join(tmpdir(), "icon-theme-"));

const listFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();

try {
  generate(src, out);
  const made = listFiles(join(out, "icons/theme"));
  assert.deepEqual(made, listFiles(join(committed, "icons/theme")), "same files in icons/theme");
  for (const f of [...made.map((f) => join("icons/theme", f)), "icon-theme-data.js"]) {
    assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(committed, f))), `${f} differs`);
  }
  console.log(`${made.length + 1} files match ${relative(process.cwd(), committed) || "."}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log("ok");
