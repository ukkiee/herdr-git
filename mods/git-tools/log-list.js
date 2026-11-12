// Commit list: the middle column of the Log panel. One row per commit: graph, subject,
// Ref labels, author, time. Reads 1,000 commits at a time and the next 1,000 when the
// end comes near. The first look at a repository, a branch or a filter is read twice:
// without tags, which answers at once, and in full (see preview).
//
// A part of the Log panel, like log-branches.js, log-filters.js and log-details.js.
// The panel (view-log.js) makes one of each, calls init once and render on every render.
// `host` is the panel:
//   host.repo                  { git, root, on, folder }, or null outside a repository
//   host.branch                the ref the list is limited to, or null (all branches).
//                              The Branch tree and the Branch filter read and set this one value.
//   host.setBranch(ref, cx)    sets it (null clears) and reads the list again
//   host.filterArgs            extra `git log` arguments from the filter row ([] when none)
//   host.setFilterArgs(a, cx)  sets them and reads the list again
//   host.selected              the commit last clicked among those picked (as git-log.js
//                              returns it), or null: what a one-commit action works on
//   host.select(hash, cx)      picks a commit that is in the list, alone (null clears)
//   host.pick(hash, cx)        the same for the person's own pick: a hash jump still
//                              running is dropped
//   host.pickWith(hash, { shift, cmd }, cx), host.pickForMenu(hash, cx), host.keepPicks(cx):
//                              Shift and Cmd clicks, a right-click, a list read again
//                              (log-select.js)
//   host.picks, host.isPicked(hash), host.pickedCommits() (newest first)
//   host.items(menu, ctx)      a menu's or toolbar's items now (log-menus.js menuItems with
//                              the actions this panel does); host.run(id, target, cx) runs
//                              one; host.itemTitle(item) is its tooltip
//   host.beginJump()           a new hash jump's turn; host.jumpLive(turn) is false once
//                              a newer jump, search, filter, pick or repository took over
//   host.goTo(hash, cx, turn?) Promise<true | false | null>: finds a commit by (short)
//                              hash, selects and reveals it; false when there is none,
//                              null when the jump was dropped. Await it inside cx.spawn.
//   host.reload(cx)            reads branches and commits again (after checkout, fetch, delete)
//   host.busy                  null, or the work of this panel's git write running now
//                              ({ key: "log.fetching" }); it may run on a repository the
//                              panel no longer shows (the panel follows the focused pane)
//   host.setBusy(work, cx, repo?)
//                              takes the repository's write lock (`repo` defaults to
//                              host.repo) → false, changing nothing, when this panel
//                              already writes or any copy holds it; null releases it
//   host.writeBlock()          why no write may start on host.repo now: this panel's own
//                              label, its write on another repository, another copy's
//                              ("Another git operation is running: …"), or null
//   host.writingHere()         host.busy while it runs on host.repo, else null: its key
//                              says which button spins
//   host.shows(repo)           true while the panel shows `repo`: a write that ended
//                              touches the selection, filters and strip only then
//   host.failedOn(repo, t, cx) shows a write's failure on `repo` in the strip, with the
//                              repository's folder name before it when the panel moved
//                              on; returns the text shown
//   host.fail(text, cx)        shows git's output in the panel's error strip (null clears it)
//   host.error                 the text in the error strip now, or null
//   host.errorMark             moves on every time the strip's text is set: whose error
//                              is shown, where the same words may come from two actions
//   host.fetch(cx)             Fetch with the busy lock, then every screen reads again
//   host.listWidth             px the Commit list has (narrow: it drops author, then time)
//   host.fixed                 { folder, on } for a Log tab on a chosen folder, else null
//   host.bus                   the panel's side of the bus, for ui.js openMenu
//   host.list, host.branches, host.details: the parts themselves (host.list.handle gets
//                              the keyboard back after a menu)

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";
import { readLog, labelRefs } from "./git-log.js";
import { formatTime } from "./i18n.js";
import { layoutGraph, graphWindow, indexSegments, segmentsIn, fitLabels } from "./graph.js";
import { openCommitMenu } from "./log-details.js";
import { ROW, row, notice, strokePath, WindowedList } from "./ui.js";

