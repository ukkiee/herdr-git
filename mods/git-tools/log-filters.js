// The search box and the Branch / User / Date / Path filters above the Commit list.
//
// A part of the Log panel: `host` is described at the top of log-list.js. It turns its
// filter values into arguments with git-log-filter.js and hands them over with
// host.setFilterArgs(args, cx), so git does the filtering and commits not read yet are
// filtered too. The Branch filter keeps no value of its own: it reads host.branch and
// sets it with host.setBranch (the Branch tree sets the same one). A hash typed into
// the search box goes to host.goTo(hash, cx).
//
// The search applies on Enter. Each filter opens a popup under its button; a filter in
// use shows its value there, with an x that clears it.
//
// props (of the Log panel or Log tab this row is in), for a list that opens filtered and
// for scripts taking screenshots:
//   filters: { text, regex, matchCase, branch, user ("me" or a part of a name or email),
//              users (["me" | a part of a name or email | { name } exact | { text } a part]),
//              date (a preset's label, or { since, until } as YYYY-MM-DD), path }
//   filterOpen: "branch" | "user" | "date" | "path": that popup starts open
//
// The User filter holds a list of people (values.users): { me: true, text } for the
// configured user, { name } for an author checked in the popup, { text } for letters
// typed and entered. A commit by any of them stays (git-log-filter.js filterArgs).

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Popover } from "gpui-base";
import { theme, props } from "herdr";
import { resolveCommit } from "./git-log.js";
import { filterArgs, isHash, isDate, readMe, userOf, readBranchNames, readAuthors, matchAuthors, DATE_PRESETS, datePreset, dateText } from "./git-log-filter.js";
import { tip as tipOn, uiGlyph, darkLook, ICON, iconButton, sentence, WindowedList } from "./ui.js";

const EMPTY = { text: "", regex: false, matchCase: false, users: [], since: "", until: "", dateLabel: "", path: "" };
const POPUP_W = 260, ITEM = 26, BRANCH_ROWS = 10, USER_ROWS = 10;
// How many repositories the User popup keeps the last author list of, to show at once
// on the next opening while it reads them again.
const AUTHORS_SEEN = 8;
// How long after an Enter in the User popup a close is taken as that Enter's doing.
const ENTER_KEEPS_OPEN_MS = 500;
const stop = (_e, cx) => cx.stop_propagation();
// Whether two rows of the User popup (userItems) are the same choice: "me", the same
// typed entry, or the same author's name.
const sameUserItem = (a, b) => a.kind === b.kind && (a.kind === "me" || (a.kind === "text" ? a.entry === b.entry : a.author.name === b.author.name));

