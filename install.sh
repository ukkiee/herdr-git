#!/bin/sh
# Installs or updates git-tools in the Herdr app's home, builds the main-git layout from
# the current main layout and shows it. Run it again after `git pull` and after every
# Herdr update (main-git is a copy: it doesn't follow Herdr's main by itself).
# Herdr's own main layout is never changed; cmd-shift-l moves to the next layout, main among them.
# Keys: adds the ones in keys.json unless they're already bound to something else.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
main="$home/layouts/main.json"
out="$home/layouts/main-git.json"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found: it's needed to build the layout. Nothing was changed."
  exit 1
fi
if [ ! -f "$main" ]; then
  echo "No $main: open Herdr once so it writes its layouts, then run this again. Nothing was changed."
  exit 1
fi
# Check before writing anything: a main layout this wasn't built for stops here.
if ! node "$here/layout.mjs" "$main"; then
  echo "Nothing was changed."
  exit 1
fi
if ! herdr-app status >/dev/null 2>&1; then
  echo "Herdr isn't running (herdr-app status failed): open it, then run this again. Nothing was changed."
  exit 1
fi

# Only files that differ are written: Herdr reloads the mod each time a file in its
# folder is saved, and the mod has thousands of files.
mkdir -p "$home/mods/git-tools"
node "$here/layout.mjs" --copy "$here/mods/git-tools" "$home/mods/git-tools"
herdr-app check "$home/mods/git-tools"

# The first time, let Herdr clone main so its clicks (sizes, theme pick) come along.
# layout.clone refuses a name that exists, so after that the file is rebuilt in place:
# layouts apply live, and a file edit wins over a click on the same field.
if [ ! -f "$out" ]; then
  herdr-app do layout.clone '{"name":"main","as":"main-git"}' >/dev/null
fi
node "$here/layout.mjs" "$main" "$out"
herdr-app do layout.switch '{"name":"main-git"}' >/dev/null
if [ -f "$home/layouts/main-git.error" ]; then
  echo "Herdr refused the new layout:"
  cat "$home/layouts/main-git.error"
  exit 1
fi
echo "Layout main-git is shown. cmd-shift-l switches layouts; Herdr's main is unchanged."

# keys.json holds every key, the defaults included, so it's only ever added to.
if [ ! -f "$home/keys.json" ]; then
  echo "No $home/keys.json yet: add the keys in keys.json by hand once Herdr has written one."
  exit 0
fi
node - "$home/keys.json" "$here/keys.json" <<'EOF'
const fs = require("fs");
const [file, wantedFile] = process.argv.slice(2);
const keys = JSON.parse(fs.readFileSync(file, "utf8"));
const wanted = JSON.parse(fs.readFileSync(wantedFile, "utf8"));
const text = (action) => typeof action === "string" ? action : JSON.stringify(action);
let changed = false;
for (const [section, binds] of Object.entries(wanted)) {
  for (const [key, action] of Object.entries(binds)) {
    if (text(keys[section]?.[key]) === text(action)) continue;
    // A key taken here, or in a section this one would shadow, stays the person's.
    const taken = [section, "global", "terminal"].find((s) => keys[s]?.[key] !== undefined);
    if (taken) {
      console.log(`${key} is already ${text(keys[taken][key])} (${taken}): left as it is. Bind ${text(action)} to another key in ${file}.`);
      continue;
    }
    (keys[section] ??= {})[key] = action;
    changed = true;
    console.log(`${key} → ${text(action)} (${section})`);
  }
}
// Written next to it and renamed over it: a write that fails halfway (a full disk)
// leaves the person's keys.json as it was.
if (changed) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(keys, null, 2) + "\n");
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
EOF
