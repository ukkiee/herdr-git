// node git-diff.test.mjs: readDiff against throwaway repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeGit } from "./git.js";
import { readDiff, touchesDiff } from "./git-diff.js";
import { translator } from "./i18n.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-diff-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const git = makeGit(exec, null);

const init = (name) => {
  const repo = `${base}/${name}`;
  mkdirSync(repo, { recursive: true });
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};
const lines = (from, to, text = (n) => `line ${n}`) => {
  const out = [];
  for (let n = from; n <= to; n++) out.push(text(n));
  return out;
};
const file = (rows) => rows.map((row) => `${row}\n`).join("");
// Rows without the hunk headers, as [kind, old, new, text].
const body = (r) => r.rows.filter((row) => row.kind !== "hunk").map((row) => [row.kind, row.old, row.new, row.text]);

// A modified file: context, removed and added lines, each with the line number of the
// side it is on. The working file is compared with HEAD.
{
  const repo = init("modified");
  writeFileSync(`${repo}/a.txt`, file(lines(1, 10)));
  sh(repo, "git add -A && git commit -q -m first");
  const next = lines(1, 10);
  next[4] = "line five"; // line 5 changed
  next.splice(8, 0, "extra"); // a line added after line 8
  writeFileSync(`${repo}/a.txt`, file(next));

  const r = await readDiff(git, repo, { path: "a.txt", commit: null, status: "modified" });
  assert.equal(r.ok, true);
  assert.equal(r.err, "");
  assert.equal(r.binary, false);
  assert.equal(r.truncated, false);
  assert.deepEqual([r.from, r.to], ["HEAD", "Working Tree"]);
  assert.equal(r.rows[0].kind, "hunk");
  assert.match(r.rows[0].text, /^@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.deepEqual([r.rows[0].old, r.rows[0].new], [null, null]);
  assert.deepEqual(body(r), [
    ["context", 2, 2, "line 2"],
    ["context", 3, 3, "line 3"],
    ["context", 4, 4, "line 4"],
    ["del", 5, null, "line 5"],
    ["add", null, 5, "line five"],
    ["context", 6, 6, "line 6"],
    ["context", 7, 7, "line 7"],
    ["context", 8, 8, "line 8"],
    ["add", null, 9, "extra"],
    ["context", 9, 10, "line 9"],
    ["context", 10, 11, "line 10"],
  ]);
}

// An unversioned file is all added lines, with or without the status hint. A deleted
// file is all removed lines, whether it was removed by hand or with `git rm`.
{
  const repo = init("new-and-gone");
  writeFileSync(`${repo}/gone.txt`, file(lines(1, 3)));
  writeFileSync(`${repo}/staged-gone.txt`, file(lines(1, 2)));
  sh(repo, "git add -A && git commit -q -m first");
  writeFileSync(`${repo}/new.txt`, file(["one", "", "three"]));
  sh(repo, "rm gone.txt && git rm -q staged-gone.txt");

  const added = [["add", null, 1, "one"], ["add", null, 2, ""], ["add", null, 3, "three"]];
  for (const status of ["unversioned", null]) {
    const r = await readDiff(git, repo, { path: "new.txt", commit: null, status });
    assert.equal(r.ok, true, r.err);
    assert.deepEqual(body(r), added);
    assert.deepEqual([r.from, r.to, r.binary, r.truncated], ["", "Working Tree", false, false]);
  }

  const gone = await readDiff(git, repo, { path: "gone.txt", commit: null, status: "deleted" });
  assert.equal(gone.ok, true, gone.err);
  assert.deepEqual(body(gone), [["del", 1, null, "line 1"], ["del", 2, null, "line 2"], ["del", 3, null, "line 3"]]);
  assert.deepEqual([gone.from, gone.to], ["HEAD", "Working Tree"]);

  const staged = await readDiff(git, repo, { path: "staged-gone.txt", commit: null, status: "deleted" });
  assert.deepEqual(body(staged), [["del", 1, null, "line 1"], ["del", 2, null, "line 2"]]);

  // A newly added file (staged, or only made known with --intent-to-add) is all added too.
  writeFileSync(`${repo}/staged.txt`, file(["a", "b"]));
  writeFileSync(`${repo}/later.txt`, file(["c"]));
  sh(repo, "git add staged.txt && git add --intent-to-add later.txt");
  assert.deepEqual(body(await readDiff(git, repo, { path: "staged.txt", status: "added" })), [["add", null, 1, "a"], ["add", null, 2, "b"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "later.txt", status: "added" })), [["add", null, 1, "c"]]);

  // A tracked file nobody changed: no rows, and not an error.
  sh(repo, "git commit -q -m second");
  const same = await readDiff(git, repo, { path: "staged.txt", status: "modified" });
  assert.deepEqual([same.ok, same.rows, same.binary], [true, [], false]);

  // The hint is older than the repository: a file listed as unversioned and committed
  // since is compared with HEAD, not shown as all added.
  writeFileSync(`${repo}/new.txt`, file(["one", "two", "three"]));
  sh(repo, "git add new.txt && git commit -q -m third");
  writeFileSync(`${repo}/new.txt`, file(["one", "two", "3"]));
  const stale = await readDiff(git, repo, { path: "new.txt", status: "unversioned" });
  assert.equal(stale.ok, true, stale.err);
  assert.deepEqual(body(stale), [["context", 1, 1, "one"], ["context", 2, 2, "two"], ["del", 3, null, "three"], ["add", null, 3, "3"]]);
  assert.deepEqual([stale.from, stale.to], ["HEAD", "Working Tree"]);
}

