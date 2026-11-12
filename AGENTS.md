# herdr-git

Git tools for the Herdr desktop app, built as a Herdr mod.

## Docs

- `GLOSSARY.md`: the project's vocabulary. Use these terms in code and docs.
- `docs/design.md`: how the mod is built (structure, rules and their reasons, test boundaries, known limits).
- `docs/adr/`: decisions that are hard to reverse.
- `docs/herdr-mod-platform.md`: observed limits of the Herdr mod platform that the design relies on.
- `RECIPE.md`: what the build does, screen by screen.

## Working here

- Mods are plain JS under `mods/<name>/`: no dependencies, no build step. Git logic takes `exec` as an argument and is tested with `node <file>.test.mjs` against real temporary repositories.
- The Herdr mod authoring guide is outside this repo, at `~/.config/herdr-app/AGENTS.md`. Read it before writing mod code.
- Full offline check: every `*.test.mjs` plus `herdr-app check mods/<name>`.
