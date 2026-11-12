// node i18n.test.mjs: choosing the language, wording sentences from the message tables,
// and times in both languages (no app, no git).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickLang, readAppleLanguages, readLocaleEnv, systemLang, translator, sentence, formatTime, formatDateTime } from "./i18n.js";

// The system's language from what was read on the window's computer. Not knowing is its
// own answer (null): right after the app starts there may be no window to ask about yet,
// or the command may fail, and English must not be taken for the system's language then.
{
  assert.equal(systemLang("macos", { code: 0, stdout: '(\n    "ko-KR",\n    en\n)' }), "ko");
  assert.equal(systemLang("macos", { code: 0, stdout: '(\n    "en-US"\n)' }), "en");
  assert.equal(systemLang("linux", { code: 0, stdout: "\n\nko_KR.UTF-8\n" }), "ko");
  assert.equal(systemLang("linux", { code: 0, stdout: "\n\n\n" }), "en");
  assert.equal(systemLang("macos", { code: 1, stdout: "" }), null, "the command failed");
  assert.equal(systemLang("macos", null), null, "the command couldn't run");
  assert.equal(systemLang("linux", { code: 127, stdout: "" }), null);
  assert.equal(systemLang(undefined, { code: 0, stdout: '("ko-KR")' }), null, "no window yet");
  assert.equal(systemLang(null, null), null);
}

// Windows: the culture name PowerShell prints for (Get-UICulture).Name, chosen by the same
// rule. A failed, missing or silent command is not known, never English.
{
  assert.equal(systemLang("windows", { code: 0, stdout: "ko-KR\r\n" }), "ko");
  assert.equal(systemLang("windows", { code: 0, stdout: "en-US\r\n" }), "en");
  assert.equal(systemLang("windows", { code: 0, stdout: "ja-JP\r\n" }), "en");
  assert.equal(systemLang("windows", { code: 0, stdout: "  \r\n ko-KR \r\n\r\n" }), "ko", "blanks around the name");
  assert.equal(systemLang("windows", { code: 0, stdout: "" }), null, "nothing printed");
  assert.equal(systemLang("windows", { code: 0, stdout: " \r\n\r\n" }), null, "only blank lines");
  assert.equal(systemLang("windows", { code: 1, stdout: "" }), null, "the command failed");
  assert.equal(systemLang("windows", { code: 1, stdout: "ko-KR\r\n" }), null, "a failed command's output");
  assert.equal(systemLang("windows", null), null, "no powershell to run");
}

// The first preferred language decides: Korean when it is Korean, English otherwise.
{
  assert.equal(pickLang(["ko-KR"]), "ko");
  assert.equal(pickLang(["ko"]), "ko");
  assert.equal(pickLang(["ko_KR.UTF-8"]), "ko");
  assert.equal(pickLang(["KO-kr"]), "ko");
  assert.equal(pickLang(["en-US", "ko-KR"]), "en");
  assert.equal(pickLang(["ja-JP", "ko-KR"]), "en");
  assert.equal(pickLang([]), "en");
  assert.equal(pickLang([""]), "en");
  assert.equal(pickLang(null), "en");
  assert.equal(pickLang(undefined), "en");
  // A tag that only starts with the letters k, o is another language (Konkani).
  assert.equal(pickLang(["kok-IN"]), "en");
}

// macOS: `defaults read -g AppleLanguages` prints a property list array.
{
  assert.deepEqual(readAppleLanguages('(\n    "ko-KR"\n)\n'), ["ko-KR"]);
  assert.deepEqual(readAppleLanguages('(\n    "en-US",\n    "ko-KR"\n)\n'), ["en-US", "ko-KR"]);
  assert.deepEqual(readAppleLanguages("(\n    en,\n    \"ko-KR\"\n)"), ["en", "ko-KR"]);
  assert.deepEqual(readAppleLanguages(""), []);
  assert.deepEqual(readAppleLanguages("The domain/default pair of (kCFPreferencesAnyApplication, AppleLanguages) does not exist"), []);
  assert.equal(pickLang(readAppleLanguages('(\n    "ko-KR"\n)\n')), "ko");
  assert.equal(pickLang(readAppleLanguages('(\n    "en-US",\n    "ko-KR"\n)\n')), "en");
  assert.equal(pickLang(readAppleLanguages("garbage")), "en");
}

