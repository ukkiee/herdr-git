// Checkout Tag or Revision: the VCS widget popup's small popup "Enter reference (branch,
// tag) name or commit hash:" (view "checkout-ref"), and what the widget does with the
// answer: HEAD detached at that commit (git-worktree.js checkoutRef), as the widget's own
// write. Enter answers the opener with the text (as a popup menu answers, ui.js
// answerMenu), Esc or a click beside it with null.
// props: { key, overlay }.

import { div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { theme, openOverlay, closeOverlay } from "herdr";
import { MOD, answerMenu } from "./ui.js";
import { checkoutRef } from "./git-worktree.js";

// askRef(bus, lang) → Promise<text | null>; await it inside cx.spawn.
function askRef(bus, lang) {
  // Unique among all copies: every opener sees every answer and takes the one with its key.
  const key = `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const answer = bus.wait(key);
  openOverlay({ mod: MOD, kind: "popup", width: 360, height: 74, props: { view: "checkout-ref", key, lang } });
  return answer;
}

// The popup's item (view-vcs-popup.js POPUP_ACTIONS): asks, then checks out as the
// widget's write; a name nothing has comes back as its failure notification.
export function checkoutRefFrom(widget, cx) {
  const host = widget.host;
  if (!widget.repo) return;
  cx.spawn(async (cx) => {
    const text = String((await askRef(host.bus, host.lang)) ?? "").trim();
    if (!text || !widget.repo) return;
    widget.write({ key: "log.checkingOut" }, (repo) => checkoutRef(repo.git, repo.root, text), cx);
    cx.notify();
  });
}

export default class CheckoutRef {
  init(p, cx) {
    this.key = p.key;
    this.overlay = p.overlay;
    this.input = InputState.new({});
    this.input.on("submit", () => {
      const text = this.input.value().trim();
      if (!text) return;
      answerMenu(this.bus, this.key, text);
      closeOverlay(this.overlay);
    });
    this.input.focus();
    // The popup takes the keyboard as it opens; ask for it once more after that.
    cx.timer.after(300, () => this.input.focus());
  }

  // Dismissed without an answer: the opener's promise still settles.
  close() { answerMenu(this.bus, this.key, null); }

  render() {
    const t = theme();
    return v_flex().id("checkout-ref").size_full().p(10).gap(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key !== "escape") return; closeOverlay(this.overlay); cx.stop_propagation(); })
      .child(div().text_color(t.muted).truncate().child(this.t("worktree.refLabel")))
      .child(div().id("checkout-ref-box").w_full().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
        .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
        .child(Input.new(this.input).w_full().h_full().text_size(12.5).text_color(t.foreground)));
  }
}