// A repository without a commit has no HEAD: its files are all added lines.
{
  const repo = init("no-head");
  writeFileSync(`${repo}/first.txt`, file(["a", "b"]));
  writeFileSync(`${repo}/other.txt`, file(["x"]));
  sh(repo, "git add first.txt");
  const staged = await readDiff(git, repo, { path: "first.txt", commit: null, status: "added" });
  assert.equal(staged.ok, true, staged.err);
  assert.deepEqual(body(staged), [["add", null, 1, "a"], ["add", null, 2, "b"]]);
  assert.deepEqual([staged.from, staged.to], ["", "Working Tree"]);
  const loose = await readDiff(git, repo, { path: "other.txt", commit: null, status: "unversioned" });
  assert.deepEqual(body(loose), [["add", null, 1, "x"]]);
}

// Paths with spaces, Korean and glob characters are taken as they are.
{
  const repo = init("names");
  mkdirSync(`${repo}/새 폴더`);
  mkdirSync(`${repo}/app/[id]`, { recursive: true });
  mkdirSync(`${repo}/app/i`);
  writeFileSync(`${repo}/새 폴더/한글 문서.md`, file(["가", "나"]));
  writeFileSync(`${repo}/my notes.md`, file(["one"]));
  writeFileSync(`${repo}/app/[id]/page.tsx`, file(["x"]));
  writeFileSync(`${repo}/app/i/page.tsx`, file(["other file"]));
  sh(repo, "git add -A && git commit -q -m first");
  writeFileSync(`${repo}/새 폴더/한글 문서.md`, file(["가", "다"]));
  writeFileSync(`${repo}/my notes.md`, file(["one", "two"]));
  writeFileSync(`${repo}/app/[id]/page.tsx`, file(["y"]));
  writeFileSync(`${repo}/app/i/page.tsx`, file(["other file changed"])); // `[id]` as a pattern would match this one
  writeFileSync(`${repo}/새 폴더/새 파일 1.txt`, file(["새 줄"]));

  assert.deepEqual(body(await readDiff(git, repo, { path: "새 폴더/한글 문서.md", status: "modified" })),
    [["context", 1, 1, "가"], ["del", 2, null, "나"], ["add", null, 2, "다"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "my notes.md", status: "modified" })),
    [["context", 1, 1, "one"], ["add", null, 2, "two"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "app/[id]/page.tsx", status: "modified" })),
    [["del", 1, null, "x"], ["add", null, 1, "y"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "새 폴더/새 파일 1.txt", status: "unversioned" })),
    [["add", null, 1, "새 줄"]]);

  // The same names in a commit.
  sh(repo, "git add -A && git commit -q -m second");
  const head = sh(repo, "git rev-parse HEAD").trim();
  assert.deepEqual(body(await readDiff(git, repo, { path: "새 폴더/한글 문서.md", commit: head })),
    [["context", 1, 1, "가"], ["del", 2, null, "나"], ["add", null, 2, "다"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "app/[id]/page.tsx", commit: head })),
    [["del", 1, null, "x"], ["add", null, 1, "y"]]);
}

