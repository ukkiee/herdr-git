// Filter values → `git log` arguments, and what the filter row needs to offer values
// (the configured user, the branch names, the date presets).
// No `herdr` import: node tests it (git-log-filter.test.mjs).

import { readRefsState } from "./git-log.js";

// The Date filter's ready-made ranges. `since` is relative, so a list read again later
// still means "the last 24 hours" then. `label` is the value kept and accepted
// (props.filters.date) in every language; `key` names it on the screen.
export const DATE_PRESETS = [
  { label: "Last 24 hours", key: "log.last24Hours", since: "24 hours ago" },
  { label: "Last 7 days", key: "log.last7Days", since: "7 days ago" },
];

// datePreset(label) → the preset kept under that label, else null.
export function datePreset(label) {
  return DATE_PRESETS.find((p) => p.label === label) ?? null;
}

// dateText(t, { dateLabel, since, until }) → the Date filter's value as the button shows
// it, in t's language: a preset's name, or the typed days ("From 2026-11-01",
// "2026-11-01 – 2026-11-09"); "" when no date is in force. t: from i18n.js translator.
export function dateText(t, { dateLabel, since, until }) {
  const preset = datePreset(dateLabel);
  if (preset) return t(preset.key);
  if (since && until) return since === until ? since : t("log.dateRange", { since, until });
  if (since) return t("log.dateFrom", { since });
  if (until) return t("log.dateUntil", { until });
  return "";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// isDate(text) → whether it is a calendar day written YYYY-MM-DD (what the Date filter
// accepts when typed). git itself takes any words as a date and never complains, so a
// typo would silently mean "now".
export function isDate(text) {
  const m = DAY.exec(String(text ?? "").trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

// A bare day means the whole day. git would read "2026-11-01" as that day at the
// current time of day, which cuts an end date short and a start date late.
const dayEdge = (value, time) => {
  const text = String(value ?? "").trim();
  return DAY.test(text) ? `${text} ${time}` : text;
};

// Text as an extended regular expression that matches exactly that text. A bracket
// holds every special character but "^" and "\", which are escaped instead.
// anyCase: letters match in either case (for a pattern in a case-sensitive search).
function literal(text, anyCase = false) {
  let out = "";
  for (const ch of text) {
    if (ch === "\\" || ch === "^") out += `\\${ch}`;
    else if (".[]$()*+?{}|".includes(ch)) out += `[${ch}]`;
    else if (anyCase && /[a-z]/i.test(ch)) out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    else out += ch;
  }
  return out;
}

// filterArgs(filter) → string[] for git-log.js readLog's `extra`
//   filter: { text, regex, matchCase, user, users, since, until, paths }
//     text: searched in commit messages, as typed (regex: as an extended regular
//     expression; matchCase: case sensitive). user: part of an author's name or email,
//     taken literally, in any case. users: [{ name } | { text }]: name is an author's
//     whole name as readAuthors gives it (Ann is not Joann), text is like `user`. Picked
//     names alone match in their case too (Ann is not ann); with a text searched in any
//     case, or typed letters, they match in any case (git's one case switch). A
//     commit by any one of `user` and `users` stays. since / until: dates git
//     understands ("24 hours ago"); a bare "2026-11-01" covers that whole day.
//     paths: [path] relative to the repository root, a file or a folder, taken
//     literally (no wildcards).
//   Empty or missing fields add nothing. Every value travels inside "--option=value" or
//   after "--", so git can't read it as an option (a value starting with "-" stays a value).
//   The Branch filter is not here: it is the Log panel's host.branch.
export function filterArgs(filter = {}) {
  const text = String(filter.text ?? "");
  const hasText = text.trim() !== "";
  const exact = hasText && Boolean(filter.matchCase);
  // git matches --author against "Name <email>" (after .mailmap) and keeps a commit when
  // any one --author matches. A name is anchored at both ends: "^Ann <".
  const authors = [];
  let typedAny = false;
  const typed = (value) => { const s = String(value ?? "").trim(); if (s) { typedAny = true; authors.push(literal(s, exact)); } };
  typed(filter.user);
  for (const entry of filter.users ?? []) {
    if (typeof entry?.name === "string" && entry.name.trim()) authors.push(`^${literal(entry.name, false)} <`);
    else typed(entry?.text);
  }
  const user = authors.length > 0;
  const since = dayEdge(filter.since, "00:00:00"), until = dayEdge(filter.until, "23:59:59");
  const paths = (filter.paths ?? []).map((path) => String(path ?? "").trim().replace(/^(\.?\/)+/, "")).filter(Boolean);
  const args = [];
  // git has one pattern syntax and one case switch for --grep and --author together.
  // So both are always extended expressions, a literal one is escaped here, and when
  // the text is case sensitive the user spells out both cases itself. The switch is git's
  // own (letters outside ASCII too, in a UTF-8 locale). It stays off when only names
  // picked from the list are asked for, so each matches in its case; with a text searched
  // in any case or typed letters it is on, and the picked names match in any case too.
  const pickedOnly = user && !hasText && !typedAny;
  if (hasText || user) args.push("--extended-regexp");
  if ((hasText || user) && !exact && !pickedOnly) args.push("--regexp-ignore-case");
  // A name picked from the list is the mapped one, so match against mapped names even
  // where log.mailmap is turned off.
  if (user) args.push("--use-mailmap");
  if (hasText) args.push(`--grep=${filter.regex ? text : literal(text)}`);
  for (const pattern of authors) args.push(`--author=${pattern}`);
  // --since stops walking at the first commit older than the date, so in a history whose
  // dates go backwards (rebases, wrong clocks) it misses newer commits behind it.
  // --since-as-filter checks every commit instead; it needs git 2.37 or later.
  if (since) args.push(`--since-as-filter=${since}`);
  if (until) args.push(`--until=${until}`);
  // ":(literal)" turns off wildcards and the other pathspec magic (":!x" would exclude).
  if (paths.length) args.push("--", ...paths.map((path) => `:(literal)${path}`));
  return args;
}

// isHash(text) → boolean: 7 to 40 hex digits, so the search box jumps to that commit
// instead of searching messages.
export function isHash(text) {
  return /^[0-9a-f]{7,40}$/i.test(String(text ?? "").trim());
}

// readMe(git, root) → { ok, err, name, email }: the user git is configured with (the
// User filter's "me"). ok: false when neither a name nor an email is set.
export async function readMe(git, root) {
  const [name, email] = await Promise.all([
    git.read(root, ["config", "--get", "user.name"]),
    git.read(root, ["config", "--get", "user.email"]),
  ]);
  // Exit code 1 is "not set"; anything else is git failing.
  const failed = [name, email].find((r) => !r.ok && r.code !== 1);
  if (failed) return { ok: false, err: failed.err, name: "", email: "" };
  const me = { name: name.ok ? name.out.trim() : "", email: email.ok ? email.out.trim() : "" };
  if (!me.name && !me.email) return { ok: false, err: "git has no user.name or user.email set.", msg: { key: "log.noUser", args: {} }, ...me };
  return { ok: true, err: "", ...me };
}

// userOf(me) → the `user` value that picks that person's commits: the email in its
// brackets (so ann@x.com doesn't also pick joann@x.com), else the name.
export function userOf(me) {
  return me?.email ? `<${me.email}>` : me?.name ?? "";
}

// readAuthors(git, root) → { ok, err, authors: [{ name, emails: [email] }] }
//   Everyone who wrote a commit on a branch, a remote branch or HEAD (tags are left out,
//   as in the Commit list's first read), for the User filter's list. One row per name:
//   a person who used several emails is one row, emails most recently used first.
//   Sorted by name, whatever the case. Names are the ones .mailmap gives, because that is
//   what git's --author matches (filterArgs asks for the mailmap too). A repository
//   without commits has no authors.
export async function readAuthors(git, root) {
  // One git call: --ignore-missing lets HEAD be named in a repository that has no commit.
  const r = await git.read(root, ["log", "--use-mailmap", "--no-show-signature", "--no-color", "--format=%aN%x00%aE",
    "--ignore-missing", "--branches", "--remotes", "HEAD", "--"]);
  if (!r.ok) return { ok: false, err: r.err, authors: [] };
  const byName = new Map();
  for (const line of r.out.split("\n")) {
    const cut = line.indexOf("\0");
    if (cut < 0) continue;
    const name = line.slice(0, cut), email = line.slice(cut + 1);
    // A commit with an empty name can't be picked by name (filterArgs anchors on it).
    if (!name.trim()) continue;
    const emails = byName.get(name) ?? [];
    if (!byName.has(name)) byName.set(name, emails);
    if (email && !emails.includes(email)) emails.push(email);
  }
  const authors = [...byName].map(([name, emails]) => ({ name, emails }));
  authors.sort((a, b) => {
    const x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { ok: true, err: "", authors };
}

// matchAuthors(authors, query) → the authors whose name or any email contains the query,
// in any case (the User popup narrowing as letters are typed). An empty query keeps the
// same array, so a caller can tell nothing was narrowed.
export function matchAuthors(authors, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return authors;
  return authors.filter((a) => a.name.toLowerCase().includes(q) || a.emails.some((e) => e.toLowerCase().includes(q)));
}

// readBranchNames(git, root) → { ok, err, current, local: [name], remote: [name] }
//   What the Branch filter offers. current: the branch HEAD is on, null when detached.
//   remote names are like "origin/main"; origin/HEAD is left out.
export async function readBranchNames(git, root) {
  const r = await readRefsState(git, root);
  if (!r.ok) return { ok: false, err: r.err, current: null, local: [], remote: [] };
  const local = [], remote = [];
  let current = null;
  // After the first line (HEAD's hash) each line is "<hash> <refname> <* or space>".
  for (const line of r.state.split("\n").slice(1)) {
    const [, ref, mark] = line.split(" ");
    if (!ref) continue;
    if (ref.startsWith("refs/heads/")) { local.push(ref.slice(11)); if (mark === "*") current = ref.slice(11); }
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push(ref.slice(13));
  }
  return { ok: true, err: "", current, local, remote };
}
