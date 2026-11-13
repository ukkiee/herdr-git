// The words of pull, branch update and Update Project: the Pull dialog, the Update
// Project dialog, the Update Info tab, their notifications and git-remote.js's sentences
// (i18n.js). Keys start with "remote.".

export const en = {
  // git-remote.js
  "remote.pickBranch": "Choose a remote and a branch to pull.",
  "remote.detached": "HEAD is detached: there is no branch to update.",
  "remote.noTracked": "The branch '{name}' has no tracked branch.",
  "remote.diverged": "'{name}' and '{upstream}' have diverged: it can only move forward.",
  "remote.trackedGone": "The tracked branch '{name}' is not there.",
  // A fetch that failed: the remote may want a password nobody can type here.
  "remote.credentialHint": "If the remote asks for a password or passphrase, set up a credential helper or an SSH agent: there is nowhere here to type one.",

  // The lock's work, while a request runs.
  "remote.pulling": "Pulling…",
  "remote.updating": "Updating…",
  "remote.resetting": "Resetting to the remote branch…",

  // Notifications
  "remote.failed": "Update failed",
  "remote.pullFailed": "Pull failed",
  "remote.notUpdated": "Not updated",
  "remote.nothing": "Nothing to update",
  "remote.stoppedBody": "{op}: resolve the conflicts, then continue.",
  "remote.branchSaid": "{name}: {text}",

  // Pull dialog
  "remote.pullTitle": "Pull to {branch}",
  "remote.pullButton": "Pull",
  "remote.modifyOptions": "Modify options",
  "remote.optRebase": "Rebase the current branch on top of incoming changes",
  "remote.optFfOnly": "Merge only if fast-forward is possible",
  "remote.optNoFf": "Create a merge commit even if fast-forward is possible",
  "remote.optSquash": "Create a single commit for all pulled changes",
  "remote.optNoCommit": "Merge without committing the result",
  "remote.optNoVerify": "Bypass pre-merge and commit message hooks",
  "remote.noRemotes": "This repository has no remote branches. Fetch first, or add a remote.",
  "remote.reading": "Reading the remotes…",

  // Update Project dialog
  "remote.updateTitle": "Update Project",
  "remote.methodMerge": "Merge incoming changes into the current branch",
  "remote.methodRebase": "Rebase the current branch on top of incoming changes",
  "remote.dontShow": "Don't show again",
  "remote.resetToRemote": "Reset to the Remote Branch",
  "remote.resetAsk": "Do you want to reset local branch {name} to {upstream}? Local commits will be dropped.",
  "remote.resetButton": "Reset",
  "remote.ok": "OK",

  // Update Info tab
  "remote.infoTab": "Update Info",
  "remote.infoSummary": "{files} file(s) updated in {commits} commit(s)",
  "remote.infoEmpty": "No commits came in.",
};

export const ko = {
  "remote.pickBranch": "풀할 원격과 브랜치를 고르세요.",
  "remote.detached": "HEAD가 분리되어 업데이트할 브랜치가 없습니다.",
  "remote.noTracked": "브랜치 '{name}'에 추적 브랜치가 없습니다.",
  "remote.diverged": "'{name}'와(과) '{upstream}'이(가) 갈라졌습니다. 빨리 감기로만 옮길 수 있습니다.",
  "remote.trackedGone": "추적 브랜치 '{name}'이(가) 없습니다.",
  "remote.credentialHint": "원격이 비밀번호나 passphrase를 묻는다면 credential helper나 SSH agent를 설정하세요. 여기에는 입력할 곳이 없습니다.",

  "remote.pulling": "풀 처리 중…",
  "remote.updating": "업데이트 중…",
  "remote.resetting": "원격 브랜치로 재설정 중…",

  "remote.failed": "업데이트 실패",
  "remote.pullFailed": "풀 실패",
  "remote.notUpdated": "업데이트하지 않음",
  "remote.nothing": "업데이트할 항목이 없습니다",
  "remote.stoppedBody": "{op}: 충돌을 해결한 뒤 계속하세요.",
  "remote.branchSaid": "{name}: {text}",

  "remote.pullTitle": "{branch}(으)로 풀",
  "remote.pullButton": "풀",
  "remote.modifyOptions": "옵션 수정",
  "remote.optRebase": "후속 변경 내용을 포함하여 현재 브랜치를 리베이스",
  "remote.optFfOnly": "빨리 감기 병합이 가능할 경우에만 병합",
  "remote.optNoFf": "빨리 감기 병합이 가능한 경우에도 병합 커밋 생성",
  "remote.optSquash": "풀한 변경 내용 모두에 대해 단일 커밋 생성",
  "remote.optNoCommit": "병합하고 결과는 커밋 안 함",
  "remote.optNoVerify": "사전 병합 및 커밋 메시지 후크 우회",
  "remote.noRemotes": "이 저장소에는 원격 브랜치가 없습니다. 먼저 페치하거나 원격을 추가하세요.",
  "remote.reading": "원격을 읽는 중…",

  "remote.updateTitle": "프로젝트 업데이트",
  "remote.methodMerge": "후속 변경 내용을 현재 브랜치로 병합",
  "remote.methodRebase": "후속 변경 내용을 포함하여 현재 브랜치를 리베이스",
  "remote.dontShow": "다시 표시 안 함",
  "remote.resetToRemote": "원격 브랜치로 재설정",
  "remote.resetAsk": "로컬 브랜치 {name}을(를) {upstream}(으)로 재설정할까요? 로컬 커밋이 삭제됩니다.",
  "remote.resetButton": "재설정",
  "remote.ok": "확인",

  "remote.infoTab": "업데이트 정보",
  "remote.infoSummary": "{commits}개 커밋에서 {files}개 파일 업데이트됨",
  "remote.infoEmpty": "받은 커밋이 없습니다.",
};