// Linux: LC_ALL, LC_MESSAGES, LANG one per line; the first one set counts.
{
  assert.deepEqual(readLocaleEnv("\n\nko_KR.UTF-8\n"), ["ko_KR.UTF-8"]);
  assert.deepEqual(readLocaleEnv("en_US.UTF-8\n\nko_KR.UTF-8\n"), ["en_US.UTF-8"]);
  assert.deepEqual(readLocaleEnv("\n\n\n"), []);
  assert.equal(pickLang(readLocaleEnv("\nko_KR.UTF-8\nen_US.UTF-8\n")), "ko");
  assert.equal(pickLang(readLocaleEnv("C\n\nko_KR.UTF-8\n")), "en");
}

// t(key, args): the sentence for a key in the copy's language, with {name} filled in.
{
  const tables = [{
    en: { "demo.files": { one: "1 file", other: "{n} files" }, "demo.deleted": "Deleted branch '{name}' ({hash}).", "demo.plain": "Close" },
    ko: { "demo.files": "{n}개 파일", "demo.deleted": "브랜치 '{name}'({hash})을(를) 삭제했습니다.", "demo.plain": "닫기" },
  }];
  const en = translator("en", tables), ko = translator("ko", tables);
  assert.equal(en("demo.plain"), "Close");
  assert.equal(ko("demo.plain"), "닫기");
  assert.equal(en("demo.deleted", { name: "feature/x", hash: "1a2b3c4" }), "Deleted branch 'feature/x' (1a2b3c4).");
  assert.equal(ko("demo.deleted", { name: "feature/x", hash: "1a2b3c4" }), "브랜치 'feature/x'(1a2b3c4)을(를) 삭제했습니다.");
  // English counts: one and other; Korean has one form.
  assert.equal(en("demo.files", { n: 1 }), "1 file");
  assert.equal(en("demo.files", { n: 3 }), "3 files");
  assert.equal(en("demo.files", { n: 0 }), "0 files");
  assert.equal(ko("demo.files", { n: 1 }), "1개 파일");
  // A value that holds braces is put in as it is, not read as another placeholder.
  assert.equal(en("demo.deleted", { name: "{hash}", hash: "$&" }), "Deleted branch '{hash}' ($&).");
  // A missing key shows itself, so a missing sentence stands out on screen.
  assert.equal(en("demo.nope"), "demo.nope");
  assert.equal(ko("demo.nope", { n: 2 }), "demo.nope");
  // A missing value leaves its placeholder in sight.
  assert.equal(en("demo.deleted", { name: "x" }), "Deleted branch 'x' ({hash}).");
  // A language it doesn't know is English.
  assert.equal(translator("fr", tables)("demo.plain"), "Close");
  // t says which language it speaks (what a dialog opened from a screen gets).
  assert.equal(ko.lang, "ko");
  assert.equal(translator("fr", tables).lang, "en");

  // A git module's result: { err: English, msg: { key, args } }. A screen words it
  // from msg; without one it shows the text it got (git's own words).
  const r = { ok: false, err: "Deleted branch 'x' (1a2b3c4).", msg: { key: "demo.deleted", args: { name: "x", hash: "1a2b3c4" } } };
  assert.equal(sentence(ko, r.msg, r.err), "브랜치 'x'(1a2b3c4)을(를) 삭제했습니다.");
  assert.equal(sentence(en, r.msg, r.err), r.err);
  assert.equal(sentence(ko, undefined, "fatal: not a git repository"), "fatal: not a git repository");
  assert.equal(sentence(ko, { key: "demo.plain" }, "Close"), "닫기");
  assert.equal(sentence(ko, null, undefined), "");
}

