// node files-data.test.mjs: the Files panel's reads against throwaway folders and
// repositories (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { readFolder } from "./files-data.js";

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
  assert.deepEqual(await readFolder(exec, `${dir}/empty`), { ok: true, entries: [], limited: false, gone: false, err: "" });
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

// A folder that isn't there is a result, not a throw, and says it's gone.
{
  const r = await readFolder(exec, `${base}/missing`);
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
  assert.deepEqual(r.entries, []);
}

console.log("ok");