const BATCH = 1000;
const LANE = 14, PAD = 5, MID = ROW / 2;
const laneX = (lane) => PAD + lane * LANE + LANE / 2;
const lanePalette = (t) => [t.ansi4, t.ansi2, t.ansi3, t.ansi5, t.ansi6, t.ansi1, t.ansi12, t.ansi10, t.ansi13, t.ansi14];
// A row's own padding (row(): 2px left here, 8px right) and the 6px between its parts.
const ROW_PAD = 10, GAP = 6, AUTHOR = 120, TIME = 124;
// The subject keeps at least this much before Ref labels take the rest.
const SUBJECT_MIN = 40;
// 11px text with no way to measure it: a character is taken as 6.5px, above the
// interface font's real average, so a label counted as fitting does fit.
const LABEL_LOOK = { char: 6.5, pad: 12, gap: 4, most: 3 };
const STRIP = 3; // the sideways scroll strip under the graph part

// What a row draws, worked out once when the commits arrive: render only places it.
function rowModel(commit, graph) {
  const segments = graph.lines.map((l) => ({
    color: l.color,
    x1: laneX(l.from ?? graph.lane), y1: l.from === null ? MID : 0,
    x2: laneX(l.to ?? graph.lane), y2: l.to === null ? MID : ROW,
  }));
  return {
    commit, segments: indexSegments(segments),
    lane: graph.lane, color: graph.color,
    width: PAD * 2 + graph.cols * LANE,
    labels: labelRefs(commit.refs),
    merge: commit.parents.length > 1,
    head: commit.refs.some((r) => r.kind === "head"),
    minute: -1, time: "",
    fitRoom: -1, fit: null, // fitLabels' answer for the room it was worked out for
  };
}

// A filtered list has gaps between its commits, so there are no lines to draw: dots only.
const LONE = { lane: 0, color: 0, cols: 1, lines: [] };

export default class LogList {
  init(host, cx) {
    this.host = host;
    this.list = new WindowedList("log-commits");
    // At the end of the rows read, scrolling down can't move the list, so a next batch
    // that failed there is read again on the wheel itself: once per input, never while a
    // read runs (loadMore checks), never from a redraw alone.
    this.list.onWheel = (rows, cx) => {
      if (rows > 0 && this.stalled && this.list.nearEnd(this.rows.length, 60)) this.loadMore(cx);
    };
    this.handle = cx.focus_handle();
    this.rows = [];
    this.index = new Map(); // hash → row number
    this.carry = null;
    this.more = false; // commits beyond the ones read
    // { err, top, mark }: the next batch failed to read. mark: host.errorMark when its error
    // went up on the strip (null: not shown).
    this.stalled = null;
    this.loading = false;
    this.read = false; // false until the first read of this repository ends
    this.turn = 0;
    this.pending = null;
    this.previewed = false; // the rows are a preview's: no tags, the full read is on its way
    this.awaited = null; // the turn whose full read a preview may still stand in for
    // How far the graph part is scrolled sideways, px. One for the whole list, so lanes
    // stay joined from row to row. Kept as asked; each frame shows it clamped to what
    // the rows in view need (graphWindow), so scrolling down into narrower history
    // doesn't leave the graph scrolled past its lanes.
    this.left = 0;
  }

  filtered() { return Boolean(this.host.branch) || this.host.filterArgs.length > 0; }

  // Lines only make sense when every parent is in the list: not with the filter row's
  // arguments. A branch alone still has its whole history.
  graphed() { return this.host.filterArgs.length === 0; }

  add(commits, fresh) {
    if (fresh) { this.rows = []; this.index = new Map(); this.carry = null; this.previewed = false; }
    const graph = this.graphed() ? layoutGraph(commits, this.carry) : null;
    if (graph) this.carry = graph.carry;
    for (let i = 0; i < commits.length; i++) {
      this.index.set(commits[i].hash, this.rows.length);
      this.rows.push(rowModel(commits[i], graph ? graph.rows[i] : LONE));
    }
  }

