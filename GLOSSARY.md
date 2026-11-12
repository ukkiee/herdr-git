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
추적 파일의 변경을 버리고 HEAD의 내용으로 되돌리는 동작.
_Avoid_: revert, discard, reset

**Amend**:
새 커밋을 만드는 대신 마지막 커밋을 고쳐 쓰는 커밋 방식.

**Rollback snapshot**:
Rollback 직전에, 되돌릴 파일들의 그때 상태를 저장소 안에 남긴 기록.
_Avoid_: 백업, stash, Local History, 히스토리

**Restore**:
Rollback snapshot의 파일이나 방금 지운 브랜치를 사라지기 직전 상태로 되살리는 동작.
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

### 모습

**Icon theme**:
파일과 폴더의 이름에 맞춰 고르는 색 아이콘 묶음. Atom Material Icons에서 가져온다.
_Avoid_: 아이콘 팩, 파일 타입 아이콘

### 배치

**main-git**:
Herdr의 `main` 레이아웃을 복제해 Commit panel과 Log panel 자리를 넣은 레이아웃.
