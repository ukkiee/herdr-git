// Go to Hash/Branch/Tag: the Log toolbar's small popup "Enter hash or branch/tag name:"
// (view "go-to-hash"), and what the Log panel does with the answer. Enter answers the
// opener with the text (as a popup menu answers, ui.js answerMenu), Esc or a click beside
// it with null.
// props: { key, overlay }.

import { div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { theme, openOverlay, closeOverlay } from "herdr";
import { MOD, answerMenu, sentence } from "./ui.js";
import { findCommit } from "./git-revision.js";

// askHash(bus, lang) → Promise<text | null>; await it inside cx.spawn.
function askHash(bus, lang) {
  // Unique among all copies: every opener sees every answer and takes the one with its key.
  const key = `hash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const answer = bus.wait(key);
  openOverlay({ mod: MOD, kind: "popup", width: 320, height: 74, props: { view: "go-to-hash", key, lang } });
  return answer;
}

// The Log toolbar's item (view-log.js ACTIONS): finds the commit and selects it in the
// Commit list, or says in the panel's strip why it can't.
export function goToHash(host, cx) {
  const repo = host.repo;
  if (!repo) return;
  cx.spawn(async (cx) => {
    const text = String((await askHash(host.bus, host.lang)) ?? "").trim();
    if (!text || repo !== host.repo) return;
    const turn = host.beginJump();
    const r = await findCommit(repo.git, repo.root, text);
    if (repo !== host.repo || !host.jumpLive(turn)) return;
    if (!r.ok) { host.fail(r.msg?.key === "revision.notFound" ? host.t("log.commitNotFound", { text }) : sentence(host.t, r.msg, r.err), cx); cx.notify(); return; }
    const found = await host.goTo(r.hash, cx, turn);
    if (found === false && repo === host.repo && host.jumpLive(turn)) host.fail(host.t(host.filterArgs?.length ? "log.commitFiltered" : "log.commitNowhere", { text }), cx);
    cx.notify();
  });
}

export default class GoToHash {
  init(p) {
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
  }

  // Dismissed without an answer: the opener's promise still settles.
  close() { answerMenu(this.bus, this.key, null); }

  render() {
    const t = theme();
    return v_flex().id("go-to-hash").size_full().p(10).gap(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key !== "escape") return; closeOverlay(this.overlay); cx.stop_propagation(); })
      .child(div().text_color(t.muted).child(this.t("revision.enterHash")))
      .child(div().id("go-to-hash-box").w_full().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
        .on_mouse_down("left", (_e, cx) => { this.input.focus(); cx.stop_propagation(); })
        .child(Input.new(this.input).w_full().h_full().text_size(12.5).text_color(t.foreground)));
  }
}
