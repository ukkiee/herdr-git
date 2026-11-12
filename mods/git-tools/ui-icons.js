// Button and menu icons: a name a screen uses → the file it draws, whether the file's own
// colors show, and whether a dark-background variant exists. Pure: no `herdr`, tested by
// ui-icons.test.mjs. ui.js does the drawing.
//
// The files are the source set's bytes under icons/ui/ (see its NOTICE.md), at their path
// in the source. Three are the mod's own line icons under icons/ and stay as they are: the
// busy spinner and the two checkbox marks.
//
// Gotchas:
// - svg() paints a file as a mask in the text color; only image() shows its colors. A screen
//   that calls svg(icon(name)) gets the shape in its text color whatever the table says.
// - A colored file has fixed colors, so it does not brighten on hover like a tinted one.
// - Most files have no _dark variant; the light file is used on dark backgrounds too.

const UI = "mods/git-tools/icons/ui/";
const OWN = "mods/git-tools/icons/";

// file: path under icons/ui/ (or the own file's name under icons/). tint: drawn in the text
// color (gray in the reference screen, or the mod's own mark). dark: a _dark file sits beside it.
const own = (file) => ({ file, own: true, tint: true });
const color = (file, extra) => ({ file, ...extra });
const tint = (file) => ({ file, tint: true });
const D = { dark: true };

export const UI_ICONS = {
  // In use on the panels and dialogs.
  "refresh": color("icons/expui/general/refresh.svg"),
  "fetch": color("icons/expui/vcs/fetch.svg"),
  "plus": color("icons/expui/general/add.svg"),
  "branch-delete": color("icons/expui/general/delete.svg"),
  // The mod's own Restore (a Rollback snapshot, a deleted branch): no reference icon, the
  // history clock is the nearest.
  "restore": color("icons/expui/general/history.svg", D),
  "rollback": color("icons/expui/vcs/revert.svg"),
  "diff": color("icons/expui/vcs/diff.svg"),
  "eye": color("icons/expui/general/show.svg"),
  "panel-bottom": color("icons/expui/toolwindows/vcs.svg"),
  "expand-all": color("icons/expui/general/expandAll.svg"),
  "collapse-all": color("icons/expui/general/collapseAll.svg"),
  "regex": color("icons/expui/inline/regex.svg"),
  "case-sensitive": color("icons/expui/inline/matchCase.svg"),
  // Clear all filters: no reference icon, the filter funnel is the nearest.
  "filter-x": color("icons/expui/general/filter.svg"),
  "x": color("icons/expui/general/closeSmall.svg"),
  // A menu item's check mark: in the item's text color, like the reference menus.
  "check": tint("icons/expui/actions/checked.svg"),
  "branch-item": color("icons/expui/general/vcs.svg"),
  "search": tint("icons/expui/general/search.svg"),
  "chevron-down": tint("icons/expui/general/chevronDown.svg"),
  "chevron-right": tint("icons/expui/general/chevronRight.svg"),
  // A filter button's dropdown arrow: the tree arrow's file, in its colors.
  "dropdown": color("icons/expui/general/chevronDown.svg"),
  "folder": tint("glyphs/expui/nodes/folder.svg"),
  "spinner": own("spinner.svg"),
  "checkbox-all": own("checkbox-all.svg"),
  "checkbox-some": own("checkbox-some.svg"),

  // For the git actions and their screens. Rebase has no icon: the reference shows none and
  // the source set has no near shape.
  "cherry-pick": color("icons/expui/vcs/new/cherryPick.svg"),
  "revert": color("icons/expui/vcs/revert.svg"),
  "reset": color("icons/expui/vcs/revert.svg"),
  "revert-selected": color("icons/expui/vcs/revert.svg"),
  "stash": color("icons/expui/vcs/stash.svg"),
  "unstash": color("icons/expui/vcs/unshelve.svg", D),
  "merge": color("icons/expui/vcs/merge.svg"),
  "open-conflicts": color("icons/expui/vcs/merge.svg"),
  "pull": color("icons/expui/vcs/new/incomingUpdate.svg"),
  "update": color("icons/expui/vcs/update.svg"),
  "push": color("icons/expui/vcs/push.svg"),
  "commit": color("icons/expui/vcs/commit.svg"),
  "compare": color("icons/expui/vcs/diff.svg"),
  "show-diff": color("icons/expui/vcs/diff.svg"),
  "patch": color("icons/expui/vcs/patch.svg"),
  "copy": color("icons/expui/general/copy.svg", D),
  "history": color("icons/expui/general/history.svg", D),
  "locate": color("icons/expui/general/locate.svg", D),
  "go-to-hash": color("icons/expui/general/search.svg"),
  "graph-options": color("icons/expui/vcs/intelliSort.svg"),
  "layout": color("icons/expui/general/layout.svg"),
  "hide-branches": color("icons/expui/general/chevronLeft.svg"),
  "settings": color("icons/expui/general/moreVertical.svg"),
  "branch-settings": color("icons/expui/general/settings.svg", D),
  "close": color("icons/expui/general/close.svg"),
  "continue": color("icons/expui/vcs/new/resolveContinue.svg"),
  "abort": color("icons/expui/vcs/abort.svg"),
  "skip": color("icons/expui/vcs/new/skipCommit.svg"),
  "resume-indexing": color("icons/expui/progress/resume.svg"),
  "conflict-apply": color("icons/expui/diff/arrow@14x14.svg", D),
  "conflict-ignore": color("icons/expui/diff/remove@14x14.svg", D),
  "apply-non-conflicts": color("icons/expui/diff/applyNotConflicts.svg"),
  "magic-resolve": color("icons/expui/diff/magicResolveToolbar.svg"),
  "current-branch": color("icons/expui/vcs/new/currentBranchLabel.svg"),
  "current-branch-favorite": color("icons/expui/vcs/new/currentBranchFavoriteLabel.svg"),
  "tag": color("icons/expui/vcs/new/branchLabel.svg"),
  "favorite": color("glyphs/expui/nodes/star.svg", D),
  "favorite-hover": color("glyphs/expui/nodes/starEmpty.svg"),
};

function entry(name) {
  const e = UI_ICONS[name];
  if (!e) throw new Error(`git-tools: no icon named "${name}"`);
  return e;
}

const lightPath = (e) => (e.own ? OWN : UI) + e.file;

// The file whose shape a tinted svg() draws: always the light one.
export const iconShape = (name) => lightPath(entry(name));

// How to draw `name`: { path, tint }. tint: paint the shape in the text color (svg()),
// else show the file's colors (image()). `dark`: the background is dark (ui.js darkLook).
// `disabled`: a turned-off button, the same shape in one gray.
export function iconDraw(name, { dark = false, disabled = false } = {}) {
  const e = entry(name);
  if (e.tint || disabled) return { path: lightPath(e), tint: true };
  return { path: dark && e.dark ? UI + e.file.replace(/\.svg$/, "_dark.svg") : lightPath(e), tint: false };
}
