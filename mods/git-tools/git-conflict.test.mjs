// node git-conflict.test.mjs: the conflict module against throwaway repositories (no app
// needed). Conflicts come from a real merge, cherry-pick and rebase; each case then reads
// the repository again with git itself: the index entries and the file on disk.
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readVersions, acceptSide, saveResult, unresolve, resolveSimpleAll, remoteWriter, REMOTE_CHUNK_BYTES } from "./git-conflict.js";
import { en } from "./messages-conflicts.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-conflict-`));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const git = makeGit(exec, null);
const sh = (cwd, cmd) => { try { return execFileSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return e.stdout; } };
// This computer's writer, the way a local space writes (writeTextFile).
const write = async (path, text) => { await writeFile(path, text); };

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const put = (repo, path, text) => writeFileSync(`${repo}/${path}`, text);
const disk = (repo, path) => (existsSync(`${repo}/${path}`) ? readFileSync(`${repo}/${path}`, "utf8") : null);
// The index stages of a path ("" when it is resolved or gone).
const stages = (repo, path) => sh(repo, `git ls-files -s -- '${path}'`).split("\n").filter(Boolean).map((l) => Number(l.split(/\s+/)[2])).sort();
const indexed = (repo, path) => sh(repo, `git show ':0:${path}'`);
const unmerged = (repo) => [...new Set(sh(repo, "git ls-files -u").split("\n").filter(Boolean).map((l) => l.split("\t")[1]))].sort();

// A merge that stops on: a file both changed (m), one ours changed and theirs deleted (d1),
// one ours deleted and theirs changed (d2), a binary (bin), a simple conflict (s: the two
// sides change lines next to each other) and a real one (h, also with CRLF).
const mergeRepo = (name) => {
  const repo = init(name);
  put(repo, "m", "a\nb\n"); put(repo, "d1", "k\n"); put(repo, "d2", "k\n");
  put(repo, "bin", "x\0base"); put(repo, "s", "1\n2\n3\n"); put(repo, "h", "a\r\nb\r\n");
  sh(repo, "git add -A && git commit -qm base && git checkout -qb feature");
  put(repo, "m", "a\nF\n"); put(repo, "d2", "kf\n"); put(repo, "bin", "x\0feature"); put(repo, "s", "1\nTWO\n3\n"); put(repo, "h", "a\r\nF\r\n");
  sh(repo, "git rm -q d1 && git add -A && git commit -qm feature && git checkout -q main");
  put(repo, "m", "a\nM\n"); put(repo, "d1", "km\n"); put(repo, "bin", "x\0main"); put(repo, "s", "ONE\n2\n3\n"); put(repo, "h", "a\r\nM\r\n");
  sh(repo, "git rm -q d2 && git add -A && git commit -qm main && git merge feature");
  assert.deepEqual(unmerged(repo), ["bin", "d1", "d2", "h", "m", "s"]);
  return repo;
};

// Three versions: base, ours (stage 2), theirs (stage 3) and the file on disk; a deleted
// side is null; a binary file says so instead of giving text.
{
  const repo = mergeRepo("read");
  const read = (path) => readFileSync(`${repo}/${path}`, "utf8");
  const m = await readVersions(git, repo, "m", { read: async (p) => read(p.slice(repo.length + 1)) });
  assert.equal(m.ok, true, m.err);
  assert.equal(m.binary, false);
  assert.deepEqual([m.base, m.ours, m.theirs], ["a\nb\n", "a\nM\n", "a\nF\n"]);
  assert.match(m.worktree, /^a\n<<<<<<< /);

  const d1 = await readVersions(git, repo, "d1");
  assert.deepEqual([d1.base, d1.ours, d1.theirs], ["k\n", "km\n", null]);
  assert.equal(d1.worktree, undefined);
  const d2 = await readVersions(git, repo, "d2");
  assert.deepEqual([d2.base, d2.ours, d2.theirs], ["k\n", null, "kf\n"]);

  const bin = await readVersions(git, repo, "bin");
  assert.equal(bin.ok, true, bin.err);
  assert.equal(bin.binary, true);
  assert.deepEqual([bin.base, bin.ours, bin.theirs], [null, null, null]);
  assert.deepEqual(bin.has, { base: true, ours: true, theirs: true });

  const h = await readVersions(git, repo, "h");
  assert.deepEqual([h.ours, h.theirs], ["a\r\nM\r\n", "a\r\nF\r\n"]);

  // A path that isn't in conflict is refused with a sentence of the module's own.
  const none = await readVersions(git, repo, "nothing");
  assert.equal(none.ok, false);
  assert.equal(none.msg.key, "conflicts.notConflicted");
  assert.equal(none.err, en["conflicts.notConflicted"].replace("{path}", "nothing"));
}