// Times: English as the Commit list writes them; Korean in the usual Korean
// order ("3분 전", "어제 오후 11:06", "26. 11. 9. 오전 9:05").
{
  const now = new Date(2026, 10, 11, 15, 30, 0);
  const at = (...parts) => Math.floor(new Date(...parts).getTime() / 1000);
  const both = (seconds, when = now) => [formatTime(seconds, "en", when), formatTime(seconds, "ko", when)];
  assert.deepEqual(both(at(2026, 10, 11, 15, 29, 40)), ["Moments ago", "방금 전"]);
  assert.deepEqual(both(at(2026, 10, 11, 15, 29, 0)), ["1 minute ago", "1분 전"]);
  assert.deepEqual(both(at(2026, 10, 11, 15, 27, 0)), ["3 minutes ago", "3분 전"]);
  assert.deepEqual(both(at(2026, 10, 11, 15, 5, 0)), ["25 minutes ago", "25분 전"]);
  assert.deepEqual(both(at(2026, 10, 11, 14, 31, 0)), ["59 minutes ago", "59분 전"]);
  assert.deepEqual(both(at(2026, 10, 11, 14, 30, 0)), ["Today 2:30 PM", "오늘 오후 2:30"]);
  assert.deepEqual(both(at(2026, 10, 11, 0, 5, 0)), ["Today 12:05 AM", "오늘 오전 12:05"]);
  assert.deepEqual(both(at(2026, 10, 10, 23, 6, 0)), ["Yesterday 11:06 PM", "어제 오후 11:06"]);
  assert.deepEqual(both(at(2026, 10, 10, 12, 0, 0)), ["Yesterday 12:00 PM", "어제 오후 12:00"]);
  assert.deepEqual(both(at(2026, 10, 9, 9, 5, 0)), ["11/9/26, 9:05 AM", "26. 11. 9. 오전 9:05"]);
  assert.deepEqual(both(at(2025, 0, 2, 18, 45, 0)), ["1/2/25, 6:45 PM", "25. 1. 2. 오후 6:45"]);
  assert.deepEqual(both(at(2009, 0, 2, 18, 45, 0)), ["1/2/09, 6:45 PM", "09. 1. 2. 오후 6:45"]);
  // Just after midnight, a commit from before it is still minutes old.
  assert.deepEqual(both(at(2026, 10, 10, 23, 50, 0), new Date(2026, 10, 11, 0, 20, 0)), ["30 minutes ago", "30분 전"]);
  // A clock that runs ahead on another machine: no negative minutes.
  assert.deepEqual(both(at(2026, 10, 11, 15, 40, 0)), ["Today 3:40 PM", "오늘 오후 3:40"]);
  // A language it doesn't know is English.
  assert.equal(formatTime(at(2026, 10, 11, 14, 30, 0), "fr", now), "Today 2:30 PM");

  // The full date and time, whatever the day (Commit details).
  assert.equal(formatDateTime(at(2026, 10, 11, 14, 30, 0), "en"), "11/11/26, 2:30 PM");
  assert.equal(formatDateTime(at(2026, 10, 11, 14, 30, 0), "ko"), "26. 11. 11. 오후 2:30");
  assert.equal(formatDateTime(at(2026, 10, 9, 0, 5, 0), "en"), "11/9/26, 12:05 AM");
  assert.equal(formatDateTime(at(2026, 10, 9, 0, 5, 0), "ko"), "26. 11. 9. 오전 12:05");
}

// Every message table in the folder (messages-<area>.js, exporting en and ko), found here
// rather than listed, so a table another screen adds is checked without editing this test.
const here = path.dirname(fileURLToPath(import.meta.url));
const tableFiles = fs.readdirSync(here).filter((name) => /^messages-[a-z0-9-]+\.js$/.test(name)).sort();
const tables = await Promise.all(tableFiles.map(async (name) => ({ name, area: name.slice(9, -3), mod: await import(`./${name}`) })));
const holes = (value) => [...new Set((typeof value === "string" ? [value] : Object.values(value ?? {})).flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
const forms = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value) : [value]);

{
  assert.ok(tableFiles.includes("messages-ui.js"), "the shared parts' table is there");
  const seen = new Map();
  for (const { name, area, mod } of tables) {
    assert.ok(mod.en && typeof mod.en === "object" && mod.ko && typeof mod.ko === "object", `${name} exports en and ko`);
    assert.deepEqual(Object.keys(mod.ko).sort(), Object.keys(mod.en).sort(), `${name}: the same keys in both languages`);
    const en = translator("en"), ko = translator("ko");
    for (const key of Object.keys(mod.en)) {
      assert.ok(key.startsWith(`${area}.`), `${name}: ${key} starts with "${area}."`);
      assert.ok(!seen.has(key), `${key} is in ${seen.get(key)} and ${name}`);
      seen.set(key, name);
      assert.deepEqual(holes(mod.ko[key]), holes(mod.en[key]), `${name}: ${key} has the same placeholders in both languages`);
      for (const lang of ["en", "ko"]) {
        const value = mod[lang][key];
        assert.ok(typeof value === "string" || (value && typeof value === "object" && typeof value.other === "string"), `${name}: ${lang} ${key} is a sentence or { one, other }`);
        for (const s of forms(value)) assert.ok(typeof s === "string" && s.trim(), `${name}: ${lang} ${key} isn't empty`);
      }
      // Registered in i18n.js TABLES: an unlisted table's keys come back as the key.
      assert.notEqual(en(key, { n: 2 }), key, `${name} is listed in i18n.js TABLES (${key})`);
      assert.notEqual(ko(key, { n: 2 }), key, `${name} is listed in i18n.js TABLES (${key})`);
    }
  }
}

