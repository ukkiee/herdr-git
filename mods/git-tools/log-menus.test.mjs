// node log-menus.test.mjs: the Log panel's menus and toolbars from one model (no app, no git).
import assert from "node:assert/strict";
import { MENUS, menuItems } from "./log-menus.js";
import { translator } from "./i18n.js";

const en = translator("en"), ko = translator("ko");
const everything = () => true;

// A menu as the person reads it: one name per item, "─" where a separator line is drawn.
const look = (items, t = ko) => items.flatMap((it) => [...(it.rule ? ["─"] : []), t(it.key, it.args)]);
const all = (name, ctx = {}, t = ko) => look(menuItems(name, everything, ctx), t);

// The commit row's menu, every item handled: the Korean names and their order
// (one commit picked, the current branch main).
{
  assert.deepEqual(all("commit", { count: 1, current: "main" }), [
    "리비전 번호 복사", "패치 생성…", "Cherry-Pick", "─",
    "리비전 체크아웃", "리비전에서 저장소를 표시합니다", "로컬과 비교", "─",
    "현재 브랜치를 여기로 재설정…", "커밋 되돌리기", "커밋 실행 취소…", "─",
    "커밋 메시지 편집…", "픽스업…", "다음으로 스쿼시…", "커밋 삭제", "여기부터 대화식으로 리베이스…", "여기까지의 내용을 모두 푸시…", "─",
    "'main'을(를) 선택된 커밋으로 리베이스", "새 브랜치…", "새 태그…", "─",
    "하위 커밋으로 이동", "상위 커밋으로 이동",
  ]);
  // Two commits: Compare Versions takes Compare with Local's place, Squash Commits… shows.
  const two = all("commit", { count: 2, current: "main" });
  assert.ok(two.includes("버전 비교") && !two.includes("로컬과 비교"));
  assert.deepEqual(two.slice(12, 18), ["커밋 메시지 편집…", "픽스업…", "다음으로 스쿼시…", "커밋 삭제", "커밋 스쿼시…", "여기부터 대화식으로 리베이스…"]);
  // Three: neither comparison.
  const three = all("commit", { count: 3, current: "main" });
  assert.ok(!three.includes("버전 비교") && !three.includes("로컬과 비교"));
  // English names; Drop Commit follows the count.
  const one = all("commit", { count: 1, current: "main" }, en);
  assert.deepEqual(one.slice(0, 4), ["Copy Revision Number", "Create Patch…", "Cherry-Pick", "─"]);
  assert.ok(one.includes("Drop Commit") && one.includes("Rebase 'main' onto Selected Commit") && one.includes("Push All up to Here…"));
  assert.ok(all("commit", { count: 2, current: "main" }, en).includes("Drop Commits"));
}

// Commit details: its file menu and its toolbar.
{
  assert.deepEqual(all("file"), [
    "Diff 표시", "새 탭에 Diff 표시", "로컬과 비교", "로컬과 이전 버전 비교", "소스 편집", "저장소 버전 열기", "─",
    "선택한 변경 내용 되돌리기", "선택한 변경 내용 체리픽", "선택된 변경 사항을 별도의 커밋으로 추출…", "선택된 변경 사항 삭제",
    "패치 생성…", "리비전에서 가져오기", "여기까지의 기록", "상위 항목에 대한 변경 내용 표시",
  ]);
  assert.deepEqual(all("detailsTools"), ["Diff 표시", "선택한 변경 내용 되돌리기", "여기까지의 기록", "옵션 표시", "모두 펼치기", "모두 접기"]);
}

// The Branch tree: a menu per kind of row, the vertical toolbar, a remote's folder.
{
  const ctx = { name: "feature", current: "main", upstream: "origin/main" };
  assert.deepEqual(all("localBranch", ctx), [
    "체크아웃", "'feature'에서 새 브랜치…", "체크아웃하고 'main'에 리베이스", "체크아웃 후 업데이트", "─",
    "'main'와(과) 비교", "작업 트리로 차이점 표시", "─",
    "'main'를 'feature'으로 리베이스", "'main'에 'feature' 병합", "─",
    "'feature'(으)로부터 새 워크트리…", "─",
    "업데이트", "푸시…", "─",
    "이름 변경…", "삭제",
  ]);
  assert.deepEqual(all("currentBranch", { name: "main", current: "main", upstream: "origin/main" }), [
    "'main'에서 새 브랜치…", "─", "작업 트리로 차이점 표시", "─", "'main'(으)로부터 새 워크트리…", "─",
    "업데이트", "푸시…", "추적된 브랜치 'origin/main'", "─", "이름 변경…",
  ]);
  // A current branch that tracks nothing has no Tracked Branch item.
  assert.ok(!all("currentBranch", { name: "main", current: "main" }).some((s) => s.startsWith("추적된 브랜치")));
  // The HEAD row: the current branch's menu without its tracked branch.
  assert.deepEqual(all("headBranch", { name: "main", current: "main" }), [
    "'main'에서 새 브랜치…", "─", "작업 트리로 차이점 표시", "─", "'main'(으)로부터 새 워크트리…", "─",
    "업데이트", "푸시…", "─", "이름 변경…",
  ]);
  assert.deepEqual(all("remoteBranch", { name: "origin/main", current: "main" }), [
    "체크아웃", "'origin/main'에서 새 브랜치…", "체크아웃하고 'main'에 리베이스", "─",
    "'main'와(과) 비교", "작업 트리로 차이점 표시", "─",
    "'main'를 'origin/main'으로 리베이스", "'main'에 'origin/main' 병합", "─",
    "'origin/main'(으)로부터 새 워크트리…", "─",
    "리베이스를 사용하여 'main'(으)로 풀 처리", "병합을 사용하여 'main'(으)로 풀 처리", "─",
    "삭제",
  ]);
  assert.deepEqual(all("remoteFolder"), ["원격 편집", "원격 제거"]);
  assert.deepEqual(all("branchTools", { name: "feature" }), [
    "Git 브랜치 숨기기", "새 브랜치…", "선택된 항목을 업데이트", "'feature' 삭제", "삭제된 브랜치…", "현재 브랜치와 비교",
    "내 브랜치 표시", "페치", "즐겨찾기로 표시/표시 해제", "선택한 브랜치 HEAD로 로그를 이동", "브랜치 패널 설정", "─",
    "모두 펼치기", "모두 접기",
  ]);
}

