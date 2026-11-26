# herdr-git

Git tools for the Herdr desktop app, built as a Herdr mod.

## Docs

- `GLOSSARY.md`: the project's vocabulary. Use these terms in code and docs.
- `docs/design.md`: how the mod is built (structure, rules and their reasons, test boundaries, known limits).
- `docs/adr/`: decisions that are hard to reverse.
- `docs/herdr-mod-platform.md`: observed limits of the Herdr mod platform that the design relies on.
- `RECIPE.md`: what the build does, screen by screen.

## Working here

- Mods are plain JS under `mods/<name>/`: no dependencies, no build step. Git logic takes `exec` as an argument and is tested with `bun <file>.test.mjs` against real temporary repositories.
- `mods/git-tools/` is ports and adapters: `core/` (`domain/`, `app/`, `ports/`, `i18n/`) holds the git logic, `adapters/in/` the Herdr screens, `adapters/out/` the git runner and other I/O; `main.js`, `mod.json` and `icons/` stay at the mod root. Imports go `adapters/in` → `core` ← `adapters/out`: lint fails a `core/` import of `herdr`, `gpui-*` or `adapters/`, and screens may import out adapters directly. A test sits beside its module. Details in `docs/design.md` §3.
- The Herdr mod authoring guide is outside this repo, at `~/.config/herdr-app/AGENTS.md`. Read it before writing mod code.
- Lint: `bun run lint` (oxlint, warnings fail; rules in `.oxlintrc.json`, including the QuickJS limits for mod code). `bun install` once first: oxlint is the repo's only dependency, a dev one.
- Full offline check: `bun tools/check.mjs` (every `*.test.mjs`, then `herdr-app check mods/git-tools`). `bun run check` runs the lint first.
