// The words on git-tools' screens in English and Korean: which language to use, the
// sentence a message key stands for, and times written the way each language writes them.
// No `herdr` import: node tests it (i18n.test.mjs). ui.js runs the commands that read the
// system's language and hands their output here.

import * as ui from "./messages-ui.js";
import * as restore from "./messages-restore.js";
import * as branches from "./messages-branches.js";
import * as filters from "./messages-filters.js";
import * as commit from "./messages-commit.js";
import * as log from "./messages-log.js";
import * as dialogs from "./messages-dialogs.js";
import * as files from "./messages-files.js";

export const LANGS = ["en", "ko"];

// pickLang(tags) → "ko" | "en": Korean when the first preferred language is Korean
// ("ko-KR", "ko", "ko_KR.UTF-8"), English for anything else, nothing, or what can't be read.
export function pickLang(tags) {
  const first = Array.isArray(tags) ? String(tags[0] ?? "") : "";
  return /^ko(?:$|[-_.@])/i.test(first.trim()) ? "ko" : "en";
}

// readAppleLanguages(stdout) → the tags in `defaults read -g AppleLanguages` output, in
// order: '(\n    "ko-KR",\n    en\n)' → ["ko-KR", "en"]. [] for anything else (the
// command's error text, an empty answer).
export function readAppleLanguages(text) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("(") || !s.endsWith(")")) return [];
  return s.slice(1, -1).split(",").map((part) => part.trim().replace(/^"(.*)"$/s, "$1")).filter(Boolean);
}

// readLocaleEnv(stdout) → [the locale] from LC_ALL, LC_MESSAGES and LANG printed one per
// line in that order: the first one set wins, as it does for programs' messages.
export function readLocaleEnv(text) {
  const first = String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  return first ? [first] : [];
}

// systemLang(platform, read) → "ko" | "en" | null: the language of the window's computer.
// platform: the window's ("macos" | "linux" | "windows"). read: { code, stdout } of the
// command that asks that system (ui.js readSystemLang), null when it couldn't run.
// Windows answers with one culture name ("ko-KR\r\n"); an empty answer there is not known,
// unlike Linux where no locale variable set means the default, English.
// null: not known (no window to ask about yet, or the command failed or said nothing),
// which is not English: the copy keeps its language and asks again.
export function systemLang(platform, read) {
  if (platform !== "macos" && platform !== "linux" && platform !== "windows") return null;
  if (!read || read.code !== 0) return null;
  if (platform === "macos") return pickLang(readAppleLanguages(read.stdout));
  const tags = readLocaleEnv(read.stdout);
  if (platform === "windows" && !tags.length) return null;
  return pickLang(tags);
}

// ---- sentences

// Every message table, one per screen area (messages-<area>.js, each exporting
// { en, ko }, keys starting with "<area>."). Every area's table is listed here: a
// screen's words go into its own area's file, and this list stays as it is. A table
// that isn't listed is never used: i18n.test.mjs finds every
// messages-*.js in the folder and fails when one of its keys doesn't come out of `t`.
export const TABLES = [ui, restore, branches, filters, commit, log, dialogs, files];

// One value per key and language: a sentence, or for English words that change with a
// count, { one, other } (chosen by args.n: one when it is 1). Placeholders are {name},
// filled from args.
const merged = (tables, lang) => Object.assign({}, ...tables.map((table) => table?.[lang] ?? {}));

// translator(lang, tables?) → t(key, args?): the sentence for `key` in `lang` (English
// when the language isn't one we have). A key no table has comes back as the key itself,
// so a missing sentence shows on screen instead of a blank; a placeholder with no value
// stays as written ("{name}"). t.lang: the language it speaks.
export function translator(lang, tables = TABLES) {
  const l = LANGS.includes(lang) ? lang : "en", words = merged(tables, l);
  const t = (key, args = {}) => {
    let value = words[key];
    if (value && typeof value === "object") value = args?.n === 1 && "one" in value ? value.one : value.other;
    if (typeof value !== "string") return String(key);
    return value.replace(/\{(\w+)\}/g, (whole, name) => (args && args[name] !== undefined && args[name] !== null ? String(args[name]) : whole));
  };
  t.lang = l;
  return t;
}

// A module that writes its own sentences (a reason a path was skipped, why a write was
// refused) returns them in English, and with them msg: { key, args }: the key
// in a messages-<area>.js table, args plain JSON for its placeholders. The key is written
// as a string literal right after `msg: { key: ` so i18n.test.mjs can find it in the source.
//
// sentence(t, msg, text) → the sentence for msg in t's language, else `text` as it came
// (git's own words, or a result without msg). Never undefined.
export function sentence(t, msg, text) {
  if (msg && typeof msg.key === "string" && typeof t === "function") return t(msg.key, msg.args ?? {});
  return String(text ?? "");
}

// ---- times

// Written out by hand: the app's runtime has no Intl, and toLocale* ignore the language.
const pad2 = (n) => String(n).padStart(2, "0");
const hour12 = (d) => d.getHours() % 12 || 12;
const CLOCK = {
  en: (d) => `${hour12(d)}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`,
  ko: (d) => `${d.getHours() < 12 ? "오전" : "오후"} ${hour12(d)}:${pad2(d.getMinutes())}`,
};
const DAY = {
  en: (d) => `${d.getMonth() + 1}/${d.getDate()}/${pad2(d.getFullYear() % 100)}`,
  ko: (d) => `${pad2(d.getFullYear() % 100)}. ${d.getMonth() + 1}. ${d.getDate()}.`,
};
const WORDS = {
  en: { moments: "Moments ago", minutes: (n) => `${n} ${n === 1 ? "minute" : "minutes"} ago`, today: "Today", yesterday: "Yesterday", sep: ", " },
  ko: { moments: "방금 전", minutes: (n) => `${n}분 전`, today: "오늘", yesterday: "어제", sep: " " },
};
const known = (lang) => (LANGS.includes(lang) ? lang : "en");

// formatDateTime(seconds, lang) → the day and time, local: "11/9/26, 9:05 AM" |
// "26. 11. 9. 오전 9:05". seconds: unix seconds.
export function formatDateTime(seconds, lang) {
  const l = known(lang), d = new Date(seconds * 1000);
  return `${DAY[l](d)}${WORDS[l].sep}${CLOCK[l](d)}`;
}

// formatTime(seconds, lang, now?) → how long ago, local: within the hour "25 minutes ago" |
// "25분 전" (under a minute "Moments ago" | "방금 전"), then "Today 2:30 PM" | "오늘 오후
// 2:30", "Yesterday 11:06 PM" | "어제 오후 11:06", else formatDateTime. A time ahead of
// `now` (another machine's clock) is never "minutes ago". now: a Date.
export function formatTime(seconds, lang, now = new Date()) {
  const l = known(lang), w = WORDS[l];
  const then = new Date(seconds * 1000), ago = now.getTime() - then.getTime();
  if (ago >= 0 && ago < 60000) return w.moments;
  if (ago >= 0 && ago < 3600000) return w.minutes(Math.floor(ago / 60000));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (then >= today) return `${w.today} ${CLOCK[l](then)}`;
  if (then >= yesterday) return `${w.yesterday} ${CLOCK[l](then)}`;
  return formatDateTime(seconds, l);
}
