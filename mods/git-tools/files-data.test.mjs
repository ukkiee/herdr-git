// node files-data.test.mjs: the Files panel's reads against throwaway folders and
// repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, readdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { readFolder, readMarks, readSearchList, roomFor } from "./files-data.js";
import { markLookup } from "./files-tree.js";

const base = realpathSync(mkdtempSync(`${tmpdir()}/git-tools-files-`));
// Same shape as herdr's exec: resolves with { code, stdout, stderr }, rejects when it can't start.
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });

const folder = (name) => {
  const dir = `${base}/${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
};
const init = (name) => {
  const repo = folder(name);
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  return repo;
};

// Names and kinds come back as they are on disk, folders first and then by name, .git
// left out. Spaces, quotes, Korean and a newline survive; a link to a folder is a folder,
// a link to a file or to nothing is a file.
{
  const dir = init("names");
  mkdirSync(`${dir}/b folder`);
  mkdirSync(`${dir}/A 폴더`);
  writeFileSync(`${dir}/z.txt`, "z");
  writeFileSync(`${dir}/it's "quoted".md`, "q");
  writeFileSync(`${dir}/한글 파일.txt`, "k");
  writeFileSync(`${dir}/line\nbreak.txt`, "n");
  writeFileSync(`${dir}/.hidden`, "h");
  writeFileSync(`${dir}/..dots`, "d");
  writeFileSync(`${dir}/README.md`, "r");
  symlinkSync("b folder", `${dir}/link-to-folder`);
  symlinkSync("z.txt", `${dir}/link-to-file`);
  symlinkSync("nowhere", `${dir}/dangling`);

  const r = await readFolder(exec, dir);
  assert.equal(r.ok, true);
  assert.equal(r.limited, false);
  assert.deepEqual(r.entries, [
    { name: "A 폴더", dir: true },
    { name: "b folder", dir: true },
    { name: "link-to-folder", dir: true },
    { name: "..dots", dir: false },
    { name: ".hidden", dir: false },
    { name: "dangling", dir: false },
    { name: "it's \"quoted\".md", dir: false },
    { name: "line\nbreak.txt", dir: false },
    { name: "link-to-file", dir: false },
    { name: "README.md", dir: false },
    { name: "z.txt", dir: false },
    { name: "한글 파일.txt", dir: false },
  ]);

  // A folder inside: same reader, its own entries.
  writeFileSync(`${dir}/b folder/inner.txt`, "i");
  assert.deepEqual((await readFolder(exec, `${dir}/b folder`)).entries, [{ name: "inner.txt", dir: false }]);

  // An empty folder is fine and not limited.
  mkdirSync(`${dir}/empty`);
  assert.deepEqual(await readFolder(exec, `${dir}/empty`), { ok: true, entries: [], limited: false, gone: false, denied: false, err: "" });
}

