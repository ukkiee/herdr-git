// Installs or updates git-tools in the Herdr app's home, builds the git-tools layout from
// the current main layout and shows it. Run it again after `git pull` and after every
// Herdr update (the layout is a copy: it doesn't follow Herdr's main by itself).
// Herdr's own main layout is never changed; cmd-shift-l moves to the next layout, main among them.
// Keys: adds the ones in keys.json unless they're already bound to something else.
//
//   node install.mjs    into $HERDR_APP_HOME, else ~/.config/herdr-app

import { readMain, writeLayout, writeWhole, copyChanged, copyReport, MOD } from "./layout.mjs";

const text = (action) => (typeof action === "string" ? action : JSON.stringify(action));

// mergeKeys(keys, wanted, file) → { keys, changed, lines }
//   Adds the bindings of `wanted` ({ section: { key: action } }) to `keys`, the parsed
//   app-home keys.json, which holds every key, the defaults included. A key already bound
//   to the same action is skipped. A key taken in its section, or in a section that
//   section would shadow (`global`, `terminal`), stays the person's and gets a line
//   saying so. `lines` are for the person; `file` is named in them. Pure: `keys` is
//   returned changed as a copy, the arguments are not modified.
export function mergeKeys(keys, wanted, file) {
  const out = structuredClone(keys), lines = [];
  let changed = false;
  for (const [section, binds] of Object.entries(wanted)) {
    for (const [key, action] of Object.entries(binds)) {
      if (text(out[section]?.[key]) === text(action)) continue;
      const taken = [section, "global", "terminal"].find((s) => out[s]?.[key] !== undefined);
      if (taken) {
        lines.push(`${key} is already ${text(out[taken][key])} (${taken}): left as it is. Bind ${text(action)} to another key in ${file}.`);
        continue;
      }
      (out[section] ??= {})[key] = action;
      changed = true;
      lines.push(`${key} → ${text(action)} (${section})`);
    }
  }
  return { keys: out, changed, lines };
}

// addKeys(fs, file, wantedFile, log): merges the keys of `wantedFile` into `file` with
// `mergeKeys` and logs its lines. The file is rewritten only when a key was added, and then
// whole (`writeWhole`): a write that fails halfway (a full disk) leaves the person's
// keys.json as it was. Throws as fs and JSON.parse do.
export function addKeys(fs, file, wantedFile, log) {
  const r = mergeKeys(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(fs.readFileSync(wantedFile, "utf8")), file);
  for (const line of r.lines) log(line);
  if (r.changed) writeWhole(fs, file, JSON.stringify(r.keys, null, 2) + "\n");
}

// herdrApp(spawnSync) → herdr(args, output) → exit code: runs `herdr-app <args>`.
//   output "quiet" shows nothing, "errors" only its stderr, "shown" all of it.
//   A herdr-app that can't be started counts as failing (127, as a shell has it).
export const herdrApp = (spawnSync) => (args, output) => {
  const stdio = output === "quiet" ? "ignore" : output === "errors" ? ["ignore", "ignore", "inherit"] : "inherit";
  const r = spawnSync("herdr-app", args, { stdio });
  if (r.error) {
    if (output !== "quiet") console.error(`Cannot run herdr-app: ${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
};

// install({ fs, herdr, here, home, button, log, warn }) → exit code
//   here: this repository's folder. home: the Herdr app's home. herdr: `herdrApp` or a
//   stand-in. button: whether the layout gets the Git button (`toMainGit`). log and warn
//   print a line to stdout and stderr.
//   The first four steps only look: if one fails, nothing has been written.
export function install({ fs, herdr, here, home, button, log = console.log, warn = console.error }) {
  const main = `${home}/layouts/main.json`, out = `${home}/layouts/git-tools.json`;
  const isFile = (path) => { try { return fs.statSync(path).isFile(); } catch { return false; } };

  if (!isFile(main)) {
    log(`No ${main}: open Herdr once so it writes its layouts, then run this again. Nothing was changed.`);
    return 1;
  }
  // Check before writing anything: a main layout this wasn't built for stops here.
  const built = readMain(fs, main, { button });
  if (!built.ok) {
    warn(built.error);
    log("Nothing was changed.");
    return 1;
  }
  if (herdr(["status"], "quiet") !== 0) {
    log("Herdr isn't running (herdr-app status failed): open it, then run this again. Nothing was changed.");
    return 1;
  }

  // Only files that differ are written: Herdr reloads the mod each time a file in its
  // folder is saved, and the mod has thousands of files.
  const mod = `${home}/mods/${MOD}`;
  try {
    fs.mkdirSync(mod, { recursive: true });
    log(copyReport(copyChanged(fs, `${here}/mods/${MOD}`, mod)));
  } catch (e) {
    warn(`Cannot copy to ${mod}: ${e.message}. Files already there are whole.`);
    return 1;
  }
  const checked = herdr(["check", mod], "shown");
  if (checked !== 0) return checked;

  // The first time, let Herdr clone main so its clicks (sizes, theme pick) come along.
  // layout.clone refuses a name that exists, so after that the file is rebuilt in place:
  // layouts apply live, and a file edit wins over a click on the same field.
  if (!isFile(out)) {
    const cloned = herdr(["do", "layout.clone", JSON.stringify({ name: "main", as: MOD })], "errors");
    if (cloned !== 0) return cloned;
  }
  try { writeLayout(fs, built.layout, out); }
  catch (e) {
    warn(`Cannot write ${out}: ${e.message}. The old file is unchanged.`);
    return 1;
  }
  const switched = herdr(["do", "layout.switch", JSON.stringify({ name: MOD })], "errors");
  if (switched !== 0) return switched;
  const refused = `${home}/layouts/${MOD}.error`;
  if (isFile(refused)) {
    log("Herdr refused the new layout:");
    log(fs.readFileSync(refused, "utf8").replace(/\n$/, ""));
    return 1;
  }
  log("Layout git-tools is shown. cmd-shift-l switches layouts; Herdr's main is unchanged.");

  // keys.json holds every key, the defaults included, so it's only ever added to.
  const keys = `${home}/keys.json`;
  if (!isFile(keys)) {
    log(`No ${keys} yet: add the keys in keys.json by hand once Herdr has written one.`);
    return 0;
  }
  try { addKeys(fs, keys, `${here}/keys.json`, log); }
  catch (e) {
    warn(`Cannot add the keys to ${keys}: ${e.message}. It is unchanged.`);
    return 1;
  }
  return 0;
}

const invoked = typeof process !== "undefined" && process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) {
  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
  const home = process.env.HERDR_APP_HOME || `${homedir()}/.config/herdr-app`;
  // Only on macOS: elsewhere the tab bar ends with the window's own buttons (minimize,
  // maximize, close), and a block right of it would sit outside them.
  process.exitCode = install({ fs, herdr: herdrApp(spawnSync), here, home, button: process.platform === "darwin" });
}