// Binary files are only named as binary: modified, unversioned, and in a commit.
{
  const repo = init("binary");
  writeFileSync(`${repo}/pic.bin`, Buffer.from([0, 1, 2, 3, 0, 255, 254]));
  sh(repo, "git add -A && git commit -q -m first");
  writeFileSync(`${repo}/pic.bin`, Buffer.from([0, 9, 9, 9, 0, 255, 254, 7]));
  writeFileSync(`${repo}/new.bin`, Buffer.from([0, 0, 0, 1]));
  for (const [path, status] of [["pic.bin", "modified"], ["new.bin", "unversioned"]]) {
    const r = await readDiff(git, repo, { path, commit: null, status });
    assert.equal(r.ok, true, r.err);
    assert.deepEqual([r.binary, r.rows, r.truncated], [true, [], false], path);
  }
  sh(repo, "git add -A && git commit -q -m second");
  const r = await readDiff(git, repo, { path: "pic.bin", commit: sh(repo, "git rev-parse HEAD").trim() });
  assert.deepEqual([r.ok, r.binary, r.rows], [true, true, []]);
}

// A diff past the limits is cut there and says so: 5,000 rows, or 400,000 characters.
{
  const repo = init("big");
  writeFileSync(`${repo}/keep.txt`, "x\n");
  sh(repo, "git add -A && git commit -q -m first");
  writeFileSync(`${repo}/many.txt`, file(lines(1, 6000)));
  const many = await readDiff(git, repo, { path: "many.txt", status: "unversioned" });
  assert.equal(many.ok, true, many.err);
  assert.equal(many.truncated, true);
  assert.equal(many.rows.length, 5000);
  // The hunk header is a row too, so the last line shown is line 4,999.
  assert.deepEqual(many.rows.at(-1), { kind: "add", old: null, new: 4999, text: "line 4999" });

  // 500 lines of 1,000 characters: the first 400 fill the character limit.
  writeFileSync(`${repo}/wide.txt`, file(lines(1, 500, () => "w".repeat(1000))));
  const wide = await readDiff(git, repo, { path: "wide.txt", status: "unversioned" });
  assert.equal(wide.truncated, true);
  const shown = wide.rows.reduce((n, row) => n + (row.kind === "hunk" ? 0 : row.text.length), 0);
  assert.ok(shown <= 400000 && shown >= 399000, `${shown} characters shown`);
  assert.ok(wide.rows.length < 500);

  // One line longer than the limit (a minified file): what fits of it is shown.
  writeFileSync(`${repo}/min.js`, "m".repeat(450000));
  const min = await readDiff(git, repo, { path: "min.js", status: "unversioned" });
  assert.equal(min.truncated, true);
  assert.deepEqual(min.rows.map((row) => row.kind), ["hunk", "add"]);
  assert.ok(min.rows[1].text.length <= 400000 && min.rows[1].text.length >= 399000);

  // Just under the limits nothing is cut.
  writeFileSync(`${repo}/fits.txt`, file(lines(1, 4999)));
  const fits = await readDiff(git, repo, { path: "fits.txt", status: "unversioned" });
  assert.deepEqual([fits.truncated, fits.rows.length], [false, 5000]);
}

