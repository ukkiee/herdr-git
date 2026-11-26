// node install.test.mjs: install.mjs against a stand-in app home and a stand-in herdr-app,
// in temporary folders only: the order of its steps, where it stops having changed
// nothing, how it copies the mod and how it adds keys.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { install, mergeKeys, addKeys } from "./install.mjs";
import { LOG_ID } from "./layout.mjs";

const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-install-`));
let count = 0;

// The parts of Herdr's shipped `main` the transform needs.
const main = () => ({
  id: "root", type: "row", children: [
    { id: "work", type: "column", resizable: false, children: [
      { id: "tabs", type: "block", size: { px: 42 }, content: { mod: "tabs" } },
      { id: "work-body", type: "row", children: [
        { id: "main", type: "block", content: { tab: "active" } },
        { id: "panel", type: "column", hidden: true, children: [
          { id: "panel-body", type: "stack", children: [
            { id: "files", type: "block", content: { mod: "files" } },
            { id: "changes", type: "block", content: { mod: "changes" } },
          ] },
        ] },
      ] },
    ] },
  ],
});

const WANTED = { "layout:git-tools": { "cmd-k": "mod.open:git-tools", "cmd-shift-g": "layout.toggle:git-log" } };

const put = (file, data) => {
  fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(file, data);
};

// A repository (`here`) with a mod of modules in subfolders, a test and an icon, and an app
// home that Herdr has opened once: its main layout and its keys.json are there.
const setup = ({ mainLayout = main(), keys = { global: { "cmd-q": "app.quit" } } } = {}) => {
  const dir = `${tmp}/case-${++count}`, here = `${dir}/repo`, home = `${dir}/home`;
  put(`${here}/mods/git-tools/main.js`, "export default 1;\n");
  put(`${here}/mods/git-tools/mod.json`, "{}\n");
  put(`${here}/mods/git-tools/core/git.js`, "export const git = 1;\n");
  put(`${here}/mods/git-tools/core/git.test.mjs`, "the test of git.js\n");
  put(`${here}/mods/git-tools/adapters/herdr.js`, "export const herdr = 1;\n");
  put(`${here}/mods/git-tools/view.test.mjs`, "the test of a view\n");
  put(`${here}/mods/git-tools/icons/x.svg`, "<svg/>\n");
  put(`${here}/keys.json`, JSON.stringify(WANTED, null, 2) + "\n");
  if (mainLayout) put(`${home}/layouts/main.json`, JSON.stringify(mainLayout, null, 2) + "\n");
  if (keys) put(`${home}/keys.json`, JSON.stringify(keys, null, 2) + "\n");
  return { here, home, mod: `${home}/mods/git-tools` };
};

const INSTALLED = ["adapters/herdr.js", "core/git.js", "icons/x.svg", "main.js", "mod.json"];

// A stand-in for herdr-app: answers status, check and the two layout commands as Herdr does
// and records each call with how its output was to be shown.
const fakeHerdr = (home, { running = true, check = 0, refuse = null } = {}) => {
  const calls = [];
  const herdr = (args, output) => {
    calls.push(`${args.join(" ")} [${output}]`);
    if (args[0] === "status") return running ? 0 : 1;
    if (args[0] === "check") return check;
    if (args[1] === "layout.clone") {
      const cloned = JSON.parse(fs.readFileSync(`${home}/layouts/main.json`, "utf8"));
      fs.writeFileSync(`${home}/layouts/git-tools.json`, JSON.stringify({ ...cloned, cloned_from: { name: "main", version: "0.1.16" } }));
      return 0;
    }
    if (args[1] === "layout.switch") {
      if (refuse) fs.writeFileSync(`${home}/layouts/git-tools.error`, refuse);
      return 0;
    }
    return 2;
  };
  return { herdr, calls };
};

const run = (paths, herdr, { useFs = fs } = {}) => {
  const out = [], err = [];
  const code = install({ fs: useFs, herdr, here: paths.here, home: paths.home, button: true, log: (l) => out.push(l), warn: (l) => err.push(l) });
  return { code, out, err };
};

const names = (dir, rel = "") => (fs.existsSync(`${dir}/${rel}`) ? fs.readdirSync(`${dir}/${rel}`, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? names(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort() : []);
// Every file of the app home with its bytes: what "nothing was changed" is checked against.
const snapshot = (dir) => Object.fromEntries(names(dir).map((n) => [n, fs.readFileSync(`${dir}/${n}`, "utf8")]));

// ---- first install, then again

{
  const paths = setup();
  const { herdr, calls } = fakeHerdr(paths.home);
  const mainBefore = fs.readFileSync(`${paths.home}/layouts/main.json`, "utf8");
  const r = run(paths, herdr);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.deepEqual(calls, [
    "status [quiet]",
    `check ${paths.mod} [shown]`,
    'do layout.clone {"name":"main","as":"git-tools"} [errors]',
    'do layout.switch {"name":"git-tools"} [errors]',
  ]);
  assert.deepEqual(names(paths.mod), INSTALLED, "the mod without its tests, subfolders included");
  assert.deepEqual(r.out, [
    "5 files updated, 0 already the same.",
    "Layout git-tools is shown. cmd-shift-l switches layouts; Herdr's main is unchanged.",
    "cmd-k → mod.open:git-tools (layout:git-tools)",
    "cmd-shift-g → layout.toggle:git-log (layout:git-tools)",
  ]);
  assert.deepEqual(r.err, []);
  const layout = JSON.parse(fs.readFileSync(`${paths.home}/layouts/git-tools.json`, "utf8"));
  assert.ok(JSON.stringify(layout).includes(`"id":"${LOG_ID}"`), "the file is the built layout");
  assert.deepEqual(layout.cloned_from, { name: "main", version: "0.1.16" }, "what the clone left is kept");
  assert.equal(fs.readFileSync(`${paths.home}/layouts/main.json`, "utf8"), mainBefore, "main is never written");
  const keys = JSON.parse(fs.readFileSync(`${paths.home}/keys.json`, "utf8"));
  assert.deepEqual(keys, { global: { "cmd-q": "app.quit" }, ...WANTED });

  // Again: nothing to write, no second clone, the layout and the keys byte for byte the same.
  const before = snapshot(paths.home);
  const again = fakeHerdr(paths.home);
  const r2 = run(paths, again.herdr);
  assert.equal(r2.code, 0);
  assert.deepEqual(again.calls, ["status [quiet]", `check ${paths.mod} [shown]`, 'do layout.switch {"name":"git-tools"} [errors]']);
  assert.deepEqual(r2.out, [
    "0 files updated, 5 already the same.",
    "Layout git-tools is shown. cmd-shift-l switches layouts; Herdr's main is unchanged.",
  ]);
  assert.deepEqual(snapshot(paths.home), before);
}

// ---- stopping before anything is written

{
  const paths = setup({ mainLayout: null });
  const { herdr, calls } = fakeHerdr(paths.home);
  const before = snapshot(paths.home);
  const r = run(paths, herdr);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, [`No ${paths.home}/layouts/main.json: open Herdr once so it writes its layouts, then run this again. Nothing was changed.`]);
  assert.deepEqual(calls, [], "Herdr isn't asked anything");
  assert.deepEqual(snapshot(paths.home), before);
}

{
  const unshaped = main();
  unshaped.children[0].children[1].children[1].children[0].children.pop();
  const paths = setup({ mainLayout: unshaped });
  const { herdr, calls } = fakeHerdr(paths.home);
  const before = snapshot(paths.home);
  const r = run(paths, herdr);
  assert.equal(r.code, 1);
  assert.equal(r.err.length, 1);
  assert.match(r.err[0], /main\.json is not shaped like the Herdr main layout this was built for: node `changes`.* is missing/);
  assert.deepEqual(r.out, ["Nothing was changed."]);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(paths.home), before);
}

{
  const paths = setup();
  fs.writeFileSync(`${paths.home}/layouts/main.json`, "{ not json");
  const { herdr, calls } = fakeHerdr(paths.home);
  const r = run(paths, herdr);
  assert.equal(r.code, 1);
  assert.match(r.err[0], /^Cannot read .*main\.json: /);
  assert.deepEqual(r.out, ["Nothing was changed."]);
  assert.deepEqual(calls, []);
}

{
  const paths = setup();
  const { herdr, calls } = fakeHerdr(paths.home, { running: false });
  const before = snapshot(paths.home);
  const r = run(paths, herdr);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, ["Herdr isn't running (herdr-app status failed): open it, then run this again. Nothing was changed."]);
  assert.deepEqual(calls, ["status [quiet]"]);
  assert.deepEqual(snapshot(paths.home), before);
}

// ---- stopping later

// herdr-app check fails: its exit code is the install's, and no layout is written.
{
  const paths = setup();
  const { herdr, calls } = fakeHerdr(paths.home, { check: 3 });
  const r = run(paths, herdr);
  assert.equal(r.code, 3);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(`${paths.home}/layouts/git-tools.json`), false);
}

// Herdr refuses the layout: its reason is shown and no key is added.
{
  const paths = setup();
  const keysBefore = fs.readFileSync(`${paths.home}/keys.json`, "utf8");
  const { herdr } = fakeHerdr(paths.home, { refuse: "node `git-log`: unknown field\n" });
  const r = run(paths, herdr);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.slice(1), ["Herdr refused the new layout:", "node `git-log`: unknown field"]);
  assert.equal(fs.readFileSync(`${paths.home}/keys.json`, "utf8"), keysBefore);
}

// ---- keys

// No keys.json yet: the install ends well and says to add the keys by hand.
{
  const paths = setup({ keys: null });
  const r = run(paths, fakeHerdr(paths.home).herdr);
  assert.equal(r.code, 0);
  assert.equal(r.out.at(-1), `No ${paths.home}/keys.json yet: add the keys in keys.json by hand once Herdr has written one.`);
  assert.equal(fs.existsSync(`${paths.home}/keys.json`), false);
}

// A key bound to something else, in its section, in global or in terminal, stays the
// person's; a key already bound to the same action is skipped quietly.
{
  const wanted = { "layout:git-tools": { "cmd-k": "mod.open:git-tools", "cmd-shift-g": "layout.toggle:git-log", "cmd-j": "a", "cmd-l": { do: "b" } } };
  const keys = {
    "layout:git-tools": { "cmd-k": "mod.open:git-tools", "cmd-shift-g": "mine" },
    global: { "cmd-j": { do: "global thing" } },
    terminal: { "cmd-l": "clear" },
  };
  const frozen = structuredClone(keys);
  const r = mergeKeys(keys, wanted, "keys.json");
  assert.equal(r.changed, false);
  assert.deepEqual(r.keys, frozen);
  assert.deepEqual(keys, frozen, "the argument is not modified");
  assert.deepEqual(r.lines, [
    "cmd-shift-g is already mine (layout:git-tools): left as it is. Bind layout.toggle:git-log to another key in keys.json.",
    'cmd-j is already {"do":"global thing"} (global): left as it is. Bind a to another key in keys.json.',
    "cmd-l is already clear (terminal): left as it is. Bind {\"do\":\"b\"} to another key in keys.json.",
  ]);

  // An action that isn't a string is compared as JSON and added as it is.
  const added = mergeKeys({ global: {} }, { "layout:git-tools": { "cmd-l": { do: "b" } } }, "keys.json");
  assert.equal(added.changed, true);
  assert.deepEqual(added.keys["layout:git-tools"], { "cmd-l": { do: "b" } });
  assert.deepEqual(added.lines, ['cmd-l → {"do":"b"} (layout:git-tools)']);
  assert.equal(mergeKeys(added.keys, { "layout:git-tools": { "cmd-l": { do: "b" } } }, "keys.json").changed, false);
}

// A disk that fills up while the keys are written: the person's keys.json is still whole
// and unchanged, and nothing is left beside it.
{
  const dir = `${tmp}/keys-full`, file = `${dir}/keys.json`, wanted = `${dir}/wanted.json`;
  put(file, JSON.stringify({ global: { "cmd-x": "existing.action" } }, null, 2) + "\n");
  put(wanted, JSON.stringify(WANTED));
  const before = fs.readFileSync(file, "utf8");
  const halfFs = { ...fs, writeFileSync(path, data) { fs.writeFileSync(path, String(data).slice(0, 10)); throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); } };
  assert.throws(() => addKeys(halfFs, file, wanted, () => {}), /no space left/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["keys.json", "wanted.json"]);
  addKeys(fs, file, wanted, () => {});
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["layout:git-tools"]["cmd-k"], "mod.open:git-tools");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["keys.json", "wanted.json"]);
}

// The keys of this repository are what the install adds.
{
  const real = JSON.parse(fs.readFileSync(new URL("./keys.json", import.meta.url), "utf8"));
  assert.equal(real["layout:git-tools"]["cmd-k"], "mod.open:git-tools");
  assert.equal(mergeKeys({}, real, "keys.json").changed, true);
}

// ---- what is copied and what is cleaned up

// The modules the source no longer has go, in subfolders too: an older flat install, tests
// an older install copied. Every other file the app home has stays: icons, JSON, hidden
// files, anything in a hidden folder, files Herdr may keep there.
{
  const paths = setup();
  const { herdr } = fakeHerdr(paths.home);
  run(paths, herdr);
  const stale = ["git.js", "view-old.mjs", "view.test.mjs", "core/git.test.mjs", "core/old.js", "adapters/deep/gone.js"];
  const kept = ["old.svg", "state.json", "notes.txt", ".hidden.js", ".cache/x.js", "core/data.json", "core/.keep.mjs"];
  for (const name of [...stale, ...kept]) put(`${paths.mod}/${name}`, "from before\n");
  fs.writeFileSync(`${paths.here}/mods/git-tools/main.js`, "export default 2;\n");
  const r = run(paths, fakeHerdr(paths.home).herdr);
  assert.equal(r.code, 0);
  assert.equal(r.out[0], "1 file updated, 4 already the same, 6 removed.");
  for (const name of stale) assert.equal(fs.existsSync(`${paths.mod}/${name}`), false, name);
  for (const name of kept) assert.equal(fs.readFileSync(`${paths.mod}/${name}`, "utf8"), "from before\n", name);
  assert.equal(fs.readFileSync(`${paths.mod}/main.js`, "utf8"), "export default 2;\n");
  assert.deepEqual(names(paths.mod).filter((n) => !kept.includes(n)), INSTALLED);
}

// A module moved into a subfolder: the new place is written and the old one deleted, and
// every delete comes after every write is in place, so Herdr sees the whole change in one go.
{
  const paths = setup();
  put(`${paths.mod}/git.js`, "export const git = 1;\n");
  const order = [];
  const watched = {
    ...fs,
    renameSync(a, b) { if (b.startsWith(`${paths.mod}/`)) order.push(`rename ${b.slice(paths.mod.length + 1)}`); fs.renameSync(a, b); },
    unlinkSync(p) { if (p.startsWith(`${paths.mod}/`)) order.push(`delete ${p.slice(paths.mod.length + 1)}`); fs.unlinkSync(p); },
  };
  const r = run(paths, fakeHerdr(paths.home).herdr, { useFs: watched });
  assert.equal(r.code, 0);
  assert.equal(order.at(-1), "delete git.js");
  assert.equal(order.length, INSTALLED.length + 1);
  assert.ok(order.slice(0, -1).every((step) => step.startsWith("rename ")), order.join(", "));
  assert.equal(fs.existsSync(`${paths.mod}/git.js`), false);
  assert.equal(fs.readFileSync(`${paths.mod}/core/git.js`, "utf8"), "export const git = 1;\n");
}

// A copy that fails (a full disk) stops the install: nothing is renamed or deleted, the
// layout is not built.
{
  const paths = setup();
  put(`${paths.mod}/stale.js`, "from before\n");
  const halfFs = { ...fs, writeFileSync(path, data) { fs.writeFileSync(path, String(data).slice(0, 3)); throw new Error("no space left"); } };
  const { herdr, calls } = fakeHerdr(paths.home);
  const r = run(paths, herdr, { useFs: halfFs });
  assert.equal(r.code, 1);
  assert.deepEqual(r.err, [`Cannot copy to ${paths.mod}: no space left. Files already there are whole.`]);
  assert.deepEqual(names(paths.mod), ["stale.js"]);
  assert.deepEqual(calls, ["status [quiet]"]);
}

// ---- run as a script

// `node install.mjs` reads HERDR_APP_HOME, and stops on an app home Herdr hasn't opened
// before asking Herdr anything.
{
  const home = `${tmp}/script-home`;
  fs.mkdirSync(home);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./install.mjs", import.meta.url))], { env: { ...process.env, HERDR_APP_HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, `No ${home}/layouts/main.json: open Herdr once so it writes its layouts, then run this again. Nothing was changed.\n`);
  assert.deepEqual(fs.readdirSync(home), []);
}

console.log("ok");
