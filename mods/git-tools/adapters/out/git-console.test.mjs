// node git-console.test.mjs: the Git console's record lines, the log file's limit, and
// two copies writing the same file (no app needed).
import assert from "node:assert/strict";
import { consoleEntry, readEntries, appendEntries, consoleRows, updateText, OUTPUT_CHARS, LOG_BYTES } from "./git-console.js";

const call = (over = {}) => ({ at: 1762990000000, cwd: "/work/app", on: null, args: ["commit", "-m", "fix"], code: 0, stdout: "", stderr: "", ...over });
const bytes = (s) => Buffer.byteLength(s, "utf8");

// A record line: when, where, the command as git would be typed, the exit code and
// what git printed (stdout, then stderr).
{
  const e = consoleEntry(call({ on: "vps", code: 1, stdout: "[main 1a2b3c4] fix\n", stderr: "warning: x\n" }));
  assert.equal(e.at, 1762990000000);
  assert.equal(e.root, "/work/app");
  assert.equal(e.on, "vps");
  assert.equal(e.command, "git commit -m fix");
  assert.equal(e.code, 1);
  assert.equal(e.output, "[main 1a2b3c4] fix\nwarning: x");
  assert.equal(typeof e.id, "string");
  assert.notEqual(consoleEntry(call()).id, consoleEntry(call()).id, "two records at the same time stay two");
  assert.equal(consoleEntry(call()).on, null);
}

// Arguments with spaces or quotes are quoted the way a shell takes them back.
{
  assert.equal(consoleEntry(call({ args: ["commit", "-m", "two words", "--", "a b.txt", "it's"] })).command,
    `git commit -m 'two words' -- 'a b.txt' 'it'\\''s'`);
  assert.equal(consoleEntry(call({ args: ["add", ""] })).command, "git add ''");
}

// A long argument (a commit message) is shown shortened: its first line, cut at 60
// characters, with "…". Short one-line arguments stay whole.
{
  const message = `${"m".repeat(70)}\n\nbody`;
  assert.equal(consoleEntry(call({ args: ["commit", "-m", message] })).command, `git commit -m '${"m".repeat(60)}…'`);
  assert.equal(consoleEntry(call({ args: ["commit", "-m", "subject\n\nbody"] })).command, "git commit -m 'subject…'");
  assert.equal(consoleEntry(call({ args: ["checkout", "x".repeat(60)] })).command, `git checkout ${"x".repeat(60)}`);
}

// A password or token in a URL never reaches the log, in the command or in git's output.
// A user name without a password stays (ssh://git@…); over http(s) the whole user part
// goes, since a token is often given as the user.
{
  const e = consoleEntry(call({
    args: ["remote", "set-url", "origin", "https://me:s3cret@example.com/r.git"],
    stderr: "fatal: unable to access 'https://ghp_TOKEN@example.com/r.git/': error\n",
  }));
  assert.equal(e.command, "git remote set-url origin 'https://***@example.com/r.git'");
  assert.equal(e.output, "fatal: unable to access 'https://***@example.com/r.git/': error");
  assert.equal(consoleEntry(call({ args: ["remote", "add", "o", "ssh://git:pw@example.com/r.git"] })).command, "git remote add o 'ssh://git:***@example.com/r.git'");
  assert.equal(consoleEntry(call({ args: ["remote", "add", "o", "ssh://git@example.com/r.git"] })).command, "git remote add o ssh://git@example.com/r.git");
  assert.equal(consoleEntry(call({ args: ["remote", "add", "o", "git@example.com:r.git"] })).command, "git remote add o git@example.com:r.git");
}

