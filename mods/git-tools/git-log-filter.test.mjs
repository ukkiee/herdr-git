// node git-log-filter.test.mjs: filter values → `git log` arguments, checked by the
// commits git-log.js reads back with them from a throwaway repository (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readLog, resolveCommit } from "./git-log.js";
import { filterArgs, isHash, isDate, readMe, userOf, readBranchNames, readAuthors, matchAuthors, DATE_PRESETS, datePreset, dateText } from "./git-log-filter.js";
import { translator } from "./i18n.js";

const tmp = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-filter-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const git = makeGit(exec, null);

const ANN = "Ann Lee <ann@example.com>", BOB = "Bob Stone <bob@example.com>", ME = "Me Myself <me@example.com>";
// `at`: unix seconds, for both dates (the Date filter reads the commit date).
const raw = (cwd, args, at, who = ANN) => {
  const [, name, email] = /^(.*) <(.*)>$/.exec(who);
  const date = at === undefined ? {} : { GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000` };
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...date, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
};
const commit = (cwd, file, message, at, who) => {
  mkdirSync(dirname(`${cwd}/${file}`), { recursive: true });
  writeFileSync(`${cwd}/${file}`, `${message} ${at}\n`);
  raw(cwd, ["add", "-A"]);
  raw(cwd, ["commit", "-q", "-m", message], at, who);
  return raw(cwd, ["rev-parse", "HEAD"]);
};

const now = Math.floor(Date.now() / 1000), HOUR = 3600, DAY = 24 * HOUR;
// Local wall-clock times: a typed date means that day where git runs.
const local = (y, m, d, h, min) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

// Dates only grow along the history, as in a real repository.
// main:    d1 - d2 - d3 - d4 - a1 - a2 - b1 - a3 - x1 - m1   (HEAD, origin/main)
// feature:                              \- f1
const repo = `${tmp}/repo`;
mkdirSync(repo);
raw(repo, ["init", "-q", "-b", "main"]);
raw(repo, ["config", "user.name", "Me Myself"]);
raw(repo, ["config", "user.email", "me@example.com"]);
const c = {};
c.d1 = commit(repo, "notes.txt", "day ten, noon", local(2020, 3, 10, 12, 0));
c.d2 = commit(repo, "notes.txt", "day eleven, just after midnight", local(2020, 3, 11, 0, 30));
c.d3 = commit(repo, "notes.txt", "day eleven, just before midnight", local(2020, 3, 11, 23, 30));
c.d4 = commit(repo, "notes.txt", "day twelve, noon", local(2020, 3, 12, 12, 0));
c.a1 = commit(repo, "docs/readme.md", "Initial import", now - 400 * DAY);
c.a2 = commit(repo, "src/login.js", "Fix login crash\n\nCloses ticket 4521.", now - 30 * DAY);
c.b1 = commit(repo, "docs/readme.md", "fix typo in docs", now - 10 * DAY, BOB);
raw(repo, ["checkout", "-q", "-b", "feature"]);
c.f1 = commit(repo, "src/search.js", "Add search (beta) [WIP]", now - 3 * DAY, BOB);
raw(repo, ["checkout", "-q", "main"]);
c.a3 = commit(repo, "src/parser.js", "Refactor a.b parser", now - 2 * DAY);
c.x1 = commit(repo, "other.txt", "Unrelated chore", now - 36 * HOUR, "Other Me <xme@example.com>");
c.m1 = commit(repo, "-dash.txt", "--all the things", now - 2 * HOUR, ME);
raw(tmp, ["init", "-q", "--bare", "origin.git"]);
raw(repo, ["remote", "add", "origin", `${tmp}/origin.git`]);
raw(repo, ["push", "-q", "origin", "main"]);
raw(repo, ["remote", "set-head", "origin", "main"]);

const nameOf = new Map(Object.entries(c).map(([name, hash]) => [hash, name]));
// The commits a filter leaves, by the names above, sorted: a set, not an order.
const found = async (filter, branch = null) => {
  const r = await readLog(git, repo, { branch, extra: filterArgs(filter) });
  assert.equal(r.ok, true, `${JSON.stringify(filter)}: ${r.err}`);
  return r.commits.map((commit) => nameOf.get(commit.hash)).sort();
};

// No filter adds nothing: the list is every commit.
{
  assert.deepEqual(filterArgs(), []);
  assert.deepEqual(filterArgs({}), []);
  assert.deepEqual(filterArgs({ text: "", user: "  ", since: "", until: null, paths: [] }), []);
  assert.deepEqual(filterArgs({ text: "   ", regex: true, matchCase: true, paths: [" ", ""] }), []);
  assert.deepEqual(await found({}), Object.keys(c).sort());
}

// Text: found anywhere in the message, as typed, whatever the case.
{
  assert.deepEqual(await found({ text: "fix" }), ["a2", "b1"]);
  assert.deepEqual(await found({ text: "FIX TYPO" }), ["b1"]);
  assert.deepEqual(await found({ text: "4521" }), ["a2"], "the body is searched too");
  assert.deepEqual(await found({ text: "no such words anywhere" }), []);
}

// Match Case.
{
  assert.deepEqual(await found({ text: "fix", matchCase: true }), ["b1"]);
  assert.deepEqual(await found({ text: "Fix", matchCase: true }), ["a2"]);
}

// Without Regex the text is literal; with it, a regular expression.
{
  assert.deepEqual(await found({ text: "a.b" }), ["a3"]);
  assert.deepEqual(await found({ text: "log.n" }), [], "a dot is a dot");
  assert.deepEqual(await found({ text: "log.n", regex: true }), ["a2"]);
  assert.deepEqual(await found({ text: "(beta) [WIP]" }), ["f1"]);
  assert.deepEqual(await found({ text: "^fix|search", regex: true }), ["a2", "b1", "f1"]);
  assert.deepEqual(await found({ text: "^(Fix|Add) ", regex: true, matchCase: true }), ["a2", "f1"]);
  assert.deepEqual(await found({ text: "^(fix|add) ", regex: true, matchCase: true }), ["b1"]);
  for (const text of ["^", "$", "*", "+", "?", "{2}", "|", "\\", "[", "]", "(", ")", "a|b"]) await found({ text });
  // A broken expression is git's error to report, not a throw.
  const broken = await readLog(git, repo, { extra: filterArgs({ text: "(", regex: true }) });
  assert.equal(broken.ok, false);
  assert.notEqual(broken.err, "");
}

// Text that looks like an option is still text.
{
  assert.deepEqual(await found({ text: "--all" }), ["m1"]);
  assert.deepEqual(await found({ text: "--all", regex: true }), ["m1"]);
  assert.deepEqual(await found({ text: "--author=Bob" }), []);
  assert.deepEqual(await found({ text: "-n1" }), []);
  assert.deepEqual(await found({ text: "--" }), ["m1"]);
}

// A hash-shaped search is a jump, not a message search.
{
  assert.equal(isHash(c.b1), true);
  assert.equal(isHash(c.b1.slice(0, 7)), true);
  assert.equal(isHash(`  ${c.b1.slice(0, 12).toUpperCase()} `), true);
  assert.equal(isHash(c.b1.slice(0, 6)), false, "too short");
  assert.equal(isHash(`${c.b1}0`), false, "too long");
  assert.equal(isHash("fix typo"), false);
  assert.equal(isHash("abcdefg"), false, "g is no hex digit");
  assert.equal(isHash(""), false);
  assert.equal(isHash(undefined), false);
  // The commit it names is the one the Log panel goes to (host.goTo resolves it this way).
  const hit = await resolveCommit(git, repo, c.b1.slice(0, 7));
  assert.deepEqual([hit.ok, hit.hash], [true, c.b1]);
  const miss = await resolveCommit(git, repo, "0123456789abcdef");
  assert.deepEqual([isHash("0123456789abcdef"), miss.ok, miss.hash], [true, false, null]);
}

// User: part of a name or an email, typed in any case, taken literally.
{
  assert.deepEqual(await found({ user: "bob" }), ["b1", "f1"]);
  assert.deepEqual(await found({ user: " Stone " }), ["b1", "f1"]);
  assert.deepEqual(await found({ user: "BOB@EXAMPLE.COM" }), ["b1", "f1"]);
  assert.deepEqual(await found({ user: "b.b" }), [], "not a regular expression");
  assert.deepEqual(await found({ user: "nobody" }), []);
  assert.deepEqual(await found({ user: "--all" }), [], "not an option");
  assert.deepEqual(await found({ user: "-n1" }), []);
  // The text's switches don't change how the user is matched.
  assert.deepEqual(await found({ user: "BOB", text: "fix", matchCase: true }), ["b1"]);
  assert.deepEqual(await found({ user: "b.b", text: "fix|Add", regex: true }), []);
  assert.deepEqual(await found({ user: "bob", text: "FIX|ADD", regex: true }), ["b1", "f1"]);
}

// User "me": the user git is configured with, and nobody whose email merely ends the same.
{
  const me = await readMe(git, repo);
  assert.deepEqual(me, { ok: true, err: "", name: "Me Myself", email: "me@example.com" });
  assert.deepEqual(await found({ user: userOf(me) }), ["m1"]);
  assert.deepEqual(await found({ user: "me@example.com" }), ["m1", "x1"], "typed, it is a part of the email");
  assert.equal(userOf({ name: "Only Name", email: "" }), "Only Name");
  // Nothing configured: there is no "me" to offer.
  const bare = `${tmp}/nobody`;
  mkdirSync(bare);
  raw(bare, ["init", "-q"]);
  const isolated = makeGit((cmd, args, options) => exec("env", ["GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", cmd, ...args], options), null);
  const nobody = await readMe(isolated, bare);
  assert.deepEqual([nobody.ok, nobody.name, nobody.email], [false, "", ""]);
  assert.notEqual(nobody.err, "");
  assert.deepEqual(nobody.msg, { key: "log.noUser", args: {} });
  const outside = await readMe(git, `${tmp}/missing-folder`);
  assert.equal(outside.ok, false);
}

// Date: the two ready-made ranges count back from now.
{
  assert.deepEqual(DATE_PRESETS.map((p) => p.label), ["Last 24 hours", "Last 7 days"]);
  const [day, week] = DATE_PRESETS;
  assert.deepEqual(await found({ since: day.since }), ["m1"]);
  assert.deepEqual(await found({ since: week.since }), ["a3", "f1", "m1", "x1"]);
}

// Date presets: what is kept (props.filters.date, the filter row's value) is the English
// name in every language; only the name on the screen follows the language.
{
  const en = translator("en"), ko = translator("ko");
  assert.equal(datePreset("Last 24 hours")?.since, "24 hours ago");
  assert.equal(datePreset("Last 7 days")?.since, "7 days ago");
  assert.equal(datePreset("지난 24시간"), null, "the Korean name is not a value to keep");
  assert.equal(datePreset(""), null);
  const day = { dateLabel: "Last 24 hours", since: "24 hours ago", until: "" };
  assert.equal(dateText(en, day), "Last 24 hours");
  assert.equal(dateText(ko, day), "지난 24시간");
  assert.equal(dateText(ko, { dateLabel: "Last 7 days", since: "7 days ago", until: "" }), "지난 7일");
  // Typed days: the words around them follow the language, the days stay as typed.
  assert.equal(dateText(en, { dateLabel: "", since: "2026-11-01", until: "" }), "From 2026-11-01");
  assert.equal(dateText(en, { dateLabel: "", since: "", until: "2026-11-09" }), "Until 2026-11-09");
  assert.equal(dateText(en, { dateLabel: "", since: "2026-11-01", until: "2026-11-09" }), "2026-11-01 – 2026-11-09");
  assert.equal(dateText(en, { dateLabel: "", since: "2026-11-01", until: "2026-11-01" }), "2026-11-01");
  assert.equal(dateText(ko, { dateLabel: "", since: "2026-11-01", until: "" }), "2026-11-01부터");
  assert.equal(dateText(ko, { dateLabel: "", since: "", until: "2026-11-09" }), "2026-11-09까지");
  assert.equal(dateText(ko, { dateLabel: "", since: "2026-11-01", until: "2026-11-09" }), "2026-11-01 – 2026-11-09");
  assert.equal(dateText(ko, { dateLabel: "", since: "", until: "" }), "");
}

// Date: a typed day covers that whole day, from its first minute to its last.
{
  assert.deepEqual(await found({ since: "2020-03-11", until: "2020-03-11" }), ["d2", "d3"]);
  assert.deepEqual(await found({ until: "2020-03-10" }), ["d1"]);
  assert.deepEqual(await found({ until: "2020-03-11" }), ["d1", "d2", "d3"]);
  assert.deepEqual(await found({ since: "2020-03-12", until: "2021-01-01" }), ["d4"]);
  assert.deepEqual(await found({ since: "2020-03-12" }), Object.keys(c).filter((name) => !["d1", "d2", "d3"].includes(name)).sort());
  assert.deepEqual(await found({ since: "2020-03-12", until: "2020-03-10" }), [], "an empty range");
  assert.equal(isDate("2020-03-11"), true);
  assert.equal(isDate(" 2024-02-29 "), true);
  assert.equal(isDate("2023-02-29"), false, "no such day");
  assert.equal(isDate("2020-13-01"), false);
  assert.equal(isDate("03/11/2020"), false);
  assert.equal(isDate("yesterday"), false);
  assert.equal(isDate(""), false);
}

// Date in a history whose dates go backwards (a rebase, a wrong clock): a commit older
// than the range doesn't hide the recent commits behind it.
// skewed: r1 (2 hours ago) - old (2015) - r2 (1 hour ago)
{
  const skewed = `${tmp}/skewed`;
  mkdirSync(skewed);
  raw(skewed, ["init", "-q", "-b", "main"]);
  const s = {
    r1: commit(skewed, "a.txt", "recent first", now - 2 * HOUR),
    old: commit(skewed, "a.txt", "dated long ago", local(2015, 6, 1, 12, 0)),
    r2: commit(skewed, "a.txt", "recent again", now - HOUR),
  };
  const names = new Map(Object.entries(s).map(([name, hash]) => [hash, name]));
  const inRange = async (filter) => {
    const r = await readLog(git, skewed, { extra: filterArgs(filter) });
    assert.equal(r.ok, true, r.err);
    return r.commits.map((commit) => names.get(commit.hash)).sort();
  };
  assert.deepEqual(await inRange({ since: DATE_PRESETS[0].since }), ["r1", "r2"]);
  assert.deepEqual(await inRange({ since: "2016-01-01" }), ["r1", "r2"]);
  assert.deepEqual(await inRange({ until: "2015-06-01" }), ["old"]);
}

// Path: a file or a folder from the repository root, taken literally.
{
  assert.deepEqual(await found({ paths: ["src"] }), ["a2", "a3", "f1"]);
  assert.deepEqual(await found({ paths: ["/src/"] }), ["a2", "a3", "f1"]);
  assert.deepEqual(await found({ paths: ["./docs/readme.md"] }), ["a1", "b1"]);
  assert.deepEqual(await found({ paths: ["docs", "-dash.txt"] }), ["a1", "b1", "m1"]);
  assert.deepEqual(await found({ paths: ["-dash.txt"] }), ["m1"], "not an option");
  assert.deepEqual(await found({ paths: ["--all"] }), []);
  assert.deepEqual(await found({ paths: ["src/*.js"] }), [], "no wildcards");
  assert.deepEqual(await found({ paths: [":!src"] }), [], "no pathspec magic");
  assert.deepEqual(await found({ paths: ["no/such/path"] }), []);
}

// Branch: the Log panel's branch limit, together with the filter's arguments.
{
  assert.deepEqual(await found({ user: "bob" }, "feature"), ["b1", "f1"]);
  assert.deepEqual(await found({ user: "bob" }, "main"), ["b1"]);
  assert.deepEqual(await found({ text: "search" }, "main"), []);
  assert.deepEqual(await found({ text: "search" }, "origin/main"), []);
  assert.deepEqual(await found({ paths: ["src"] }, "feature"), ["a2", "f1"]);
  const names = await readBranchNames(git, repo);
  assert.deepEqual(names, { ok: true, err: "", current: "main", local: ["feature", "main"], remote: ["origin/main"] });
  raw(repo, ["checkout", "-q", "--detach"]);
  assert.equal((await readBranchNames(git, repo)).current, null, "a detached HEAD is on no branch");
  raw(repo, ["checkout", "-q", "main"]);
  assert.equal((await readBranchNames(git, `${tmp}/missing-folder`)).ok, false);
}

// Filters together: a commit has to pass every one.
{
  const all = { text: "fix", user: "bob", since: "30 days ago", paths: ["docs"] };
  assert.deepEqual(await found(all), ["b1"]);
  assert.deepEqual(await found(all, "feature"), ["b1"]);
  assert.deepEqual(await found({ ...all, matchCase: true, regex: true, text: "^fix" }), ["b1"]);
  assert.deepEqual(await found({ ...all, user: "ann" }), []);
  assert.deepEqual(await found({ ...all, paths: ["src"] }), []);
  assert.deepEqual(await found({ ...all, since: "7 days ago" }), []);
  assert.deepEqual(await found({ ...all, until: "2020-03-12" }), []);
  assert.deepEqual(await found({ text: "fix", paths: ["src", "docs"], until: "11 days ago" }), ["a2"]);
}

// A filtered list is read in batches like the whole one: skip counts matching commits.
{
  const extra = filterArgs({ since: "2020-03-12", paths: ["src", "docs", "notes.txt"] });
  const whole = await readLog(git, repo, { extra });
  assert.deepEqual(whole.commits.map((commit) => nameOf.get(commit.hash)), ["a3", "f1", "b1", "a2", "a1", "d4"]);
  const pieces = [];
  for (let skip = 0; ; skip += 2) {
    const r = await readLog(git, repo, { skip, count: 2, extra });
    assert.equal(r.ok, true, r.err);
    pieces.push(...r.commits);
    if (r.commits.length < 2) break;
  }
  assert.deepEqual(pieces, whole.commits);
}

// The people of a repository: one more, with names that contain each other, odd
// characters, and commits reached only through a remote branch, a detached HEAD or a tag.
// people main: p1 Ann(x) - p2 Joann - p3 bob - p4 Ann(work) - p5 Zed - p6 Dr. - p7 -n1 Dash - p8 Nick
//        origin/gone: + r1 Remo (the local branch is deleted)
//        tag v-only:  + t1 Tagger Only (no branch has it)
//        HEAD (detached): + h1 Detached Dee
const people = `${tmp}/people`;
mkdirSync(people);
raw(people, ["init", "-q", "-b", "main"]);
const p = {};
p.p1 = commit(people, "a.txt", "ann one", now - 9 * DAY, "Ann <ann@x.com>");
p.p2 = commit(people, "a.txt", "joann one", now - 8 * DAY, "Joann <joann@x.com>");
p.p3 = commit(people, "b.txt", "bob one", now - 7 * DAY, "bob <bob@x.com>");
p.p4 = commit(people, "a.txt", "ann two", now - 6 * DAY, "Ann <ann@work.com>");
p.p5 = commit(people, "z.txt", "zed one", now - 5 * DAY, "Zed <zed@x.com>");
p.p6 = commit(people, "d.txt", "doctor one", now - 4 * DAY, "Dr. (A+B) [x] <dr@x.com>");
p.p7 = commit(people, "n.txt", "dash one", now - 3 * DAY, "-n1 Dash <dash@x.com>");
// .mailmap names the person behind an old name: git's --author goes by the mapped name.
writeFileSync(`${people}/.mailmap`, "Nick New <nick@x.com> Old Nick <nick@x.com>\n");
p.p8 = commit(people, "k.txt", "nick one", now - 2 * DAY, "Old Nick <nick@x.com>");
raw(people, ["checkout", "-q", "-b", "gone"]);
p.r1 = commit(people, "r.txt", "remo one", now - DAY, "Remo <remo@x.com>");
raw(tmp, ["init", "-q", "--bare", "people-origin.git"]);
raw(people, ["remote", "add", "origin", `${tmp}/people-origin.git`]);
raw(people, ["push", "-q", "origin", "gone"]);
raw(people, ["checkout", "-q", "main"]);
raw(people, ["branch", "-q", "-D", "gone"]);
raw(people, ["checkout", "-q", "-b", "tagged"]);
p.t1 = commit(people, "t.txt", "tagger one", now - DAY, "Tagger Only <tag@x.com>");
raw(people, ["tag", "v-only"]);
raw(people, ["checkout", "-q", "main"]);
raw(people, ["branch", "-q", "-D", "tagged"]);
raw(people, ["checkout", "-q", "--detach"]);
p.h1 = commit(people, "h.txt", "detached one", now - HOUR, "Detached Dee <dee@x.com>");

const pName = new Map(Object.entries(p).map(([name, hash]) => [hash, name]));
const pick = async (filter, branch = null) => {
  const r = await readLog(git, people, { branch, extra: filterArgs(filter) });
  assert.equal(r.ok, true, `${JSON.stringify(filter)}: ${r.err}`);
  return r.commits.map((commit) => pName.get(commit.hash)).sort();
};

// The author list: one row per name with its emails (most recent first), in name order
// whatever the case, from branches, remote branches and HEAD but not from tags.
{
  const r = await readAuthors(git, people);
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.authors, [
    { name: "-n1 Dash", emails: ["dash@x.com"] },
    { name: "Ann", emails: ["ann@work.com", "ann@x.com"] },
    { name: "bob", emails: ["bob@x.com"] },
    { name: "Detached Dee", emails: ["dee@x.com"] },
    { name: "Dr. (A+B) [x]", emails: ["dr@x.com"] },
    { name: "Joann", emails: ["joann@x.com"] },
    { name: "Nick New", emails: ["nick@x.com"] },
    { name: "Remo", emails: ["remo@x.com"] },
    { name: "Zed", emails: ["zed@x.com"] },
  ]);
  // A repository without commits has nobody yet; a folder that isn't one is git's error.
  const empty = `${tmp}/people-empty`;
  mkdirSync(empty);
  raw(empty, ["init", "-q"]);
  assert.deepEqual(await readAuthors(git, empty), { ok: true, err: "", authors: [] });
  const outside = await readAuthors(git, `${tmp}/missing-folder`);
  assert.equal(outside.ok, false);
  assert.notEqual(outside.err, "");
}

// Narrowing the list as letters are typed: a part of the name or of any email, any case.
{
  const { authors } = await readAuthors(git, people);
  const names = (q) => matchAuthors(authors, q).map((a) => a.name);
  assert.equal(matchAuthors(authors, ""), authors);
  assert.equal(matchAuthors(authors, "   "), authors);
  assert.deepEqual(names("ANN"), ["Ann", "Joann"]);
  assert.deepEqual(names(" work.com "), ["Ann"]);
  assert.deepEqual(names("(a+b)"), ["Dr. (A+B) [x]"]);
  assert.deepEqual(names("nobody"), []);
}

// Several users: a commit by any one of them stays. A name picked from the list is that
// exact name: Ann is not Joann, and Ann Lee is not Ann.
{
  assert.deepEqual(await pick({ users: [{ name: "Ann" }] }), ["p1", "p4"]);
  assert.deepEqual(await pick({ users: [{ name: "Joann" }] }), ["p2"]);
  assert.deepEqual(await pick({ users: [{ name: "Ann" }, { name: "Zed" }] }), ["p1", "p4", "p5"]);
  assert.deepEqual(await pick({ users: [{ name: "An" }] }), [], "a name is whole, not a part");
  assert.deepEqual(await found({ users: [{ name: "Ann" }] }), [], "Ann Lee is someone else");
  assert.deepEqual(await found({ users: [{ name: "Ann Lee" }, { name: "Bob Stone" }] }), ["a1", "a2", "a3", "b1", "d1", "d2", "d3", "d4", "f1"]);
  // Names made of a regular expression's characters, or shaped like an option.
  assert.deepEqual(await pick({ users: [{ name: "Dr. (A+B) [x]" }] }), ["p6"]);
  assert.deepEqual(await pick({ users: [{ name: "Dr" }] }), []);
  assert.deepEqual(await pick({ users: [{ name: "-n1 Dash" }] }), ["p7"]);
  assert.deepEqual(await pick({ users: [{ name: "--all" }] }), []);
  // The name the author list shows (mapped by .mailmap) picks that person's commits,
  // even where git is told not to map names in its own output.
  assert.deepEqual(await pick({ users: [{ name: "Nick New" }] }), ["p8"]);
  raw(people, ["config", "log.mailmap", "false"]);
  assert.deepEqual(await pick({ users: [{ name: "Nick New" }] }), ["p8"]);
  raw(people, ["config", "--unset", "log.mailmap"]);
  // Remote branches and a detached HEAD count; so does the branch limit.
  assert.deepEqual(await pick({ users: [{ name: "Remo" }, { name: "Detached Dee" }] }), ["h1", "r1"]);
  assert.deepEqual(await pick({ users: [{ name: "Remo" }, { name: "Ann" }] }, "main"), ["p1", "p4"]);
}

// Typed letters are a part of a name or an email, and add to the names picked.
{
  assert.deepEqual(await pick({ users: [{ text: "ann" }] }), ["p1", "p2", "p4"]);
  assert.deepEqual(await pick({ users: [{ text: "OAN" }, { name: "Zed" }] }), ["p2", "p5"]);
  assert.deepEqual(await pick({ users: [{ text: "work.com" }] }), ["p4"]);
  assert.deepEqual(await pick({ users: [{ text: "(a+b)" }] }), ["p6"], "literal, any case");
  assert.deepEqual(await pick({ users: [{ text: "-n1" }] }), ["p7"]);
  // The single `user` value (props.filters.user, scripts) is one more typed entry.
  assert.deepEqual(await pick({ user: "bob", users: [{ name: "Zed" }] }), ["p3", "p5"]);
  // Empty entries add nothing.
  assert.deepEqual(filterArgs({ users: [{ text: "  " }, { name: "" }, null] }), []);
}

// Names picked from the list alone (no text, no typed letters) match in their case too:
// bob is not Bob. git has one case switch for the text and the authors, so with a text
// searched in any case, or typed letters, the switch is on and a picked name matches in
// any case as well. The text and typed letters always behave as without a picked name.
{
  const cased = `${tmp}/cased`;
  mkdirSync(cased);
  raw(cased, ["init", "-q", "-b", "main"]);
  const c = {};
  c.c1 = commit(cased, "a.txt", "fix one", now - 3 * DAY, "bob <bob@x.com>");
  c.c2 = commit(cased, "a.txt", "fix two", now - 2 * DAY, "Bob <bob@y.com>");
  c.c3 = commit(cased, "a.txt", "fix three", now - DAY, "Carl <carl@x.com>");
  const cName = new Map(Object.entries(c).map(([name, hash]) => [hash, name]));
  const inCased = async (filter) => {
    const r = await readLog(git, cased, { extra: filterArgs(filter) });
    assert.equal(r.ok, true, `${JSON.stringify(filter)}: ${r.err}`);
    return r.commits.map((commit) => cName.get(commit.hash)).sort();
  };
  const bob = [{ name: "bob" }];
  for (const matchCase of [false, true]) {
    assert.deepEqual(await inCased({ users: bob, matchCase }), ["c1"], `no text, matchCase ${matchCase}`);
    assert.deepEqual(await inCased({ users: [{ name: "Bob" }], matchCase }), ["c2"], `no text, matchCase ${matchCase}`);
    assert.deepEqual(await inCased({ users: [{ name: "bob" }, { name: "Carl" }], matchCase }), ["c1", "c3"], `two names, matchCase ${matchCase}`);
  }
  // With Match Case on, the text is case sensitive and a picked name is its case.
  assert.deepEqual(await inCased({ users: bob, text: "fix", matchCase: true }), ["c1"]);
  assert.deepEqual(await inCased({ users: bob, text: "f.x", regex: true, matchCase: true }), ["c1"]);
  assert.deepEqual(await inCased({ users: bob, text: "FIX", matchCase: true }), []);
  assert.deepEqual(await inCased({ users: [...bob, { text: "CARL" }], text: "fix", matchCase: true }), ["c1", "c3"]);
  // The text in any case, or typed letters: the switch is on, bob is Bob too.
  assert.deepEqual(await inCased({ users: bob, text: "FIX" }), ["c1", "c2"]);
  assert.deepEqual(await inCased({ users: bob, text: "F.X", regex: true }), ["c1", "c2"]);
  assert.deepEqual(await inCased({ users: [...bob, { text: "CARL" }] }), ["c1", "c2", "c3"]);
  // Without a picked name: typed letters and the text in any case.
  assert.deepEqual(await inCased({ users: [{ text: "BOB" }], text: "FIX" }), ["c1", "c2"]);
}

// Letters outside ASCII match in any case like the others, with or without a picked
// name, where git runs in a UTF-8 locale.
{
  const LOCALE = "en_US.UTF-8";
  let has = false;
  try { has = execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").some((line) => line.trim().toLowerCase().replace("utf8", "utf-8") === LOCALE.toLowerCase()); } catch { /* no locale command */ }
  if (!has) console.log(`skipped: no ${LOCALE} locale here, so case-insensitive matching outside ASCII isn't checked`);
  else {
    const utf8 = `${tmp}/utf8`;
    mkdirSync(utf8);
    raw(utf8, ["init", "-q", "-b", "main"]);
    const u = {};
    u.u1 = commit(utf8, "a.txt", "first", now - 3 * DAY, "bob <bob@x.com>");
    u.u2 = commit(utf8, "a.txt", "Änderung", now - 2 * DAY, "Änne <anne@x.com>");
    u.u3 = commit(utf8, "a.txt", "second", now - DAY, "Bob <bob@y.com>");
    const uName = new Map(Object.entries(u).map(([name, hash]) => [hash, name]));
    const run = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, env: { ...process.env, LC_ALL: LOCALE } }, (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
    const inUtf8 = async (filter) => {
      const r = await readLog(makeGit(run, null), utf8, { extra: filterArgs(filter) });
      assert.equal(r.ok, true, `${JSON.stringify(filter)}: ${r.err}`);
      return r.commits.map((commit) => uName.get(commit.hash)).sort();
    };
    assert.deepEqual(await inUtf8({ text: "änderung" }), ["u2"]);
    assert.deepEqual(await inUtf8({ text: "änderung", users: [{ name: "Änne" }] }), ["u2"]);
    assert.deepEqual(await inUtf8({ users: [{ text: "änne" }] }), ["u2"]);
    assert.deepEqual(await inUtf8({ users: [{ text: "änne" }, { name: "bob" }] }), ["u1", "u2", "u3"]);
    assert.deepEqual(await inUtf8({ users: [{ name: "Änne" }] }), ["u2"]);
    assert.deepEqual(await inUtf8({ users: [{ name: "änne" }] }), []);
  }
}

// "me" with someone else.
{
  const me = await readMe(git, repo);
  assert.deepEqual(await found({ users: [{ text: userOf(me) }, { name: "Bob Stone" }] }), ["b1", "f1", "m1"]);
}

// Several users with the other filters: every filter still has to pass.
{
  const team = [{ name: "Ann Lee" }, { name: "Bob Stone" }];
  assert.deepEqual(await found({ users: team, text: "fix" }), ["a2", "b1"]);
  assert.deepEqual(await found({ users: team, text: "Fix", matchCase: true }), ["a2"]);
  assert.deepEqual(await found({ users: team, text: "^(fix|add) ", regex: true }), ["a2", "b1", "f1"]);
  assert.deepEqual(await found({ users: team, paths: ["docs"] }), ["a1", "b1"]);
  assert.deepEqual(await found({ users: team, since: "7 days ago" }), ["a3", "f1"]);
  assert.deepEqual(await found({ users: team, until: "2020-03-11" }), ["d1", "d2", "d3"]);
  assert.deepEqual(await found({ users: team, since: "2021-01-01" }, "main"), ["a1", "a2", "a3", "b1"]);
  assert.deepEqual(await found({ users: [{ name: "Bob Stone" }, { text: "xme" }], text: "chore" }), ["x1"]);
}

console.log("ok");
