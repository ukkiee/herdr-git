// Shared parts for every git-tools screen: the copy's language, where the repository is,
// rows, icon buttons, checkboxes, the windowed list, popup menus, dialogs, the error
// strip and the note bar, stroked lines, and the bus the screens talk to each other on.
// Screens import from here and don't edit it; a part only one screen needs stays in that
// screen's file.

import { div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Textarea, Scrollbar } from "gpui-base";
import { spaces, panes, focused, layout, openOverlay, closeOverlay, run, shared, setShared, exec, settings, theme, window as hostWindow } from "herdr";
import { makeCopy, post } from "./bus.js";
import { makeLocks, BEAT, sameRepo, repoName } from "./lock.js";
import { LANGS, translator, systemLang, sentence } from "./i18n.js";
import { fileIcon, folderIcon, darkColor } from "./icon-theme.js";
import { iconShape, iconDraw } from "./ui-icons.js";
import { menuWidth } from "./ui-size.js";
import { en as consoleEn, ko as consoleKo } from "./messages-console.js";

export const MOD = "git-tools";
export const ROW = 24;
// The shape of a named icon (ui-icons.js), for svg(): drawn in the text color. A colored
// icon goes through uiGlyph or iconButton instead.
export const icon = (name) => iconShape(name);
// The size buttons and menus draw their icons at: the icons' own 16-pixel grid.
export const ICON = 16;

// ---- language

// Each copy has its language and its t(key, args) (i18n.js), set by main.js before the
// screen's init as `screen.lang` and `screen.t`. A screen words everything with
// `this.t(...)` at the time it draws, never a t kept from earlier: the language can
// change after the first draw.
//
// The shared parts below are called from screens that don't hand them a `t`. main.js
// runs each of the screen's calls (init, render, command, event, serve) inside
// `speakAs(screen.t, …)`, and a part called during that call speaks the screen's
// language. This one module-level value is safe where per-copy state isn't: it is set
// only for the length of one synchronous call (nothing else runs meanwhile, so no other
// copy sees it) and put back right after. A click handler or a spawned task runs outside
// that call: a part used there takes the screen (askOwner, writeBlock) or a `t`, else
// it speaks English.
let speaking = null;
const ENGLISH = translator("en");
const words = (t) => t ?? speaking ?? ENGLISH;

export function speakAs(t, fn) {
  const before = speaking;
  speaking = t ?? null;
  try { return fn(); } finally { speaking = before; }
}

// The language the window's computer last said, kept in Herdr's shared state so a copy
// opened later starts in it instead of English. Written only when it differs (every
// write redraws every copy).
const LANG = "git-tools.lang";

// props.lang ("en" | "ko") fixes a copy's language: the opener's for a dialog or a popup
// menu, or a person's choice when they open a tab with it to check the other language.
export const fixedLang = (p) => (LANGS.includes(p?.lang) ? p.lang : null);
export function rememberedLang() {
  const lang = shared(LANG);
  return LANGS.includes(lang) ? lang : null;
}
export function rememberLang(lang) {
  if (LANGS.includes(lang) && shared(LANG) !== lang) setShared(LANG, lang);
}

// The language of the computer the window is on (a remote space's too): macOS's first
// preferred language, Linux's locale variables, Windows' display language (UI culture).
// null when it isn't known: no window yet (right after the app starts) or the command
// failed, couldn't start or said nothing. The copy then keeps what it has and asks again
// (main.js).
export async function readSystemLang() {
  const platform = hostWindow()?.platform;
  let read = null;
  try {
    if (platform === "macos") read = await exec("defaults", ["read", "-g", "AppleLanguages"], { timeout: 5000 });
    else if (platform === "linux") read = await exec("sh", ["-c", 'printf "%s\\n%s\\n%s\\n" "$LC_ALL" "$LC_MESSAGES" "$LANG"'], { timeout: 5000 });
    // -NoProfile: a person's profile script can print text of its own or be slow to load.
    else if (platform === "windows") read = await exec("powershell", ["-NoProfile", "-Command", "(Get-UICulture).Name"], { timeout: 5000 });
  } catch { /* read stays null: not known */ }
  return systemLang(platform, read);
}

// The language a dialog or popup menu opened now gets: the caller's `lang`, else the
// language of the screen whose call is running, else the system's as last read.
const openingLang = (lang) => fixedLang({ lang }) ?? speaking?.lang ?? rememberedLang() ?? "en";

// sentence(t, msg, text) → what a screen shows for a git module's result: the sentence
// for `msg` ({ key, args }) in the screen's language, else `text` as it came (git's own
// words, or a module that doesn't word its results yet). i18n.js has it; here so screens
// import their parts from one place.
export { sentence };

