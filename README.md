# herdr-git

**English** | [한국어](README.ko.md)

Git tools for the [Herdr](https://herdr.dev) desktop app: a Commit panel
behind the tab bar's Changes button, a Files panel behind its Files button and a Git Log
panel under the work area. Pick the files to commit, commit or amend, push with a
preview, roll files back and restore them, bring deleted branches back, browse your
files with their git status, and browse branches and history with a commit graph, search
and filters.

![git-tools](preview.png)

- **Commit panel** (Changes button, `cmd-k`): changed and unversioned files as a
  checkbox tree. Only the checked files are committed, whatever git has staged.
  Amend, Commit and Push…, Rollback…, Restore Rolled-Back Changes…, Show Diff. With
  Amend on, the files of the last commit show at the bottom.
- **Files panel** (Files button): the focused pane's folder as a tree, names colored by
  their git status, a dot beside folders with changes inside, a search box that finds
  files by part of their path, and a read-only preview of the file you press.
  Right-click a row for Show Diff, Copy Path, Copy Relative Path and Reveal in Finder.
- **Log panel** (the Git button beside Changes, `cmd-shift-g`): Branch tree (checkout,
  new branch, delete, deleted branches, fetch), every commit with a graph, search by
  text or hash, Branch / User / Date / Path filters, and the selected commit's files and
  message.
- **Diff tab**: one file's unified diff with line numbers, opened from any panel. A
  working file's tab follows the file as it changes.

### Undo a rollback or a branch delete

- **Rollback** records the files it is about to throw away inside the repository first.
  Right after it, a row under the Commit panel says `Rolled back N files.` with
  **Restore…**; any time later, the toolbar's **Restore Rolled-Back Changes…** lists the
  last 50 rollbacks. Pick one, check the files (double-click one to see its diff), press
  Restore. A file you changed again since the rollback is never overwritten: it is
  skipped and the dialog says why. A new file still on disk as it was recorded (rolled
  back with `Delete local copies of added files` off) counts as restored. What was
  staged comes back too, so `git status` reads as it did before the rollback; a file
  you staged something else for since keeps that staging, and the dialog says so.
- **Deleting a branch** records it in the repository first, then shows a row under the
  Log panel, `Deleted branch 'x' (1a2b3c4).`, with **Restore**: the branch comes back at
  the same commit, tracking the same remote branch, without checking it out. Any time
  later, the Branch tree's **Deleted Branches…** button lists the branches deleted in
  this repository, newest first; check several and press Restore. git keeps them for
  about 30 days. A branch of that name made meanwhile is left alone.

### User filter

Type a few letters: the repository's authors narrow as you type. Check several people
by clicking or with ↑ ↓ and Enter; the list keeps the commits of any of them. Enter with
no row selected adds what you typed as a part of a name or email to match.

### File icons

Files and folders in the changed-file trees, the Files panel and the Diff tab's header
show the
[Atom Material Icons](https://github.com/AtomMaterialUI/iconGenerator) icons (the light
or dark variant with Herdr's look). See "Icons and size" below for their license.

### Language

The screens are Korean when your computer's first preferred language is Korean, and
English otherwise. There is no switch in the mod. macOS reads the system's preferred
languages, Linux the `LC_ALL`, `LC_MESSAGES` and `LANG` variables, and Windows its
display language (not yet checked on a real Windows machine). A space on another machine still follows the computer the window is on. After
changing the system language, restart Herdr. git's own messages are shown as git writes
them.

It all lives in a layout called `main-git`, a copy of Herdr's `main`. Herdr's own
layout and its Changes and Files panels are left as they are.

## Before you add it

- **Programs**: the mod runs `git` in the repository of the focused pane (on the
  space's machine when the space is on another one), and `env` to pass
  `GIT_TERMINAL_PROMPT=0` to git. The Files panel lists folders with `sh` (PowerShell
  for a folder on a Windows computer) where the space runs, and Reveal in Finder runs
  `open -R`. To pick the language it runs, on your own computer,
  `defaults read -g AppleLanguages` (macOS), `sh -c 'printf …'` printing `LC_ALL`,
  `LC_MESSAGES` and `LANG` (Linux) or `powershell -NoProfile -Command
  "(Get-UICulture).Name"` (Windows).
- **Network**: `git fetch --all --prune` when you press Fetch, and `git push` when you
  press Push or Force Push. Nothing else goes out.
- **Your repositories**: git-tools writes only when you press a button (commit, amend,
  rollback, restore, checkout, new branch, delete branch, restore a branch, fetch, push).
  It never runs `reset --hard`, a forced checkout or a bare `--force`. One of these runs
  at a time per repository: while one runs, the buttons for the others are off on every
  git-tools screen showing that repository.
- **Rollback records**: each Rollback adds a commit object under the private ref
  `refs/git-tools/rollback` (with its reflog) and leaves an emptied file
  `git-tools-rollback-index-<id>` in the git folder, one for each Commit panel id that
  rolled back or restored there (`<id>` is kept in the copy's storage, so copies opened
  with the same props share one; a copy that can't keep it leaves one more file each
  run; 65 bytes in a SHA-1 repository, 89 in a SHA-256 one). It isn't a branch or tag and is never pushed, but **the newest record
  shows as one commit in `git log --all`** and in tools that draw every ref (like
  `git stash`). A record the ref no longer points at goes 30 days later, when git's
  reflog expiry runs at `gc` (the default); the newest record stays as long as the ref
  points at it. git-tools deletes none itself. A record also holds what was staged, as a
  second commit that `git log --all` shows beside the newest record.
- **Deleted-branch records**: before each Delete, the branch is recorded in the reflog
  of the private ref `refs/git-tools/deleted-branches`, which rests on the first commit
  of HEAD's history, so `git log --all` shows no new commit (only that ref's name on the
  first commit). git drops a record about 30 days later, when its reflog expiry runs at
  `gc`; git-tools deletes none itself and changes no git config for it. Records stay in
  that clone: `push --all` and clone don't carry them. Restoring a deleted branch also
  writes back its `branch.<name>.remote` and `.merge` config.
- **Files in Herdr's app home** (`~/.config/herdr-app`, or `$HERDR_APP_HOME`):
  `install.sh` writes `mods/git-tools/` and `layouts/main-git.json`, and adds two keys to
  `keys.json`. The mod keeps three small values in `shared.json`: `git-tools.bus` (how its
  screens tell each other the repository changed), `git-tools.lock` (which
  repository a git-tools write is running on) and `git-tools.lang` (the system language
  last read, `"en"` or `"ko"`). It writes to the clipboard only for Copy Revision Number,
  Copy Path and Copy Relative Path.

How it's built and what to watch for: [RECIPE.md](RECIPE.md).

## Install

You need Herdr running, `node`, and `git` 2.37 or later on every machine your spaces
run on.

```sh
git clone https://github.com/ukkiee/herdr-git
cd herdr-git && ./install.sh
```

`install.sh` copies the mod (only the files that differ from what is installed), builds
`main-git` from your current `main` layout, switches to it and adds the keys. If your `main` layout isn't shaped the way it expects, it says
which part is missing and changes nothing.

### Keys

| key | does |
|---|---|
| `cmd-k` | opens the Commit panel |
| `cmd-shift-g` | shows or hides the Log panel |

Both work only in the `main-git` layout. A key you already use for something else is
left alone; `install.sh` says so, and you can bind the action to another key in
`keys.json`.

### After a Herdr update

`main-git` is a copy, so it doesn't pick up changes Herdr makes to `main`. **Run
`./install.sh` again after every Herdr update** (and after `git pull` here). It rebuilds
`main-git` from your current `main`. Changes you made by hand to `main-git.json` are lost
then.

### Back to `main`

Press `cmd-shift-l` (Herdr's layout switch). It moves to the next layout, so with more
than two layouts press it until `main` shows. Herdr's own Changes panel is there
unchanged. Press it until `main-git` shows, or run `./install.sh`, to come back.

### Remove it

Switch to `main` first, then delete `mods/git-tools/` and `layouts/main-git.json` in the
app home, and the `layout:main-git` section of `keys.json`. Herdr may also have left
`layouts/.state/main-git.json` and the `git-tools.bus`, `git-tools.lock` and
`git-tools.lang` keys in `shared.json`; all are safe to delete. Rollback and
deleted-branch records stay in each repository until git expires them;
`git update-ref -d refs/git-tools/rollback` and
`git update-ref -d refs/git-tools/deleted-branches` there drop them at once (they can't be
restored after that).

## Force push

- Force Push sits under the ▾ next to Push in the Push dialog. It is always
  `--force-with-lease`: git refuses if someone pushed to the remote branch since your
  last fetch. A plain `--force` is never used.
- It is disabled on `main` and `master`, including a branch that pushes to a remote
  `main` or `master`.
- There is no place to type a password, passphrase or GPG PIN. A remote that asks for
  one doesn't hang: the push fails and the dialog shows git's error. Your commit is
  already made; set up a credential helper or SSH agent and press Push again.

## Icons and size

- The file and folder icons are **Atom Material Icons** by Elior "Mallowigi" Boukhobza,
  MIT License, taken from
  [`AtomMaterialUI/iconGenerator`](https://github.com/AtomMaterialUI/iconGenerator) at
  commit `90e051eecb393c6380be18a1941c3096170c15d6` (the rules and icons of Atom Material
  Icons 210.0.2): 1,797 file icons and 351 folder icons,
  closed and open. The license and the source are in
  [`mods/git-tools/icons/theme/LICENSE`](mods/git-tools/icons/theme/LICENSE) and
  [`NOTICE.md`](mods/git-tools/icons/theme/NOTICE.md). Icons that depict a product's logo
  or mark stay that owner's.
- They add **2,502 files, about 5.6 MB**, to the repository and to the installed mod
  folder.
- `node tools/gen-icon-theme.mjs <unpacked iconGenerator folder>` makes them again; the
  script's header says how to get that folder.

## Known limits

- One repository at a time, the focused pane's; submodules aren't shown on their own.
- No stash or shelve, merge, rebase, pull, cherry-pick, revert or reset.
- Diffs are unified only: no side-by-side view, no syntax colors. In the Commit panel a
  renamed file lists as a deleted file and an added file, and the added file's diff is
  the whole file.
- Commit amends only the last commit and commits whole files, not lines.
- In a space on another machine nothing watches the files: a working file's Diff tab
  reads again every 10 seconds while it is on screen.
- The Git button is on macOS only. On Windows and Linux, show the Log panel with
  `cmd-shift-g` or the Commit panel's Git Log button.
- Commit details hides when the Log panel is narrower than about 930px.
- Commit details names at most 12 branches that contain the commit, then `and N more`.
- English and Korean only, picked from the system with no switch.
- Windows hasn't been checked on a real machine: picking the language, and the Files
  panel's folder lists and search there. Linux and an English macOS haven't been checked
  on a real machine either.
- Restore doesn't bring back the staging of a file you staged something else for since
  the rollback, or of a file that was in a conflict; the file itself comes back.
- Deleted branches are kept for about 30 days (git's default reflog expiry), the
  Deleted Branches list shows the newest 50, and the records stay in that clone.
- The Files panel reads its search list when a search starts: a file made while you
  search shows from the next search. Outside a repository it searches the first 20,000
  files. Its tree shows at most 500 entries per folder and 5,000 in all.
- Restore checks for changes when it starts. A file another program edits in the moment
  between that check and the write (tens of ms to about 100 ms for a few files) is
  overwritten; git's own checkout has the same gap.
- If Herdr's app home is copied to another computer or kept in sync between two, both
  apps can hold the same Commit panel id; if they roll back the same repository at the
  same moment, their records can get mixed up.
- With a `.mailmap`, the User filter, the Commit list, Commit details and the Push
  dialog show the mapped names. Checking `bob` matches `bob` alone while only
  names are checked. While a text is searched with Match Case off, or letters typed in
  the User popup are in force (and no text is searched with Match Case on), it also
  matches `Bob`: git has one case setting for the text and the authors.
