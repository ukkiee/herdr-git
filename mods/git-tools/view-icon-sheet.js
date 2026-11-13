// Icon sheet: every icon the Icon theme lookup can return, by name in a grid, to find icons
// that come out broken or empty in Herdr (also after the theme is generated again). Not
// reachable from any screen; a command opens it as a tab:
//   herdr-app do tab.new '{"name":"Icon sheet","mod":"git-tools","props":{"view":"icon-sheet"}}'
// props.look: "light" | "dark" draws the grid on a fixed light or dark background instead
// of Herdr's; the toolbar button cycles the same three.
//
// On opening it also times the lookup in the app's own engine and shows the result in the
// toolbar: a fresh theme (its own rule tables and memo, not the screens' shared one) asked
// for FILE_SAMPLES distinct paths and every folder rule's name, then the same again. The
// grid is drawn from the rule data, never from lookups, so it shows at once.
//
// Gotcha: Herdr interrupts a script call that runs too long ("did not load: interrupted"),
// and a first lookup runs the joined rule regexes, which QuickJS (no JIT) may run tens of
// times slower than node. So the timing runs in small steps on one-shot timers, started
// from init and never from render: a step does at most STEP_LOOKUPS lookups and stops early
// once STEP_MS has passed. Only the time inside the steps is added up.
//
// The sheet's words stay English: it is a check screen, not one people use.

import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";
import { tip, panelFrame, toolbar, spacer, button, darkLook, WindowedList } from "./ui.js";
import { makeIconTheme, THEME_ROOT, DEFAULT_FILE_ICON, DEFAULT_FOLDER_ICON } from "./icon-theme.js";
import { FILE_RULES, FOLDER_RULES, DARK_FILE_ICONS, CLOSED_ONLY_FOLDER_ICONS } from "./icon-theme-data.js";

const CELL = 170;
const ROW_H = 32;
const FILE_SAMPLES = 3000;
const LOOKS = ["herdr", "light", "dark"];
const PAPER = { bg: "#ffffff", fg: "#1f2328" };
const INK = { bg: "#1e1f22", fg: "#dfe1e5" };

const unique = (names) => [...new Set(names)].sort((a, b) => a.localeCompare(b));
const fileIcons = unique([DEFAULT_FILE_ICON, ...FILE_RULES.map((r) => r.icon)]);
const folderIcons = unique([DEFAULT_FOLDER_ICON, ...FOLDER_RULES.map((r) => r.icon)]);
const closedOnly = new Set(CLOSED_ONLY_FOLDER_ICONS);

// Each section: a heading and its cells. A cell draws one or two icons (base and dark
// variant) under one name.
const SECTIONS = [
  { id: "files", title: "File icons", cells: fileIcons.map((n) => ({ name: n, icons: [`${THEME_ROOT}/files/${n}.svg`] })) },
  { id: "dark", title: "File icons with a dark variant (base on light, _dark on dark)", pair: true,
    cells: unique(DARK_FILE_ICONS).map((n) => ({ name: n, icons: [`${THEME_ROOT}/files/${n}.svg`, `${THEME_ROOT}/files/${n}_dark.svg`] })) },
  { id: "folders", title: "Folder icons, closed", cells: folderIcons.map((n) => ({ name: n, icons: [`${THEME_ROOT}/folders/${n}.svg`] })) },
  { id: "open", title: "Folder icons, open", cells: folderIcons.filter((n) => !closedOnly.has(n)).map((n) => ({ name: n, icons: [`${THEME_ROOT}/foldersOpen/${n}.svg`] })) },
];

// Paths the way a changes list holds them: folders, a name made from a rule's icon, and a
// spread of extensions (one without). All distinct, so every one is a first lookup.
function samplePaths() {
  const exts = ["ts", "tsx", "json", "md", "css", "png", "lock", "yml", "js", ""];
  const paths = [];
  for (let i = 0; i < FILE_SAMPLES; i++) {
    const ext = exts[i % exts.length];
    paths.push(`src/m${i % 40}/${fileIcons[i % fileIcons.length]}-${i}${ext ? `.${ext}` : ""}`);
  }
  return paths;
}

const img = (path, size) => image(path).size(size).flex_none();