// A file of a commit is compared with the commit's first parent; in the first commit,
// which has none, it is all added lines. What the working tree holds now doesn't matter.
{
  const repo = init("commits");
  writeFileSync(`${repo}/a.txt`, file(["one", "two"]));
  sh(repo, "git add -A && git commit -q -m first");
  const first = sh(repo, "git rev-parse HEAD").trim();
  writeFileSync(`${repo}/a.txt`, file(["one", "2", "three"]));
  writeFileSync(`${repo}/b.txt`, file(["new in second"]));
  sh(repo, "git add -A && git commit -q -m second");
  const second = sh(repo, "git rev-parse HEAD").trim();
  sh(repo, "git rm -q b.txt && git commit -q -m third");
  const third = sh(repo, "git rev-parse HEAD").trim();
  writeFileSync(`${repo}/a.txt`, file(["not committed"]));

  const root = await readDiff(git, repo, { path: "a.txt", commit: first });
  assert.equal(root.ok, true, root.err);
  assert.deepEqual(body(root), [["add", null, 1, "one"], ["add", null, 2, "two"]]);
  assert.deepEqual([root.from, root.to], ["", first.slice(0, 7)]);

  const changed = await readDiff(git, repo, { path: "a.txt", commit: second });
  assert.deepEqual(body(changed), [["context", 1, 1, "one"], ["del", 2, null, "two"], ["add", null, 2, "2"], ["add", null, 3, "three"]]);
  assert.deepEqual([changed.from, changed.to], [first.slice(0, 7), second.slice(0, 7)]);
  // A short hash names the same commit.
  assert.deepEqual(body(await readDiff(git, repo, { path: "a.txt", commit: second.slice(0, 8) })), body(changed));

  assert.deepEqual(body(await readDiff(git, repo, { path: "b.txt", commit: second })), [["add", null, 1, "new in second"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "b.txt", commit: third })), [["del", 1, null, "new in second"]]);

  // A merge commit: against its first parent, so what the merged branch brought in shows.
  sh(repo, `git checkout -q -- a.txt && git checkout -q -b side ${second} && echo side > side.txt && git add -A && git commit -q -m side
git checkout -q main && git merge -q --no-ff -m merge side`);
  const merge = sh(repo, "git rev-parse HEAD").trim();
  const merged = await readDiff(git, repo, { path: "side.txt", commit: merge });
  assert.deepEqual(body(merged), [["add", null, 1, "side"]]);
  assert.deepEqual([merged.from, merged.to], [third.slice(0, 7), merge.slice(0, 7)]);
}

