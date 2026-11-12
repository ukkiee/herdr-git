# herdr-git

Herdr 데스크톱 앱 안에서 변경을 커밋하고 기록을 살펴보는 Git 도구 mod다.

## Language

### 화면

**Commit panel**:
작업 트리의 변경을 골라 커밋하는 사이드 패널. 우상단 Changes 버튼이 연다.
_Avoid_: Changes 창, 변경 창, 커밋 뷰

**Log panel**:
브랜치와 커밋 기록을 보여 주는 하단 패널.
_Avoid_: Git 창, 히스토리, 로그 뷰

**Git button**:
탭 바의 Changes 버튼 오른쪽에서 Log panel을 보이고 숨기는 버튼. Commit panel 툴바의 Git Log 버튼과는 다른 것이다.
_Avoid_: 로그 버튼, Git 탭

**Files panel**:
포커스된 폴더를 트리로 보여 주고 파일을 읽기 전용으로 미리 보는 사이드 패널. 우상단 Files 버튼이 연다.
_Avoid_: 파일 창, 탐색기, 파일 트리

**Deleted Branches dialog**:
저장소에 기록된 지운 브랜치를 골라 되살리는 창.
_Avoid_: 휴지통, 삭제 기록 창

**Restore dialog**:
Rollback snapshot을 골라 파일을 되살리는 창.
_Avoid_: 히스토리 창, 복구 창

**Diff tab**:
파일 하나의 차이를 보여 주는 space의 탭.
_Avoid_: diff 창, 비교 뷰

**Push dialog**:
푸시될 커밋을 보여 주고 푸시를 확정하는 창.
_Avoid_: 푸시 확인 창

**Rollback dialog**:
되돌릴 파일을 확정하는 창.
_Avoid_: 되돌리기 확인

**VCS widget**:
현재 브랜치와 Operation in progress를 보여 주고, 누르면 브랜치 목록과 브랜치 동작을 여는 블록.
_Avoid_: 브랜치 위젯, 브랜치 팝업

**VCS Operations popup**:
자주 쓰는 git 동작을 한곳에 모아 단축키로 여는 팝업.
_Avoid_: Git 메뉴, 빠른 메뉴

**Conflicts dialog**:
Conflict 파일 목록을 보여 주고, 파일마다 한쪽 변경을 받아들이거나 Merge Revisions dialog를 여는 창.
_Avoid_: 충돌 해결 창

**Merge Revisions dialog**:
Conflict 파일 하나를 내 쪽, 결과, 상대 쪽 세 칸으로 보며 결과를 만드는 창.
_Avoid_: 병합 도구, mergetool, 3-way 편집기

**Stash tab**:
Commit panel 머리에서 커밋 탭과 나란히 있는 탭. Stash 목록을 보여 주고 고른 Stash를 Unstash한다. Stash가 하나라도 있을 때만 보인다.
_Avoid_: 스태시 창, 스태시 목록 창

**Git console**:
이 mod가 실행한 git 명령과 그 출력을 보여 주는 space의 탭.
_Avoid_: 출력 창, 로그(Log panel과 헷갈림)

### 커밋 창의 개념

**Changes**:
git이 추적하는 파일 가운데 HEAD와 다른 파일의 그룹.
_Avoid_: 수정 목록, staged, unstaged

**Unversioned Files**:
git이 추적하지 않고 무시하지도 않는 파일의 그룹.
_Avoid_: untracked, 새 파일

**Included**:
체크박스가 켜져 다음 커밋에 들어갈 파일의 상태. git의 스테이징 상태와 무관하다.
_Avoid_: staged, 선택됨

**Rollback**:
추적 파일의 커밋하지 않은 변경을 버리고 HEAD의 내용으로 되돌리는 동작. 커밋을 거꾸로 하는 Revert Commit, 브랜치를 옮기는 Reset과 다르다.
_Avoid_: revert, discard, reset

**Amend**:
새 커밋을 만드는 대신 마지막 커밋을 고쳐 쓰는 커밋 방식.

**Last commit group**:
Amend가 켜진 동안 Commit panel 맨 아래에 보이는, 마지막 커밋에 든 파일의 그룹.
_Avoid_: 지난 커밋 목록, amend 파일

