// The Git console's records: what one git write looked like, the log file that keeps
// them (one JSON record per line), its size limit, and writing that file when another
// copy may write it at the same time. No `herdr` import: node tests it
// (git-console.test.mjs). app-files.js binds it to Herdr's files; git.js hands it the calls.

// What is kept of git's output, and of a command line (a rollback's paths can fill 60 KB).
export const OUTPUT_CHARS = 4000;
// The log file's limit in UTF-8 bytes: past it the oldest records go.
export const LOG_BYTES = 512 * 1024;
// A longer argument (a commit message) shows as its first line cut to this.
const ARG_CHARS = 60;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// An argument as a shell would take it back: bare when nothing in it needs quoting.
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (arg) => (SAFE.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

// A URL's credentials as "***": over http(s) the whole user part (a token often stands as
// the user), elsewhere only the password (ssh://git@… keeps its user).
const CREDENTIALS = /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/@'"]+)@/g;
const hidden = (text) => String(text ?? "").replace(CREDENTIALS, (all, scheme, user) => {
  if (/^https?$/i.test(scheme)) return `${scheme}://***@`;
  const at = user.indexOf(":");
  return at < 0 ? all : `${scheme}://${user.slice(0, at)}:***@`;
});

function shortened(arg) {
  const s = hidden(arg), first = s.split("\n")[0];
  if (first.length > ARG_CHARS) return `${first.slice(0, ARG_CHARS)}…`;
  return first === s ? s : `${first}…`;
}

const newId = (at) => `${Number(at).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// consoleEntry(call) → { id, at, root, on, command, code, output }: a record of one git
// command. call: what git.js hands its recorder ({ at, cwd, on, args, code, stdout, stderr }).
// command: "git …" with long arguments shortened, cut at OUTPUT_CHARS. output: stdout
// then stderr, trimmed, cut at OUTPUT_CHARS.
export function consoleEntry(call) {
  const command = clip(["git", ...(call.args ?? []).map((arg) => quote(shortened(arg)))].join(" "), OUTPUT_CHARS);
  const output = [call.stdout, call.stderr].map((s) => hidden(s).trim()).filter(Boolean).join("\n");
  return { id: newId(call.at), at: call.at, root: call.cwd ?? null, on: call.on ?? null, command, code: call.code, output: clip(output, OUTPUT_CHARS) };
}

const isEntry = (e) => e && typeof e === "object" && !Array.isArray(e) && typeof e.id === "string"
  && Number.isFinite(e.at) && typeof e.command === "string";

// readEntries(text) → the records in the log file's text, oldest first. A line that isn't
// one (cut off by a crash, edited by hand) is skipped. null (no file yet) → [].
export function readEntries(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (isEntry(e)) out.push(e); } catch { /* not a record */ }
  }
  return out;
}

// UTF-8 length without TextEncoder (the app's runtime may not have it).
function utf8Bytes(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

// appendEntries(text, entries, limit?) → the log file's next text: the records already
// there, then `entries` (one already there by id is not added again), then the oldest
// dropped until the text fits `limit` bytes.
export function appendEntries(text, entries, limit = LOG_BYTES) {
  const kept = readEntries(text), ids = new Set(kept.map((e) => e.id));
  for (const e of entries) if (!ids.has(e.id)) { kept.push(e); ids.add(e.id); }
  const lines = kept.map((e) => `${JSON.stringify(e)}\n`);
  const sizes = lines.map(utf8Bytes);
  let total = sizes.reduce((a, b) => a + b, 0), from = 0;
  while (total > limit && from < lines.length - 1) total -= sizes[from++];
  return lines.slice(from).join("");
}

// consoleRows(entries) → the console's rows, one per drawn line: for each record its
// { kind: "command", id, at, root, on, text, failed }, its output lines
// { kind: "output", text }, and { kind: "exit", code } when it didn't end with 0.
export function consoleRows(entries) {
  const rows = [];
  for (const e of entries) {
    const failed = e.code !== 0;
    rows.push({ kind: "command", id: e.id, at: e.at, root: e.root ?? null, on: e.on ?? null, text: e.command, failed });
    if (e.output) for (const line of String(e.output).split("\n")) rows.push({ kind: "output", text: line });
    if (failed) rows.push({ kind: "exit", code: e.code });
  }
  return rows;
}

// updateText(io, change, { tries? }) → { ok: true, text } | { ok: false, err }: writes
// change(text) over the file's text. io: { read() → text | null, write(text, expected) }
// where write refuses (rejects) when the file no longer holds `expected` (Herdr's
// writeTextFile). Refused, it reads again and applies `change` to what another copy
// wrote, `tries` writes at most. A change that returns the text as it was writes nothing.
export async function updateText(io, change, { tries = 3 } = {}) {
  let err = "";
  for (let i = 0; i < tries; i++) {
    let current;
    try { current = await io.read(); } catch (error) { return { ok: false, err: String(error?.message ?? error) }; }
    const next = change(current ?? null);
    if (next === current) return { ok: true, text: current };
    try { await io.write(next, current ?? null); return { ok: true, text: next }; }
    catch (error) { err = String(error?.message ?? error); }
  }
  return { ok: false, err };
}
