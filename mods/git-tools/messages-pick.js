// The words of Cherry-Pick, Revert Commit and the file-level Revert Selected Changes and
// Cherry-Pick Selected Changes: their notifications, the reasons the items are off, the
// write lock's work names and the sentences of git-operation.js and git-changes.js
// (i18n.js). Keys start with "pick.".

export const en = {
  "pick.busy": "Another operation is in progress: finish or abort it first.",
  "pick.noCommits": "No commits to apply.",
  "pick.noFiles": "No files selected.",
  "pick.mergeCommit": "Merge commits can't be applied this way",
  "pick.inBranch": "Commit {hash} is already in the current branch",
  "pick.picking": "Cherry-picking…",
  "pick.reverting": "Reverting…",
  "pick.revertingChanges": "Reverting selected changes…",
  "pick.pickingChanges": "Cherry-picking selected changes…",
  "pick.revertDone": "Revert successful",
  "pick.nothingTitle": "Nothing to cherry-pick",
  "pick.nothingBody": "All changes from {hash} have already been applied",
  "pick.nothingToRevert": "Nothing to revert",
  "pick.nothingToRevertBody": "The selected files are already as they were before {hash}",
};

export const ko = {
  "pick.busy": "다른 작업이 진행 중입니다. 먼저 끝내거나 중단하세요.",
  "pick.noCommits": "적용할 커밋이 없습니다.",
  "pick.noFiles": "선택한 파일이 없습니다.",
  "pick.mergeCommit": "병합 커밋은 이 방법으로 적용할 수 없습니다",
  "pick.inBranch": "커밋 {hash}이(가) 이미 현재 브랜치에 있습니다",
  "pick.picking": "Cherry-Pick 중…",
  "pick.reverting": "되돌리는 중…",
  "pick.revertingChanges": "선택한 변경 내용 되돌리는 중…",
  "pick.pickingChanges": "선택한 변경 내용 체리픽 중…",
  "pick.revertDone": "Revert에 성공했습니다",
  "pick.nothingTitle": "cherry-pick할 항목이 없습니다",
  "pick.nothingBody": "{hash}의 모든 변경 내용이 이미 적용되었습니다",
  "pick.nothingToRevert": "되돌릴 항목이 없습니다",
  "pick.nothingToRevertBody": "선택한 파일이 이미 {hash} 이전과 같습니다",
};