// ---- where git runs

// The focused pane's folder, else the space's (the order the shipped Changes panel uses),
// and the machine to run git on (null: this computer).
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { folder: pane?.cwd || f?.cwd || space?.folder || null, on, space: space?.id ?? null };
}

// ---- the main-git layout's nodes

// Ids install.sh (layout.mjs) gives the layout. The Commit panel is the `changes` child
// of the `panel-body` stack inside `panel`, as in Herdr's own main layout.
export const LOG_NODE = "git-log";

const findNode = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
};

// null when the shown layout has no Log panel (not main-git).
export function logPanelShown() {
  const node = findNode(layout(), LOG_NODE);
  return node ? !node.hidden : null;
}

export const toggleLogPanel = () => { run("layout.toggle", { id: LOG_NODE }); };

// Whether the shown layout has the tab bar's Git button (main-git on macOS).
export const gitButtonPlaced = () => findNode(layout(), "git-log-button") !== null;

export function openCommitPanel() {
  run("layout.select", { stack: "panel-body", child: "changes" });
  run("layout.show", { id: "panel" });
}

// ---- screens talking to each other

// Copies of this mod (panel, dialog, popup, tab) may share these modules, so a copy's
// own state is never kept at module level: each copy has its side of the bus (bus.js
// `makeCopy`, made by `subscribe` in main.js and handed to the screen as `screen.bus`).
// What one copy tells the others (the repository changed, a popup menu's pick) goes
// through Herdr's shared state: one small value (bus.js) holding the last few events,
// each with a number. Setting it re-renders every shown copy; a copy's render (main.js
// calls `bus.pump`) sees a number it hasn't handled and takes the new events in a timer
// of its own. A hidden copy does the same when it shows again.
//
// Never hand anything to another copy directly (a promise or a callback kept in
// globalThis): what the receiving code starts then runs inside the SENDER's call, belongs
// to the sender, and is dropped unfinished when the sender closes (a panel's read would
// hang with its loading flag on; a menu's pick would never run). Taken from its own
// render, the work is the receiving copy's own.
const BUS = "git-tools.bus";
const slot = { read: () => shared(BUS), write: (value) => setShared(BUS, value) };

// main.js calls this once per copy, in init: the copy's side of the bus (bus.js
// `makeCopy`: next, stop, pump, and what openMenu and answerMenu use). Its events go to
// the screen's `event(e, cx)`.
export const subscribe = () => makeCopy(slot);

// event: { type, ...fields }: plain JSON and small (the value is saved with the person's
// shared state). Known type: "changed" { root, by? } (a git write finished: screens
// showing that repository read it again; without `root`, every screen does, as after
// events went unseen). by: the request key of a write a panel ran for a dialog
// (serveRequest), so the panel can tell that write's own "changed" from later ones.
// Every copy gets it a moment later, the sender too if it is still there.
export function broadcast(event) {
  post(slot, event);
}

// ---- one git write at a time per repository

// Every copy shares one lock value (lock.js) in Herdr's shared state: whichever screen
// starts a write (a panel, a tab on the same repository), the others see the repository
// held and don't start one. main.js makes each copy's side in init (`screen.locks`),
// beats it every BEAT ms and releases what the copy holds in close.
const LOCK = "git-tools.lock";
const lockSlot = { read: () => shared(LOCK), write: (value) => setShared(LOCK, value) };
export const lockSide = (owner) => makeLocks(lockSlot, owner, () => Date.now());
export const LOCK_BEAT = BEAT;

// tr: a t (i18n.js) when called outside the screen's own call (see speakAs).
export const runningText = (label, tr) => words(tr)("ui.running", { label });
export const elsewhereText = (label, tr) => words(tr)("ui.runningElsewhere", { label });

// A write is named by a work: { key, args? }, a message key ("commit.committing") that each
// copy words in its own language. What tells writes apart (which button spins) compares
// the key, never the words.
// workName(work, tr) → the work worded in tr's language.
export const workName = (work, tr) => words(tr)(work?.key ?? "", work?.args ?? {});
// heldName(held, tr) → a lock record's write (lock.js holder) in tr's language: by its
// work, or by its label when the copy that holds it wrote none.
const heldName = (held, tr) => (held.work ? workName(held.work, tr) : held.label);

// A screen that writes keeps `busy` (the work of its own write, or null) and `held`
// (the repository its lock is on). These two are the one place a write takes and lets go
// of the lock; screens call them from their setBusy.
//
// A panel follows the focused pane while its write runs, so `held` and the repository it
// shows (`repo` below) may differ. One write at a time per screen still holds: `busy`
// blocks every write of the screen, wherever it is.