export default class LogFilters {
  init(host, _cx) {
    this.host = host;
    this.values = { ...EMPTY, users: [] };
    this.open = null; // which filter's popup shows
    this.focused = null; // which input has the keyboard
    this.names = null; // { current, local, remote } for the Branch popup
    this.branchRows = new WindowedList("log-filter-branch-rows", { rowHeight: ITEM });
    this.branchAt = -1; // the row of the Branch popup the arrow keys are on
    this.branchCache = null; // { names, q, items }: branchItems() for those two
    this.me = null; // { ok, err, name, email }
    this.authors = null; // { ok, err, authors } for the User popup, of this repository
    this.authorsSeen = new Map(); // repoKey → the last { ok, authors } read there, newest last
    this.userRows = new WindowedList("log-filter-user-rows", { rowHeight: ITEM });
    this.userAt = -1; // the row of the User popup the arrow keys are on
    // When (Date.now) the User popup last saw an Enter, an Escape or a press outside it,
    // and last closed: keepUserOpen and userClosing tell an Enter's close from a person's.
    this.userEnterAt = -Infinity; this.userHandAt = -Infinity; this.userClosedAt = -Infinity;
    this.userCache = null; // { authors, q, users, me, items }: userItems() for those
    this.dateError = null;
    this.noted = null; // our own text in the panel's error strip
    this.repoKey = undefined;
    const input = (name, placeholder, onSubmit) => {
      const state = InputState.new({ placeholder });
      state.on("submit", (_e, cx) => onSubmit(cx));
      state.on("focus", (_e, cx) => { this.focused = name; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focused === name) this.focused = null; cx.notify(); });
      return state;
    };
    this.input = input;
    this.makeInputs();
    this.makeUserInput();
    const p = props() ?? {};
    // Used once the repository is known: "me" and the branch limit belong to it.
    this.initial = p.filters || p.filterOpen ? { filters: p.filters ?? {}, open: p.filterOpen ?? null } : null;
  }

  // The search box and the Branch, Date and Path inputs. Their placeholders are fixed when
  // they are made: a copy whose language changed since gets new ones holding what was
  // typed (render asks for it; the User input is made again in show).
  makeInputs() {
    const { input } = this, tr = this.host.t;
    const kept = this.inputsLang === undefined ? null : { search: this.search.value(), branch: this.branchInput.value(), since: this.sinceInput.value(), until: this.untilInput.value(), path: this.pathInput.value() };
    this.inputsLang = this.host.lang;
    this.search = input("search", tr("log.textOrHash"), (cx) => this.submit(cx));
    this.search.on("change", (_e, cx) => {
      this.unnote(cx);
      // Emptying the box takes the text filter off without another Enter.
      if (this.search.value().trim() === "" && this.values.text) { this.values.text = ""; this.apply(cx); }
    });
    this.branchInput = input("branch", tr("log.searchBranches"), (cx) => {
      const items = this.branchItems();
      const pick = items[this.branchAt]?.ref ? items[this.branchAt] : items.find((item) => item.ref);
      if (pick) this.pickBranch(pick.ref, cx);
    });
    this.branchInput.on("change", (_e, cx) => { this.branchRows.top = 0; this.branchAt = -1; cx.notify(); });
    this.sinceInput = input("since", tr("log.fromDate"), (cx) => this.submitDates(cx));
    this.untilInput = input("until", tr("log.toDate"), (cx) => this.submitDates(cx));
    this.pathInput = input("path", tr("log.pathFromRoot"), (cx) => {
      const path = this.pathInput.value().trim();
      if (path) this.set({ path }, cx);
    });
    if (!kept) return;
    this.search.set_value(kept.search); this.branchInput.set_value(kept.branch);
    this.sinceInput.set_value(kept.since); this.untilInput.set_value(kept.until); this.pathInput.set_value(kept.path);
    const focused = { search: this.search, branch: this.branchInput, since: this.sinceInput, until: this.untilInput, path: this.pathInput }[this.focused];
    if (focused) focused.focus();
  }

  // ---- values → the list

  args() {
    const v = this.values;
    return filterArgs({ text: v.text, regex: v.regex, matchCase: v.matchCase, users: v.users, since: v.since, until: v.until, paths: v.path ? [v.path] : [] });
  }

  any() {
    const v = this.values;
    return Boolean(this.host.branch || v.text.trim() || v.users.length || v.since || v.until || v.path);
  }

  // The list is read again only when the arguments really changed.
  // Every change of the values ends here (set, clear, clearAll, start, setUsers), so the
  // User popup's rows are worked out here for the new choice, never in render.
  apply(cx) {
    this.userItems();
    const args = this.args();
    if (JSON.stringify(args) !== JSON.stringify(this.host.filterArgs)) this.host.setFilterArgs(args, cx);
    cx.notify();
  }

  set(changes, cx) {
    Object.assign(this.values, changes);
    this.open = null;
    this.apply(cx);
  }

  clear(name, cx) {
    if (name === "branch") { this.host.setBranch(null, cx); return; }
    if (name === "user") this.set({ users: [] }, cx);
    // dateLabel: a preset's label (DATE_PRESETS), kept in English whatever the language;
    // "" for typed days.
    else if (name === "date") this.set({ since: "", until: "", dateLabel: "" }, cx);
    else if (name === "path") this.set({ path: "" }, cx);
  }

  clearAll(cx) {
    this.values = { ...EMPTY, users: [], regex: this.values.regex, matchCase: this.values.matchCase };
    this.search.set_value("");
    this.open = null;
    this.unnote(cx);
    if (this.host.branch) this.host.setBranch(null, cx);
    this.apply(cx);
  }

  // ---- the search box

  submit(cx) {
    const typed = this.search.value();
    this.unnote(cx);
    if (isHash(typed)) { this.jump(typed.trim(), cx); return; }
    // A text search drops a hash jump still running, even when the arguments stay the same.
    this.host.beginJump();
    this.values.text = typed;
    this.apply(cx);
  }

  jump(text, cx) {
    const { host } = this, repo = host.repo;
    if (!repo) return;
    // The box holds a hash now, so no message search is in force.
    if (this.values.text) { this.values.text = ""; this.apply(cx); }
    // Taken after the filter change above: a later search, filter change or pick makes
    // this jump void, and its late answer then neither selects nor posts a note.
    const turn = host.beginJump();
    cx.spawn(async (cx) => {
      const r = await resolveCommit(repo.git, repo.root, text);
      if (repo !== host.repo || !host.jumpLive(turn)) return;
      if (!r.ok) { this.note(host.t("log.commitNotFound", { text }), cx); return; }
      const found = await host.goTo(r.hash, cx, turn);
      if (found === false && repo === host.repo && host.jumpLive(turn)) this.note(host.t(this.any() ? "log.commitFiltered" : "log.commitNowhere", { text }), cx);
    });
  }

  note(text, cx) { this.noted = text; this.host.fail(text, cx); }

  // Takes our own note off the error strip; anyone else's text stays.
  unnote(cx) {
    if (this.noted && this.host.error === this.noted) this.host.fail(null, cx);
    this.noted = null;
  }

  toggle(name, cx) {
    this.values[name] = !this.values[name];
    if (this.values.text.trim()) this.apply(cx);
    cx.notify();
  }

  // ---- the popups

  show(name, cx) {
    this.open = name;
    this.dateError = null;
    const repo = this.host.repo;
    if (name === "branch" && repo) {
      this.branchInput.set_value("");
      this.branchRows.top = 0; this.branchAt = -1;
      cx.spawn(async (cx) => {
        const r = await readBranchNames(repo.git, repo.root);
        if (repo !== this.host.repo) return;
        this.names = r;
        // The branch in force starts in view, however far down the list it is.
        const items = this.branchItems();
        this.branchRows.reveal(items.findIndex((it) => it.ref && it.ref === this.host.branch), items.length);
        cx.notify();
      });
    }
    if (name === "user" && repo && !this.me) {
      cx.spawn(async (cx) => {
        const r = await readMe(repo.git, repo.root);
        if (repo !== this.host.repo) return;
        this.me = r;
        this.userItems();
        cx.notify();
      });
    }
    if (name === "user") {
      // The placeholder is fixed when the input is made: a copy whose language changed
      // since gets a new one.
      if (this.userInputLang !== this.host.lang) this.makeUserInput();
      this.userInput.set_value("");
      this.userRows.top = 0; this.userAt = -1;
      if (repo) this.readUsers(repo, cx);
    }
    if (name === "date") {
      const typed = !datePreset(this.values.dateLabel);
      this.sinceInput.set_value(typed ? this.values.since : "");
      this.untilInput.set_value(typed ? this.values.until : "");
    }
    if (name === "path") this.pathInput.set_value(this.values.path);
    const first = { branch: this.branchInput, user: this.userInput, date: this.sinceInput, path: this.pathInput }[name];
    // The popup's content exists only after the next render, so focus again once it does.
    first.focus();
    cx.timer.after(150, () => { if (this.open === name) first.focus(); });
    cx.notify();
  }

  pickBranch(ref, cx) {
    this.open = null;
    if (ref !== this.host.branch) this.host.setBranch(ref, cx);
    cx.notify();
  }

  // ---- the User popup

  makeUserInput() {
    this.userInputLang = this.host.lang;
    this.userInput = this.input("user", this.host.t("filters.userPlaceholder"), (cx) => this.submitUser(cx));
    this.userInput.on("change", (_e, cx) => { this.userRows.top = 0; this.userAt = -1; this.userItems(); cx.notify(); });
  }

  // The list read last time in this repository shows at once; the read that follows
  // replaces it. The input works all along. Only the newest read's answer is used: one
  // started before it may end after it, with an older list.
  readUsers(repo, cx) {
    const key = this.repoKey, read = (this.usersRead = (this.usersRead ?? 0) + 1);
    if (!this.authors?.ok) this.authors = this.authorsSeen.get(key) ?? this.authors;
    this.userItems();
    cx.spawn(async (cx) => {
      const r = await readAuthors(repo.git, repo.root);
      if (repo !== this.host.repo || read !== this.usersRead) return;
      // A failed read again keeps the list in view; with none, its error shows.
      if (r.ok || !this.authors?.ok) {
        // The arrow stays on the row it was on, wherever the new list puts it, or on none:
        // Enter must never check someone else.
        const at = this.userItems()[this.userAt];
        this.authors = r;
        // Worked out here in any case, so render finds the rows ready.
        const items = this.userItems();
        this.userAt = at ? items.findIndex((item) => sameUserItem(item, at)) : -1;
      }
      if (r.ok) {
        this.authorsSeen.delete(key);
        this.authorsSeen.set(key, r);
        while (this.authorsSeen.size > AUTHORS_SEEN) this.authorsSeen.delete(this.authorsSeen.keys().next().value);
      }
      cx.notify();
    });
  }

  // The popup stays open: each change reads the list again at once.
  setUsers(users, cx) {
    this.values.users = users;
    this.userItems();
    this.apply(cx);
  }

  // Rows of the User popup: { kind: "me" }, { kind: "text", entry } for each typed entry
  // in force, then { kind: "name", author } for the authors the input matches. Worked out
  // once per answer, input and choice, not in every render (there may be thousands): each
  // place that changes one of them calls this, so render finds them ready.
  userItems() {
    const authors = this.authors, q = this.userInput.value().trim(), users = this.values.users, me = this.me;
    const cache = this.userCache;
    if (cache && cache.authors === authors && cache.q === q && cache.users === users && cache.me === me) return cache.items;
    const items = [{ kind: "me" }];
    for (const entry of users) if (!entry.me && !entry.name) items.push({ kind: "text", entry });
    if (authors?.ok) for (const author of matchAuthors(authors.authors, q)) items.push({ kind: "name", author });
    this.userCache = { authors, q, users, me, items };
    return items;
  }

  userChecked(item) {
    const users = this.values.users;
    if (item.kind === "me") return users.some((e) => e.me);
    if (item.kind === "text") return true;
    return users.some((e) => e.name === item.author.name);
  }

  toggleUser(item, cx) {
    const users = this.values.users, under = this.userItems()[this.userAt];
    if (item.kind === "me") {
      if (!this.me?.ok) return;
      this.setUsers(users.some((e) => e.me) ? users.filter((e) => !e.me) : [{ me: true, text: userOf(this.me) }, ...users], cx);
    } else if (item.kind === "text") {
      this.setUsers(users.filter((e) => e !== item.entry), cx);
    } else {
      const name = item.author.name;
      this.setUsers(users.some((e) => e.name === name) ? users.filter((e) => e.name !== name) : [...users, { name }], cx);
    }
    // A typed row that went away moves the rows after it: the arrow stays on the row it
    // was on, or on none when that row went.
    this.userAt = under ? this.userItems().findIndex((it) => sameUserItem(it, under)) : -1;
  }

  // Enter: the row the arrows are on changes its check; with none, the letters typed are
  // added as a part of a name or email to look for.
  submitUser(cx) {
    this.keepUserOpen(cx);
    const items = this.userItems();
    if (this.userAt >= 0 && items[this.userAt]) { this.toggleUser(items[this.userAt], cx); return; }
    const text = this.userInput.value().trim();
    if (!text) return;
    // Emptied first, so the rows worked out below are the ones the next render shows: setting
    // the value may not fire a change.
    this.userInput.set_value("");
    const users = this.values.users;
    if (!users.some((e) => !e.me && !e.name && e.text === text)) this.setUsers([...users, { text }], cx);
    else this.userItems();
    this.userRows.top = 0;
    cx.notify();
  }

  // Gotcha: in the app an Enter in the User popup's input also closes the popup (the
  // Popover is told to close; which part of the platform asks is not known), while a click
  // on a row does not. The popup must stay open after Enter, so one close per Enter is
  // held back: the first that comes within ENTER_KEEPS_OPEN_MS of it, with no Escape or
  // outside press seen since, is refused, or one reported before the Enter's submit arrives
  // is undone here. Any close after that one closes, however soon: an Escape may never reach
  // the popup's key listener, so this can't wait to see one. The input gets the keyboard back.
  keepUserOpen(cx) {
    const now = Date.now();
    this.userEnterAt = now;
    const byHand = this.userClosedAt - this.userHandAt < ENTER_KEEPS_OPEN_MS;
    if (this.open !== "user" && now - this.userClosedAt < ENTER_KEEPS_OPEN_MS && !byHand) {
      this.userEnterAt = -Infinity;
      this.open = "user";
      this.refocusUser(cx);
    }
  }

  // The Popover asks to close the User popup: true when it may.
  userClosing() {
    const now = Date.now();
    if (now - this.userEnterAt < ENTER_KEEPS_OPEN_MS && this.userHandAt < this.userEnterAt) {
      this.userEnterAt = -Infinity;
      return false;
    }
    this.userClosedAt = now;
    return true;
  }

  refocusUser(cx) {
    this.userInput.focus();
    // Focus may move again as the popup redraws: once more after it has.
    cx.timer.after(150, () => { if (this.open === "user") this.userInput.focus(); });
    cx.notify();
  }

  moveUser(by, cx) {
    const items = this.userItems();
    let i = this.userAt + by;
    if (items[i]?.kind === "me" && !this.me?.ok) i += by;
    if (!items[i]) return;
    this.userAt = i;
    this.userRows.reveal(i, items.length);
    cx.notify();
  }

  entryLabel(entry) {
    return entry.me ? this.host.t("filters.me") : entry.name ?? entry.text;
  }

  // The button's value: the one person, or how many.
  userValue() {
    const users = this.values.users;
    if (!users.length) return "";
    return users.length === 1 ? this.entryLabel(users[0]) : this.host.t("filters.users", { n: users.length });
  }

  submitDates(cx) {
    const since = this.sinceInput.value().trim(), until = this.untilInput.value().trim();
    // dateError holds a message key: the words follow the language when it is drawn.
    if (!since && !until) { this.dateError = "log.dateNeeded"; cx.notify(); return; }
    if ((since && !isDate(since)) || (until && !isDate(until))) { this.dateError = "log.dateFormat"; cx.notify(); return; }
    if (since && until && since > until) { this.dateError = "log.dateOrder"; cx.notify(); return; }
    this.dateError = null;
    this.set({ since, until, dateLabel: "" }, cx);
  }

  // Rows of the Branch popup: { head: text } for a group title, { ref, label, hint } else.
  // Every branch is a row (a repository may have thousands), so they are worked out once
  // per answer and search text, not in every render.
  branchItems() {
    const names = this.names;
    if (!names?.ok) return [];
    const q = this.branchInput.value().trim().toLowerCase(), tr = this.host.t, lang = this.host.lang;
    const cache = this.branchCache;
    if (cache && cache.names === names && cache.q === q && cache.lang === lang) return cache.items;
    const match = (name) => !q || name.toLowerCase().includes(q);
    const items = [];
    // HEAD means the branch it is on, as in the Branch tree; detached, HEAD itself.
    if (match("head")) items.push({ ref: names.current ?? "HEAD", label: "HEAD", hint: names.current ?? tr("log.detached") });
    const local = names.local.filter(match), remote = names.remote.filter(match);
    if (local.length) items.push({ head: tr("log.local") }, ...local.map((name) => ({ ref: name, label: name })));
    if (remote.length) items.push({ head: tr("log.remote") }, ...remote.map((name) => ({ ref: name, label: name })));
    this.branchCache = { names, q, lang, items };
    return items;
  }

  // Up and Down in the Branch popup: to the next branch row, over the group titles.
  moveBranch(by, cx) {
    const items = this.branchItems();
    let i = this.branchAt + by;
    while (items[i]?.head) i += by;
    if (!items[i]) return;
    this.branchAt = i;
    this.branchRows.reveal(i, items.length);
    cx.notify();
  }

  // Values a script or a Log tab's props start the row with.
  start({ filters, open }, cx) {
    const { host } = this, repo = host.repo, v = this.values;
    if (typeof filters.text === "string") { v.text = filters.text; this.search.set_value(filters.text); }
    v.regex = Boolean(filters.regex); v.matchCase = Boolean(filters.matchCase);
    if (typeof filters.path === "string") v.path = filters.path.trim();
    const preset = datePreset(filters.date);
    if (preset) Object.assign(v, { since: preset.since, until: "", dateLabel: preset.label });
    else if (filters.date && typeof filters.date === "object") {
      const since = isDate(filters.date.since) ? filters.date.since.trim() : "", until = isDate(filters.date.until) ? filters.date.until.trim() : "";
      if (since || until) Object.assign(v, { since, until, dateLabel: "" });
    }
    // user: one typed value (scripts may still send it); users: several. "me" waits for git's answer.
    const wanted = [...(typeof filters.user === "string" ? [filters.user] : []), ...(Array.isArray(filters.users) ? filters.users : [])];
    let wantMe = false;
    const users = [];
    for (const w of wanted) {
      if (typeof w === "string" && w.trim() === "me") wantMe = true;
      else if (typeof w === "string" && w.trim()) users.push({ text: w.trim() });
      else if (typeof w?.name === "string" && w.name.trim()) users.push({ name: w.name });
      else if (typeof w?.text === "string" && w.text.trim()) users.push({ text: w.text.trim() });
    }
    v.users = users;
    if (typeof filters.branch === "string" && filters.branch) host.setBranch(filters.branch, cx);
    if (isHash(v.text)) { const hash = v.text.trim(); v.text = ""; this.jump(hash, cx); }
    this.apply(cx);
    if (wantMe) {
      cx.spawn(async (cx) => {
        const r = await readMe(repo.git, repo.root);
        if (repo !== host.repo) return;
        this.me = r;
        this.userItems();
        if (r.ok) { if (!this.values.users.some((e) => e.me)) this.setUsers([{ me: true, text: userOf(r) }, ...this.values.users], cx); }
        else host.fail(sentence(host.t, r.msg, r.err), cx);
      });
    }
    if (open) this.show(open, cx);
  }

  // Another repository: "me", the branch names and the values typed belonged to the old one.
  follow(cx) {
    const repo = this.host.repo;
    const key = repo ? JSON.stringify([repo.root, repo.on]) : null;
    if (!key || key === this.repoKey) return;
    const first = this.repoKey === undefined;
    this.repoKey = key;
    this.me = null; this.names = null;
    this.authors = null; this.userAt = -1;
    // No authors yet, so this is only "me" and the typed rows: render then reads it ready.
    this.userItems();
    const initial = first ? this.initial : null;
    this.initial = null;
    // This runs inside render, where nothing may ask for a redraw (cx.notify throws, and
    // cx.spawn starts its function at once, still inside render): a timer runs it after.
    if (initial) cx.timer.after(1, (cx) => this.start(initial, cx));
    else if (!first && (this.any() || this.search.value())) cx.timer.after(1, (cx) => this.clearAll(cx));
  }

  // ---- drawing

  field(id, state, name, t) {
    return h_flex().id(id).h(26).w_full().min_w(0).px(8).items_center().rounded(5).border_1().border_color(this.focused === name ? t.accent : t.input).bg(t.background)
      .cursor_text().on_mouse_down("left", stop)
      .child(Input.new(state).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground));
  }

  item(id, label, t, { hint, checked = false, disabled = false, active = false, onClick } = {}) {
    return h_flex().id(id).h(ITEM).flex_none().w_full().min_w(0).px(8).gap(8).items_center().rounded(5)
      .text_color(disabled ? t.dim : t.foreground)
      .when(active, (el) => el.bg(t.hover))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(div().size(ICON).flex_none().when(checked, (el) => el.child(uiGlyph("check"))))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(hint ?? "")));
  }

  popup(t) {
    return v_flex().w(POPUP_W).p(5).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12.5).text_color(t.foreground).on_mouse_down("left", stop);
  }

  rule(t) { return div().flex_none().mx(6).my(3).h(1).bg(t.border); }

  branchRow(i, t) {
    const it = this.branchItems()[i];
    if (it.head) return h_flex().h(ITEM).flex_none().w_full().px(8).pb(3).items_end().text_size(11).text_color(t.dim).child(it.head);
    return this.item(`log-filter-branch-${i}`, it.label, t, { hint: it.hint, checked: it.ref === this.host.branch, active: i === this.branchAt, onClick: (cx) => this.pickBranch(it.ref, cx) });
  }

  branchPopup(t) {
    const names = this.names, n = this.branchItems().length, tr = this.host.t;
    const state = !names ? this.item("log-filter-branch-wait", tr("ui.loading"), t, { disabled: true })
      : !names.ok ? div().px(8).py(4).text_size(12).text_color(t.ansi1).child(names.err ?? "")
        : !n ? this.item("log-filter-branch-none", tr("log.noMatchingBranches"), t, { disabled: true })
          : null;
    return this.popup(t)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.moveBranch(1, cx);
        else if (e.key === "up") this.moveBranch(-1, cx);
        else return;
        cx.stop_propagation();
      })
      .child(this.field("log-filter-branch-search", this.branchInput, "branch", t))
      // A height in px, never only a maximum: the rows drawn are the ones that fit in it,
      // and a scroll area that has just a maximum height finds nothing to scroll.
      .child(state ?? div().id("log-filter-branch-list").w_full().h(Math.min(BRANCH_ROWS, n) * ITEM)
        .child(this.branchRows.render(n, (i) => this.branchRow(i, t), t)));
  }

  userRow(i, t) {
    const it = this.userItems()[i], tr = this.host.t, me = this.me;
    const common = { checked: this.userChecked(it), active: i === this.userAt, onClick: (cx) => this.toggleUser(it, cx) };
    if (it.kind === "me") {
      return this.item("log-filter-user-me", tr("filters.me"), t, {
        ...common, hint: me ? (me.ok ? me.name || me.email : tr("filters.meNotSet")) : "", disabled: !me?.ok,
      });
    }
    if (it.kind === "text") return this.item(`log-filter-user-${i}`, it.entry.text, t, { ...common, hint: tr("filters.typed") });
    const emails = it.author.emails;
    return this.item(`log-filter-user-${i}`, it.author.name, t, { ...common, hint: emails.length > 1 ? `${emails[0]} +${emails.length - 1}` : emails[0] ?? "" });
  }

  userPopup(t) {
    const tr = this.host.t, authors = this.authors, n = this.userItems().length;
    const listed = n - 1 - this.values.users.filter((e) => !e.me && !e.name).length;
    const state = !authors ? this.item("log-filter-user-wait", tr("filters.loading"), t, { disabled: true })
      : !authors.ok ? div().px(8).py(4).text_size(12).text_color(t.ansi1).child(authors.err ?? "")
        : !listed && this.userInput.value().trim() ? this.item("log-filter-user-none", tr("filters.noUsers"), t, { disabled: true })
          : null;
    return this.popup(t)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.userHandAt = Date.now(); return; }
        if (e.key === "down") this.moveUser(1, cx);
        else if (e.key === "up") this.moveUser(-1, cx);
        else return;
        cx.stop_propagation();
      })
      // A press outside, the filter's own button included: the person closes it.
      .on_mouse_down_out(() => { this.userHandAt = Date.now(); })
      .child(this.field("log-filter-user-input", this.userInput, "user", t))
      // A height in px, as in the Branch popup: only the rows in view are drawn.
      .child(div().id("log-filter-user-list").w_full().h(Math.min(USER_ROWS, n) * ITEM)
        .child(this.userRows.render(n, (i) => this.userRow(i, t), t)))
      .when(Boolean(state), (el) => el.child(state))
      .child(div().px(8).pb(3).text_size(11).text_color(t.dim).child(tr("filters.userHint")));
  }

  datePopup(t) {
    const v = this.values, tr = this.host.t;
    return this.popup(t)
      // The label is what is kept (in English); the key is what the row says.
      .children(DATE_PRESETS.map((p, i) => this.item(`log-filter-date-${i}`, tr(p.key), t, {
        checked: v.dateLabel === p.label, onClick: (cx) => this.set({ since: p.since, until: "", dateLabel: p.label }, cx),
      })))
      .child(this.rule(t))
      .child(v_flex().px(3).pb(3).gap(4)
        .child(this.field("log-filter-date-since", this.sinceInput, "since", t))
        .child(this.field("log-filter-date-until", this.untilInput, "until", t)))
      .child(div().px(8).pb(3).text_size(11).text_color(this.dateError ? t.ansi1 : t.dim).child(tr(this.dateError ?? "log.enterApplies")));
  }

  pathPopup(t) {
    return this.popup(t)
      .child(div().p(3).child(this.field("log-filter-path-input", this.pathInput, "path", t)))
      .child(div().px(8).pb(3).text_size(11).text_color(t.dim).child(this.host.t("log.pathHint")));
  }

  // One filter's button, with its popup. value: what is in force, "" when nothing.
  // tip: the tooltip's text after the label, when the value is only a summary.
  filter(name, label, value, content, t, narrow, tip = value) {
    const open = this.open === name, set = Boolean(value);
    const chip = h_flex().id(`log-filter-${name}`).h(24).flex_none().pl(7).pr(set ? 4 : 5).gap(3).items_center().rounded(5).text_size(12)
      .cursor_pointer().text_color(set ? t.foreground : t.muted)
      .when(open || set, (el) => el.bg(t.selected))
      // A long value is cut short in the button: the tooltip has all of it.
      .when(set && !open, (el) => tipOn(el, `${label}: ${tip}`))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(set && !narrow, (el) => el.child(div().flex_none().text_color(t.muted).child(`${label}:`)))
      .child(div().max_w(narrow ? 84 : 150).truncate().child(set ? value : label))
      .when(!set, (el) => el.child(uiGlyph("dropdown", { dark: darkLook(t.background) })));
    return h_flex().flex_none().items_center()
      .child(Popover.new(`log-filter-${name}-popup`).open(open)
        .on_open_change((opened, cx) => {
          if (opened) this.show(name, cx);
          else if (name === "user" && this.open === name && !this.userClosing()) this.refocusUser(cx);
          else if (this.open === name) { this.open = null; cx.notify(); }
        })
        .trigger(chip)
        .content(content))
      // Beside the trigger, not inside it: a press on the x must not open the popup.
      .when(set, (el) => el.child(iconButton(`log-filter-${name}-clear`, "x", t, { title: this.host.t("log.clearFilter", { label }), size: 18, onClick: (_e, cx) => this.clear(name, cx) })));
  }

  render(cx) {
    const { host } = this, t = theme(), v = this.values, tr = host.t;
    if (!host.repo) return div();
    this.follow(cx);
    if (this.inputsLang !== host.lang && !this.relabeling) {
      // Not here: render may not make the redraw new inputs need.
      this.relabeling = true;
      cx.timer.after(1, (cx) => { this.relabeling = false; if (this.inputsLang !== this.host.lang) { this.makeInputs(); cx.notify(); } });
    }
    const narrow = (host.listWidth ?? 9999) < 760;
    return h_flex().id("log-filters").size_full().min_w(0).gap(4).items_center().overflow_hidden()
      .child(h_flex().id("log-search").flex_1().min_w(96).max_w(300).h(24).pl(6).pr(2).gap(4).items_center().rounded(5).border_1()
        .border_color(this.focused === "search" ? t.accent : t.input).bg(t.background)
        .cursor_text().on_mouse_down("left", stop)
        .child(uiGlyph("search").text_color(t.dim))
        .child(Input.new(this.search).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
        .child(iconButton("log-search-regex", "regex", t, { title: tr("log.regex"), size: 20, active: v.regex, onClick: (_e, cx) => this.toggle("regex", cx) }))
        .child(iconButton("log-search-case", "case-sensitive", t, { title: tr("log.matchCase"), size: 20, active: v.matchCase, onClick: (_e, cx) => this.toggle("matchCase", cx) })))
      .child(this.filter("branch", tr("log.branch"), host.branch ?? "", this.branchPopup(t), t, narrow))
      .child(this.filter("user", host.t("filters.user"), this.userValue(), this.userPopup(t), t, narrow, v.users.map((e) => this.entryLabel(e)).join(", ")))
      .child(this.filter("date", tr("log.date"), dateText(tr, v), this.datePopup(t), t, narrow))
      .child(this.filter("path", tr("log.path"), v.path, this.pathPopup(t), t, narrow))
      .when(this.any(), (el) => el.child(iconButton("log-filter-clear", "filter-x", t, { title: tr("log.clearAllFilters"), onClick: (_e, cx) => this.clearAll(cx) })));
  }
}