// Output is cut at 4,000 characters; so is a command line of many paths.
{
  assert.equal(OUTPUT_CHARS, 4000);
  const e = consoleEntry(call({ stdout: "o".repeat(5000) }));
  assert.equal(e.output, `${"o".repeat(4000)}…`);
  const exact = consoleEntry(call({ stdout: "o".repeat(4000) }));
  assert.equal(exact.output, "o".repeat(4000));
  const paths = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.txt`);
  const many = consoleEntry(call({ args: ["rm", "--", ...paths] }));
  assert.equal(many.command.length, 4001);
  assert.ok(many.command.startsWith("git rm -- src/file-0.txt src/file-1.txt"));
  assert.ok(many.command.endsWith("…"));
}

// The log file: one JSON record per line. What isn't a record (a cut-off last line, a
// line edited by hand) is skipped, not fatal.
{
  const a = consoleEntry(call({ args: ["branch", "a"] })), b = consoleEntry(call({ args: ["branch", "b"] }));
  const text = appendEntries(null, [a, b]);
  assert.equal(text, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
  assert.deepEqual(readEntries(text), [a, b]);
  assert.deepEqual(readEntries(`${text}{"id":"half`), [a, b]);
  assert.deepEqual(readEntries(`not json\n${text}[1]\n{"id":"x"}\n`), [a, b]);
  assert.deepEqual(readEntries(null), []);
  assert.deepEqual(readEntries(""), []);
}

// Past 512 KiB (UTF-8 bytes) the oldest records go first, until the file fits again.
{
  assert.equal(LOG_BYTES, 512 * 1024);
  const big = (i) => consoleEntry(call({ at: i, args: ["commit", "-m", `${i}`], stdout: "가".repeat(3000) }));
  let text = null;
  for (let i = 0; i < 70; i++) text = appendEntries(text, [big(i)]);
  assert.ok(bytes(text) <= LOG_BYTES, `kept ${bytes(text)} bytes`);
  const kept = readEntries(text);
  assert.equal(kept.at(-1).at, 69, "the newest stays");
  const one = bytes(`${JSON.stringify(big(0))}\n`);
  assert.ok(bytes(text) + one > LOG_BYTES, "nothing more went than needed");
  assert.deepEqual(kept.map((e) => e.at), Array.from({ length: kept.length }, (_, i) => 70 - kept.length + i), "the oldest went, in order");
  assert.ok(kept.length < 70);
  // A smaller limit the same way.
  const small = appendEntries(null, [big(1), big(2), big(3)], one * 2);
  assert.deepEqual(readEntries(small).map((e) => e.at), [2, 3]);
}

// The same record written twice (a write that landed though it was reported failed) is kept once.
{
  const a = consoleEntry(call());
  assert.deepEqual(readEntries(appendEntries(appendEntries(null, [a]), [a])), [a]);
}

// The console's rows: per record, the command line with its time, repository and
// machine, then each output line, then the exit code when it failed.
{
  const ok = consoleEntry(call({ args: ["push"], stdout: "", stderr: "To origin\n   a..b  main -> main\n" }));
  const failed = consoleEntry(call({ on: "vps", args: ["pull"], code: 1, stderr: "fatal: no\n" }));
  const quiet = consoleEntry(call({ args: ["branch", "x"] }));
  assert.deepEqual(consoleRows([ok, failed, quiet]), [
    { kind: "command", id: ok.id, at: ok.at, root: "/work/app", on: null, text: "git push", failed: false },
    { kind: "output", text: "To origin" },
    { kind: "output", text: "   a..b  main -> main" },
    { kind: "command", id: failed.id, at: failed.at, root: "/work/app", on: "vps", text: "git pull", failed: true },
    { kind: "output", text: "fatal: no" },
    { kind: "exit", code: 1 },
    { kind: "command", id: quiet.id, at: quiet.at, root: "/work/app", on: null, text: "git branch x", failed: false },
  ]);
  assert.deepEqual(consoleRows([]), []);
}

// Writing through a file whose write takes the text it expects to replace (Herdr's
// writeTextFile): two copies that read the same file each keep their record. The one
// whose write is refused reads again, merges and writes again, three tries at most.
{
  const file = (start) => {
    const f = { text: start, writes: 0 };
    f.io = (hook) => ({
      read: async () => f.text,
      write: async (text, expected) => {
        await hook?.();
        f.writes++;
        if (f.text !== expected) throw new Error("stale snapshot");
        f.text = text;
      },
    });
    return f;
  };
  const a = consoleEntry(call({ args: ["branch", "from-a"] })), b = consoleEntry(call({ args: ["branch", "from-b"] }));
  const base = appendEntries(null, [consoleEntry(call({ args: ["branch", "base"] }))]);
  const f = file(base);
  // Copy B writes between copy A's read and its write: A's first write is refused.
  let once = true;
  const fromA = updateText(f.io(async () => { if (once) { once = false; await updateText(f.io(), (text) => appendEntries(text, [b])); } }), (text) => appendEntries(text, [a]));
  assert.deepEqual(await fromA, { ok: true, text: f.text });
  assert.deepEqual(readEntries(f.text).map((e) => e.command), ["git branch base", "git branch from-b", "git branch from-a"]);
  // A file that doesn't exist yet is created (expected null).
  const empty = file(null);
  assert.equal((await updateText(empty.io(), (text) => appendEntries(text, [a]))).ok, true);
  assert.deepEqual(readEntries(empty.text), [a]);
  // Refused every time: it gives up after three writes and says why.
  const busy = file(base);
  const r = await updateText(busy.io(async () => { busy.text += "\n"; }), (text) => appendEntries(text, [a]));
  assert.equal(r.ok, false);
  assert.match(r.err, /stale snapshot/);
  assert.equal(busy.writes, 3);
  // A read that fails is a failure too, with nothing written.
  const unreadable = { read: async () => { throw new Error("denied"); }, write: async () => { throw new Error("written"); } };
  assert.deepEqual(await updateText(unreadable, (t) => t), { ok: false, err: "denied" });
  // Nothing to change (the change returns the same text): nothing is written.
  const same = file(base);
  assert.deepEqual(await updateText(same.io(), (text) => text), { ok: true, text: base });
  assert.equal(same.writes, 0);
}

console.log("ok");
