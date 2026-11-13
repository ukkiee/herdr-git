// Stash tab: the Commit panel's second head tab ("Commit | Stash"), there only while the
// repository has a stash. The list (message, when it was made, the branch on the right),
// the chosen stash's files as a tree under it (Show Diff, view options, expand and
// collapse all), Apply (the default) and Pop at the bottom. A file opens its Diff tab: the
// stash against the commit it was made on, an untracked file against nothing.
// Right-click on a stash: Pop, Apply, Unstash…, Drop, Clear, then Show Diff and Show Diff
// in New Tab; Drop and Clear ask first (view-stash.js).
//
// The panel (view-commit.js) hosts it: it reads the list after each of the panel's own
// reads, and on any copy's "changed" whatever its repository, since every worktree of a
// repository shares one stash list. The tab's Apply and Pop run in the panel copy under
// the repository's lock, as the Unstash dialog's do (view-unstash.js runUnstash); a
// conflict opens the Conflicts dialog and the stash stays.
//
// host: the Commit panel screen (repo, bus, lang, t, setBusy, writeFailed, writeBlock,
// refresh, writeError).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { listStashes, stashFiles } from "./git-stash.js";
import { buildRows, folderKeys } from "./tree.js";
import { formatDateTime } from "./i18n.js";
import { uiGlyph, ICON, fileGlyph, folderGlyph, darkLook, panelFrame, toolbar, spacer, iconButton, button, row, notice, errorStrip, WindowedList, openMenu, broadcast, sentence } from "./ui.js";
import { sameRepo } from "./lock.js";
import { openDiff } from "./view-diff.js";
import { openStash, openStashConfirm } from "./view-stash.js";
import { openUnstash, runUnstash } from "./view-unstash.js";

const stop = (_e, cx) => cx.stop_propagation();

function statusColor(status, t) {
  return { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted, unversioned: t.ansi1 }[status] ?? t.foreground;
}

export default class StashTab {
  init(host) {
    this.host = host;
    this.repo = null; // the repository the list is of
    this.stashes = [];
    this.tab = "commit"; // "commit" | "stash"
    this.selected = null; // the chosen stash's hash
    this.files = new Map(); // hash → stashFiles result: a stash's files never change
    this.rows = []; this.fileAt = -1;
    this.grouped = false;
    this.collapsed = new Set();
    this.stashList = new WindowedList("stash-list");
    this.fileList = new WindowedList("stash-files");
  }

  // ---- what the panel asks

  // any(): the repository has a stash, so the head tabs show.
  any() { return this.stashes.length > 0 && sameRepo(this.repo, this.host.repo); }

  // showing(): the Stash tab is the one shown, in place of the commit list and form.
  showing() { return this.tab === "stash" && this.any(); }