  // One read. `fresh`: from the top again, as many as are shown now; else the next batch.
  // Resolves when the rows are in place. A newer reload makes an older read's answer void.
  fetch(fresh) {
    const { host } = this, repo = host.repo, turn = fresh ? ++this.turn : this.turn;
    const skip = fresh ? 0 : this.rows.length;
    const count = fresh ? Math.max(BATCH, Math.ceil(this.rows.length / BATCH) * BATCH) : BATCH;
    this.loading = true;
    const work = (async () => {
      const r = await readLog(repo.git, repo.root, { skip, count, branch: host.branch, extra: host.filterArgs });
      if (turn !== this.turn) return null;
      this.loading = false; this.read = true; this.pending = null;
      // The full read is here (or failed): a preview that lands after it is void, also
      // while a next batch is being read.
      if (fresh) { this.awaited = null; if (!r.ok) this.previewed = false; }
      // A failed next batch keeps `more` and the rows read: the poll or the next scroll
      // reads that batch again (stalled holds where the list stood, so a redraw alone
      // doesn't retry it over and over).
      if (!r.ok) {
        if (fresh) this.more = false;
        // An error shown for an earlier try of this batch is still this batch's.
        else this.stalled = { err: r.err, top: this.list.top, mark: this.stalled?.mark ?? null };
        return r;
      }
      // recovered: the next batch that failed before and reads now; whoever asked for this
      // read takes its error off the strip (see recover).
      const recovered = !fresh && this.stalled ? this.stalled : null;
      this.stalled = null;
      // Over a preview the person may have scrolled already: the commit on top stays there
      // when it is among the rows read (commits only tags reach may have pushed it past
      // them: then the list stays at the same row number). At the very top it stays at
      // the top, where the newest commits are.
      const over = fresh && this.previewed;
      const top = over && this.list.top > 0 ? this.rows[this.list.top]?.commit.hash : null;
      this.add(r.commits, fresh);
      this.more = r.commits.length >= count;
      const at = top ? this.index.get(top) : undefined;
      if (at !== undefined) this.list.top = at;
      return { ...r, recovered, over };
    })();
    this.pending = work;
    return work;
  }

  // The first look at a repository, a branch or a filter. The full read opens every tag,
  // to label commits and to find the ones only a tag reaches: in a repository with tens of
  // thousands of tags that takes a second or two, and the same read without tags a tenth
  // of that. So the rows without tags show first, and the full read replaces them when it
  // lands (it brings the tag labels and the commits only tags reach). Nothing is read on
  // from a preview: the next batch waits for the full read.
  preview(turn, moved, cx) {
    const { host } = this, repo = host.repo;
    cx.spawn(async (cx) => {
      const r = await readLog(repo.git, repo.root, { count: BATCH, branch: host.branch, extra: host.filterArgs, tags: false });
      // Void when the full read landed first or a newer reload began (`awaited` is this
      // turn only until then; `loading` won't do, a next batch sets it again).
      // An empty answer may only mean every commit hangs on a tag: the full read says.
      if (this.awaited !== turn || !r.ok || !r.commits.length) return;
      this.add(r.commits, true);
      this.previewed = true; this.read = true;
      if (moved) this.list.top = 0;
      cx.notify();
    });
  }