// writingOn(screen, repo) → true while the screen's own write runs on `repo`: only then
// is its spinner drawn on that repository's buttons.
export const writingOn = (screen, repo) => Boolean(screen.busy) && sameRepo(screen.held, repo);

// writeBlock(screen, repo) → why a write can't start on `repo` now, or null: the
// screen's own write there (its name, shown next to its own spinner), its own write on
// another repository ("Another git operation is running in another repository: …"), or
// another copy's write there ("Another git operation is running: Committing…"). Each in
// the screen's language.
export function writeBlock(screen, repo) {
  if (screen.busy) {
    const name = workName(screen.busy, screen.t);
    return writingOn(screen, repo) ? name : elsewhereText(name, screen.t);
  }
  const held = repo?.root ? screen.locks?.holder(repo) : null;
  return held ? runningText(heldName(held, screen.t), screen.t) : null;
}

// writeName(screen, repo) → writeBlock's short form for a narrow toolbar, or null. It
// starts with the running write's name so cutting the end still leaves the name:
// "Committing…" for any write on `repo`, "Checking out… (another repository)" for the
// screen's own write elsewhere. The full sentence goes in its tooltip.
export function writeName(screen, repo) {
  if (screen.busy) {
    const name = workName(screen.busy, screen.t);
    return writingOn(screen, repo) ? name : words(screen.t)("ui.anotherRepository", { label: name });
  }
  const held = repo?.root ? screen.locks?.holder(repo) : null;
  return held ? heldName(held, screen.t) : null;
}

// readBlocked(screen, repo) → true while a write runs on `repo` (the screen's own or any
// copy's): a read then would see it half done. A write on another repository never
// holds a read back.
export function readBlocked(screen, repo) {
  return writingOn(screen, repo) || Boolean(repo?.root && screen.locks?.holder(repo));
}

// fromRepo(screen, repo, text) → a write's failure as the screen shows it: as it is when
// the screen still shows `repo`, else with the repository's folder name before it
// ("slowhook: …"), since it lands on another repository's screen.
export const fromRepo = (screen, repo, text) => (sameRepo(repo, screen.repo) ? text : `${repoName(repo?.root)}: ${text}`);

// takeWrite(screen, repo, work): true when the screen now holds `repo` and `busy` is
// `work` ({ key, args? }); false (nothing changed) while the screen already writes or
// anyone holds the repository. The lock gets the work and its words in this screen's
// language (lock.js).
export function takeWrite(screen, repo, work) {
  if (screen.busy || !repo?.root || !screen.locks) return false;
  if (!screen.locks.take(repo, workName(work, screen.t), work).ok) return false;
  screen.busy = work;
  screen.held = { root: repo.root, on: repo.on ?? null };
  return true;
}

export function releaseWrite(screen) {
  if (screen.held) screen.locks?.release(screen.held);
  screen.held = null;
  screen.busy = null;
}

// copyId(key): this copy's id, which names the scratch index its Rollbacks and Restores
// write in a repository's git folder (git-snapshot.js): lower-case hex, made once and
// kept in localStorage under `key`, so a copy keeps one file per repository across
// restarts. Copies of another Herdr app have other ids and never write that file; copies
// of this app that share the storage take turns under the write lock. Without storage,
// an id for this run only.
const COPY_ID = /^[0-9a-f]{16,64}$/;
export function copyId(key) {
  try {
    const kept = localStorage.getItem(key);
    if (COPY_ID.test(kept ?? "")) return kept;
  } catch { /* no storage: a new id below */ }
  const id = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  try { localStorage.setItem(key, id); } catch { /* kept for this run only */ }
  return id;
}

// ---- a dialog's write, run by the panel copy that opened it

// Herdr closes a dialog on Esc whatever the mod does, and what a closed copy started
// stops after its current await: the push or the new branch would happen with nobody
// left to tell the panels or show git's error. So a dialog only asks, and the panel copy
// that opened it (props.owner, its bus id) runs the write as its own work.

// How long the panel has to take a request. A panel that didn't take it by then never
// runs it, so the dialog can say nothing was started and let the person press again.
export const ASK_WITHIN = 3000;
// The answer a panel copy leaves, as it closes, for a request it took and hasn't
// answered (main.js close): git may have run, or may still run, so nobody can say.
export const UNKNOWN = { ok: false, unknown: true, err: "" };
// An answer travels in the shared value, which is saved with the person's state.
const CLIP = 4000;
const clip = (text) => { const s = String(text ?? ""); return s.length > CLIP ? `${s.slice(0, CLIP)}…` : s; };

