// Space tabs that come one per kind: opening one where the shown space already has a tab
// of that kind replaces it. A tab doesn't tell which screen its pane shows, so a kind is
// known by its name: the name templates of that kind in every language (a message with
// {placeholders}), as view-console.js knows its tab.
//
//   openSpaceTab({ view: "compare-files", props, name, kind: [en["x.tab"], ko["x.tab"]] })
//
// The new tab opens before the old one closes: closing a space's last tab closes the space.

import { spaces, panes, run } from "herdr";
import { MOD, newTab } from "./ui.js";

const escape = (text) => text.replace(/[.*+?^$()|[\]\\]/g, "\\$&");

// namePattern(templates) → a RegExp that matches a name made from any of the templates,
// whatever went in their placeholders.
export function namePattern(templates) {
  const one = (template) => String(template).split(/\{\w+\}/).map((part) => escape(part)).join(".+");
  return new RegExp(`^(?:${templates.map(one).join("|")})$`);
}

// openSpaceTab({ view, props, name, kind, unlike }): opens a tab in the shown space whose
// only pane is this mod's `view` with `props` (saved with the tab: plain JSON), named
// `name`. A tab of this mod in that space whose name fits `kind` (name templates) and
// none of `unlike` (other kinds' templates a name of this kind could also fit, as
// "{a} and {b}" fits "x and Local Version") is closed.
export function openSpaceTab({ view, props = {}, name, kind = [], unlike = [] }) {
  const space = spaces().find((s) => s.active);
  const ours = new Set(panes().filter((p) => p.mod === MOD).map((p) => p.tab));
  const pattern = kind.length ? namePattern(kind) : null, other = unlike.length ? namePattern(unlike) : null;
  const fits = (text) => pattern.test(text) && !other?.test(text);
  const old = pattern ? space?.tabs?.find((tab) => tab.panes === 1 && ours.has(tab.id) && fits(tab.name ?? "")) : null;
  newTab(name, { ...props, view });
  if (old) run("tab.close", { id: old.id });
}