  // The panel calls this after host.reload and when host.branch or host.filterArgs change.
  // What is shown stays until the new commits are there.
  reload(cx) {
    const { host } = this, repo = host.repo;
    if (!repo) { this.turn++; this.rows = []; this.index = new Map(); this.carry = null; this.more = false; this.stalled = null; this.loading = false; this.read = false; this.previewed = false; this.awaited = null; this.key = null; return; }
    const key = JSON.stringify([repo.root, repo.on]), view = JSON.stringify([host.branch, host.filterArgs]);
    if (key !== this.key) { this.key = key; this.rows = []; this.index = new Map(); this.stalled = null; this.read = false; this.previewed = false; this.list.top = 0; this.left = 0; }
    const moved = view !== this.view;
    this.view = view;
    // Rows still on screen from the view before are not a preview of this one: where they
    // were scrolled to says nothing about the new list.
    if (moved) this.previewed = false;
    const stalled = this.stalled;
    // Rows of this view already on screen are left as they are until the full read lands.
    const first = moved || !this.rows.length;
    cx.spawn(async (cx) => {
      const work = this.fetch(true);
      this.awaited = first ? this.turn : null;
      if (first) this.preview(this.turn, moved, cx);
      const r = await work;
      if (!r) return;
      if (!r.ok) { this.failed = r.err; host.fail(r.err, cx); this.failedMark = host.errorMark; }
      else {
        // The read works again: its own old error goes, anyone else's stays, even in the
        // same words.
        if (this.failed && host.errorMark === this.failedMark) host.fail(null, cx);
        else if (stalled?.mark != null && host.errorMark === stalled.mark) host.fail(null, cx);
        this.failed = null;
        // A preview already put the list at the top of this view; from there on the
        // place is the person's.
        if (moved && !r.over) this.list.top = 0;
        // Picked commits may be gone (amended, filtered out); the ones still here stay
        // picked, and host.selected becomes the newly read object.
        if (host.picks.picked.size) host.keepPicks(cx);
      }
      cx.notify();
    });
  }

  loadMore(cx) {
    if (this.loading || !this.more || !this.host.repo) return;
    const work = this.fetch(false);
    cx.spawn(async (cx) => {
      const r = await work;
      if (r && !r.ok) this.stall(r, cx);
      else this.recover(r, cx);
      cx.notify();
    });
  }

  // The next batch failed: its error goes on the strip, marked as this batch's.
  stall(r, cx) {
    this.host.fail(r.err, cx);
    if (this.stalled) this.stalled.mark = this.host.errorMark;
  }

  // A next batch that failed reads now, by whatever way (scroll, poll, hash search): its
  // own old error goes from the strip while nothing else has been put there since; anyone
  // else's stays, even in the same words.
  recover(r, cx) {
    const mark = r?.ok ? r.recovered?.mark : null;
    if (mark != null && this.host.errorMark === mark) this.host.fail(null, cx);
  }

  // The panel's poll: a next batch that failed is read again.
  retry(cx) { if (this.stalled) this.loadMore(cx); }

  find(hash) {
    const at = this.index.get(hash);
    return at === undefined ? null : this.rows[at].commit;
  }

  // Reads on until the commit is in the list, then selects it and scrolls it to the
  // middle. False when the list ends without it (filtered out, or another branch); null
  // as soon as live() says something newer took over (the selection is left alone).
  async goTo(hash, cx, live = () => true) {
    for (let reads = 0; reads < 500; reads++) {
      if (!live()) return null;
      const at = this.index.get(hash);
      if (at !== undefined) {
        this.host.select(hash, cx);
        this.list.scrollTo(at - Math.floor(this.list.fit / 2), this.rows.length);
        cx.notify();
        return true;
      }
      if (this.pending) { await this.pending; continue; }
      if (!this.more || !this.host.repo) return false;
      const r = await this.fetch(false);
      // A read that worked clears its batch's old error even when this search was given up
      // (fetch answers null for a list that was read again since).
      this.recover(r, cx);
      if (!live()) return null;
      if (r && !r.ok) { this.stall(r, cx); return false; }
    }
    return false;
  }

  move(by, cx) {
    const n = this.rows.length;
    if (!n) return;
    const now = this.host.selected ? this.index.get(this.host.selected.hash) : undefined;
    const at = now === undefined ? (by > 0 ? this.list.top : Math.min(n - 1, this.list.top + this.list.fit - 1)) : Math.max(0, Math.min(n - 1, now + by));
    this.host.pick(this.rows[at].commit.hash, cx);
    this.list.reveal(at, n);
    cx.notify();
  }

