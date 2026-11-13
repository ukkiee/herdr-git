// Commit details: the right column of the Log panel. On top the files the selected
// commit changed, as a folder tree (status colors, Expand All, Collapse All); under it
// the whole message, `short hash · date · author <email>`, the committer when it is
// someone else, and the branches that contain the commit.
//
// A part of the Log panel: `host` is described at the top of log-list.js. The panel
// calls show(commit, cx) when the selection moves to another commit (showMany(commits, cx)
// when several are picked: the files they changed together), and retry(cx) on
// Refresh and on its poll: a read that failed is tried again for the same commit.
//
// The commit and its files are read at once; the containing branches are read apart
// (git walks back from every branch) and fill in when they arrive. Each show() takes a
// new turn, and an answer from an older turn is dropped: moving through the list fast
// never lets an earlier commit's answer land on a later one.
//
// Also here: the commit row's right-click menu (openCommitMenu, called by log-list.js).
//
// command(name, cx) takes `details-*` names (listed there) for keys and scripts.

import { div, svg, list } from "gpui-kit";
import { v_flex, Scrollbar } from "gpui-base";
import { theme } from "herdr";
import { readCommit, readContaining } from "./git-show.js";
import { checkoutRevision } from "./git-branch.js";
import { readEditFacts } from "./git-rewrite.js";
import { buildRows, folderKeys, parentIndex } from "./tree.js";
import { combineChanges } from "./log-select.js";
import { openDiff } from "./view-diff.js";
import { openBranchNew } from "./view-branch-new.js";
import { ROW, ICON, icon, uiGlyph, fileGlyph, folderGlyph, darkLook, row, toolbar, spacer, iconButton, notice, broadcast, openMenu, WindowedList, runningText, workName } from "./ui.js";
import { formatDateTime } from "./i18n.js";

const INDENT = 14;
const SHORT = 7; // as the Branch tree's HEAD row and the Diff tab's header show a hash
const MAX_BRANCHES = 12;
// The share of the column's height the file tree may take when it has that many files.
const TREE_SHARE = 0.5;

const short = (hash) => String(hash ?? "").slice(0, SHORT);

// The toolbar's buttons, by item (log-menus.js detailsTools): element id and icon. Written
// out as calls so ui-icons.test.mjs sees every icon name. An item missing here draws the
// settings icon: an unknown name would throw in render.
const TOOL_BUTTONS = {
  "details.showDiff": (t, o) => iconButton("log-detail-diff", "show-diff", t, o),
  "details.revertSelected": (t, o) => iconButton("log-detail-revert", "revert-selected", t, o),
  "details.historyUpToHere": (t, o) => iconButton("log-detail-history", "history", t, o),
  "details.displayOptions": (t, o) => iconButton("log-detail-options", "eye", t, o),
  "details.expandAll": (t, o) => iconButton("log-detail-expand", "expand-all", t, o),
  "details.collapseAll": (t, o) => iconButton("log-detail-collapse", "collapse-all", t, o),
};
function toolButton(id, t, o) {
  if (TOOL_BUTTONS[id]) return TOOL_BUTTONS[id](t, o);
  const elementId = `log-${id.split(".").join("-")}`;
  return iconButton(elementId, "settings", t, o);
}
const stop = (_e, cx) => cx.stop_propagation();

// Always the date itself ("11/9/26, 9:05 AM" | "26. 11. 9. 오전 9:05"): the list says
// "Today"; here the commit is read closely and may stay on screen across midnight.
const dateOf = (seconds, lang) => formatDateTime(seconds, lang);

// A renamed file is the same file under a new name: the color of a change.
function statusColor(status, t) {
  return { modified: t.ansi4, renamed: t.ansi4, added: t.ansi2, deleted: t.muted }[status] ?? t.foreground;
}

// ---- the commit row's right-click menu

// Copy Revision Number: the full hash on the clipboard; several commits' hashes, newest
// first, between spaces. commits: a commit or a list of them.
export function copyRevision(commits, cx) {
  const hashes = (Array.isArray(commits) ? commits : [commits]).map((c) => c?.hash).filter(Boolean);
  if (hashes.length) cx.write_to_clipboard(hashes.join(" "));
}