// performance.now when the engine has it; Date.now counts whole milliseconds only.
const precise = typeof globalThis.performance?.now === "function";
const clock = precise ? () => globalThis.performance.now() : () => Date.now();
const ms = (n) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`;

// A step: at most this many lookups, and no new one once STEP_MS has passed. A first lookup
// takes about 0.03 ms in node; at fifty times that in QuickJS a full step is about 25 ms.
const STEP_LOOKUPS = 16;
const STEP_MS = 4;

// The timed passes in order. The first is the single lookup that builds the file rules.
function timingPasses() {
  const paths = samplePaths(), folders = unique(FOLDER_RULES.map((r) => r.name.toLowerCase()));
  return [
    { items: ["a.ts"], ask: (fresh, p) => fresh.fileIcon(p) },
    { items: paths, ask: (fresh, p) => fresh.fileIcon(p) },
    { items: paths, ask: (fresh, p) => fresh.fileIcon(p, { dark: true }) },
    { items: folders, ask: (fresh, f) => fresh.folderIcon(f) },
    { items: folders, ask: (fresh, f) => fresh.folderIcon(f, { open: true }) },
  ];
}

const timingLine = (passes, took) =>
  `Lookup (${precise ? "performance.now" : "Date.now"}, ${STEP_LOOKUPS} per step): file rules built ${ms(took[0])}, `
  + `${passes[1].items.length} distinct paths ${ms(took[1])}, again ${ms(took[2])}; `
  + `${passes[3].items.length} folder names ${ms(took[3])} (with their rules built), again ${ms(took[4])}`;

export default class IconSheet {
  init(p, cx) {
    this.look = LOOKS.includes(p.look) ? p.look : "herdr";
    this.list = new WindowedList("icon-sheet-list", { rowHeight: ROW_H });
    this.cols = 0;
    this.rows = [];
    this.layout(4);
    this.timing = "Lookup: timing…";
    this.startTiming(cx);
  }

  startTiming(cx) {
    const fresh = makeIconTheme();
    const passes = timingPasses();
    const total = passes.reduce((n, s) => n + s.items.length, 0);
    const took = passes.map(() => 0);
    let pass = 0, at = 0, done = 0, steps = 0;
    const step = (cx) => {
      const start = clock();
      let n = 0;
      while (pass < passes.length && n < STEP_LOOKUPS && (n === 0 || clock() - start < STEP_MS)) {
        const s = passes[pass];
        const t0 = clock();
        s.ask(fresh, s.items[at]);
        took[pass] += clock() - t0;
        n++; done++;
        if (++at === s.items.length) { pass++; at = 0; }
      }
      steps++;
      if (pass < passes.length) {
        // A redraw repaints the whole window, so the progress shows only now and then.
        if (steps % 25 === 0) { this.timing = `Lookup: timing… ${done}/${total}`; cx.notify(); }
        cx.timer.after(0, step);
      } else {
        this.timing = timingLine(passes, took);
        cx.notify();
      }
    };
    cx.timer.after(0, step);
  }

  // Rows for `cols` cells across: a heading row, then the section's cells in rows.
  layout(cols) {
    if (cols === this.cols) return false;
    this.cols = cols;
    const rows = [];
    for (const s of SECTIONS) {
      rows.push({ kind: "head", text: `${s.title} (${s.cells.length})` });
      for (let i = 0; i < s.cells.length; i += cols) rows.push({ kind: "cells", section: s, from: i, cells: s.cells.slice(i, i + cols) });
    }
    this.rows = rows;
    return true;
  }

  colors(t) {
    if (this.look === "light") return PAPER;
    if (this.look === "dark") return INK;
    return { bg: t.background, fg: t.foreground };
  }

  renderRow(i, t, c) {
    const r = this.rows[i];
    if (r.kind === "head") {
      return h_flex().h(ROW_H).w_full().flex_none().items_end().pb(4).px(10).font_semibold().text_color(c.fg).child(r.text);
    }
    return h_flex().h(ROW_H).w_full().flex_none().items_center().px(10).children(r.cells.map((cell, k) => {
      const id = `icon-sheet-${r.section.id}-${r.from + k}`;
      const icons = r.section.pair
        ? [div().p(2).rounded(3).bg(PAPER.bg).child(img(cell.icons[0], 14)), div().p(2).rounded(3).bg(INK.bg).child(img(cell.icons[1], 14))]
        : [img(cell.icons[0], 14), img(cell.icons[0], 24)];
      return h_flex().id(id).w(CELL).flex_none().gap(6).items_center().map((el) => tip(el, cell.icons.join("\n")))
        .children(icons)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(c.fg).child(cell.name));
    }));
  }

  render() {
    const t = theme(), c = this.colors(t);
    const lookLabel = this.look === "herdr" ? `Herdr (${darkLook(c.bg) ? "dark" : "light"})` : this.look === "light" ? "Light" : "Dark";
    return panelFrame("icon-sheet", t)
      .child(toolbar(t)
        .child(div().px(4).font_semibold().child("Icon sheet"))
        .child(div().id("icon-sheet-timing").min_w(0).truncate().text_size(12).text_color(t.muted).map((el) => tip(el, this.timing)).child(this.timing))
        .child(spacer())
        .child(button("icon-sheet-look", `Background: ${lookLabel}`, t, {
          onClick: (_e, cx) => { this.look = LOOKS[(LOOKS.indexOf(this.look) + 1) % LOOKS.length]; cx.notify(); },
        })))
      .child(v_flex().id("icon-sheet-body").flex_1().min_h(0).w_full().bg(c.bg)
        .on_size_change((size, cx) => { if (this.layout(Math.max(1, Math.floor((size.width - 20) / CELL)))) cx.notify(); })
        .child(this.list.render(this.rows.length, (i) => this.renderRow(i, t, c), t)));
  }
}