  // Script and key commands the panel passes on (git-tools.log-next, …).
  command(name, cx) {
    if (name === "log-next") this.move(1, cx);
    else if (name === "log-prev") this.move(-1, cx);
    else if (name === "log-top") { this.list.scrollTo(0, this.rows.length); cx.notify(); }
    else if (name === "log-end") { this.list.scrollTo(this.rows.length, this.rows.length); cx.notify(); }
    else if (name === "log-page-down" || name === "log-page-up") { this.list.scrollBy((name === "log-page-down" ? 1 : -1) * Math.max(1, this.list.fit - 1), this.rows.length); cx.notify(); }
    else if (name === "log-focus") this.handle.focus();
  }

  // Worked out again each minute, and when the copy's language changes.
  timeOf(m) {
    const minute = Math.floor(Date.now() / 60000), lang = this.host.lang;
    if (m.minute !== minute || m.timeLang !== lang) { m.minute = minute; m.timeLang = lang; m.time = formatTime(m.commit.time, lang); }
    return m.time;
  }

  // The graph part's window for the rows in view: as wide as the widest of them needs,
  // at most half the list. A few dozen rows, not the whole list.
  graphView(width) {
    const n = this.rows.length, top = Math.max(0, Math.min(this.list.top, this.list.limit(n)));
    const end = Math.min(n, top + this.list.fit + 1);
    let widest = 0;
    for (let i = top; i < end; i++) widest = Math.max(widest, this.rows[i].width);
    return graphWindow({ widest, listWidth: width, left: this.left });
  }

  // A sideways wheel (a touchpad, or Shift with a plain wheel) moves the graph part of
  // every row. True when the graph could take it: the list then doesn't also scroll down.
  slide(e, cx) {
    const { x, y } = e.delta;
    const by = Math.abs(x) > Math.abs(y) ? x : e.modifiers?.shift ? y : 0;
    if (!by) return false;
    const v = this.graphView(this.host.listWidth ?? 9999);
    if (!v.max) return false;
    const next = Math.max(0, Math.min(v.left - by, v.max));
    if (next !== this.left) { this.left = next; cx.notify(); }
    return true;
  }

  graphCell(m, t, palette, v) {
    const w = Math.min(m.width, v.room), left = v.left;
    const color = palette[m.color % palette.length], x = laneX(m.lane) - left;
    let cell = div().relative().flex_none().h(ROW).w(w).overflow_hidden();
    for (const s of segmentsIn(m.segments, left, left + w)) cell = cell.child(strokePath((p) => p.move_to(s.x1 - left, s.y1).line_to(s.x2 - left, s.y2), palette[s.color % palette.length], 1.5));
    if (x < -6 || x > w + 6) return cell;
    // HEAD's commit is a ring around a dot.
    if (m.head) return cell.child(div().absolute().left(x - 6).top(MID - 6).size(12).rounded(6).border_1().border_color(color).bg(t.background).flex().items_center().justify_center().child(div().size(6).rounded(3).bg(color)));
    return cell.child(div().absolute().left(x - 4).top(MID - 4).size(8).rounded(4).bg(color));
  }

  label(label, t) {
    const color = label.current ? t.ansi3 : { local: t.ansi2, remote: t.ansi5, tag: t.muted, head: t.ansi3 }[label.kind];
    return h_flex().flex_none().h(16).px(5).items_center().rounded(4).border_1().border_color(color).text_size(11).text_color(color).whitespace_nowrap()
      .when(label.current, (el) => el.font_semibold())
      .child(label.text);
  }