// Checkout Revision: a detached HEAD at the commit. git's refusal (changes in the way)
// is shown as it is; nothing is forced. The text it put in the error strip is kept on
// this panel's LogDetails (host.details), so a later success clears only its own.
// It takes the repository's write lock (host.setBusy); while anyone holds it, it doesn't start.
export function checkoutCommit(host, commit, cx) {
  const repo = host.repo, part = host.details;
  if (!repo || !commit?.hash || !host.setBusy({ key: "log.checkingOut" }, cx)) return;
  cx.spawn(async (cx) => {
    let r;
    try { r = await checkoutRevision(repo.git, repo.root, commit.hash); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
    // Released first: the panel skips reads while a write runs.
    host.setBusy(null, cx);
    if (r.ok) {
      // A strip on another repository is that one's: left alone.
      if (host.shows(repo) && part.checkoutError && host.error === part.checkoutError) host.fail(null, cx);
      part.checkoutError = null;
      // Every screen on the repository reads again, this panel included.
      broadcast({ type: "changed", root: repo.root });
    } else {
      part.checkoutError = host.failedOn(repo, r.err, cx);
    }
    cx.notify();
  });
}

// New Branch…: the dialog, starting at the commit, with this panel as the copy that
// creates the branch. Not while anyone writes to the repository.
export function newBranchAt(host, commit) {
  const repo = host.repo;
  if (!repo || !commit?.hash || host.writeBlock()) return;
  openBranchNew({ root: repo.root, on: repo.on, from: commit.hash, label: short(commit.hash), chosen: Boolean(host.fixed), owner: host.bus.id, lang: host.lang });
}

// The words of a write running on the repository, for a menu item it stops. The panel's
// own write here is named like another copy's: a menu has no spinner.
function writingWords(host) {
  const tr = host.t, writing = host.writeBlock();
  return writing ? (host.writingHere() ? runningText(workName(host.busy, tr), tr) : writing) : null;
}

// Opens a menu of the model's items (host.items) and runs the one picked. The answer
// settles in this panel's own call (ui.js openMenu), so what the pick starts is the panel's
// work and outlives the popup.
function openItems(host, items, target, cx, { width, hint, after }) {
  if (!items.length) return;
  const tr = host.t;
  const rows = items.map((it) => ({
    label: tr(it.key, it.args), value: it.id, rule: it.rule, disabled: it.disabled,
    title: it.why?.text || (it.why?.key ? tr(it.why.key, it.why.args) : undefined),
    hint: hint?.[it.id] ?? it.hint ?? undefined,
  }));
  cx.spawn(async (cx) => {
    const pick = await openMenu(host.bus, rows, { width, lang: host.lang });
    after?.();
    if (pick) host.run(pick, target, cx);
    cx.notify();
  });
}

// openCommitMenu(host, commits, cx)
//   The Commit list calls this on a right-click of a commit row: the commit menu's items
//   (log-menus.js) this panel does, for the commits picked. host: the Log panel; commits:
//   a commit or the commits picked, newest first, as git-log.js returns them.
//   The edit facts of the commits (git-rewrite.js readEditFacts) are read first, so the
//   history edits show on or off with their reason (ctx.edit). Facts that can't be read,
//   or more commits than EDIT_FACTS_MAX, leave ctx.edit out: those items then check when
//   picked. A menu whose repository the panel left while reading doesn't open.
//   The Commit list gets the keyboard back when the menu goes.
export function openCommitMenu(host, commits, cx) {
  const list = (Array.isArray(commits) ? commits : [commits]).filter((c) => c?.hash);
  const repo = host?.repo;
  if (!repo || !list.length) return;
  cx.spawn(async (cx) => {
    const facts = list.length <= EDIT_FACTS_MAX ? await readEditFacts(repo.git, repo.root, list.map((c) => c.hash)) : null;
    if (!host.shows(repo)) return;
    const head = host.branches.data?.head;
    const items = host.items("commit", { count: list.length, current: head?.branch ?? "HEAD", writing: writingWords(host), ...(facts?.ok ? { edit: facts } : {}) });
    const hint = list.length === 1 ? { "commit.copyRevision": short(list[0].hash) } : null;
    openItems(host, items, list, cx, { width: 300, hint, after: () => host.list.handle.focus() });
    cx.notify();
  });
}

// The most commits whose edit facts a right-click reads before the menu opens: each one
// costs git calls.
const EDIT_FACTS_MAX = 50;

// ---- the column

export default class LogDetails {
  init(host, cx) {
    this.host = host;
    this.commit = null; // the selected commit as the list has it, or null
    this.info = null; // readCommit's answer for it, once it is in
    this.branches = null; // readContaining's: null while reading, false when it failed
    this.turn = 0; // one per show(): answers of an older turn are dropped
    this.branchTurn = 0;
    this.seen = null; // host.selected as last looked at (follow)
    this.collapsed = new Set(); // folder keys
    this.cursor = null; // key of the row last clicked or reached with the arrow keys
    this.rows = [];
    this.text = null; // the words under the tree, worked out when the data arrives
    this.height = 0;
    this.list = new WindowedList("log-detail-files");
    this.handle = cx.focus_handle();
    this.checkoutError = null; // the error strip text checkoutCommit put there last
  }

  // ---- reading

  // The panel calls this when the selection moves. commit: as git-log.js returns it, or
  // null (then: "Select commit to view changes"). What the list already knows (subject,
  // author, time) shows at once; the rest when it is read.
  show(commit, cx) {
    const repo = this.host.repo, turn = ++this.turn;
    this.many = null;
    this.commit = repo && commit?.hash ? commit : null;
    this.seen = this.commit;
    this.info = null; this.branches = null;
    this.collapsed = new Set(); this.cursor = null; this.rows = []; this.list.top = 0;
    this.describe();
    cx.notify();
    if (!this.commit) return;
    const { hash } = this.commit;
    cx.spawn(async (cx) => {
      const r = await readCommit(repo.git, repo.root, hash);
      if (turn !== this.turn) return;
      if (r.ok) {
        if (this.failed && this.host.error === this.failed) this.host.fail(null, cx);
        this.failed = null;
        this.info = r;
        this.build();
        this.describe();
      } else {
        // git's words go in the panel's strip; the column keeps what the list knew.
        this.info = { ...r, files: [] };
        this.failed = r.err;
        this.host.fail(r.err, cx);
      }
      cx.notify();
    });
    this.readBranches(cx);
  }

  // Several commits picked: the files they changed together (log-select.js
  // combineChanges), and one line per commit under the tree. Each commit is read as for
  // one; a file's Show Diff shows the change of the newest picked commit that touched it.
  showMany(commits, cx) {
    const repo = this.host.repo, turn = ++this.turn;
    this.commit = null; this.many = commits; this.seen = null;
    this.info = null; this.branches = null;
    this.collapsed = new Set(); this.cursor = null; this.rows = []; this.list.top = 0;
    this.describe();
    cx.notify();
    if (!repo) return;
    cx.spawn(async (cx) => {
      const read = [];
      // A few at a time: a Shift range can pick hundreds.
      for (let i = 0; i < commits.length; i += 8) {
        read.push(...await Promise.all(commits.slice(i, i + 8).map((c) => readCommit(repo.git, repo.root, c.hash))));
        if (turn !== this.turn) return;
      }
      const failed = read.find((r) => !r.ok);
      if (failed) {
        this.info = { ok: false, err: failed.err, files: [] };
        this.failed = failed.err;
        this.host.fail(failed.err, cx);
      } else {
        if (this.failed && this.host.error === this.failed) this.host.fail(null, cx);
        this.failed = null;
        const files = combineChanges(read).map((f) => ({ ...f, commit: read.find((r) => r.files.some((x) => x.path === f.path))?.hash }));
        this.info = { ok: true, many: true, files };
        this.build();
      }
      this.describe();
      cx.notify();
    });
  }

  // What failed for the commit shown (its files and message, or the branches that
  // contain it) is read again; what was read stays.
  retry(cx) {
    if (this.many) { if (this.info && !this.info.ok) this.showMany(this.many, cx); return; }
    if (!this.commit || !this.host.repo) return;
    if (this.info && !this.info.ok) this.show(this.commit, cx);
    else if (this.branches === false) this.readBranches(cx);
  }

  // Apart from readCommit, so a slow walk doesn't hold the rest back. Also run again when
  // the refs moved under the same commit (follow): what was shown stays until then.
  readBranches(cx) {
    const repo = this.host.repo, turn = this.turn, mine = ++this.branchTurn;
    if (!repo || !this.commit) return;
    const { hash } = this.commit;
    cx.spawn(async (cx) => {
      const r = await readContaining(repo.git, repo.root, hash);
      if (turn !== this.turn || mine !== this.branchTurn) return;
      this.branches = r.ok ? r.branches : false;
      this.describe();
      cx.notify();
    });
  }

  // After a reload the list hands the panel the same commit as a newly read object: a
  // ref moved (a branch made here, a fetch), so the containing branches may differ.
  // Called from render, where nothing may be started: the read goes to a timer.
  follow(cx) {
    const now = this.host.selected;
    if (now === this.seen) return;
    this.seen = now;
    if (!now || !this.commit || now.hash !== this.commit.hash) return;
    const turn = this.turn;
    cx.timer.after(0, (cx) => { if (turn === this.turn) this.readBranches(cx); });
  }

  // ---- what is drawn, worked out when the data changes (not in render)

  // The panel's language changed (main.js spoke): the words under the tree are kept, not
  // drawn anew, so they are made again in it.
  spoke() {
    if (this.text && this.textLang !== this.host.lang) this.describe();
  }

  build() {
    this.rows = buildRows(this.info?.files ?? [], { grouped: true, compact: true, collapsed: this.collapsed });
  }

  describe() {
    const c = this.commit, info = this.info?.ok ? this.info : null;
    const tr = this.host.t, lang = this.host.lang;
    this.textLang = lang;
    if (this.many) {
      const items = [{ key: "subject", kind: "subject", text: tr("log.commitsSelected", { n: this.many.length }) }];
      this.many.forEach((m, i) => items.push({ key: `many-${i}`, kind: "meta", text: `${short(m.hash)} · ${m.subject} · ${m.author}` }));
      this.text = { items, id: this.many.map((m) => m.hash).join("-").slice(0, 200) };
      return;
    }
    if (!c) { this.text = null; return; }
    const lines = (info ? info.message : c.subject ?? "").split("\n");
    const body = lines.slice(1);
    while (body.length && !body[0].trim()) body.shift();
    const author = info ? info.author : c.author, email = info ? info.email : c.email;
    const b = this.branches;
    const committer = info && (info.committer !== info.author || info.committerEmail !== info.email)
      ? tr("log.committedBy", { who: `${info.committer}${info.committerEmail ? ` <${info.committerEmail}>` : ""}`, date: dateOf(info.commitTime, lang) }) : "";
    const names = b ? b.slice(0, MAX_BRANCHES).map((x) => x.name).join(", ") : "";
    const branches = b === null ? null
      : b === false ? tr("log.branchesUnread")
        : !b.length ? tr("log.inNoBranch")
          : tr("log.inBranches", { n: b.length, list: b.length > MAX_BRANCHES ? tr("log.listAndMore", { list: names, more: b.length - MAX_BRANCHES }) : names });
    // One item per message line: the column draws only the items in view, so a message
    // of thousands of lines costs what a screenful does.
    const items = [{ key: "subject", kind: "subject", text: lines[0] }];
    body.forEach((line, i) => items.push({ key: `body-${i}`, kind: "body", text: line, first: i === 0 }));
    items.push({ key: "meta", kind: "meta", text: `${short(c.hash)} · ${dateOf(info ? info.authorTime : c.time, lang)} · ${author}${email ? ` <${email}>` : ""}` });
    if (committer) items.push({ key: "committer", kind: "meta", text: committer });
    items.push({ key: "branches", kind: "branches", text: branches });
    this.text = { items };
  }

  // ---- the file tree

  at(key) { return key ? this.rows.findIndex((r) => r.key === key) : -1; }
  cursorRow() { return this.rows[this.at(this.cursor)] ?? null; }

  setFold(m, folded, cx) {
    if (folded) this.collapsed.add(m.key); else this.collapsed.delete(m.key);
    this.build();
    cx.notify();
  }

  // Show Diff: the commit's change to that file, in a Diff tab (view-diff.js compares
  // the commit with its first parent; the first commit shows as all added; a renamed
  // file is compared with the file it was).
  showDiff(m) {
    const repo = this.host.repo;
    if (!repo || !this.info?.ok || !m || m.folder) return false;
    openDiff({ root: repo.root, on: repo.on, path: m.path, commit: m.item.commit ?? this.info.hash, status: m.item.status, oldPath: m.item.from ?? null });
    return true;
  }

  // A double click or Enter: a folder folds, a file opens its diff.
  activate(m, cx) {
    if (!m) return;
    this.cursor = m.key;
    if (m.folder) this.setFold(m, m.open, cx);
    else this.showDiff(m);
    cx.notify();
  }

  move(by, cx) {
    const n = this.rows.length;
    if (!n) return;
    const now = this.at(this.cursor);
    const next = now < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, now + by));
    this.cursor = this.rows[next].key;
    this.list.reveal(next, n);
    cx.notify();
  }

  // Left folds an open folder, else goes to the folder the row sits in; right unfolds.
  fold(left, cx) {
    const i = this.at(this.cursor), m = this.rows[i];
    if (!m) return;
    if (m.folder && m.open === left) return this.setFold(m, left, cx);
    if (!left) return;
    const parent = parentIndex(this.rows, i);
    if (parent >= 0) { this.cursor = this.rows[parent].key; this.list.reveal(parent, this.rows.length); cx.notify(); }
  }

  expandAll(cx) { this.collapsed = new Set(); this.build(); cx.notify(); }

  collapseAll(cx) {
    this.collapsed = new Set(folderKeys(this.info?.files ?? [], { compact: true }));
    this.build();
    this.list.top = 0;
    cx.notify();
  }

  menu(m, cx) {
    if (!m || m.folder) return;
    // While the menu is open its row shows no tooltip: it would cover the menu's item.
    const items = this.host.items("file", { writing: writingWords(this.host) });
    if (!items.length) return;
    this.menuRow = m.key;
    openItems(this.host, items, m, cx, { width: 300, after: () => { if (this.menuRow === m.key) this.menuRow = null; this.handle.focus(); } });
  }

  // `git-tools.details-…` for keys and scripts:
  //   details-next, details-prev, details-left, details-right: move and fold in the tree
  //   details-open: what a double click does (a file's diff, fold a folder)
  //   details-menu: the cursor file's menu
  //   details-expand-all, details-collapse-all, details-focus
  //   details-commit-menu, details-copy-revision, details-checkout-revision,
  //   details-new-branch: the selected commit's right-click menu and its three items
  command(name, cx) {
    const m = this.cursorRow(), { host } = this, commit = host.selected;
    if (name === "details-next") this.move(1, cx);
    else if (name === "details-prev") this.move(-1, cx);
    else if (name === "details-left") this.fold(true, cx);
    else if (name === "details-right") this.fold(false, cx);
    else if (name === "details-open") this.activate(m, cx);
    else if (name === "details-menu") this.menu(m, cx);
    else if (name === "details-expand-all") this.expandAll(cx);
    else if (name === "details-collapse-all") this.collapseAll(cx);
    else if (name === "details-focus") this.handle.focus();
    else if (name === "details-commit-menu") openCommitMenu(host, host.pickedCommits(), cx);
    else if (name === "details-copy-revision") copyRevision(commit, cx);
    else if (name === "details-checkout-revision") checkoutCommit(host, commit, cx);
    else if (name === "details-new-branch") newBranchAt(host, commit);
  }

  // ---- drawing

  fileRow(i, t) {
    const m = this.rows[i];
    const el = row(`log-detail-file-${i}`, t, { selected: this.cursor === m.key }).pl(6 + m.depth * INDENT).pr(10).gap(5)
      .on_click((e, cx) => {
        this.handle.focus();
        this.cursor = m.key;
        if (e.click_count === 2) this.activate(m, cx);
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { this.handle.focus(); this.cursor = m.key; this.menu(m, cx); cx.notify(); });
    if (m.folder) {
      return el
        .child(div().id(`log-detail-fold-${i}`).size(ICON).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.cursor = m.key; this.setFold(m, m.open, cx); })
          .child(uiGlyph(m.open ? "chevron-down" : "chevron-right")))
        .child(folderGlyph(m.name, { open: m.open, size: 13 }))
        .child(div().flex_none().max_w("70%").truncate().child(m.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.host.t("log.files", { n: m.count })));
    }
    const { status, from } = m.item;
    return el.when(this.menuRow !== m.key, (el) => el.tooltip(status === "renamed" && from ? this.host.t("log.renamedFrom", { path: m.path, from }) : m.path))
      // The arrow's place is kept so a file lines up with the folders beside it.
      .child(div().size(ICON).flex_none())
      .child(fileGlyph(m.path, { dark: this.dark, size: 13 }))
      .child(div().flex_1().min_w(0).truncate().text_color(statusColor(status, t)).when(status === "deleted", (el) => el.line_through()).child(m.name));
  }

  // One item of the message column. Called by the lazy list from inside layout: no
  // handlers and no state here. The 6px between the subject, the body and the lines
  // under it is each item's own top padding, as the list has no gap.
  wordsItem(item, t) {
    const el = div().w_full().min_w(0).px(10);
    if (item.kind === "subject") return el.pt(8).font_semibold().child(item.text);
    // describe() drops the blank lines before the body, so the first body line has text.
    if (item.kind === "body") return item.text ? el.when(item.first, (el) => el.pt(6)).child(item.text) : el.h(8);
    if (item.kind === "meta") return el.pt(6).text_size(12).text_color(t.muted).child(item.text);
    if (item.text === null) {
      return el.pt(6).pb(8).flex().items_center().gap(6).text_size(12).text_color(t.dim)
        .child(svg(icon("spinner")).size(12).flex_none().spin(900)).child(this.host.t("log.readingBranches"));
    }
    return el.pt(6).pb(8).text_size(12).text_color(t.muted).child(item.text);
  }

  // GPUI's lazy list: message lines wrap, so their heights are only known once drawn,
  // which a list of fixed-height rows can't take. Its scroll position belongs to its id;
  // a new id per commit and per item count starts another commit at the top, and keeps
  // a list from reusing the heights of items that have moved.
  words(t) {
    const { items } = this.text, id = `log-detail-message-${this.text.id ?? this.commit.hash}-${items.length}`;
    return div().relative().flex_1().min_h(0).w_full().min_w(0)
      .child(list(id, items.length, (i) => items[i].key, (i) => this.wordsItem(items[i], t)).size_full())
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  render(cx) {
    const { host } = this, t = theme(), tr = host.t;
    this.dark = darkLook();
    this.follow(cx);
    if (!host.repo) return div();
    if ((!this.commit && !this.many) || !this.text) return notice(tr("log.selectCommit"), t);
    const n = this.rows.length, loading = !this.info;
    // The tree is as tall as its rows, up to its share of the column; the message takes
    // the rest. Before the column is measured: a guess that the first frame corrects.
    // Whole rows only: a tree that scrolls shouldn't end on half a row.
    const room = Math.max(2, Math.floor((((this.height || 300) - 34) * TREE_SHARE) / ROW)) * ROW;
    // One more px for the line under it: without it the last row would not fit whole.
    const treeHeight = (n ? Math.min(n * ROW, room) : ROW * 2) + 1;
    return v_flex().id("log-detail").size_full().min_h(0).min_w(0).text_size(12.5)
      .on_size_change((size, cx) => {
        if (size.height === this.height) return;
        this.height = size.height;
        cx.notify();
      })
      // As tall as the Commit list's toolbar, so the bottom lines meet.
      .child(toolbar(t)
        .child(div().px(4).flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(loading ? "" : tr("log.files", { n: this.info.files.length })))
        .child(spacer())
        .children(host.items("detailsTools", { loaded: n > 0 }).map((it) => toolButton(it.id, t, {
          title: host.itemTitle(it) || tr(it.key, it.args), disabled: it.disabled, onClick: (_e, cx) => host.run(it.id, this.cursorRow(), cx),
        }))))
      .child(div().id("log-detail-tree").track_focus(this.handle).flex_none().w_full().h(treeHeight).border_b(1).border_color(t.border)
        .on_key_down((e, cx) => {
          if (e.key === "down") this.move(1, cx);
          else if (e.key === "up") this.move(-1, cx);
          else if (e.key === "left") this.fold(true, cx);
          else if (e.key === "right") this.fold(false, cx);
          else if (e.key === "enter") this.activate(this.cursorRow(), cx);
          else return;
          cx.stop_propagation();
        })
        .child(loading ? notice(tr("ui.loading"), t, { busy: true })
          : !n ? notice(this.info.ok ? tr("log.noChanges") : "", t)
            : this.list.render(n, (i) => this.fileRow(i, t), t)))
      .child(this.words(t));
  }
}