// A file a commit renamed, asked about with the path it had before: it is compared with
// that file, so only the lines the commit changed are rows.
{
  const repo = init("renamed");
  mkdirSync(`${repo}/src`);
  writeFileSync(`${repo}/src/old name.txt`, file(lines(1, 8)));
  writeFileSync(`${repo}/same.txt`, file(lines(1, 3)));
  sh(repo, "git add -A && git commit -q -m first");
  const first = sh(repo, "git rev-parse HEAD").trim();
  const next = lines(1, 8);
  next[2] = "line three";
  sh(repo, `git mv "src/old name.txt" "new*name.txt" && git mv same.txt moved.txt`);
  writeFileSync(`${repo}/new*name.txt`, file(next));
  sh(repo, "git add -A && git commit -q -m rename");
  const second = sh(repo, "git rev-parse HEAD").trim();

  const r = await readDiff(git, repo, { path: "new*name.txt", commit: second, oldPath: "src/old name.txt" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(body(r), [
    ["context", 1, 1, "line 1"],
    ["context", 2, 2, "line 2"],
    ["del", 3, null, "line 3"],
    ["add", null, 3, "line three"],
    ["context", 4, 4, "line 4"],
    ["context", 5, 5, "line 5"],
    ["context", 6, 6, "line 6"],
  ]);
  assert.deepEqual([r.from, r.to], [first.slice(0, 7), second.slice(0, 7)]);

  // Asked about without the old path, the same file is all added lines.
  const alone = await readDiff(git, repo, { path: "new*name.txt", commit: second });
  assert.deepEqual(body(alone), next.map((text, i) => ["add", null, i + 1, text]));

  // Renamed and nothing else: no rows, and not an error.
  const moved = await readDiff(git, repo, { path: "moved.txt", commit: second, oldPath: "same.txt" });
  assert.equal(moved.ok, true, moved.err);
  assert.deepEqual(moved.rows, []);
  assert.deepEqual([moved.binary, moved.from, moved.to], [false, first.slice(0, 7), second.slice(0, 7)]);

  // An old path the parent never had, or a commit with nothing before it: the file as
  // the commit has it, all added.
  const wrong = await readDiff(git, repo, { path: "new*name.txt", commit: second, oldPath: "nowhere.txt" });
  assert.equal(wrong.ok, true, wrong.err);
  assert.deepEqual(body(wrong), body(alone));
  const root = await readDiff(git, repo, { path: "same.txt", commit: first, oldPath: "nowhere.txt" });
  assert.deepEqual(body(root), lines(1, 3).map((text, i) => ["add", null, i + 1, text]));

  // A working file has no old path to compare with: the hint is ignored.
  writeFileSync(`${repo}/moved.txt`, file(["line 1", "line 2", "line 3", "line 4"]));
  const working = await readDiff(git, repo, { path: "moved.txt", oldPath: "same.txt", status: "modified" });
  assert.deepEqual(body(working).filter(([kind]) => kind !== "context"), [["add", null, 4, "line 4"]]);
}

// Which changes on disk can change a working file's diff, out of what a folder watch
// reports (absolute paths): the file, a folder above it, something where the file was,
// git's own folder (HEAD moved), and whatever can't be placed under the root.
{
  const yes = (changed, root = "/repo", path = "src/app/a.ts") => assert.equal(touchesDiff(changed, root, path), true, JSON.stringify(changed));
  const no = (changed, root = "/repo", path = "src/app/a.ts") => assert.equal(touchesDiff(changed, root, path), false, JSON.stringify(changed));
  yes(["/repo/src/app/a.ts"]);
  yes(["/repo/other.txt", "/repo/src/app/a.ts"]);
  yes(["/repo/src/app"]);
  yes(["/repo/src"]);
  yes(["/repo/src/app/a.ts/inner"]);
  yes(["/repo"]);
  yes(["/elsewhere/x"]);
  yes(["/repo/.git"]);
  yes(["/repo/.git/HEAD"]);
  yes(["/repo/.git/refs/heads/main"]);
  no([]);
  no(["/repo/other.txt"]);
  no(["/repo/src/app/a.tsx"]);
  no(["/repo/src/app/b.ts", "/repo/src/application/a.ts"]);
  no(["/repo/.git/objects/ab/cdef", "/repo/.git/objects"]);
  no(["/repo/.gitignore"]);
  no(["/repo/sub/.git/HEAD"]);
  // The root as some callers write it, and Windows' separators.
  yes(["/repo/x"], "/repo/", "x");
  no(["/repo/y"], "/repo/", "x");
  yes(["C:\\repo\\src\\a.ts"], "C:/repo", "src/a.ts");
  no(["C:\\repo\\other.txt"], "C:/repo", "src/a.ts");
}

// Line endings and a missing last newline: \r isn't shown as text, git's remark is a row.
{
  const repo = init("endings");
  writeFileSync(`${repo}/crlf.txt`, "one\r\ntwo\r\n");
  writeFileSync(`${repo}/tail.txt`, "one\ntwo");
  sh(repo, "git -c core.autocrlf=false add -A && git commit -q -m first");
  writeFileSync(`${repo}/crlf.txt`, "one\r\n2\r\n");
  writeFileSync(`${repo}/tail.txt`, "one\ntwo\n");
  assert.deepEqual(body(await readDiff(git, repo, { path: "crlf.txt", status: "modified" })),
    [["context", 1, 1, "one"], ["del", 2, null, "two"], ["add", null, 2, "2"]]);
  assert.deepEqual(body(await readDiff(git, repo, { path: "tail.txt", status: "modified" })),
    [["context", 1, 1, "one"], ["del", 2, null, "two"], ["note", null, null, "No newline at end of file"], ["add", null, 2, "two"]]);
}

// The person's git config doesn't change what comes back.
{
  const repo = init("config");
  writeFileSync(`${repo}/a.txt`, file(lines(1, 9)));
  sh(repo, "git add -A && git commit -q -m first");
  sh(repo, "git config color.ui always && git config diff.noprefix true && git config diff.context 0 && git config diff.external /usr/bin/false");
  const next = lines(1, 9);
  next[4] = "five";
  writeFileSync(`${repo}/a.txt`, file(next));
  const r = await readDiff(git, repo, { path: "a.txt", status: "modified" });
  assert.equal(r.ok, true, r.err);
  assert.deepEqual(body(r).map((row) => row[0]), ["context", "context", "context", "del", "add", "context", "context", "context"]);
  assert.equal(r.rows.find((row) => row.kind === "add").text, "five");
}

// git can't answer: a result with git's words, not an exception.
{
  const repo = init("errors");
  writeFileSync(`${repo}/a.txt`, "x\n");
  sh(repo, "git add -A && git commit -q -m first");
  const unknown = await readDiff(git, repo, { path: "a.txt", commit: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.err.length > 0);
  assert.deepEqual([unknown.rows, unknown.binary, unknown.truncated], [[], false, false]);

  const missing = await readDiff(git, repo, { path: "never-there.txt", commit: null, status: "unversioned" });
  assert.equal(missing.ok, false);
  assert.ok(missing.err.length > 0);

  const plain = `${base}/plain`;
  mkdirSync(plain);
  const outside = await readDiff(git, plain, { path: "a.txt", commit: null, status: "modified" });
  assert.equal(outside.ok, false);
  assert.ok(outside.err.length > 0);
  assert.deepEqual(outside.rows, []);

  const down = await readDiff(makeGit(() => Promise.reject(new Error("machine vps is unreachable")), "vps"), "/repo", { path: "a.txt" });
  assert.equal(down.ok, false);
  assert.match(down.err, /unreachable/);
  assert.equal((await readDiff(git, repo, {})).ok, false);
}

// Reading a diff leaves .git/index alone (the Commit panel watches the folder).
{
  const repo = init("quiet");
  writeFileSync(`${repo}/a.txt`, "1\n");
  writeFileSync(`${repo}/b.txt`, "1\n");
  sh(repo, "git add -A && git commit -q -m first");
  const index = `${repo}/.git/index`;
  const snapshot = () => ({ bytes: readFileSync(index).toString("hex"), mtime: statSync(index).mtimeMs });
  const later = new Date(Date.now() + 5000);
  utimesSync(`${repo}/a.txt`, later, later); // a stale timestamp makes a plain `git diff` rewrite the index
  writeFileSync(`${repo}/b.txt`, "2\n");
  const before = snapshot();
  await readDiff(git, repo, { path: "a.txt", status: "modified" });
  await readDiff(git, repo, { path: "b.txt", status: "modified" });
  assert.deepEqual(snapshot(), before, "reading a diff does not rewrite the index");
}

// No file asked about: the module's own sentence, with its key (i18n.js). The English made
// from the key is the err itself.
{
  const r = await readDiff(git, base, {});
  assert.equal(r.ok, false);
  assert.equal(r.err, "No file to show.");
  assert.equal(r.msg?.key, "dialogs.diff.noFile");
  assert.equal(translator("en")(r.msg.key, r.msg.args), r.err);
  assert.notEqual(translator("ko")(r.msg.key, r.msg.args), r.msg.key);
}

console.log("ok");
