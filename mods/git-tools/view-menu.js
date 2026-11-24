// Popup menu screen. Opened by ui.js `openMenu(bus, items, { width, at })`, which resolves
// in the opener's copy with the picked item's value.
// props: { key, items: [{ label, value, disabled?, hint?, title?, rule?, checked? }], overlay }.
// ↑/↓ move, Enter picks, Esc or a click beside it closes (the opener gets null).
// When any item has `checked` (true or false), each such item gets a check slot before its
// label, as wide as the commit panel's checkbox, and a true one draws that checkbox's tick
// there, without the box, in the item's text color. Labels of those items then start in one
// place; an item without `checked` (a group name) starts at the row's left edge.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, closeOverlay, shared } from "herdr";
import { answerMenu, menuMetrics, icon, MENU_ROWS } from "./ui.js";
import { menuChecks, menuStates } from "./ui-size.js";

export default class Menu {
  init(p, cx) {
    this.key = p.key;
    this.overlay = p.overlay;
    this.items = Array.isArray(p.items) ? p.items : [];
    this.checks = menuChecks(this.items);
    this.at = this.items.findIndex((it) => !it.disabled);
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  move(by) {
    const n = this.items.length;
    for (let step = 1; step <= n; step++) {
      const i = (((this.at + by * step) % n) + n) % n;
      if (!this.items[i].disabled) { this.at = i; return; }
    }
  }

  pick(i) {
    const item = this.items[i];
    if (!item || item.disabled) return;
    answerMenu(this.bus, this.key, item.value ?? item.label);
    closeOverlay(this.overlay);
  }

  // Dismissed without a pick: the opener's promise still settles.
  close() {
    answerMenu(this.bus, this.key, null);
  }

  render() {
    const t = theme(), m = menuMetrics, settled = shared(MENU_ROWS);
    if (settled?.key === this.key) ({ items: this.items, at: this.at } = menuStates(this.items, settled.states, this.at));
    return v_flex().id("git-menu").track_focus(this.handle).w_full().min_h(0).p(m.pad).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else if (e.key === "enter") this.pick(this.at);
        else if (e.key === "escape") closeOverlay(this.overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(this.items.map((item, i) => {
        const color = item.disabled ? t.dim : t.foreground;
        return v_flex().flex_none()
          .when(Boolean(item.rule) && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
          .child(h_flex().id(`git-menu-${i}`).h(m.row).px(8).gap(m.gap).rounded(6).items_center()
            .text_color(color)
            .when(i === this.at && !item.disabled, (el) => el.bg(t.selected))
            .when(!item.disabled, (el) => el.hover((s) => s.bg(t.hover)).on_click(() => this.pick(i)))
            .when(Boolean(item.title), (el) => el.tooltip(item.title))
            .when(this.checks && typeof item.checked === "boolean", (el) => el.child(div().w(m.check).flex_none().flex().items_center().justify_center()
              .when(item.checked, (el) => el.child(svg(icon("checkbox-all")).size(11).text_color(color)))))
            .child(div().flex_1().min_w(0).truncate().child(item.label))
            .when(Boolean(item.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(item.hint))));
      }));
  }
}
