# Herdr mod 플랫폼 한계

출처는 Herdr 앱 홈(`~/.config/herdr-app`)의 `AGENTS.md`, `herdr.d.ts`, `gpui-kit.d.ts`(gpui-shell 0.7.1), 내장 mod 코드, `herdr-app commands`다.
표기: **[문서]** 문서·타입이 명시, **[코드]** 내장 mod가 실제로 씀, **[타입만]** 타입 선언만 있고 내장 사용 예 없음(런타임 미검증), **[실험]** 직접 실행해 관측, **[미확인]** 찾지 못함.

## 배치

- 내장 레이아웃과 내장 mod는 읽기 전용이고 시작할 때마다 통째로 교체된다. 고치면 다음 시작에 `<name>-edited`로 밀려난다. [문서]
- 구조를 바꾸려면 `layout.clone`, 코드를 바꾸려면 `mod.clone`. 복제본은 업데이트되지 않는다. [문서]
- `mod.json`의 `"place": "bottom" | "right"`는 내장 `main`에 자동 도킹되지 않는다. 실행 중에도 재시작 뒤에도. [실험]
- `main`의 뼈대: `root(row) = [sidebar, work(column) = [tabs, work-body(row) = [main, panel], status]]`. `panel` > `panel-body`(stack) > `files`, `changes` 블록. `work` column은 `resizable: false`라 그 안에 직접 넣은 블록은 경계 드래그가 안 된다. [코드]
- 우상단 Files/Changes 버튼은 내장 `tabs` mod가 그리고, 레이아웃 노드 id(`files`, `changes`)를 `layout.select` + `layout.show`로 연다. 보일 버튼은 `shared("workspace.panels")`가 정한다. [코드]
- 같은 mod를 레이아웃에 여러 번 넣고 `props`로 역할을 가를 수 있다. [코드]
- mod를 탭(`tab.new {mod, props}`), pane(`pane.split {direction, mod, props}`), 오버레이(`openOverlay({mod, kind: "dialog" | "popup" | "window", props})`)로 열 수 있다. [문서]

## UI 부품

- `gpui-base`의 `Button`, `Checkbox`, `Input`은 스타일이 없다. 전부 직접 그린다. [문서]
- Tree, Diff 뷰어, 드롭다운 메뉴 컴포넌트가 없다. [관측: export 목록]
- `v_virtual_list`는 렌더러 안에 핸들러를 달 수 없다. 행당 좌클릭 하나(key만)와 우클릭 하나뿐이다. 체크박스·펼침·선택이 같이 있는 행은 수동 윈도잉(보이는 구간만 그림 + `on_scroll_wheel` + 직접 그린 thumb)으로 만든다. [문서] dialog 안에서는 `v_virtual_list`가 그려지지 않을 수 있다(직접 확인하지 않았다).
- 여러 줄 입력: `TextareaState` + `Textarea`. [코드]
- 커스텀 페인팅: `PathBuilder` + `window.paint_path`. `fill()`은 내장 사용 예가 있고 `stroke()`는 [타입만]. `canvas` 요소는 없다.
- `Editor`는 구문 강조·줄 번호·읽기 전용이 되지만 줄 배경·데코레이션 옵션이 없다. 색칠한 diff는 행을 직접 그려야 하고 구문 강조를 잃는다. [관측: `EditorState` 옵션]
- `Checkbox`, `h_resizable`/`v_resizable`, `Popover`, `Select`는 [타입만].
- UI 아이콘 세트가 없다. Lucide 스타일 SVG(`viewBox 0 0 24 24`, `stroke="currentColor"`, `stroke-width="1.5"`)를 mod 폴더에 직접 둔다. [코드]
- 우클릭: `.on_mouse_down("right", …)` + popup 오버레이. [코드]
- `overflow_y_scrollbar()`는 요소를 감싼다. `max_h(...)`만 주면 안쪽 영역이 내용만큼 커지고 바깥이 잘라서, 휠로 스크롤되지 않고 막대도 안 보인다(Branch 필터 팝업과 오류 띠에서 재현). 높이를 px로 주거나, `max_h(...).overflow_y_scroll()`(감싸지 않는 쪽)에 `Scrollbar.vertical(id)`를 겹치면 스크롤된다. [실험] 내장 `changes` mod의 주석도 같은 감싸기를 말한다. [코드]
- `Popover` 안의 요소도 휠 입력(`on_scroll_wheel`, 스크롤 영역)과 키 입력(`on_key_down`, 포커스가 그 안의 `Input`에 있을 때 위·아래 화살표 포함)을 받는다. [실험]
- `image("mods/<name>/x.svg")`는 색이 든 SVG를 그 색대로 그린다(Atom Material Icons의 16×16 아이콘으로 확인). [실험]
- 앱 내부 drag & drop은 없다(외부 파일 드롭만). [문서]

## `herdr` API

- `exec(command, args?, { cwd?, on?, timeout? })`: stdin·스트리밍·env 옵션이 없다. 출력 8 MiB, timeout 기본 30초·최대 10분. `on`으로 원격 머신에서 실행. [문서] 따라서 자격 증명·GPG 프롬프트를 받을 수 없고, 환경 변수는 `env VAR=… git …`로 넘긴다.
- `readTextFile`(1 MiB, 원격 가능), `writeTextFile`(로컬 전용). [문서]
- `watchFolder(dir)`: 로컬 전용. macOS에서는 `.git` 아래 변경도 온다. 읽기 명령이 인덱스를 건드리면 새로고침이 다음 새로고침을 부르므로 `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`를 붙인다. [코드: 내장 `changes`]
- 타이머: `cx.timer.every` / `cx.timer.after`. `setTimeout` 없음. [문서]
- 상태: `localStorage`(mod 복사본별), `shared`/`setShared`(모든 mod 공유, 설정하면 창 전체 재렌더). [문서]
- mod 명령: `<mod>.<command>`는 문자열만 전달되고 **보이는 복사본에만** 간다. [문서] 키는 `keys.json`의 `global` 또는 `mod:<name>`.
- 파일을 에디터로 여는 앱 명령은 없다. [관측: `herdr-app commands`]
- **시스템 언어를 알려 주는 API는 없다.** `herdr.d.ts`에 언어·로캘 항목이 없고 [문서], mod 안에서 `Intl`은 정의돼 있지 않으며 `navigator`가 없고 `process.env.LANG`은 비어 있다. `toLocaleDateString()`은 로캘 없이 `02/05/1971` 꼴을 낸다. 대신 `exec`로 읽을 수 있다: macOS에서 `defaults read -g AppleLanguages`가 `("ko-KR")`를, `sh -c 'echo $LANG'`이 `ko_KR.UTF-8`을 돌려줬다. [실험: 설치된 사본에 임시 코드를 넣어 실행] `herdr-app check`는 `exec`를 실제로 실행하지 않는다(같은 코드가 check에서는 아무것도 남기지 않았다). [실험]

## 렌더와 도구

- `render`는 `cx.notify()`와 Herdr 라이브 데이터 변화마다 다시 돌고, 다시 그리기는 창 전체다. 파싱·정렬·그래프 계산은 캐시한다. [문서]
- import는 `gpui-kit`, `gpui-base`, `herdr`, 같은 폴더의 `./x.js`뿐이다. 폴더 밖 import는 심볼릭 링크 포함 거부된다. [문서/코드]
- `herdr-app check <mod 폴더>`: 한 번 로드해 초기 묘사를 검사한다. 레이아웃 계산, 지연 행, 이후 async 상태는 보지 않는다. [문서]
- `herdr-app shot [file.png]`: 마지막 창 프레임을 PNG로 저장한다. [문서]