// askOwner(screen, action, args, who, cx, done)
//   From a dialog (screen.owner, screen.bus). done(r, cx) gets the panel's answer
//   ({ ok, err, … }), or { ok: false, err, unheard: true } when the panel didn't take
//   the request in time, or { ok: false, err } when the answer got lost on the way or the
//   panel closed while it ran the write (the result is unknown then: it is never said
//   that nothing started, and nothing is run again).
//   who: the panel as the person knows it: a message key ("ui.commitPanel"), or the
//   English name ("Commit panel", "Log panel"), which is worded from its key too.
//   The sentences are in the dialog's language (screen.t).
const PANELS = { "Commit panel": "ui.commitPanel", "Log panel": "ui.logPanel" };
export function askOwner(screen, action, args, who, cx, done) {
  const tr = words(screen.t), panel = tr(PANELS[who] ?? who);
  const notTaken = tr("ui.notTaken", { who: panel });
  const gone = tr("ui.lostWhileRunning", { who: panel });
  if (!screen.owner) { done({ ok: false, err: notTaken, unheard: true }, cx); return; }
  const { key, reply } = screen.bus.request(screen.owner, action, args, ASK_WITHIN);
  let gaveUp = false;
  // A little after the panel's own deadline, so a request it took right at the end
  // shows up as taken here.
  cx.timer.after(ASK_WITHIN + 250, () => {
    if (screen.bus.acked(key)) return;
    gaveUp = true;
    screen.bus.drop(key);
  });
  cx.spawn(async (cx) => {
    const r = await reply;
    if (r?.unknown) done({ ok: false, err: gone }, cx);
    else done(r ?? (gaveUp ? { ok: false, err: notTaken, unheard: true } : { ok: false, err: tr("ui.lostShownThere", { who: panel }) }), cx);
    cx.notify();
  });
}

// serveRequest(screen, e, label, work, cx)
//   From a panel's serve(): runs request `e` ({ key, args: { root, on, … } }) as this
//   copy's write on that repository, under `label` (a work: { key, args? }, see
//   takeWrite). work(repo) → { ok, err, changed?, … }
//   (`changed`: the repository changed although the write failed). After it: the lock
//   goes, every screen on the repository is told "changed" (by: e.key), a failure goes to the
//   panel's error strip (screen.writeFailed; see fromRepo when the panel moved on), and
//   the dialog gets the answer. The repository is the request's, never the panel's.
//   A failure that comes with msg (i18n.js `sentence`) is worded in the panel's language
//   for its strip and the answer's err; the answer carries the msg on too.
//   screen: setBusy(label, cx, repo) → bool, writeFailed(text | null, cx), repo, bus, t.
export function serveRequest(screen, e, label, work, cx) {
  const args = e.args ?? {}, repo = { root: args.root ?? null, on: args.on ?? null }, tr = words(screen.t);
  // Only what the dialog shows: git's whole output would sit in the saved shared value.
  const answer = (r) => screen.bus.answer(e.key, { ok: Boolean(r.ok), err: clip(r.err), ...(r.msg ? { msg: r.msg } : {}), ...(r.moved ? { moved: true } : {}) });
  if (!repo.root) { answer({ ok: false, err: tr("ui.noRepository"), msg: { key: "ui.noRepository" } }); return; }
  if (!screen.setBusy(label, cx, repo)) {
    const why = writeBlock(screen, repo);
    answer({ ok: false, err: screen.busy ? runningText(workName(screen.busy, tr), tr) : why ?? runningText("…", tr) });
    return;
  }
  cx.spawn(async (cx) => {
    let r;
    try { r = await work(repo); } catch (error) { r = { ok: false, err: String(error?.message ?? error) }; }
    r = r ?? { ok: false, err: "" };
    // Released first: panels skip reads while a write runs.
    screen.setBusy(null, cx);
    if (r.ok || r.changed) broadcast({ type: "changed", root: repo.root, by: e.key });
    // The panel may show another repository by now: its strip is that one's, so a success
    // here leaves it alone and a failure comes with this repository's folder name.
    const err = r.ok ? null : sentence(tr, r.msg, r.err) || tr("ui.gitFailed");
    if (sameRepo(repo, screen.repo)) screen.writeFailed(err, cx);
    else if (err) screen.writeFailed(fromRepo(screen, repo, err), cx);
    answer({ ok: r.ok, moved: r.moved, err: r.ok ? "" : err, msg: r.ok ? undefined : r.msg });
    cx.notify();
  });
}

// ---- opening other screens