// The Log toolbar right of the filter row; Regex and Match Case sit in the search box.
{
  assert.deepEqual(all("logTools"), ["그래프 옵션", "새로고침", "페치", "Cherry-Pick", "옵션 표시", "해시/브랜치/태그로 이동", "숨기기"]);
  assert.deepEqual(all("logSearch"), ["정규식", "대/소문자 구분"]);
  // A Log tab on a chosen folder has nothing to hide.
  assert.ok(!all("logTools", { fixed: true }).includes("숨기기"));
}

// Every name in the model is in both languages' tables.
{
  for (const name of Object.keys(MENUS)) {
    for (const it of menuItems(name, everything, { count: 2, name: "x", current: "y", upstream: "z" })) {
      assert.notEqual(en(it.key, it.args), it.key, `${name}: ${it.id} has an English name`);
      assert.notEqual(ko(it.key, it.args), it.key, `${name}: ${it.id} has a Korean name`);
    }
  }
}

// An item with nothing registered to do it doesn't show, and no separator is left over:
// none first, none last, never two in a row.
{
  const handled = new Set(["commit.copyRevision", "commit.checkoutRevision", "commit.newBranch"]);
  assert.deepEqual(look(menuItems("commit", handled, { count: 1 })), ["리비전 번호 복사", "─", "리비전 체크아웃", "─", "새 브랜치…"]);
  // Only items from the middle of the menu: no separator before the first.
  assert.deepEqual(look(menuItems("commit", new Set(["commit.revert", "commit.newTag"]), { count: 1 })), ["커밋 되돌리기", "─", "새 태그…"]);
  assert.deepEqual(look(menuItems("commit", new Set(["commit.goToParent"]), { count: 1 })), ["상위 커밋으로 이동"]);
  assert.deepEqual(menuItems("commit", new Set(), { count: 1 }), []);
  // A function works as well as a set.
  assert.deepEqual(look(menuItems("localBranch", (id) => id === "branch.checkout" || id === "branch.delete", { name: "f" })), ["체크아웃", "─", "삭제"]);
  // An item registered but not shown for this selection takes no separator with it.
  assert.deepEqual(look(menuItems("commit", new Set(["commit.compareWithLocal", "commit.revert"]), { count: 3 })), ["커밋 되돌리기"]);
  // The rule sits on the first item after it, for the screen's menu (ui.js openMenu).
  const items = menuItems("commit", handled, { count: 1 });
  assert.deepEqual(items.map((it) => [it.id, it.rule]), [["commit.copyRevision", false], ["commit.checkoutRevision", true], ["commit.newBranch", true]]);
}

