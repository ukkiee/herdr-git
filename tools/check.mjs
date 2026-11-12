// Full offline check: every *.test.mjs with node, then `herdr-app check mods/git-tools`.
//   node tools/check.mjs
// One line per test file (PASS or FAIL, its time, its last line, and what it skipped), then the
// totals. Exits 1 when a test or the app's check fails.
//
// - A test that prints "skip: …" still passes; the line shows what it left out. The icon theme's
//   reproduction check is one: it runs only with ICON_THEME_SOURCE set to the unpacked source
//   (see tools/gen-icon-theme.mjs), and this script passes the variable through.
// - `herdr-app check` needs the Herdr app's command line. Without it the step is reported as
//   skipped, not failed: the tests alone still say whether the git and pure modules hold.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MOD = "mods/git-tools";

// Generated icons hold no tests; .git and node_modules are not ours to walk.
const SKIP_DIRS = new Set([".git", "node_modules", "icons"]);
function findTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) findTests(join(dir, entry.name), out); }
    else if (entry.name.endsWith(".test.mjs")) out.push(join(dir, entry.name));
  }
  return out;
}

const lines = (text) => text.trim().split("\n").filter(Boolean);
const tests = findTests(root).sort();
const failed = [];
let skipped = 0;
for (const file of tests) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8", timeout: 600000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;
  const skips = lines(r.stdout ?? "").filter((l) => /^skip\b/i.test(l));
  if (skips.length) skipped++;
  if (!ok) failed.push(relative(root, file));
  console.log(`${ok ? "PASS" : "FAIL"} ${relative(root, file)} (${Date.now() - started} ms) ${lines(r.stdout ?? "").at(-1) ?? ""}${skips.length ? ` [${skips.join("; ")}]` : ""}`);
  if (!ok) console.log(lines(out).slice(-40).join("\n"));
}
console.log(`tests: ${tests.length} files, ${tests.length - failed.length} passed, ${failed.length} failed, ${skipped} with a skip${failed.length ? `: ${failed.join(", ")}` : ""}`);

let checked = true;
const started = Date.now();
const r = spawnSync("herdr-app", ["check", MOD], { cwd: root, encoding: "utf8", timeout: 300000 });
if (r.error?.code === "ENOENT") {
  console.log(`herdr-app check ${MOD}: skipped (herdr-app is not on PATH)`);
} else {
  checked = r.status === 0;
  console.log(`herdr-app check ${MOD}: ${checked ? "passed" : "FAILED"} (${Date.now() - started} ms)`);
  if (!checked) console.log(lines(`${r.stdout ?? ""}${r.stderr ?? ""}`).slice(-15).join("\n"));
}
process.exit(failed.length === 0 && checked ? 0 : 1);
