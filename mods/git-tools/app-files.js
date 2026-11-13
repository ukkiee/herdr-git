// The files git-tools keeps for the whole app, in the `git-tools` folder of the app's
// home (never the mod folder: a file saved there reloads every copy):
//   console.jsonl   the Git console's records (git-console.js), at most 512 KiB
//   settings.json   app-wide settings, one JSON object: other screens read and save
//                   their keys with appSetting / saveAppSetting
// Several copies may write at once, so every write goes through git-console.js
// updateText: writeTextFile only replaces what the copy read, and a refused write reads
// again, merges and writes again (three tries). A value kept per repository belongs in
// that repository's local git config (`gittools.*`), not here.

import { appHome, readTextFile, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { consoleEntry, readEntries, appendEntries, updateText } from "./git-console.js";
import { broadcast } from "./ui.js";

const DIR = "git-tools";
const CONSOLE = "console.jsonl";
const SETTINGS = "settings.json";

const folder = () => `${appHome()}/${DIR}`;
const pathOf = (name) => `${folder()}/${name}`;

// Whether writeTextFile makes a missing folder is not documented, so the folder is made
// first. Fine when it is there already.
async function ensureFolder() {
  try { await fs.mkdir(folder(), { recursive: true }); } catch { /* the write below says what went wrong */ }
}

const fileIo = (name) => ({
  read: () => readTextFile(pathOf(name)),
  write: async (text, expected) => { await ensureFolder(); await writeTextFile(pathOf(name), text, expected); },
});

// ---- the Git console

// The bus event that tells console tabs to read the log again. Small on purpose: the
// records stay in the file, never in the shared value (every write there redraws the window).
export const CONSOLE_EVENT = "console";

// recordGit(call): git.js's recorder (main.js installs it with recordWith): adds the call's
// record to the log and tells the console tabs. A failure is left to git.js, which ignores it.
export async function recordGit(call) {
  const entry = consoleEntry(call);
  const r = await updateText(fileIo(CONSOLE), (text) => appendEntries(text, [entry]));
  if (!r.ok) throw new Error(r.err);
  broadcast({ type: CONSOLE_EVENT });
}

// readConsole() → { ok: true, entries } | { ok: false, err }: the records, oldest first.
export async function readConsole() {
  try { return { ok: true, entries: readEntries(await readTextFile(pathOf(CONSOLE))) }; }
  catch (error) { return { ok: false, err: String(error?.message ?? error) }; }
}

// ---- app-wide settings

const parseSettings = (text) => {
  try {
    const value = JSON.parse(text ?? "");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

// appSettings() → the settings object ({} when there is none yet or it can't be read).
export async function appSettings() {
  try { return parseSettings(await readTextFile(pathOf(SETTINGS))); } catch { return {}; }
}

// appSetting(key, fallback?) → the value saved under `key`, else `fallback`.
export async function appSetting(key, fallback = undefined) {
  const all = await appSettings();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
}

// saveAppSetting(key, value) → { ok, err? }: saves one key (plain JSON; undefined removes
// it). Another copy's keys saved in the meantime are kept: the change is made again on
// what the file holds when a write is refused.
export async function saveAppSetting(key, value) {
  const r = await updateText(fileIo(SETTINGS), (text) => {
    const next = { ...parseSettings(text) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    const out = `${JSON.stringify(next, null, 2)}\n`;
    return out === text ? text : out;
  });
  return r.ok ? { ok: true } : { ok: false, err: r.err };
}