**Rollback snapshot**:
Rollback 직전에, 되돌릴 파일들의 그때 상태와 스테이징을 저장소 안에 남긴 기록. 사용자가 넣는 Stash와 달리 Rollback이 스스로 남기고 stash 목록에 보이지 않는다.
_Avoid_: 백업, stash, Local History, 히스토리

**Restore**:
Rollback snapshot의 파일이나 지운 브랜치를 사라지기 직전 상태로 되살리는 동작.
_Avoid_: undo, revert, 복구, 되돌리기(Rollback과 헷갈린다)

### 로그 창의 개념

**Branch tree**:
HEAD, Local, Remote 세 그룹으로 브랜치를 보여 주는 로그 창의 왼쪽 영역.

**Commit list**:
커밋을 그래프와 함께 한 줄씩 보여 주는 로그 창의 가운데 영역.

**Commit details**:
선택한 커밋의 변경 파일과 메시지·작성자·해시를 보여 주는 로그 창의 오른쪽 영역.

**Ref label**:
커밋 줄 오른쪽에 붙는 브랜치·태그 이름표.
_Avoid_: 배지, 태그

**Protected branch**:
강제 푸시를 허용하지 않는 브랜치. `main`과 `master`다.

### git 동작

**Stash**:
커밋하지 않은 변경을 git의 stash 목록에 넣어 두고 작업 트리를 비우는 동작, 또는 그렇게 넣어 둔 묶음 하나.
_Avoid_: shelve, 임시 저장, Rollback snapshot

**Unstash**:
stash 하나를 작업 트리에 다시 적용하는 동작. Apply는 목록에 남기고 Pop은 목록에서 지운다.
_Avoid_: Restore, 복원

**Merge**:
다른 브랜치의 커밋을 현재 브랜치에 합치는 동작.

**Rebase**:
현재 브랜치의 커밋을 다른 커밋 위로 옮겨 다시 쌓는 동작.

**Interactive rebase**:
고른 커밋부터 현재까지의 커밋을 순서 바꾸기, 합치기(Squash), 버리기(Drop), 메시지 고치기로 다시 쌓는 Rebase.

**Pull**:
원격 브랜치를 가져와 현재 브랜치에 Merge나 Rebase로 반영하는 동작. 가져오기만 하는 Fetch와 다르다.

**Cherry-Pick**:
다른 커밋의 변경을 현재 브랜치에 새 커밋으로 적용하는 동작.

**Revert Commit**:
고른 커밋의 변경을 거꾸로 적용하는 새 커밋을 만드는 동작. 기록은 지우지 않는다.
_Avoid_: Rollback, 되돌리기

**Reset**:
현재 브랜치를 고른 커밋으로 옮기는 동작. 모드(Soft, Mixed, Hard, Keep)가 작업 트리와 스테이징을 어떻게 할지 정한다.
_Avoid_: Rollback, Revert Commit

**Undo Commit**:
현재 브랜치의 마지막 커밋을 지우고 그 변경을 커밋하지 않은 변경으로 되돌리는 동작.

**Conflict**:
Merge, Rebase, Pull, Cherry-Pick, Revert Commit, Unstash가 두 쪽의 변경을 저절로 합치지 못한 파일.
_Avoid_: 충돌 상태

**Smart operation**:
로컬 변경이 git 동작을 막을 때, 변경을 Stash로 치워 두고 동작을 한 뒤 Unstash하는 실행 방식.
_Avoid_: autostash

**Favorite branch**:
목록에서 현재 브랜치 다음으로 올려 보이게 표시한 브랜치. main과 master는 처음부터 Favorite branch다.
_Avoid_: 고정 브랜치, 북마크

**Operation in progress**:
Merge, Rebase, Cherry-Pick, Revert Commit이 Conflict 등으로 멈춰 Continue나 Abort를 기다리는 저장소의 상태.
_Avoid_: 충돌 상태, 멈춤

### 모습

**Icon theme**:
파일과 폴더의 이름에 맞춰 고르는 색 아이콘 묶음. Atom Material Icons에서 가져온다.
_Avoid_: 아이콘 팩, 파일 타입 아이콘

**UI icon**:
버튼과 메뉴 항목에 붙는 동작 아이콘. Icon theme과 저자는 같지만 파일 이름이 아니라 동작에 맞춰 고른다.
_Avoid_: 툴바 아이콘

### 배치

**main-git**:
Herdr의 `main` 레이아웃을 복제해 Commit panel, Files panel, Log panel, Git button 자리를 넣은 레이아웃.
