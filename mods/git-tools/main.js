// git-tools: one mod, many screens. The layout, an overlay or a tab says which screen
// a copy is with props.view; this file only routes. Screens live in view-*.js.
//
// A screen is a plain class (default export of its file):
//   init(props, cx)      once; props is props() (view, overlay id, whatever the opener passed)
//   render(cx)           returns the element tree
//   command(name, cx)    optional: a `git-tools.<name>` key or script command, for shown copies
//   event(e, cx)         optional: something another screen broadcast (ui.js `broadcast`)
//   close(cx)            optional: the last call before the copy goes (250 ms at most)
//   serve(e, cx)         optional: a dialog's request { key, action, args } for this copy
//                        to run (ui.js `serveRequest`); returns true when it took it
//   this.bus             set before init: this copy's side of the bus, for ui.js
//                        `openMenu` and `answerMenu` (never another copy's)
//   this.locks           set before init: this copy's side of the repository write locks
//                        (ui.js `takeWrite`, `writeBlock`)
//   this.lang, this.t    set before init: the copy's language ("en" | "ko") and its
//                        t(key, args) (i18n.js). Both are replaced when the system's
//                        language turns out different, followed by a redraw: call
//                        this.t when drawing, and word again any text kept from before
//                        in spoke(cx) (optional), called right after they are replaced.
//
// The copy's language: props.lang when the opener gave one (dialogs and menus get the
// opener's, ui.js openDialog/openMenu), else the language last read on this computer
// (ui.js rememberedLang), else English; a copy without props.lang then reads the
// system's language and switches when it differs. Right after the app starts the system
// may not answer yet: the copy asks again, and follows what another copy remembered.

import { View, div } from "gpui-kit";
import { props, nextCommand, theme } from "herdr";
import { subscribe, lockSide, LOCK_BEAT, UNKNOWN, openCommitPanel, close, speakAs, fixedLang, rememberedLang, rememberLang, readSystemLang } from "./ui.js";
import { translator } from "./i18n.js";
import { warmIcons } from "./icon-theme.js";
import Commit from "./view-commit.js";
import Log from "./view-log.js";
import Diff from "./view-diff.js";
import Push from "./view-push.js";
import Rollback from "./view-rollback.js";
import Restore from "./view-restore.js";
import BranchNew from "./view-branch-new.js";
import Menu from "./view-menu.js";
import IconSheet from "./view-icon-sheet.js";
import LogButton from "./view-log-button.js";
import DeletedBranches from "./view-deleted-branches.js";
import Files from "./view-files.js";
import { recordWith } from "./git.js";
import { recordGit } from "./app-files.js";
import Console from "./view-console.js";
import CompareFiles, { FileDiff, FileView } from "./view-compare-files.js";
import CompareBranches from "./view-compare-branches.js";

// When the system's language isn't known yet, how long to wait before each next ask.
const ASK_AGAIN = [1000, 3000, 10000];

// The screen table: props.view → the screen's class.
export const VIEWS = {
  "commit": Commit, // Commit panel: the `changes` block of the main-git layout
  "log": Log, // Log panel: the `git-log` block of the main-git layout
  "log-button": LogButton, // Git button: the `git-log-button` block right of the tab bar
  "diff": Diff, // Diff tab: tab.new { mod, props }
  "push": Push, // Push dialog
  "rollback": Rollback, // Rollback dialog
  "restore": Restore, // Restore dialog
  "branch-new": BranchNew, // New Branch dialog
  "menu": Menu, // popup menus (ui.js `openMenu`)
  "icon-sheet": IconSheet, // every Icon theme icon, for checking: tab.new { mod, props } only
  "deleted-branches": DeletedBranches, // Deleted Branches dialog
  "files": Files, // Files panel: the `files` block of the main-git layout
  "console": Console, // Git console tab: tab.new { mod, props } (view-console.js openConsole)
  "compare-files": CompareFiles, // working tree, local and version compare tabs (space-tabs.js)
  "compare-diff": FileDiff, // one file between two revisions: tab.new { mod, props }
  "compare-file": FileView, // one file read only: tab.new { mod, props }
  "compare-branches": CompareBranches, // branch compare tab (space-tabs.js)
};

