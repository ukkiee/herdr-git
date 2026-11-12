// Git console tab: every git command git-tools ran that may write (git.js records them,
// app-files.js keeps them), oldest first: the time, repository, machine and command
// line, then what git printed, then the exit code when it failed. A space tab, one per
// space (openConsole):
//   herdr-app do tab.new '{"name":"Console","mod":"git-tools","props":{"view":"console"}}'
// The log is read again when a copy says it grew (the bus's "console" event), or when
// this copy missed events.

import { div } from "gpui-kit";
import { theme, settings, spaces, panes, run } from "herdr";
import { panelFrame, toolbar, spacer, button, notice, WindowedList, MOD } from "./ui.js";
import { readConsole, CONSOLE_EVENT } from "./app-files.js";
import { consoleRows } from "./git-console.js";
import { en, ko } from "./messages-console.js";

const VIEW = "console";
const ROW_H = 20;
// The tab's name in either language: how openConsole finds a console tab, since a tab
// doesn't tell which screen its pane shows.
const NAMES = new Set([en["console.title"], ko["console.title"]]);

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const repoName = (root) => String(root ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(root ?? "");

// openConsole(t): shows the shown space's console tab, or opens one. One console per space:
// a tab named Console | 콘솔 whose only pane is a git-tools screen counts as it.
export function openConsole(t) {
  const space = spaces().find((s) => s.active);
  const ours = new Set(panes().filter((p) => p.mod === MOD).map((p) => p.tab));
  const found = space?.tabs?.find((tab) => tab.panes === 1 && ours.has(tab.id) && NAMES.has(tab.name));
  if (found) run("tab.select", { id: found.id });
  else run("tab.new", { name: t("console.title"), mod: MOD, props: { view: VIEW } });
}

export default class Console {
  init(_props, cx) {
    this.list = new WindowedList("console-list", { rowHeight: ROW_H });
    this.rows = [];
    this.loaded = false;
    this.error = null;
    this.load(cx);
  }

  // The newest line is in view: new lines keep it so. Scrolled up, the view stays put.
  atEnd() { return this.list.top >= this.list.limit(this.rows.length); }

  load(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      const r = await readConsole();
      this.loading = false;
      const follow = this.atEnd();
      if (r.ok) { this.rows = consoleRows(r.entries); this.error = null; }
      else this.error = r.err;
      this.loaded = true;
      if (follow) this.list.scrollTo(this.rows.length, this.rows.length);
      if (this.again) { this.again = false; this.load(cx); }
      cx.notify();
    });
  }

  event(e, cx) {
    // A "changed" without a root stands for events that went unseen: one may be ours.
    if (e.type === CONSOLE_EVENT || (e.type === "changed" && !e.root)) this.load(cx);
  }

  toEnd(cx) {
    this.list.scrollTo(this.rows.length, this.rows.length);
    cx.notify();
  }

  drawRow(r, i, t) {
    const line = div().id(`console-row-${i}`).h(ROW_H).w_full().min_w(0).flex_none().px(10).flex().items_center().whitespace_nowrap().overflow_hidden();
    if (r.kind === "command") {
      const where = `[${repoName(r.root)}${r.on ? ` (${r.on})` : ""}]`;
      return line.gap(6)
        .child(div().flex_none().text_color(t.dim).child(clock(r.at)))
        .child(div().flex_none().text_color(t.dim).child(where))
        .child(div().flex_1().min_w(0).truncate().text_color(r.failed ? t.ansi1 : t.foreground).child(r.text));
    }
    if (r.kind === "exit") return line.pl(26).text_color(t.ansi1).child(this.t("console.exit", { code: r.code }));
    return line.pl(26).text_color(t.dim).child(div().min_w(0).truncate().child(r.text || " "));
  }

  render() {
    const t = theme();
    const body = !this.loaded ? notice(this.t("ui.loading"), t, { busy: true })
      : this.error ? notice(this.t("console.readFailed", { err: this.error }), t)
      : !this.rows.length ? notice(this.t("console.empty"), t)
      : div().flex_1().min_h(0).w_full().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(this.list.render(this.rows.length, (i) => this.drawRow(this.rows[i], i, t), t));
    const bar = toolbar(t).child(div().pl(4).text_color(t.dim).child(this.t("console.title"))).child(spacer())
      .child(button("console-end", this.t("console.toEnd"), t, { disabled: !this.rows.length || this.atEnd(), onClick: (_e, cx) => this.toEnd(cx) }));
    return panelFrame("console", t).child(bar).child(body);
  }
}