// Keys the mod's code uses are in the tables. Read from the source: a git module returns
// msg: { key: "<literal>", … } and a screen calls t("<literal>", …) (also this.t, tr, and
// a t got from a call, words(tr)("…")). A msg key that isn't a literal can't be checked,
// so it fails here.
{
  const en = translator("en"), ko = translator("ko");
  const sources = fs.readdirSync(here).filter((name) => name.endsWith(".js") && !name.startsWith("messages-")).sort();
  const used = [], hidden = [];
  for (const name of sources) {
    // Comment lines left out: they may show the shape without using a key.
    const text = fs.readFileSync(path.join(here, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const m of text.matchAll(/\bmsg\s*:\s*\{\s*key\s*:\s*(["'])([^"'\n]+)\1/g)) used.push([name, m[2]]);
    for (const m of text.matchAll(/\bmsg\s*:\s*\{\s*key\s*:\s*(?!["'])(\S[^,}\n]*)/g)) hidden.push(`${name}: msg key ${m[1]}`);
    for (const m of text.matchAll(/(?:\bt|\btr|\))\(\s*(["'])([a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+)\1/g)) used.push([name, m[2]]);
  }
  assert.deepEqual(hidden, [], "msg keys are string literals");
  assert.ok(used.some(([name, key]) => name === "ui.js" && key === "ui.noRepository"), "the scan finds ui.js's msg");
  for (const [name, key] of used) {
    assert.notEqual(en(key, { n: 2 }), key, `${name} uses ${key}, which no table has`);
    assert.notEqual(ko(key, { n: 2 }), key, `${name} uses ${key}, which no table has`);
  }
}

// The shared parts' words, as a Korean screen shows them.
{
  const ko = translator("ko"), en = translator("en");
  assert.equal(en("ui.notRepository", { folder: "/Users/me/notes" }), "/Users/me/notes is not in a git repository.");
  assert.equal(ko("ui.notRepository", { folder: "/Users/me/notes" }), "/Users/me/notes은(는) git 저장소 안에 있지 않습니다.");
  assert.equal(en("ui.running", { label: "Committing…" }), "Another git operation is running: Committing…");
  assert.equal(ko("ui.running", { label: "Committing…" }), "다른 git 작업이 실행 중입니다: Committing…");
  assert.equal(en("ui.loading"), "Loading…");
  assert.equal(ko("ui.loading"), "로드 중…");
}

// The Rollback dialog's note names the way back by the button's own name, in both
// languages. One state has one name: "No changes" is the same Korean in every table.
// Sentences end as their English does.
{
  const ko = translator("ko"), en = translator("en");
  assert.equal(en("dialogs.rollback.restoreLater"), "Rolled-back files can be brought back later with Restore Rolled-Back Changes…");
  assert.ok(en("dialogs.rollback.restoreLater").includes(en("restore.button")));
  assert.ok(ko("dialogs.rollback.restoreLater").includes(ko("restore.button")), ko("dialogs.rollback.restoreLater"));
  assert.equal(en("commit.noChanges"), en("log.noChanges"));
  assert.equal(ko("commit.noChanges"), "변경 사항 없음");
  assert.equal(ko("log.noChanges"), "변경 사항 없음");
  assert.equal(en("log.noCommit", { text: "abc1234" }).endsWith("."), ko("log.noCommit", { text: "abc1234" }).endsWith("."));
  // The words git-snapshot.js writes itself, worded in Korean with git's parts kept.
  assert.equal(ko("restore.failedNotAll", { err: "fatal: x", list: "a: y" }), "fatal: x\n지금 있는 것을 지키려고 복원하지 않은 파일:\na: y");
  assert.equal(ko("restore.recordChanged", { path: "src/a.ts" }), "기록하는 동안 기록할 파일이 바뀌었습니다(src/a.ts). 이 저장소에서 다른 롤백이 실행 중일 수 있습니다. 다시 시도하세요.");
}

console.log("ok");