// props.owner, for a dialog whose write the opener runs: the opener's bus id (`bus.id`).
// props.lang: the dialog's language, so it draws in it from the start. Pass the
// opener's (`lang: this.lang`) from a click handler or a task: there the opener isn't
// known here, and the system's language as last read is used.
export function openDialog(view, props = {}, { width = 560, height = 420 } = {}) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width, height, props: { ...props, view, lang: openingLang(props.lang) } });
}

// A tab in the shown space whose only pane is one of our screens. Its props are saved
// with the tab, so they must be plain JSON. No language goes in them: a saved language
// would stay after the system's changed. A tab reads the system's language itself; a
// `lang` the caller puts in props fixes it (for checking the other language).
export function openTab(view, props = {}, name) {
  run("tab.new", { name, mod: MOD, props: { ...props, view } });
}

const MENU_ROW = 28, MENU_PAD = 5, MENU_RULE = 9;

// A popup menu. Resolves with the chosen item's `value`, or null when it's dismissed.
// items: [{ label, value, disabled?, hint?, title?, rule? }] (`hint`: dim text on the
// right, `title`: a tooltip, `rule`: a line above the item). Items go through overlay
// props, so they are plain JSON: no functions. `bus` is the opening copy's (`this.bus` on
// a screen, `host.bus` in a part of the Log panel). Await it inside cx.spawn:
//   cx.spawn(async (cx) => { const v = await openMenu(this.bus, items); if (v) …; cx.notify(); });
// at: where the menu's top left goes, { x, y } in window coordinates (a mouse event's
// `position`). Without it the popup opens where Herdr last saw the pointer, which for a
// press inside a dialog is somewhere outside the dialog: a dialog passes `at`.
// lang: the menu's language, as for openDialog (pass `lang: this.lang`). Labels are the
// opener's to word; the menu screen draws them as given.
// width: the narrowest the menu is. It widens to its longest label (ui-size.js menuWidth),
// so a label with a long branch name still shows what it does.
export function openMenu(bus, items, { width = 220, at, lang } = {}) {
  // Unique among all copies: every opener sees every answer and takes the one with its key.
  const key = `menu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const height = MENU_PAD * 2 + items.length * MENU_ROW + items.filter((it, i) => it.rule && i > 0).length * MENU_RULE;
  const answer = bus.wait(key);
  const spot = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : undefined;
  openOverlay({ mod: MOD, kind: "popup", width: menuWidth(items, { min: width }), height, ...(spot ? { at: spot } : {}), props: { view: "menu", key, items, lang: openingLang(lang) } });
  return answer;
}

// True when the repository opted in to script commands that change it:
//   git config --local gittools.scripted true
// A `git-tools.<command>` reaches every shown copy, the side panels on the person's own
// repositories included, so the commands that write only run where this says yes (or in
// a copy opened on a chosen folder, which the screen checks itself).
export async function scriptedRepo(git, root) {
  if (!git || !root) return false;
  const r = await git.read(root, ["config", "--local", "--type=bool", "--get", "gittools.scripted"]);
  return r.ok && r.out.trim() === "true";
}

// Called by the menu screen (in the popup's copy, with that copy's `bus`): once with the
// pick, and with null when it closes unanswered. The first call for a key counts. The
// answer travels like any event and settles only in the opener's own pump, so what the
// pick starts there (git, a dialog) is the opener's work and outlives the popup.
export function answerMenu(bus, key, value) {
  bus.answer(key, value);
}

export const menuMetrics = { row: MENU_ROW, pad: MENU_PAD, rule: MENU_RULE };

// ---- small parts

const stop = (_e, cx) => cx.stop_propagation();

// The card a panel draws itself as, like the shipped Files and Changes panels.
export function panelFrame(id, t) {
  return v_flex().id(id).size_full().min_w(0).min_h(0).rounded(10).overflow_hidden()
    .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
}

// The strip of icon buttons on top of a panel. Children: iconButton()s, a title, spacer().
export function toolbar(t) {
  return h_flex().h(34).flex_none().w_full().min_w(0).px(6).gap(2).items_center().border_b(1).border_color(t.border);
}

export const spacer = () => div().flex_1().min_w(0);

// A list row: fixed height, indented by depth, selected or hoverable. Add children and
// handlers to it. Give every row a unique id.
export function row(id, t, { selected = false, depth = 0, height = ROW } = {}) {
  return h_flex().id(id).h(height).w_full().min_w(0).flex_none().items_center().gap(6).pl(8 + depth * 16).pr(8)
    .when(selected, (el) => el.bg(t.selected))
    .when(!selected, (el) => el.hover((s) => s.bg(t.hover)));
}

// ---- file and folder icons (icon-theme.js)

// darkColor(color): see icon-theme.js, where it is tested without the host.
export { darkColor };

// True when the icons are drawn on a dark background, so the theme's _dark variants show.
// Judged from the color the rows are painted on (`background`, default: the theme's
// background, which panelFrame paints), never from the appearance setting: what decides
// whether an icon shows is the paint under it, and the two can disagree. Read it once per
// render and pass it to fileGlyph: a change of theme redraws every copy, so the icons follow.
export const darkLook = (background = theme().background) => darkColor(background) ?? settings()?.dark === true;

// A file row's icon in the theme's own colors. `path` is the repository-relative path, so
// rules that look at folders ("tests/a.ts") match too. The lookup remembers every path:
// only the first draw of a path runs the theme's rules, later draws are a table read.
export function fileGlyph(path, { dark = false, size = 14 } = {}) {
  return image(fileIcon(path, { dark })).size(size).flex_none();
}

// A folder row's icon. `name` may be a compact row's joined folders ("src/app"): the last
// folder picks the icon. `open`: the row is expanded. Folder icons have no dark variant.
export function folderGlyph(name, { open = false, size = 14 } = {}) {
  return image(folderIcon(name.slice(name.lastIndexOf("/") + 1), { open })).size(size).flex_none();
}

// A named icon (ui-icons.js) as an element: in the file's colors, or its shape in the
// surrounding text color for the gray ones and for `disabled` (one gray, like a turned-off
// button). `dark`: the background is dark, so a _dark file shows where there is one; pass
// darkLook() of what the icon sits on.
export function uiGlyph(name, { dark = false, disabled = false, size = ICON } = {}) {
  const { path, tint } = iconDraw(name, { dark, disabled });
  return (tint ? svg(path) : image(path)).size(size).flex_none();
}

// A square toolbar button drawing a named icon (ui-icons.js) at 16 pixels. The press stops
// here so a row or a draggable bar underneath doesn't also get it. The button sits on the
// panel's background (t.background), which picks the dark files.
export function iconButton(id, name, t, { title, disabled = false, active = false, busy = false, size = 24, onClick } = {}) {
  let el = div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(5)
    .text_color(disabled ? t.dim : active ? t.foreground : t.muted)
    .when(active, (el) => el.bg(t.selected))
    .when(disabled, (el) => el.opacity(0.5))
    .child(busy ? svg(icon("spinner")).size(15).spin(900) : uiGlyph(name, { dark: darkLook(t.background), disabled, size: Math.min(ICON, size - 2) }));
  if (title) el = el.tooltip(title);
  if (disabled) return el;
  return el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop)
    .on_click((e, cx) => { cx.stop_propagation(); onClick?.(e, cx); });
}

// state: true | false | "all" | "some" | "none". Three states for folders and groups.
export function checkbox(id, state, t, { disabled = false, onClick } = {}) {
  const s = state === true ? "all" : state === false ? "none" : state;
  let el = div().id(id).size(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
    .border_color(s === "none" ? t.input : t.accent)
    .when(s !== "none", (el) => el.bg(t.accent))
    .when(disabled, (el) => el.opacity(0.5))
    .when(s !== "none", (el) => el.child(svg(icon(s === "all" ? "checkbox-all" : "checkbox-some")).size(11).text_color(t.accent_foreground)));
  if (disabled) return el;
  return el.cursor_pointer().on_mouse_down("left", stop)
    .on_click((e, cx) => { cx.stop_propagation(); onClick?.(e, cx); });
}

// A text button for dialogs and forms. kind: "primary" | "plain".
export function button(id, label, t, { kind = "plain", disabled = false, busy = false, title, onClick } = {}) {
  const primary = kind === "primary";
  let el = h_flex().id(id).h(28).px(14).gap(6).flex_none().items_center().rounded(6).border_1().text_size(12.5)
    .border_color(primary && !disabled ? t.solid : t.input)
    .bg(primary && !disabled ? t.solid : t.raised)
    .text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
    .when(busy, (el) => el.child(svg(icon("spinner")).size(12).spin(900)))
    .child(label);
  if (title) el = el.tooltip(title);
  if (disabled || busy) return el;
  return el.cursor_pointer().hover((s) => s.opacity(0.88))
    .on_mouse_down("left", stop)
    .on_click((e, cx) => { cx.stop_propagation(); onClick?.(e, cx); });
}

// Centered words for an empty, loading or not-a-repository state. t: the theme.
// "Loading…" is the shared loading word: it comes out in the screen's language whichever
// way the screen spells it (the English word or t("ui.loading")).
export function notice(text, t, { busy = false } = {}) {
  const shown = text === "Loading…" ? words()("ui.loading") : text;
  return h_flex().size_full().min_h(0).items_center().justify_center().gap(8).p(16).text_color(t.dim)
    .when(busy, (el) => el.child(svg(icon("spinner")).size(14).flex_none().spin(900)))
    .child(div().min_w(0).child(shown));
}

// tr: a t (i18n.js), for a call outside the screen's own (see speakAs).
export const notRepository = (folder, tr) => words(tr)("ui.notRepository", { folder: folder || words(tr)("ui.thisFolder") });

// Text that is as tall as it needs, up to maxHeight, and scrolls past that. The area
// that scrolls is a plain overflow_y_scroll() with its bar laid over it:
// overflow_y_scrollbar() wraps its element, and the area inside the wrapper, given only
// a maximum height, grows with its text and has nothing to scroll.
export function scrollText(id, text, t, { maxHeight, color } = {}) {
  return div().relative().w_full().min_w(0)
    .child(div().id(id).w_full().max_h(maxHeight).overflow_y_scroll().text_size(12).text_color(color ?? t.ansi1).child(text))
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

// Shows the shown space's Git console tab, or opens one: the strip's link. The same tab
// view-console.js openConsole finds (a tab named Console | 콘솔 whose only pane is ours);
// written here because view-console.js imports this file.
const CONSOLE_NAMES = new Set([consoleEn["console.title"], consoleKo["console.title"]]);
function showConsole() {
  const space = spaces().find((s) => s.active);
  const ours = new Set(panes().filter((p) => p.mod === MOD).map((p) => p.tab));
  const found = space?.tabs?.find((tab) => tab.panes === 1 && ours.has(tab.id) && CONSOLE_NAMES.has(tab.name));
  if (found) run("tab.select", { id: found.id });
  else run("tab.new", { name: words()("console.title"), mod: MOD, props: { view: "console" } });
}

// git's own words under a panel or inside a dialog, with a way to dismiss them.
// What was read before stays on screen above it. "View in Console" opens the Git
// console, where a failed write's whole command and output are kept (git.js records it).
export function errorStrip(id, text, t, onDismiss) {
  return h_flex().id(id).w_full().flex_none().max_h(120).gap(8).px(10).py(6).items_start().border_t(1).border_color(t.border).bg(t.raised)
    .child(div().flex_1().min_w(0).child(scrollText(`${id}-text`, text, t, { maxHeight: 108 })))
    .child(div().id(`${id}-console`).flex_none().text_size(12).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); showConsole(); })
      .child(words()("vcs-ops.viewInConsole")))
    .when(Boolean(onDismiss), (el) => el.child(iconButton(`${id}-close`, "x", t, { title: words()("ui.dismiss"), size: 20, onClick: onDismiss })));
}

// noteBar(id, text, t, { action, onDismiss }): a one-line notice where the error strip
// goes (under a panel's body), in the ordinary text color: something that went right
// and can be taken back ("Rolled back 3 files." with Restore…). t: the theme.
//   action: { label, onClick(e, cx), busy?, disabled?, title? }: one button after the text.
//   onDismiss(e, cx): the x at the end; without it there is none.
// The screen keeps whether it shows (and drops it on the next write or a repository
// change); this only draws it.
export function noteBar(id, text, t, { action, onDismiss } = {}) {
  return h_flex().id(id).w_full().flex_none().gap(8).px(10).py(5).items_center().border_t(1).border_color(t.border).bg(t.raised).text_size(12.5)
    .child(div().flex_1().min_w(0).text_color(t.foreground).child(text))
    .when(Boolean(action), (el) => el.child(button(`${id}-action`, action.label, t, { busy: action.busy, disabled: action.disabled, title: action.title, onClick: action.onClick })))
    .when(Boolean(onDismiss), (el) => el.child(iconButton(`${id}-close`, "x", t, { title: words()("ui.dismiss"), size: 20, onClick: onDismiss })));
}

// The frame of a dialog: title and close, the body, the buttons. Esc is the screen's
// own to handle (track_focus + on_key_down on the element this returns).
export function dialogFrame(id, title, t, { body, footer = [], note, onClose } = {}) {
  return v_flex().id(id).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
      .child(iconButton(`${id}-close`, "x", t, { title: words()("ui.close"), onClick: onClose ?? (() => {}) })))
    .child(div().flex_1().min_h(0).child(body))
    .child(h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(note ?? ""))
      .children(footer));
}

export const close = (overlay) => { if (overlay) closeOverlay(overlay); };

// A framed multi-line text box around a TextareaState (make the state once, in init:
// TextareaState.new({ placeholder, rows })). The height comes from `rows` or .h().
export function textBox(id, state, t, { focused = false } = {}) {
  return div().id(id).w_full().min_w(0).px(8).py(6).rounded(6).border_1().border_color(focused ? t.accent : t.input).bg(t.background)
    .cursor_text().on_mouse_down("left", stop)
    .child(Textarea.new(state).w_full().text_size(13).text_color(t.foreground));
}

// ---- drawing lines

// A stroked path over its parent (which must be .relative()). `draw` gets a path builder
// and returns it: (p) => p.move_to(8, 0).line_to(8, 24). Coordinates are px inside the
// parent's box, or "50%" strings. This is how the commit graph draws its lanes.
export function strokePath(draw, color, width = 1.5) {
  return window.paint_path(draw(PathBuilder.stroke(width)).build(), color).absolute().top(0).left(0).size_full();
}

// ---- the windowed list

// A list that draws only the rows in view, with its own wheel handling and scroll
// thumb. Rows are ordinary elements, so a row can hold a checkbox, a chevron and its
// own click and right-click handlers (the virtual list can't).
// Keep one per list on the screen (not made in render):
//   this.list = new WindowedList("changes");
//   this.list.render(rows.length, (i) => rowFor(rows[i]), t)
// Every row must be `rowHeight` tall. Moving the selection: list.reveal(index, count).
// list.onWheel = (rows, cx) => …: called from the wheel handler for each whole row of
// wheel input, whether or not the list moved (rows > 0: down).
export class WindowedList {
  constructor(id, { rowHeight = ROW } = {}) {
    this.id = id;
    this.rowHeight = rowHeight;
    this.top = 0; // index of the first row drawn
    this.fit = 1; // whole rows that fit
    this.height = 0;
    this.wheel = 0;
    this.drag = null;
  }

  limit(count) { return Math.max(0, count - this.fit); }

  scrollTo(top, count) {
    const next = Math.max(0, Math.min(Math.round(top), this.limit(count)));
    const moved = next !== this.top;
    this.top = next;
    return moved;
  }

  scrollBy(rows, count) { return this.scrollTo(this.top + rows, count); }

  // Scrolls just enough to show a row (for arrow keys).
  reveal(index, count) {
    if (index < 0) return false;
    if (index < this.top) return this.scrollTo(index, count);
    if (index >= this.top + this.fit) return this.scrollTo(index - this.fit + 1, count);
    return false;
  }

  // True when the last rows are in view: time to read the next batch.
  nearEnd(count, margin = 50) { return this.top + this.fit + margin >= count; }

  render(count, renderRow, t) {
    const h = this.rowHeight;
    this.top = Math.max(0, Math.min(this.top, this.limit(count)));
    // One extra row fills the part-row gap at the bottom; the box clips it.
    const shown = Math.max(0, Math.min(count - this.top, this.fit + 1));
    const rows = [];
    for (let i = 0; i < shown; i++) rows.push(renderRow(this.top + i));
    const scrolls = count > this.fit && this.height > 0;
    const thumb = scrolls ? Math.max(24, (this.height * this.fit) / count) : 0;
    const travel = Math.max(1, this.height - thumb), limit = Math.max(1, this.limit(count));
    return div().id(this.id).relative().size_full().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        const fit = Math.max(1, Math.floor(size.height / h));
        if (fit === this.fit && size.height === this.height) return;
        this.fit = fit; this.height = size.height;
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        // Pixels from touchpads and wheels alike; rows move once a full row has built up.
        this.wheel -= e.delta.y;
        const steps = Math.trunc(this.wheel / h);
        if (!steps) return;
        this.wheel -= steps * h;
        if (this.scrollBy(steps, count)) cx.notify();
        // Told even when the list can't move (at its end): the owner may read on.
        this.onWheel?.(steps, cx);
      })
      // The thumb is dragged from the whole list's box: moves only arrive while hovered,
      // and a release outside the box never arrives. A move event doesn't say whether the
      // button is still down, so the drag ends at the release here or at the next press
      // anywhere (in the box but off the thumb, or outside it).
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        if (this.scrollTo(this.drag.top + ((e.position.y - this.drag.y) * limit) / travel, count)) cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_mouse_down("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_mouse_down_out((_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .child(v_flex().w_full().children(rows))
      .when(scrolls, (el) => el.child(
        div().id(`${this.id}-thumb`).absolute().right(1).w(6).rounded(3).h(thumb).top((travel * this.top) / limit)
          .bg(this.drag ? t.muted : t.border).hover((s) => s.bg(t.muted))
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { y: e.position.y, top: this.top }; cx.notify(); })));
  }
}
