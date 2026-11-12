// Git button: the block right of the tab bar in the main-git layout (layout.mjs). It
// shows and hides the Log panel, and is drawn like the tab bar's own Files and Changes
// buttons so the three read as one row. The tab bar's mod draws those two itself and
// takes no others, which is why this one is a block of its own.

import { svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";
import { icon, logPanelShown, toggleLogPanel } from "./ui.js";

export default class LogButton {
  init() {}

  render() {
    const t = theme(), on = logPanelShown() === true;
    // The strip behind the button continues the tab bar: its color and the line under it.
    return h_flex().id("git-log-strip").size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("git-log-button").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .tooltip(this.t("commit.gitLog"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => toggleLogPanel())
        .child(svg(icon("branch-item")).size(14))
        .child("Git"));
  }
}