// Accepting a side: the path is resolved in the index and the file is that side's
// version; a side that deleted the file deletes it. Undoing the resolution makes it a
// conflict again, with the file as git left it.
{
  const repo = mergeRepo("accept");
  const r = await acceptSide(git, repo, "m", "theirs");
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(stages(repo, "m"), [0]);
  assert.equal(indexed(repo, "m"), "a\nF\n");
  assert.equal(disk(repo, "m"), "a\nF\n");

  assert.equal((await acceptSide(git, repo, "d1", "theirs")).ok, true);
  assert.deepEqual(stages(repo, "d1"), []);
  assert.equal(disk(repo, "d1"), null);

  assert.equal((await acceptSide(git, repo, "d2", "theirs")).ok, true);
  assert.deepEqual(stages(repo, "d2"), [0]);
  assert.equal(disk(repo, "d2"), "kf\n");

  assert.equal((await acceptSide(git, repo, "h", "ours")).ok, true);
  assert.equal(disk(repo, "h"), "a\r\nM\r\n");

  // The binary file takes a side as a whole.
  assert.equal((await acceptSide(git, repo, "bin", "ours")).ok, true);
  assert.deepEqual(stages(repo, "bin"), [0]);
  assert.equal(readFileSync(`${repo}/bin`, "latin1"), "x\0main");

  // A path that is no longer in conflict, or an unknown side, is refused.
  const again = await acceptSide(git, repo, "m", "ours");
  assert.equal(again.ok, false);
  assert.equal(again.msg.key, "conflicts.notConflicted");
  assert.equal(disk(repo, "m"), "a\nF\n");
  assert.equal((await acceptSide(git, repo, "s", "left")).ok, false);
  assert.deepEqual(stages(repo, "s"), [1, 2, 3]);

  // Undo: conflicted again, the stages as the merge left them.
  assert.equal((await unresolve(git, repo, "m")).ok, true);
  assert.deepEqual(stages(repo, "m"), [1, 2, 3]);
  assert.match(disk(repo, "m"), /<<<<<<< /);
  const back = await readVersions(git, repo, "m");
  assert.deepEqual([back.base, back.ours, back.theirs], ["a\nb\n", "a\nM\n", "a\nF\n"]);

  // A side deleted by the resolution comes back as git left it: ours' file on disk.
  assert.equal((await unresolve(git, repo, "d1")).ok, true);
  assert.deepEqual(stages(repo, "d1"), [1, 2]);
  assert.equal(disk(repo, "d1"), "km\n");
  assert.equal((await unresolve(git, repo, "d2")).ok, true);
  assert.deepEqual(stages(repo, "d2"), [1, 3]);
  assert.equal(disk(repo, "d2"), "kf\n");

  // A path that never was in conflict can't be undone, and nothing changes.
  put(repo, "z", "z\n");
  sh(repo, "git add z");
  const z = await unresolve(git, repo, "z");
  assert.equal(z.ok, false);
  assert.equal(z.msg.key, "conflicts.cannotUnresolve");
  assert.deepEqual(stages(repo, "z"), [0]);
}

