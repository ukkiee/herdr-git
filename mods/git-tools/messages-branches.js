// The words of deleting a branch and restoring it: the Log panel's notice, the Deleted
// Branches dialog and its Branch tree button, and the results git-branch.js words
// (i18n.js). Keys start with "branches.".

export const en = {
  "branches.deleted": "Deleted branch '{name}' ({hash}).",
  "branches.restore": "Restore",
  "branches.unknownCommit": "Branch '{name}' can't be restored: its commit isn't known.",
  "branches.notRecorded": "Branch '{name}' was not deleted: it couldn't be recorded to restore later. {err}",
  "branches.checkedOutElsewhere": "Cannot delete branch '{name}': it is checked out in the worktree at {path}.",
  "branches.nameTaken": "a branch of this name exists now at another commit",
  "branches.skipExists": "a branch of this name exists now",
  "branches.notAllRestored": { one: "Restored 1 branch. Not restored:\n{list}", other: "Restored {n} branches. Not restored:\n{list}" },
  "branches.notAllUpstream": { one: "Restored 1 branch. Restored without their upstream:\n{untracked}", other: "Restored {n} branches. Restored without their upstream:\n{untracked}" },
  "branches.notAllRestoredUpstream": { one: "Restored 1 branch. Not restored:\n{list}\nRestored without their upstream:\n{untracked}", other: "Restored {n} branches. Not restored:\n{list}\nRestored without their upstream:\n{untracked}" },
  "branches.openDeleted": "Deleted Branches…",
  "branches.dialogTitle": "Deleted Branches",
  "branches.keptNote": "Deleted branches are kept for about 30 days.",
  "branches.noneKept": "No deleted branches are kept in this repository.",
  "branches.checked": { one: "1 branch checked", other: "{n} branches checked" },
  "branches.noneChecked": "No branches checked",
  "branches.restoring": "Restoring branches…",
  "branches.restored": { one: "Restored 1 branch.", other: "Restored {n} branches." },
};

export const ko = {
  "branches.deleted": "삭제된 브랜치: '{name}' ({hash})",
  "branches.restore": "복원",
  "branches.unknownCommit": "브랜치 '{name}'을(를) 복원할 수 없습니다: 커밋을 알 수 없습니다.",
  "branches.notRecorded": "브랜치 '{name}'을(를) 삭제하지 않았습니다: 나중에 복원할 수 있게 기록하지 못했습니다. {err}",
  "branches.checkedOutElsewhere": "브랜치 '{name}'을(를) 삭제할 수 없습니다: {path}의 worktree에서 체크아웃되어 있습니다.",
  "branches.nameTaken": "같은 이름의 브랜치가 지금 다른 커밋에 있습니다",
  "branches.skipExists": "같은 이름의 브랜치가 지금 있습니다",
  "branches.notAllRestored": "브랜치 {n}개를 복원했습니다. 복원하지 않은 브랜치:\n{list}",
  "branches.notAllUpstream": "브랜치 {n}개를 복원했습니다. 추적 브랜치는 되돌리지 못한 브랜치:\n{untracked}",
  "branches.notAllRestoredUpstream": "브랜치 {n}개를 복원했습니다. 복원하지 않은 브랜치:\n{list}\n추적 브랜치는 되돌리지 못한 브랜치:\n{untracked}",
  "branches.openDeleted": "삭제된 브랜치…",
  "branches.dialogTitle": "삭제된 브랜치",
  "branches.keptNote": "삭제된 브랜치는 약 30일 동안 보관됩니다.",
  "branches.noneKept": "이 저장소에 보관된 삭제된 브랜치가 없습니다.",
  "branches.checked": "브랜치 {n}개 선택됨",
  "branches.noneChecked": "선택한 브랜치 없음",
  "branches.restoring": "브랜치 복원 중…",
  "branches.restored": "브랜치 {n}개를 복원했습니다.",
};
