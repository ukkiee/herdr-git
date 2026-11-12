---
status: accepted
---

# 지운 브랜치는 숨은 ref 하나의 reflog에 두고, ref는 HEAD 역사의 뿌리 커밋에 세워 둔다

브랜치를 여러 개 정리하다 며칠 뒤 그중 하나가 필요해질 수 있다. 그래서 Delete는 브랜치를 지우기 **전에** 숨은 ref `refs/git-tools/deleted-branches`를 그 브랜치의 커밋으로 옮기고(reflog 메시지에 이름과 추적의 원격·대상), 곧바로 ref를 "세워 둘 커밋"으로 되돌린다. 지운 커밋은 그 ref의 reflog에만 남는다. 기록하지 못하면 지우지 않는다.

세워 둘 커밋은 HEAD 역사의 뿌리 커밋(첫 부모를 따라간 끝)이다. ref가 이미 가리키는 커밋이 HEAD의 조상이면 그대로 쓰고, 아니면(처음이거나 amend·rebase로 그 커밋이 HEAD의 역사에서 빠졌으면) 다시 찾아 세운다. HEAD가 이미 닿는 커밋이므로 `git log --all`에 새로 보이는 커밋이 없다.

## Considered Options

- **브랜치마다 숨은 ref:** ref가 지운 커밋을 가리키므로 `git log --all`과 그래프에 계속 보인다. 정리하려고 지운 브랜치가 남아 보인다.
- **ref가 마지막으로 지운 커밋을 가리킴**(Rollback snapshot과 같은 꼴): 가장 최근에 지운 브랜치가 `git log --all`에 보인다.
- **앱에 목록만 두고 저장소에는 아무것도 남기지 않음:** 체크아웃한 적 없는 브랜치의 커밋은 어떤 reflog에도 없어서 `gc --prune=now` 한 번에 사라진다. 다른 worktree와 다른 컴퓨터의 Herdr에서도 목록이 보이지 않는다.
- **`refs/` 밖의 이름**(`ORIG_HEAD` 같은 자리): worktree마다 따로이고, git이 드물게 쓰는 이름 규칙에 기댄다.
- **ref를 빈 트리에 세움:** 커밋이 아니어서 `git log -g`로 목록을 읽을 수 없다.

## Consequences

- 지운 커밋은 `git log --all`, 브랜치 목록, 태그 목록에 나오지 않고 `gc --prune=now` 뒤에도 남는다. ref는 `refs/heads/` 밖이라 worktree가 함께 쓰고, `push --all`과 clone은 옮기지 않는다(`push --mirror`는 ref만 옮기고 reflog는 옮기지 않는다).
- 보관은 git의 reflog 정리를 따른다. 지운 커밋은 ref가 더 닿지 않는 커밋이므로 `gc.reflogExpireUnreachable`(기본 30일) 뒤 gc가 돌 때 사라진다. mod는 기록을 지우지 않고 저장소 설정을 바꾸지 않는다.
- 기록의 메시지는 `deleted <이름>` 또는 `deleted <이름> <원격> <대상>`이고, ref를 되돌린 항목은 `parked`다. git은 reflog 메시지의 연속된 공백을 하나로 줄이므로 각 칸의 `%`, 공백, 제어 문자는 `%XX`로 적는다. 이 꼴과 ref 이름은 이미 남은 기록을 읽는 방법이므로, 바꾸려면 옛 기록을 읽는 길을 함께 둬야 한다.
- git은 ref를 지금 값과 같은 커밋으로 옮기면 reflog에 항목을 더하지 않는다. 그래서 지울 브랜치가 ref가 서 있는 커밋에 있으면(커밋이 하나뿐인 저장소에서 지울 때 등) ref가 먼저 비켜 선 뒤 기록한다. 비켜 설 자리는 그 브랜치의 트리로 만든 부모 없는 커밋이다(작성자는 mod 자신이어서 사용자 설정에 이름이 없어도 된다). 이 커밋은 이 reflog에만 있고 그 항목은 `parked`여서 목록과 `git log --all`에 나오지 않으며, 기록과 함께 정리된다. `git reflog write`는 최근 git에만 있어서 쓰지 않는다.
- HEAD에 커밋이 없는 저장소(갓 만든 orphan 브랜치 등)에서는 HEAD의 역사가 없으므로 지운 브랜치 역사의 뿌리 커밋에 세운다. 그 커밋 하나는 `git log --all`에 보일 수 있다.
- 목록은 reflog를 최신순으로 읽어 50개까지 낸다. 같은 이름·같은 해시는 한 줄이고, 같은 이름의 로컬 브랜치가 지금 같은 해시에 있으면 빼고, 다른 해시에 있으면 고를 수 없음과 이유를 붙인다.
