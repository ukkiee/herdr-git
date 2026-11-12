// The words of deleting a branch and restoring it: the Log panel's notice and the
// results git-branch.js words (i18n.js). Keys start with "branches.".

export const en = {
  "branches.deleted": "Deleted branch '{name}' ({hash}).",
  "branches.restore": "Restore",
  "branches.unknownCommit": "Branch '{name}' can't be restored: its commit isn't known.",
  "branches.notRecorded": "Branch '{name}' was not deleted: it couldn't be recorded to restore later. {err}",
  "branches.nameTaken": "a branch of this name exists now at another commit",
  "branches.skipExists": "a branch of this name exists now",
  "branches.notAllRestored": { one: "Restored 1 branch. Not restored:\n{list}", other: "Restored {n} branches. Not restored:\n{list}" },
};

export const ko = {
  "branches.deleted": "삭제된 브랜치: '{name}' ({hash})",
  "branches.restore": "복원",
  "branches.unknownCommit": "브랜치 '{name}'을(를) 복원할 수 없습니다: 커밋을 알 수 없습니다.",
  "branches.notRecorded": "브랜치 '{name}'을(를) 삭제하지 않았습니다: 나중에 복원할 수 있게 기록하지 못했습니다. {err}",
  "branches.nameTaken": "같은 이름의 브랜치가 지금 다른 커밋에 있습니다",
  "branches.skipExists": "같은 이름의 브랜치가 지금 있습니다",
  "branches.notAllRestored": "브랜치 {n}개를 복원했습니다. 복원하지 않은 브랜치:\n{list}",
};