  // Reads the list of the panel's repository (after each panel read, and on "changed").
  refresh(cx) {
    const repo = this.host.repo;
    if (!sameRepo(repo, this.repo)) {
      this.repo = repo; this.stashes = []; this.selected = null; this.files = new Map(); this.rows = []; this.fileAt = -1;
      this.stashList.top = 0; this.fileList.top = 0;
    }
    if (!repo) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const r = await listStashes(repo.git, repo.root);
        if (!sameRepo(repo, this.repo) || !r.ok) return;
        this.stashes = r.stashes;
        if (!this.stashes.some((s) => s.hash === this.selected)) this.selected = this.stashes[0]?.hash ?? null;
        for (const hash of this.files.keys()) if (!this.stashes.some((s) => s.hash === hash)) this.files.delete(hash);
        this.readFiles(cx);
      } finally {
        this.loading = false;
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // A write on the panel's own repository already reads the list again with the panel's
  // read; one on another worktree (or any unseen ones, no root) changes it too.
  event(e, cx) { if (e.type === "changed" && (!e.root || e.root !== this.repo?.root)) this.refresh(cx); }

  // Commands the panel passes on: true when taken.
  //   commit-stash: the Stash dialog. commit-unstash: the Stash tab, when there is a stash.
  command(name) {
    if (name === "commit-stash") return this.openStash() || true;
    if (name === "commit-unstash") { if (this.any()) this.tab = "stash"; return true; }
    return false;
  }

  openStash() {
    const repo = this.host.repo;
    if (!repo) return false;
    openStash({ root: repo.root, on: repo.on, owner: this.host.bus.id, lang: this.host.lang });
    return true;
  }

  // ---- the chosen stash and its files

  current() { return this.stashes.find((s) => s.hash === this.selected) ?? null; }

  choose(hash, cx) {
    if (hash === this.selected) return;
    this.selected = hash; this.fileAt = -1; this.fileList.top = 0; this.collapsed = new Set();
    this.readFiles(cx);
  }

  readFiles(cx) {
    const hash = this.selected, repo = this.repo;
    if (!hash || !repo || this.files.has(hash)) { this.rebuild(); return; }
    this.files.set(hash, null);
    this.rebuild();
    cx.spawn(async (cx) => {
      const r = await stashFiles(repo.git, repo.root, hash);
      if (!sameRepo(repo, this.repo)) return;
      this.files.set(hash, r);
      if (hash === this.selected) this.rebuild();
      cx.notify();
    });
  }

  rebuild() {
    const r = this.selected ? this.files.get(this.selected) : null;
    this.rows = r?.ok ? buildRows(r.files, { grouped: this.grouped, compact: true, collapsed: this.collapsed }) : [];
    if (this.fileAt >= this.rows.length) this.fileAt = -1;
  }

  // The file Show Diff opens: the selected file row, else the stash's first file.
  diffFile() {
    const r = this.rows[this.fileAt];
    if (r && !r.folder) return r.item;
    const files = this.files.get(this.selected);
    return files?.ok ? files.files[0] ?? null : null;
  }

  showDiff(file = this.diffFile()) {
    const repo = this.repo;
    if (!repo || !file) return false;
    openDiff({ root: repo.root, on: repo.on, path: file.path, commit: file.commit, status: file.status, oldPath: file.from ?? null });
    return true;
  }

  // ---- writes

  blocked() { return this.repo ? this.host.writeBlock() : null; }

  // Apply or Pop of the chosen stash, run here under the repository's lock.
  unstash(pop, cx, s = this.current()) {
    const repo = this.repo;
    if (!s || !repo || this.blocked()) return;
    if (!this.host.setBusy({ key: pop ? "stash.popping" : "stash.applying" }, cx, repo)) return;
    cx.spawn(async (cx) => {
      let r;
      try { r = await runUnstash(repo.git, repo.root, { hash: s.hash, ref: s.ref, pop, on: repo.on }, this.host); }
      catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
      this.host.setBusy(null, cx);
      if (r.ok || r.changed) broadcast({ type: "changed", root: repo.root });
      this.host.writeFailed(r.ok ? null : sentence(this.host.t, r.msg, r.err) || this.host.t("ui.gitFailed"), cx);
      this.refresh(cx);
      cx.notify();
    });
  }

  unstashAs(s = this.current()) {
    const repo = this.repo;
    if (!s || !repo) return;
    openUnstash({ root: repo.root, on: repo.on, owner: this.host.bus.id, lang: this.host.lang, stash: { hash: s.hash, ref: s.ref, message: s.message } });
  }

  ask(confirm, s = this.current()) {
    const repo = this.repo;
    if (!repo || (confirm === "drop" && !s)) return;
    const stash = s ? { hash: s.hash, ref: s.ref, message: s.message } : null;
    openStashConfirm({ root: repo.root, on: repo.on, owner: this.host.bus.id, lang: this.host.lang, confirm, stash });
  }

  stashMenu(s, cx) {
    const blocked = this.blocked(), title = blocked ?? undefined, t = this.host.t;
    const items = [
      { label: t("stash.pop"), value: "pop", disabled: Boolean(blocked), title },
      { label: t("stash.apply"), value: "apply", disabled: Boolean(blocked), title },
      { label: t("stash.unstash"), value: "unstash", disabled: Boolean(blocked), title },
      { label: t("stash.drop"), value: "drop", disabled: Boolean(blocked), title },
      { label: t("stash.clear"), value: "clear", disabled: Boolean(blocked), title },
      { label: t("stash.showDiff"), value: "diff", rule: true },
      { label: t("stash.showDiffNewTab"), value: "diff-tab" },
    ];
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.host.bus, items, { lang: this.host.lang });
      if (picked === "pop" || picked === "apply") this.unstash(picked === "pop", cx, s);
      else if (picked === "unstash") this.unstashAs(s);
      else if (picked === "drop" || picked === "clear") this.ask(picked, s);
      else if (picked === "diff" || picked === "diff-tab") this.showDiff();
      cx.notify();
    });
  }

  viewOptions(cx) {
    cx.spawn(async (cx) => {
      const picked = await openMenu(this.host.bus, [{ label: this.host.t("commit.groupByDirectory"), value: "group", hint: this.grouped ? "✓" : "" }], { lang: this.host.lang });
      if (picked === "group") { this.grouped = !this.grouped; this.rebuild(); }
      cx.notify();
    });
  }

  expandAll() { this.collapsed = new Set(); this.rebuild(); }

  collapseAll() {
    const files = this.files.get(this.selected);
    this.collapsed = new Set(files?.ok ? folderKeys(files.files, { compact: true }) : []);
    this.rebuild();
  }

  // ---- drawing

  // The head tabs, "Commit | Stash", above both tabs' toolbars (only while there is a stash).
  header(t) {
    const tab = (id, label, on) => div().id(`commit-tab-${id}`).px(10).h_full().flex().items_center().cursor_pointer()
      .border_b(2).border_color(on ? t.accent : t.chrome ?? t.surface)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); })
      .child(label);
    return h_flex().id("commit-tabs").w_full().h(30).flex_none().px(4).items_end().border_b(1).border_color(t.border).text_size(12.5)
      .child(tab("commit", this.host.t("stash.tabCommit"), !this.showing()))
      .child(tab("stash", this.host.t("stash.tab"), this.showing()));
  }

  stashRow(i, t) {
    const s = this.stashes[i], on = s.hash === this.selected;
    return row(`stash-row-${i}`, t, { selected: on })
      .on_click((e, cx) => {
        this.choose(s.hash, cx);
        if (e.click_count === 2) this.showDiff();
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { this.choose(s.hash, cx); this.stashMenu(s, cx); cx.notify(); })
      .tooltip(`${s.ref}  ${s.hash.slice(0, 8)}\n${s.subject}`)
      .child(div().flex_initial().min_w(0).truncate().child(s.message || s.hash.slice(0, 8)))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(formatDateTime(s.time, this.host.lang)))
      .child(spacer())
      .when(Boolean(s.branch), (el) => el
        .child(uiGlyph("branch-item", { dark: this.dark, size: 14 }))
        .child(div().flex_none().max_w("40%").truncate().text_size(12).text_color(t.muted).child(s.branch ?? "")));
  }

  fileRow(i, t) {
    const r = this.rows[i];
    const el = row(`stash-file-${r.key}`, t, { selected: i === this.fileAt, depth: r.depth })
      .on_click((e, cx) => {
        this.fileAt = i;
        if (e.click_count === 2) {
          if (r.folder) this.fold(r); else this.showDiff(r.item);
        }
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        this.fileAt = i;
        if (!r.folder) {
          cx.spawn(async (cx) => {
            const picked = await openMenu(this.host.bus, [{ label: this.host.t("stash.showDiff"), value: "diff" }], { lang: this.host.lang });
            if (picked === "diff") this.showDiff(r.item);
            cx.notify();
          });
        }
        cx.notify();
      })
      .child(r.folder
        ? div().id(`stash-fold-${r.key}`).size(ICON).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.fold(r); cx.notify(); })
          .child(uiGlyph(r.open ? "chevron-down" : "chevron-right"))
        : div().size(ICON).flex_none());
    if (r.folder) {
      return el.child(folderGlyph(r.name, { open: r.open }))
        .child(div().flex_none().max_w("70%").truncate().child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.host.t("commit.files", { n: r.count })));
    }
    const status = r.item.status, where = this.grouped ? "" : r.dir;
    const name = div().truncate().text_color(statusColor(status, t)).when(status === "deleted", (el) => el.line_through()).child(r.name);
    return el.child(fileGlyph(r.path, { dark: this.dark }))
      .child(where ? name.flex_none().max_w("70%") : name.flex_1().min_w(0))
      .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where)));
  }

  fold(r) {
    if (!this.collapsed.delete(r.key)) this.collapsed.add(r.key);
    this.rebuild();
  }

  render(cx, t) {
    this.dark = darkLook();
    const tr = this.host.t, s = this.current(), blocked = this.blocked();
    const files = this.selected ? this.files.get(this.selected) : undefined;
    const filesBody = !s ? notice(tr("stash.pickOne"), t)
      : files === null || files === undefined ? notice(tr("ui.loading"), t, { busy: true })
      : !files.ok ? notice(sentence(tr, files.msg, files.err), t)
      : !this.rows.length ? notice(tr("stash.noFiles"), t)
      : this.fileList.render(this.rows.length, (i) => this.fileRow(i, t), t);
    const redraw = (fn) => (_e, cx) => { fn(cx); cx.notify(); };
    const busy = Boolean(blocked);
    return panelFrame("commit-panel", t)
      .child(this.header(t))
      .child(toolbar(t)
        .child(iconButton("stash-refresh", "refresh", t, { title: tr("stash.refresh"), busy: Boolean(this.loading), onClick: redraw((cx) => { this.refresh(cx); this.host.refresh(cx); }) }))
        .child(iconButton("stash-diff", "diff", t, { title: tr("stash.showDiff"), disabled: !this.diffFile(), onClick: redraw(() => this.showDiff()) }))
        .child(iconButton("stash-view-options", "eye", t, { title: tr("commit.viewOptions"), active: this.grouped, onClick: (_e, cx) => this.viewOptions(cx) }))
        .child(iconButton("stash-expand", "expand-all", t, { title: tr("commit.expandAll"), disabled: !this.rows.length, onClick: redraw(() => this.expandAll()) }))
        .child(iconButton("stash-collapse", "collapse-all", t, { title: tr("commit.collapseAll"), disabled: !this.rows.length, onClick: redraw(() => this.collapseAll()) }))
        .child(spacer()))
      .child(v_flex().id("stash-body").flex_1().min_h(0)
        .child(div().id("stash-list-box").h(Math.min(this.stashes.length, 6) * 24 + 2).flex_none().border_b(1).border_color(t.border)
          .child(this.stashList.render(this.stashes.length, (i) => this.stashRow(i, t), t)))
        .child(div().id("stash-files").flex_1().min_h(0).child(filesBody)))
      .child(h_flex().id("stash-buttons").flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border)
        .child(button("stash-apply", tr("stash.apply"), t, { kind: "primary", disabled: !s || busy, title: blocked ?? undefined, onClick: (_e, cx) => this.unstash(false, cx) }))
        .child(button("stash-pop", tr("stash.pop"), t, { disabled: !s || busy, title: blocked ?? undefined, onClick: (_e, cx) => this.unstash(true, cx) })))
      .when(Boolean(this.host.writeError), (el) => el.child(errorStrip("stash-write-error", this.host.writeError ?? "", t, (_e, cx) => { this.host.writeError = null; cx.notify(); })));
  }
}