// Why an item is off: the reason goes with it (shown on hover), the item stays in place.
{
  const reason = (name, id, ctx) => {
    const it = menuItems(name, everything, ctx).find((x) => x.id === id);
    return it.disabled ? (it.why.text ?? ko(it.why.key, it.why.args)) : null;
  };
  const busy = "다른 git 작업이 실행 중입니다: 커밋 중…";
  // A git write running on the repository stops every item that writes, with its words.
  assert.equal(reason("commit", "commit.checkoutRevision", { count: 1, writing: busy }), busy);
  assert.equal(reason("commit", "commit.newBranch", { count: 1, writing: busy }), busy);
  assert.equal(reason("commit", "commit.copyRevision", { count: 1, writing: busy }), null);
  // Checkout Revision and New Branch… work on one commit.
  assert.equal(reason("commit", "commit.checkoutRevision", { count: 2 }), "커밋을 하나만 선택하세요");
  assert.equal(reason("commit", "commit.newBranch", { count: 2 }), "커밋을 하나만 선택하세요");
  assert.equal(reason("commit", "commit.checkoutRevision", { count: 1 }), null);
  // The Branch tree's Delete says why before saying a write runs.
  assert.equal(reason("localBranch", "branch.delete", { name: "f", deleteBlock: "현재 브랜치는 삭제할 수 없습니다", writing: busy }), "현재 브랜치는 삭제할 수 없습니다");
  assert.equal(reason("localBranch", "branch.delete", { name: "f", writing: busy }), busy);
  assert.equal(reason("remoteBranch", "branch.delete", { name: "origin/f", deleteBlock: "여기서는 원격 브랜치를 삭제할 수 없습니다" }), "여기서는 원격 브랜치를 삭제할 수 없습니다");
  assert.equal(reason("localBranch", "branch.checkout", { name: "f", writing: busy }), busy);
  assert.equal(reason("localBranch", "branch.newFrom", { name: "f", writing: busy }), busy);
  assert.equal(reason("localBranch", "branch.newFrom", { name: "f" }), null);
  // The toolbar: New Branch and Deleted Branches wait for the branches to be read; Fetch for the lock.
  assert.equal(reason("branchTools", "branches.new", { loaded: false }), "");
  assert.equal(reason("branchTools", "branches.new", { loaded: true, writing: busy }), busy);
  assert.equal(reason("branchTools", "branches.deleted", { loaded: false }), "");
  assert.equal(reason("branchTools", "branches.deleted", { loaded: true, writing: busy }), null);
  assert.equal(reason("branchTools", "branches.delete", { loaded: true, deleteBlock: "삭제할 로컬 브랜치 선택" }), "삭제할 로컬 브랜치 선택");
  assert.equal(reason("branchTools", "branches.fetch", { writing: busy }), busy);
  assert.equal(reason("logTools", "log.fetch", { writing: busy }), busy);
  assert.equal(reason("logTools", "log.refresh", { writing: busy }), null);
  assert.equal(reason("branchTools", "branches.expandAll", { writing: busy }), null);
  // Commit details' Expand All and Collapse All wait for files to show.
  assert.equal(reason("detailsTools", "details.expandAll", { loaded: false }), "");
  assert.equal(reason("detailsTools", "details.collapseAll", { loaded: true, writing: busy }), null);
  // An item off for no reason worth words (nothing read yet) has an empty text, not a key.
  const off = menuItems("branchTools", everything, { loaded: false }).find((x) => x.id === "branches.new");
  assert.deepEqual([off.disabled, off.why], [true, { text: "" }]);
  // The work a toolbar button spins for while it runs.
  assert.equal(menuItems("branchTools", everything, {}).find((x) => x.id === "branches.fetch").work, "log.fetching");
}

// The key an item has in the Commit list shows on its right: ← goes to the child commit,
// → to the parent. Items without a key carry none.
{
  const hints = Object.fromEntries(menuItems("commit", everything, { count: 1, current: "main" }).map((x) => [x.id, x.hint]));
  assert.equal(hints["commit.goToChild"], "←");
  assert.equal(hints["commit.goToParent"], "→");
  assert.equal(hints["commit.revert"], null);
}

// The history edits: off with the edit check's reason (rebase-plan.js editCheck) when the
// menu has the edit facts (ctx.edit, git-rewrite.js readEditFacts), else on the number of
// commits picked alone; off while a git write runs.
{
  const reason = (id, ctx) => {
    const it = menuItems("commit", everything, ctx).find((x) => x.id === id);
    return it.disabled ? (it.why.text ?? ko(it.why.key, it.why.args)) : null;
  };
  const H = "a".repeat(40), P = "b".repeat(40);
  const facts = (more = {}) => ({ head: H, operation: null, protected: null, mergeAbove: false, commits: [{ hash: H, parents: 1, onBranch: true, pushedProtected: false }], ...more });
  const pushed = facts({ protected: "origin/main", commits: [{ hash: H, parents: 1, onBranch: true, pushedProtected: true }] });
  for (const id of ["commit.undo", "commit.editMessage", "commit.drop"]) {
    assert.equal(reason(id, { count: 1, edit: facts() }), null, id);
    assert.equal(reason(id, { count: 1, edit: pushed }), "현재 브랜치의 커밋이 이미 보호된 브랜치 origin/main에 푸시되었습니다", id);
    assert.equal(reason(id, { count: 1, writing: "busy" }), "busy", id);
  }
  assert.equal(reason("commit.undo", { count: 1, edit: facts({ head: P }) }), "선택한 커밋이 현재 브랜치의 마지막 커밋이 아닙니다");
  assert.equal(reason("commit.editMessage", { count: 2 }), "커밋을 하나만 선택하세요");
  assert.equal(reason("commit.drop", { count: 2 }), null);
  assert.equal(reason("commit.squash", { count: 2 }), null);
  assert.equal(reason("commit.squash", { count: 2, edit: facts({ operation: "merge", commits: [facts().commits[0], { hash: P, parents: 1, onBranch: true, pushedProtected: false }] }) }), "병합 중에는 커밋을 편집할 수 없습니다");
  assert.equal(menuItems("commit", everything, { count: 1 }).some((x) => x.id === "commit.squash"), false);
}

console.log("ok");