// `mod.open:git-tools` (cmd-k) opens a copy with no view. No single app command both
// selects a stack child and shows its hidden parent, and a mod command only reaches
// copies that are already shown, so this copy does the two steps and closes itself.
class OpenCommitPanel {
  init(p) { openCommitPanel(); close(p.overlay); }
  render() { return div(); }
}

class Unknown {
  init(p) { this.view = p.view; }
  render() { return div().p(12).text_color(theme().dim).child(this.t("ui.noScreen", { view: this.view ?? "" })); }
}

export default class GitTools extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // Made here, per copy: the modules may be shared by every copy (ui.js).
    this.events = subscribe();
    this.locks = lockSide(this.events.id);
    this.screen = new (VIEWS[p.view] ?? (p.view === undefined && p.overlay ? OpenCommitPanel : Unknown))();
    this.screen.bus = this.events;
    this.screen.locks = this.locks;
    const fixed = fixedLang(p);
    this.fixed = Boolean(fixed);
    this.speak(fixed ?? rememberedLang() ?? "en");
    // Here, not in a screen's first render: the copies share the module, so only the
    // first copy pays for it.
    warmIcons();
    // Every runner records its writes in the Git console (git.js). Each copy installs the
    // same function, before its screen can run git.
    recordWith(recordGit);
    this.say(() => this.screen.init(p, cx));
    if (!fixed) this.askLang(cx, 0);
    // A lock this copy holds stays alive only while it beats (lock.js STALE). Writes
    // nothing while the copy holds none.
    cx.timer.every(LOCK_BEAT, () => this.locks.beat());
    cx.spawn(async (cx) => {
      for (;;) {
        const name = await nextCommand();
        this.say(() => this.screen.command?.(name, cx));
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const e = await this.events.next();
        if (!e) return;
        if (e.type === "request") {
          // Answered either way, so the dialog never waits for a screen that can't run it.
          if (!this.say(() => this.screen.serve?.(e, cx))) this.events.answer(e.key, { ok: false, err: this.t("ui.cantServe"), msg: { key: "ui.cantServe" } });
        } else this.say(() => this.screen.event?.(e, cx));
        cx.notify();
      }
    });
  }

  // Reads the system's language and remembers it for every copy; not known, it asks
  // again a few times.
  askLang(cx, attempt) {
    cx.spawn(async (cx) => {
      const lang = await readSystemLang();
      if (!lang) {
        if (attempt < ASK_AGAIN.length) cx.timer.after(ASK_AGAIN[attempt], (cx) => this.askLang(cx, attempt + 1));
        return;
      }
      rememberLang(lang);
      this.turnTo(lang, cx);
    });
  }

  // Switches the copy to `lang` when it speaks another, and draws again.
  turnTo(lang, cx) {
    if (!lang || lang === this.lang) return;
    this.speak(lang);
    this.say(() => this.screen.spoke?.(cx));
    cx.notify();
  }

  // The copy's language, on this view and its screen.
  speak(lang) {
    this.t = translator(lang);
    this.lang = this.t.lang;
    this.screen.t = this.t;
    this.screen.lang = this.lang;
  }

  // Runs one of the screen's calls with the shared parts speaking its language (ui.js
  // speakAs): what they word while it runs is in this copy's language.
  say(fn) { return speakAs(this.t, fn); }

  render(cx) {
    // What other copies posted since this one last looked (ui.js): the loop in init gets it.
    this.events.pump(cx);
    // The remembered language changed (another copy read the system's): this copy follows.
    // In a timer: nothing may be redrawn from inside render.
    if (!this.fixed && !this.turning && (rememberedLang() ?? this.lang) !== this.lang) {
      this.turning = true;
      cx.timer.after(0, (cx) => { this.turning = false; this.turnTo(rememberedLang(), cx); });
    }
    return this.say(() => this.screen.render(cx));
  }

  async close(cx) {
    // A dialog may wait on a write this copy took: it is told the result is unknown (git
    // may still be running), never that nothing started.
    this.events.stop(UNKNOWN);
    // First and synchronous: the 250 ms may run out in the screen's own close.
    this.locks.releaseAll();
    await this.say(() => this.screen.close?.(cx));
  }
}