  // Ref labels get 45% of the row at most, and never the subject's last SUBJECT_MIN px.
  // labelSpace: what the row's other parts leave, before the graph part takes its own.
  labels(m, t, labelSpace, graphWidth) {
    const room = Math.max(0, Math.min(labelSpace.most, labelSpace.left - graphWidth));
    if (m.fitRoom !== room) { m.fit = fitLabels(m.labels, room, LABEL_LOOK); m.fitRoom = room; }
    const { shown, rest } = m.fit;
    // Left-aligned in a box no wider than the room: should the estimate fall short, the
    // last label's end is cut, never the first label's start.
    return h_flex().flex_none().max_w(room).gap(LABEL_LOOK.gap).overflow_hidden()
      .children(shown.map((l) => this.label(l, t)))
      .when(rest > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${rest}`)));
  }

  commitRow(i, t, palette, wide, v, labelSpace) {
    const m = this.rows[i], { commit } = m, { host } = this;
    return row(`log-commit-${i}`, t, { selected: host.isPicked(commit.hash) }).pl(2)
      .on_click((e, cx) => {
        this.handle.focus();
        const mods = { shift: Boolean(e.modifiers?.shift), cmd: Boolean(e.modifiers?.platform || e.modifiers?.control) };
        if (mods.shift || mods.cmd) host.pickWith(commit.hash, mods, cx);
        else host.pick(commit.hash, cx);
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { this.handle.focus(); host.pickForMenu(commit.hash, cx); openCommitMenu(host, host.pickedCommits(), cx); cx.notify(); })
      // On the row, so it runs before the list's own wheel handling and can stop it.
      .on_scroll_wheel((e, cx) => { if (this.slide(e, cx)) cx.stop_propagation(); })
      .child(this.graphCell(m, t, palette, v))
      .child(div().flex_1().min_w(0).truncate().text_color(m.merge ? t.dim : t.foreground).child(commit.subject))
      .when(m.labels.length > 0, (el) => el.child(this.labels(m, t, labelSpace, Math.min(m.width, v.room))))
      .when(wide > 1, (el) => el.child(div().flex_none().w(AUTHOR).truncate().text_size(12).text_color(t.muted).child(commit.author)))
      .when(wide > 0, (el) => el.child(div().flex_none().w(TIME).truncate().text_size(12).text_color(t.muted).child(this.timeOf(m))));
  }

  // A thin strip under the graph part while it has more than it shows: where the window is.
  scrollStrip(v, t) {
    const widest = v.room + v.max, thumb = Math.max(16, (v.room * v.room) / widest);
    return div().absolute().left(2).bottom(1).w(v.room).h(STRIP).rounded(2).bg(t.border)
      .child(div().absolute().top(0).h(STRIP).rounded(2).bg(t.muted).w(thumb).left(((v.room - thumb) * v.left) / v.max));
  }

  render(cx) {
    const { host } = this, n = this.rows.length, t = theme(), tr = host.t;
    if (!host.repo) return div();
    if (!this.read) return notice(tr("ui.loading"), t, { busy: true });
    // A read that failed says so in the panel's error strip, not "No commits yet".
    if (!n) return notice(this.loading ? tr("ui.loading") : this.failed ? "" : this.filtered() ? tr("log.noMatchingCommits") : tr("log.noCommits"), t, { busy: this.loading });
    // The next batch starts in a timer: nothing may start inside render.
    const scrolled = !this.stalled || this.stalled.top !== this.list.top;
    if (this.list.nearEnd(n, 60) && this.more && !this.loading && !this.later && scrolled) {
      this.later = true;
      cx.timer.after(0, (cx) => { this.later = false; this.loadMore(cx); });
    }
    const palette = lanePalette(t), width = host.listWidth ?? 9999, wide = width >= 520 ? 2 : width >= 380 ? 1 : 0;
    const v = this.graphView(width);
    const labelSpace = {
      most: Math.floor((width - ROW_PAD) * 0.45),
      left: width - ROW_PAD - GAP * 2 - SUBJECT_MIN - (wide > 1 ? AUTHOR + GAP : 0) - (wide > 0 ? TIME + GAP : 0),
    };
    return div().id("log-list").track_focus(this.handle).relative().size_full().min_h(0)
      .on_key_down((e, cx) => {
        const page = Math.max(1, this.list.fit - 1);
        if (e.key === "down") this.move(1, cx);
        else if (e.key === "up") this.move(-1, cx);
        else if (e.key === "pagedown") this.move(page, cx);
        else if (e.key === "pageup") this.move(-page, cx);
        else if (e.key === "home") this.move(-this.rows.length, cx);
        else if (e.key === "end") this.move(this.rows.length, cx);
        else return;
        cx.stop_propagation();
      })
      .child(this.list.render(n, (i) => this.commitRow(i, t, palette, wide, v, labelSpace), t))
      .when(v.max > 0, (el) => el.child(this.scrollStrip(v, t)));
  }
}
