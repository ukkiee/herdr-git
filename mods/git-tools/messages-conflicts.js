// The words of conflict resolution (i18n.js): the sentences git-conflict.js writes itself
// and the Conflicts dialog's (view-conflicts.js, conflicts-model.js). Keys start with
// "conflicts.".

export const en = {
  "conflicts.notConflicted": "{path} is not in conflict.",
  "conflicts.cannotUnresolve": "Couldn't undo the resolution of {path}: git has no record of its conflict.",
  "conflicts.writeFailed": "Couldn't write {path}: {err}",
  "conflicts.unknownSide": "Unknown side: {side}.",

  "conflicts.title": "Conflicts",
  "conflicts.headMerge": "Merging branch {from} into branch {into}",
  "conflicts.headRebase": "Rebasing branch {branch} onto branch {onto}",
  "conflicts.headCurrent": "Current commit {hash} made by {author}:",
  "conflicts.headCherryPick": "Conflicts during cherry-picking commit {hash} made by {author}",
  "conflicts.headRevert": "Conflicts during reverting commit {hash} made by {author}",
  "conflicts.headUnstash": "Conflicts during unstashing {stash}",
  "conflicts.headDefault": "The following files have conflicts:",
  "conflicts.yours": "Yours",
  "conflicts.yoursOn": "Yours ({name})",
  "conflicts.theirs": "Theirs",
  "conflicts.theirsOn": "Theirs ({name})",
};

export const ko = {
  "conflicts.notConflicted": "{path}에 충돌이 없습니다.",
  "conflicts.cannotUnresolve": "{path}의 충돌 해결을 되돌릴 수 없습니다: git에 이 파일의 충돌 기록이 없습니다.",
  "conflicts.writeFailed": "{path}을(를) 쓰지 못했습니다: {err}",
  "conflicts.unknownSide": "알 수 없는 쪽입니다: {side}.",

  "conflicts.title": "충돌",
  "conflicts.headMerge": "브랜치 {from}을(를) 브랜치 {into}에 병합합니다",
  "conflicts.headRebase": "브랜치 {onto}에 브랜치 {branch} 리베이스하는 중",
  "conflicts.headCurrent": "{author}이(가) 작성한 현재 커밋 {hash}:",
  "conflicts.headCherryPick": "{author} 님이 작성한 커밋 {hash}을(를) cherry-pick하는 동안 충돌이 발생했습니다",
  "conflicts.headRevert": "{author} 님이 작성한 커밋 {hash}을(를) 되돌리는 동안 충돌이 발생했습니다",
  "conflicts.headUnstash": "{stash}을(를) 스태시 취소하는 동안 충돌이 발생했습니다",
  "conflicts.headDefault": "다음 파일에 충돌이 있습니다:",
  "conflicts.yours": "내 변경 내용",
  "conflicts.yoursOn": "내 변경 내용({name})",
  "conflicts.theirs": "다른 이의 변경 내용",
  "conflicts.theirsOn": "다른 이의 변경 내용({name})",
};