// A folder over the per-folder limit gives the limit's worth, folders still first, and
// says it was cut. `room` (what the whole tree can still take) cuts the same way.
{
  const dir = folder("many");
  for (let i = 0; i < 12; i++) writeFileSync(`${dir}/f${String(i).padStart(2, "0")}`, "");
  mkdirSync(`${dir}/zz-folder`);
  const r = await readFolder(exec, dir, { limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.limited, true);
  assert.equal(r.entries.length, 5);
  const onDisk = new Set(readdirSync(dir));
  assert.equal(onDisk.size, 13);
  for (const e of r.entries) assert.equal(onDisk.has(e.name), true, e.name);
  assert.equal(new Set(r.entries.map((e) => e.name)).size, 5);

  const exact = await readFolder(exec, dir, { limit: 13 });
  assert.equal(exact.limited, false);
  assert.equal(exact.entries.length, 13);
  assert.deepEqual(exact.entries[0], { name: "zz-folder", dir: true });

  const roomy = await readFolder(exec, dir, { room: 3 });
  assert.equal(roomy.limited, true);
  assert.equal(roomy.entries.length, 3);

  const none = await readFolder(exec, dir, { room: 0 });
  assert.equal(none.limited, true);
  assert.deepEqual(none.entries, []);
}

// The room a folder may fill: the tree's total less what the other loaded folders hold
// (a folder read again doesn't count against itself).
{
  const loaded = new Map([["", new Array(3).fill({ name: "x", dir: false })], ["a", new Array(4).fill({ name: "y", dir: false })]]);
  assert.equal(roomFor(loaded, "b", 10), 3);
  assert.equal(roomFor(loaded, "a", 10), 7);
  assert.equal(roomFor(loaded, "b", 5), 0);
  assert.equal(roomFor(new Map(), ""), 5000);
}

// A folder that isn't there is a result, not a throw, and says it's gone.
{
  const r = await readFolder(exec, `${base}/missing`);
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
  assert.deepEqual(r.entries, []);
}

// A folder that can't be read (no permission) is a failure that says so, not an empty
// folder: one that can't be listed and one that can be listed but not entered.
{
  const dir = folder("locked");
  for (const [name, mode] of [["closed", 0o000], ["unlisted", 0o300], ["unentered", 0o600]]) {
    mkdirSync(`${dir}/${name}`);
    writeFileSync(`${dir}/${name}/inside.txt`, "i");
    chmodSync(`${dir}/${name}`, mode);
    const r = await readFolder(exec, `${dir}/${name}`);
    chmodSync(`${dir}/${name}`, 0o755);
    assert.equal(r.ok, false, name);
    assert.equal(r.gone, false, name);
    assert.equal(r.denied, true, name);
    assert.deepEqual(r.entries, [], name);
  }
  const fine = await readFolder(exec, `${dir}/closed`);
  assert.equal(fine.ok, true);
  assert.equal(fine.denied, false);
}

// Every file and folder under .git with its size, time and mode: a read that refreshed
// the index, took a lock or left a cookie changes it.
const gitState = (repo) => {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`, s = statSync(p);
      out.push(`${p} ${s.size} ${s.mtimeMs} ${s.mode}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(`${repo}/.git`);
  return out.sort().join("\n");
};

// Git marks: modified, added (staged or untracked), deleted, conflict and ignored, keyed
// by path from the folder read. An ignored folder marks what's under it; a folder's dot
// counts changed files below it but not ignored ones. The read leaves .git as it was,
// even with an index git would like to refresh.
{
  const repo = init("marks");
  mkdirSync(`${repo}/src/deep`, { recursive: true });
  mkdirSync(`${repo}/quiet`);
  writeFileSync(`${repo}/.gitignore`, "node_modules/\n*.log\n");
  for (const f of ["mod.txt", "gone.txt", "c.txt", "src/deep/a.ts", "quiet/q.txt", "same size.txt"]) writeFileSync(`${repo}/${f}`, "base\n");
  sh(repo, "git add -A && git commit -q -m base && git checkout -q -b other && echo theirs > c.txt && git commit -qam theirs && git checkout -q main && echo ours > c.txt && git commit -qam ours && git merge -q other || true");
  writeFileSync(`${repo}/mod.txt`, "changed\n");
  sh(repo, "rm gone.txt");
  writeFileSync(`${repo}/staged new.txt`, "n\n");
  sh(repo, "git add 'staged new.txt'");
  writeFileSync(`${repo}/새 파일.txt`, "u\n");
  writeFileSync(`${repo}/src/deep/b.ts`, "u\n");
  mkdirSync(`${repo}/newdir/inner`, { recursive: true });
  writeFileSync(`${repo}/newdir/inner/f.txt`, "u\n");
  mkdirSync(`${repo}/node_modules/pkg`, { recursive: true });
  writeFileSync(`${repo}/node_modules/pkg/index.js`, "i\n");
  writeFileSync(`${repo}/quiet/debug.log`, "l\n");
  // Same size, later time: the index entry no longer matches the file's stat.
  writeFileSync(`${repo}/same size.txt`, "BASE\n");
  sh(repo, "git checkout -q -- 'same size.txt' && touch -t 203001010000 'same size.txt'");
  const before = gitState(repo);

  const r = await readMarks(exec, repo);
  assert.equal(r.ok, true);
  assert.deepEqual(r.repo, { root: repo, prefix: "" });
  const m = markLookup(r.marks);
  assert.equal(m.mark("mod.txt"), "modified");
  assert.equal(m.mark("staged new.txt"), "added");
  assert.equal(m.mark("새 파일.txt"), "added");
  assert.equal(m.mark("gone.txt"), "deleted");
  assert.equal(m.mark("c.txt"), "conflict");
  assert.equal(m.mark("src/deep/b.ts"), "added");
  assert.equal(m.mark("src/deep/a.ts"), null);
  assert.equal(m.mark("same size.txt"), null);
  assert.equal(m.mark("newdir"), "added");
  assert.equal(m.mark("newdir/inner/f.txt"), "added");
  assert.equal(m.mark("node_modules"), "ignored");
  assert.equal(m.mark("node_modules/pkg"), "ignored");
  assert.equal(m.mark("node_modules/pkg/index.js"), "ignored");
  assert.equal(m.mark("quiet/debug.log"), "ignored");
  assert.equal(m.mark("quiet/q.txt"), null);
  assert.equal(m.dot("src"), true);
  assert.equal(m.dot("src/deep"), true);
  assert.equal(m.dot("newdir"), true);
  assert.equal(m.dot("newdir/inner"), true);
  assert.equal(m.dot("quiet"), false);
  assert.equal(m.dot("node_modules"), false);
  assert.equal(gitState(repo), before);

  // From a folder inside the repository: paths are from that folder, the rest of the
  // repository leaves no marks, and the prefix says where the folder sits.
  const inner = await readMarks(exec, `${repo}/src`);
  assert.equal(inner.ok, true);
  assert.deepEqual(inner.repo, { root: repo, prefix: "src/" });
  const mi = markLookup(inner.marks);
  assert.equal(mi.mark("deep/b.ts"), "added");
  assert.equal(mi.dot("deep"), true);
  assert.equal(mi.mark("mod.txt"), null);
  assert.deepEqual(Object.keys(inner.marks), ["deep/b.ts"]);
  assert.equal(gitState(repo), before);
}

// A folder read from inside an untracked folder or an ignored one: git gives that whole
// folder as one line, and every path under the folder read takes its mark (an added one
// with dots, an ignored one dim without).
{
  const repo = init("marks-inside");
  writeFileSync(`${repo}/.gitignore`, "node_modules/\n");
  writeFileSync(`${repo}/t.txt`, "t");
  sh(repo, "git add -A && git commit -q -m base");
  mkdirSync(`${repo}/newdir/sub/deeper`, { recursive: true });
  writeFileSync(`${repo}/newdir/sub/deeper/y.js`, "y");
  writeFileSync(`${repo}/newdir/sub/x.js`, "x");
  mkdirSync(`${repo}/node_modules/foo/lib`, { recursive: true });
  writeFileSync(`${repo}/node_modules/foo/lib/i.js`, "i");

  for (const at of ["newdir", "newdir/sub"]) {
    const r = await readMarks(exec, `${repo}/${at}`);
    assert.equal(r.ok, true);
    const m = markLookup(r.marks);
    const name = at === "newdir" ? "sub/x.js" : "x.js";
    assert.equal(m.mark(name), "added", at);
    assert.equal(m.mark(at === "newdir" ? "sub/deeper" : "deeper"), "added", at);
    assert.equal(m.dot(at === "newdir" ? "sub" : "deeper"), true, at);
  }

  const ignored = await readMarks(exec, `${repo}/node_modules/foo`);
  assert.equal(ignored.ok, true);
  const mi = markLookup(ignored.marks);
  assert.equal(mi.mark("lib"), "ignored");
  assert.equal(mi.mark("lib/i.js"), "ignored");
  assert.equal(mi.dot("lib"), false);
}

// Outside a repository there are no marks, and that is not a failure.
{
  const dir = folder("plain");
  writeFileSync(`${dir}/a.txt`, "a");
  const r = await readMarks(exec, dir);
  assert.deepEqual(r, { ok: true, repo: null, marks: {}, err: "" });
  assert.equal(markLookup(r.marks).mark("a.txt"), null);
}

const sorted = (list) => [...list].sort();

// The search list inside a repository: tracked files and new files, not ignored ones, not
// files deleted from disk, nothing under .git. Paths are from the folder searched.
{
  const repo = init("search-repo");
  mkdirSync(`${repo}/src/deep`, { recursive: true });
  writeFileSync(`${repo}/.gitignore`, "node_modules/\n*.log\n");
  writeFileSync(`${repo}/top.txt`, "t");
  writeFileSync(`${repo}/gone.txt`, "g");
  writeFileSync(`${repo}/src/deep/a b.ts`, "a");
  sh(repo, "git add -A && git commit -q -m base && rm gone.txt");
  writeFileSync(`${repo}/src/새 파일.ts`, "n");
  writeFileSync(`${repo}/src/line\nbreak.ts`, "n");
  writeFileSync(`${repo}/src/debug.log`, "l");
  mkdirSync(`${repo}/node_modules/pkg`, { recursive: true });
  writeFileSync(`${repo}/node_modules/pkg/index.js`, "i");
  const before = gitState(repo);

  const r = await readSearchList(exec, repo);
  assert.equal(r.ok, true);
  assert.equal(r.repo, true);
  assert.equal(r.limited, false);
  assert.deepEqual(sorted(r.files), sorted([".gitignore", "top.txt", "src/deep/a b.ts", "src/새 파일.ts", "src/line\nbreak.ts"]));

  const inner = await readSearchList(exec, `${repo}/src`);
  assert.deepEqual(sorted(inner.files), sorted(["deep/a b.ts", "새 파일.ts", "line\nbreak.ts"]));
  assert.equal(gitState(repo), before);
}

// The search list inside a repository stops at the limit too and says so; files deleted
// from disk don't take a place.
{
  const repo = init("search-repo-limit");
  for (const f of ["a.txt", "b.txt", "c.txt", "d.txt", "gone.txt"]) writeFileSync(`${repo}/${f}`, f);
  sh(repo, "git add -A && git commit -q -m base && rm gone.txt");
  writeFileSync(`${repo}/new.txt`, "n");
  const all = ["a.txt", "b.txt", "c.txt", "d.txt", "new.txt"];

  const cut = await readSearchList(exec, repo, { limit: 3 });
  assert.equal(cut.ok, true);
  assert.equal(cut.limited, true);
  assert.equal(cut.files.length, 3);
  for (const f of cut.files) assert.equal(all.includes(f), true, f);

  const exact = await readSearchList(exec, repo, { limit: all.length });
  assert.equal(exact.limited, false);
  assert.deepEqual(sorted(exact.files), all);
}

// When the list is cut, tracked files keep their places before new ones: a folder of
// generated files left out of .gitignore can't push the tracked files out.
{
  const repo = init("search-repo-tracked-first");
  mkdirSync(`${repo}/src`);
  for (const f of ["src/m.txt", "src/z.txt", "y.txt", "z.txt"]) writeFileSync(`${repo}/${f}`, f);
  sh(repo, "git add -A && git commit -q -m base");
  mkdirSync(`${repo}/build`);
  for (const f of ["a.txt", "build/a.out", "src/a.txt"]) writeFileSync(`${repo}/${f}`, f);
  const tracked = sh(repo, "git ls-files").split("\n").filter(Boolean);
  assert.equal(tracked.length, 4);

  const cut = await readSearchList(exec, repo, { limit: 4 });
  assert.equal(cut.limited, true);
  assert.deepEqual(sorted(cut.files), sorted(tracked));

  const inner = await readSearchList(exec, `${repo}/src`, { limit: 2 });
  assert.equal(inner.limited, true);
  assert.deepEqual(sorted(inner.files), ["m.txt", "z.txt"]);
}

// A submodule is a folder, not a file: it stays out of the search list, from the root and
// from a folder above it.
{
  const source = init("search-sub-source");
  writeFileSync(`${source}/lib.c`, "l");
  sh(source, "git add -A && git commit -q -m lib");
  const repo = init("search-sub");
  mkdirSync(`${repo}/deps`);
  writeFileSync(`${repo}/deps/readme.txt`, "r");
  writeFileSync(`${repo}/top.txt`, "t");
  sh(repo, `git add -A && git commit -q -m base && git -c protocol.file.allow=always submodule add -q "${source}" deps/vendor && git commit -q -m sub`);

  const r = await readSearchList(exec, repo);
  assert.equal(r.ok, true);
  assert.deepEqual(sorted(r.files), sorted([".gitmodules", "top.txt", "deps/readme.txt"]));
  const inner = await readSearchList(exec, `${repo}/deps`);
  assert.deepEqual(sorted(inner.files), ["readme.txt"]);

  // A submodule named apart from its path, in a folder with a space, is left out too; a
  // .gitmodules entry whose path now holds a plain tracked file leaves that file in.
  mkdirSync(`${repo}/deps/old lib`);
  writeFileSync(`${repo}/deps/old lib/keep.txt`, "k");
  sh(repo, `git -c protocol.file.allow=always submodule add -q --name other "${source}" "deps/my lib" && git add -A && git config -f .gitmodules submodule.stale.path "deps/old lib/keep.txt" && git add .gitmodules && git commit -q -m more`);
  const more = await readSearchList(exec, `${repo}/deps`);
  assert.deepEqual(sorted(more.files), sorted(["readme.txt", "old lib/keep.txt"]));
}

// Outside a repository the folder is walked: every file below it, links to files too,
// nothing under a .git, and the walk stops at the limit and says so.
{
  const dir = folder("search-plain");
  mkdirSync(`${dir}/a/b`, { recursive: true });
  mkdirSync(`${dir}/proj/.git/objects`, { recursive: true });
  mkdirSync(`${dir}/.hidden dir`);
  writeFileSync(`${dir}/one.txt`, "1");
  writeFileSync(`${dir}/a/two "q".txt`, "2");
  writeFileSync(`${dir}/a/b/셋.txt`, "3");
  writeFileSync(`${dir}/a/b/line\nbreak`, "4");
  writeFileSync(`${dir}/proj/main.c`, "5");
  writeFileSync(`${dir}/proj/.git/HEAD`, "ref");
  writeFileSync(`${dir}/proj/.git/objects/x`, "x");
  writeFileSync(`${dir}/.hidden dir/.env`, "6");
  symlinkSync("one.txt", `${dir}/link.txt`);
  symlinkSync("a", `${dir}/link-dir`);
  const all = ["one.txt", "a/two \"q\".txt", "a/b/셋.txt", "a/b/line\nbreak", "proj/main.c", ".hidden dir/.env", "link.txt"];

  const r = await readSearchList(exec, dir);
  assert.equal(r.ok, true);
  assert.equal(r.repo, false);
  assert.equal(r.limited, false);
  assert.deepEqual(sorted(r.files), sorted(all));

  const exact = await readSearchList(exec, dir, { limit: all.length });
  assert.equal(exact.limited, false);
  assert.equal(exact.files.length, all.length);

  const cut = await readSearchList(exec, dir, { limit: 3 });
  assert.equal(cut.ok, true);
  assert.equal(cut.limited, true);
  assert.equal(cut.files.length, 3);
  for (const f of cut.files) assert.equal(all.includes(f), true, f);

  const missing = await readSearchList(exec, `${base}/no-such-folder`);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.files, []);
}

console.log("ok");
