---
status: accepted
---

# `main` 레이아웃을 복제해 패널 자리를 만든다

Commit panel을 우상단 Changes 버튼으로, Files panel을 Files 버튼으로 열고 Log panel을 창 하단에 고정하려면 레이아웃 구조를 바꿔야 한다. Herdr의 내장 `main` 레이아웃은 구조 변경을 받지 않으므로, 설치 스크립트가 `main`을 `main-git`으로 복제해 `changes`와 `files` 자리의 mod를 바꾸고 하단 블록을 넣는다. 탭 바 mod(`tabs`)는 복제하지 않는다. Log panel을 여닫는 Git 버튼은 탭 바 안에 넣지 않고, 탭 바 블록을 row로 감싸 그 오른쪽에 mod의 블록으로 둔다.

## Considered Options

- **`mod.json`의 `"place": "bottom"` / `"right"` 자동 도킹.** 빈 mod 두 개로 실험했다. 실행 중에도, Herdr 재시작 뒤에도 내장 `main`에 붙지 않았다(화면, `layouts/.state/main.json`, `seen.json` 모두 변화 없음).
- **복제 없이 pane·탭으로 열기.** 업데이트 단절이 없지만 우상단 버튼과 하단 고정 패널을 만들 수 없다.
- **`tabs`까지 복제해 버튼을 추가.** 버튼 라벨을 바꾸고 Git 버튼을 Changes 버튼과 같은 간격으로 놓을 수 있지만 탭 바도 Herdr 업데이트를 받지 못한다.

## Consequences

- `main-git`은 이후 Herdr의 `main` 변경을 받지 못한다. 설치 스크립트를 다시 실행하면 현재 `main`에서 다시 만든다. 그래서 변환은 `main`의 구조가 바뀌어도 실패를 알리도록, 기대하는 노드(`work`, `tabs`, `work-body`, `panel-body`, `changes`, `files`)가 없으면 멈춘다.
- Changes와 Files 버튼의 라벨은 그대로 남는다. 버튼은 mod가 아니라 레이아웃 노드 id `changes`와 `files`를 열기 때문에 두 블록은 id를 유지하고 내용만 바뀐다. Files panel은 Git 버튼과 달리 모든 OS에서 바꾼다.
- Git 버튼은 탭 바 밖의 블록이다. Changes 버튼과의 사이에 탭 바의 오른쪽 여백이 끼어 간격이 탭 바 안의 버튼 사이보다 넓다. 탭 바의 오른쪽 끝에 창 버튼이 있는 OS에서는 블록이 그 바깥에 놓이므로 macOS에서만 넣는다.
- VCS widget(현재 브랜치, 받을·보낼 커밋 수, 진행 중 동작)도 같은 row의 블록으로 Git 버튼 왼쪽에 둔다(`git-vcs-widget`). 블록은 240px로 만들어지고, 위젯이 그려지면 `layout.resize`로 위젯 내용 너비에 맞춰진다. 위젯은 360px까지 넓어지고 그보다 긴 브랜치 이름은 줄여 보인다. Git 버튼과 같은 이유로 macOS에서만 넣고, 다른 OS에서는 포커스를 따르는 Log panel의 Commit list 툴바 왼쪽 끝에 같은 위젯을 그린다. 위젯이 생기기 전에 만든 `main-git`에 다시 설치하면 그 자리에 더해진다.
- `main` 레이아웃으로 돌아가면 Herdr의 원래 Changes와 Files가 그대로 있다.