// Saving a result: the file is the text, byte for byte, and resolved in the index.
{
  const repo = mergeRepo("save");
  const text = "a\r\nM\r\nF\r\n";
  const r = await saveResult(git, repo, "h", text, { write });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(stages(repo, "h"), [0]);
  assert.equal(readFileSync(`${repo}/h`, "utf8"), text);
  assert.equal(indexed(repo, "h"), text);
  // Undo works after a save too.
  assert.equal((await unresolve(git, repo, "h")).ok, true);
  assert.deepEqual(stages(repo, "h"), [1, 2, 3]);

  // A writer that fails leaves the conflict as it was.
  const failed = await saveResult(git, repo, "m", "x\n", { write: async () => { throw new Error("disk full"); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.msg.key, "conflicts.writeFailed");
  assert.match(failed.err, /disk full/);
  assert.deepEqual(stages(repo, "m"), [1, 2, 3]);
  // No writer: nothing written.
  assert.equal((await saveResult(git, repo, "m", "x\n", {})).ok, false);
  assert.deepEqual(stages(repo, "m"), [1, 2, 3]);
}

// Resolving all simple conflicts: a file whose conflicts all merge line by line is saved
// with that merge and resolved; the others (a real conflict, a deleted side, a binary)
// are left exactly as they were.
{
  const repo = mergeRepo("simple");
  const before = { m: disk(repo, "m"), h: disk(repo, "h"), d1: disk(repo, "d1") };
  const r = await resolveSimpleAll(git, repo, { write });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(r.resolved, ["s"]);
  assert.deepEqual(r.left, ["bin", "d1", "d2", "h", "m"]);
  assert.equal(disk(repo, "s"), "ONE\nTWO\n3\n");
  assert.equal(indexed(repo, "s"), "ONE\nTWO\n3\n");
  assert.deepEqual(unmerged(repo), ["bin", "d1", "d2", "h", "m"]);
  assert.deepEqual({ m: disk(repo, "m"), h: disk(repo, "h"), d1: disk(repo, "d1") }, before);
  // Only the paths asked for, when given.
  const again = await resolveSimpleAll(git, repo, { write, paths: ["m"] });
  assert.deepEqual([again.resolved, again.left], [[], ["m"]]);
}

// A cherry-pick's conflict: ours is HEAD's, theirs the picked commit's.
{
  const repo = init("pick");
  put(repo, "f", "1\n2\n3\n");
  sh(repo, "git add -A && git commit -qm base && git checkout -qb other");
  put(repo, "f", "1\nOTHER\n3\n");
  sh(repo, "git commit -qam other && git checkout -q main");
  put(repo, "f", "1\nMAIN\n3\n");
  sh(repo, "git commit -qam main && git cherry-pick other");
  const v = await readVersions(git, repo, "f");
  assert.deepEqual([v.base, v.ours, v.theirs], ["1\n2\n3\n", "1\nMAIN\n3\n", "1\nOTHER\n3\n"]);
  assert.equal((await saveResult(git, repo, "f", "1\nBOTH\n3\n", { write })).ok, true);
  assert.deepEqual(unmerged(repo), []);
  assert.equal(indexed(repo, "f"), "1\nBOTH\n3\n");
}

// A rebase's conflict: ours (stage 2) is the branch rebuilt onto, theirs the commit being
// rebuilt. Accepting and undoing work the same.
{
  const repo = init("rebase");
  put(repo, "f", "1\n2\n3\n");
  sh(repo, "git add -A && git commit -qm base && git checkout -qb topic");
  put(repo, "f", "1\nTOPIC\n3\n");
  sh(repo, "git commit -qam topic && git checkout -q main");
  put(repo, "f", "1\nMAIN\n3\n");
  sh(repo, "git commit -qam main && git checkout -q topic && git rebase main");
  assert.ok(existsSync(`${repo}/.git/rebase-merge`));
  const v = await readVersions(git, repo, "f");
  assert.deepEqual([v.ours, v.theirs], ["1\nMAIN\n3\n", "1\nTOPIC\n3\n"]);
  assert.equal((await acceptSide(git, repo, "f", "theirs")).ok, true);
  assert.equal(disk(repo, "f"), "1\nTOPIC\n3\n");
  assert.equal((await unresolve(git, repo, "f")).ok, true);
  assert.deepEqual(stages(repo, "f"), [1, 2, 3]);
}

// The remote way of writing: parts of at most 100 KB each, appended to a temporary file
// that then takes the file's name. Run here with this computer's sh: a 300 KB text with
// multi-byte letters and CRLF comes out byte for byte, and the file keeps its mode.
{
  const repo = mergeRepo("remote");
  const calls = [];
  const spy = async (cmd, args, options) => { calls.push({ cmd, args, options }); return exec(cmd, args, options); };
  const remote = remoteWriter(spy, "far-away");
  chmodSync(`${repo}/h`, 0o755);
  const line = "가나다 abc \"$x\" `y` \\ 'q'\r\n";
  let text = "";
  while (Buffer.byteLength(text) < 300 * 1024) text += line;
  text += "끝";
  const r = await saveResult(git, repo, "h", text, { write: remote });
  assert.equal(r.ok, true, r.err);
  assert.ok(readFileSync(`${repo}/h`).equals(Buffer.from(text, "utf8")));
  assert.equal(indexed(repo, "h"), text);
  assert.equal(statSync(`${repo}/h`).mode & 0o777, 0o755);
  assert.equal(REMOTE_CHUNK_BYTES <= 100 * 1024, true);
  assert.ok(calls.length >= 4, `${calls.length} calls`);
  for (const call of calls) {
    assert.equal(call.cmd, "sh");
    assert.equal(call.options.on, "far-away");
    for (const arg of call.args) assert.ok(Buffer.byteLength(arg) <= 100 * 1024, `${Buffer.byteLength(arg)} bytes`);
  }
  // No temporary file is left next to it.
  assert.deepEqual(sh(repo, "ls -a").split("\n").filter((n) => n.includes(".tmp")), []);

  // A new file (no file there yet) and an empty text.
  assert.equal((await remote(`${repo}/new-file`, "")).ok, true);
  assert.equal(readFileSync(`${repo}/new-file`, "utf8"), "");
  // A file with no mode to keep (a new one next to it) also works through saveResult.
  const plain = await saveResult(git, repo, "m", "x\n", { write: remoteWriter(exec, null) });
  assert.equal(plain.ok, true, plain.err);
  assert.equal(disk(repo, "m"), "x\n");
  // A folder that doesn't exist fails with the shell's words.
  const missing = await remoteWriter(exec, null)(`${repo}/no/such/folder/f`, "x");
  assert.equal(missing.ok, false);
}

console.log("ok");
