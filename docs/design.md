# git-tools 설계

용어는 [GLOSSARY.md](../GLOSSARY.md) 파일을 따른다. 화면의 문구·치수·줄 하나하나와 명령 목록은
[RECIPE.md](../RECIPE.md) 파일에 있고, 이 문서는 구조, 규칙과 그 이유, 경계, 한계를 말한다.

## 1. 무엇인가

`git-tools`는 Herdr 데스크톱 앱 안에서 변경을 골라 커밋하고, 푸시하고, 브랜치와 커밋 기록을
살펴보는 mod다. Stash, Merge, Rebase, Pull, Cherry-Pick, Revert Commit, Reset과 지난 커밋 고치기,
충돌 해결, 비교 화면도 같은 mod가 한다. 의존성과 빌드 단계가 없는 JS 파일 묶음이고, `main-git`
레이아웃 안에서 돈다. space가 다른 머신에 있으면 git 명령을 모두 그 머신에서 실행한다.

## 2. 화면 구성

모든 화면은 mod 하나의 사본이다. 사본을 연 쪽이 넘긴 `props.view`가 어느 화면인지 정하고,
`main.js` 파일은 그 값으로 길만 나눈다.

- **Commit panel** (`view-commit.js`, 아래쪽 커밋 양식은 `commit-form.js`): Changes와
  Unversioned Files를 체크박스 트리로 보여 주고, 체크한 파일만 커밋한다. 레이아웃 블록
  `changes` 자리에 들어간다. Amend가 켜진 동안에는 맨 아래에 Last commit group이 붙는다.
  Operation in progress가 있으면 변경 트리 위에 진행 중 줄(이어가기·중단·건너뛰기)과 "충돌 병합"
  노드가 붙는다. stash가 있으면 머리에 Stash tab(`commit-stash-tab.js`)이 생긴다. 픽스업·다음으로
  스쿼시를 고르면 그 커밋을 대상으로 하는 상태(버튼 하나 "커밋 및 리베이스…")가 된다.
- **Files panel** (`view-files.js`): 포커스된 pane의 폴더를 폴더마다 펼쳐 읽는 트리로 보여 주고,
  파일을 누르면 읽기 전용 미리보기로 바뀐다. 레이아웃 블록 `files` 자리에 들어간다. 이름의 git
  표시, 바뀐 파일이 든 폴더의 점, 이름의 일부로 찾는 찾기 칸, 화살표·Enter·Esc 키, 줄의 우클릭
  메뉴(Show Diff, 경로 복사, Finder에서 보기)가 있다. 읽기는 `files-data.js`, 판단은
  `files-tree.js`가 한다.
- **Log panel** (`view-log.js`): 작업 영역 아래 블록 `git-log`. 세 열은 각자의 파일이 그린다.
  - **Branch tree** (`log-branches.js`): HEAD, Local, Remote, Tags. 현재 → Favorite branch →
    이름순으로 놓고, 세로 툴바와 우클릭 메뉴가 브랜치 동작을 연다.
  - **Commit list** (`log-list.js`, 위의 검색과 필터는 `log-filters.js`, 그래프·표시 옵션은
    `log-options.js`): 그래프, 제목, Ref label, 작성자, 시각. Shift·Cmd 클릭으로 여러 커밋을 고른다.
  - **Commit details** (`log-details.js`): 고른 커밋(여럿이면 합친 변경)의 파일 트리, 전체 메시지,
    그 커밋을 담은 브랜치, 커밋 줄과 파일 줄의 우클릭 메뉴.
  - 세 열의 메뉴와 툴바 항목은 모두 `log-menus.js`의 표에서 나온다.
- **Git 버튼** (`view-log-button.js`): 탭 바의 Changes 버튼 오른쪽 블록 `git-log-button`. Log
  panel을 보이고 숨긴다. macOS에서만 놓인다.
- **VCS widget** (`view-vcs-widget.js`, 팝업은 `view-vcs-popup.js`): 현재 브랜치와 받을·보낼 커밋 수,
  분리된 HEAD의 해시, Operation in progress를 보인다. macOS에서는 Git 버튼 왼쪽 블록
  `git-vcs-widget`, 다른 OS에서는 Commit list 툴바 왼쪽 끝에 그린다. 누르면 팝업(검색, 맨 위 동작,
  최근·로컬·원격·태그 트리와 브랜치별 메뉴)이 열린다.
- **VCS Operations popup** (`view-vcs-ops.js`, 판단은 `vcs-ops.js`): `cmd-shift-v`가 여는, git 동작에
  1~0 번호를 단 팝업.
- **충돌 창**: Conflicts dialog (`view-conflicts.js`)와 Merge Revisions dialog
  (`view-merge-revisions.js`). 동작이 충돌로 멈추면 그 동작을 연 사본이 Conflicts dialog를 연다.
- **동작 창**: Smart dialog (`view-smart.js`), Stash와 Unstash (`view-stash.js`, `view-unstash.js`),
  병합·리베이스·풀 (`view-merge.js`, `view-rebase.js`, `view-pull.js`), 프로젝트 업데이트
  (`view-update-project.js`), Git 재설정과 HEAD 재설정 (`view-reset.js`, `view-reset-head.js`),
  커밋 메시지 편집·커밋 삭제·커밋 스쿼시·추출 (`view-reword.js`, `view-drop-commits.js`,
  `view-squash.js`, `view-extract.js`), 커밋 리베이스 (`view-interactive-rebase.js`), 새 태그·이름
  변경·원격 정의 (`view-tag.js`, `view-rename-branch.js`, `view-remote.js`), 패치 파일 설정
  (`view-patch.js`), 새 워크트리 (`view-worktree.js`). 작은 팝업: 해시로 이동 (`view-go-to-hash.js`),
  태그 또는 리비전 체크아웃 (`view-checkout-ref.js`).
- **space 탭**: 비교 탭 (`view-compare-files.js`의 작업 트리·로컬·버전 세 모드,
  `view-compare-branches.js`), 비교 탭이 여는 파일 diff와 읽기 전용 파일 (`compare-diff`,
  `compare-file`), 리비전의 저장소 (`view-revision-tree.js`), 여기까지의 기록 (`view-history-tab.js`),
  Update Info tab (`view-update-info.js`), Git console (`view-console.js`). 같은 종류의 탭이
  있으면 새로 열지 않고 바꾼다(`space-tabs.js`).
- **Diff tab** (`view-diff.js`): 파일 하나의 통합 diff를 줄마다 그리는 space의 탭. 작업 파일의
  탭은 파일을 따라간다.
- **창**: Rollback dialog (`view-rollback.js`), Restore dialog (`view-restore.js`), Push dialog
  (`view-push.js`), New Branch와 Delete Branch (`view-branch-new.js`, 지울 때는 `mode: "delete"`),
  Deleted Branches dialog (`view-deleted-branches.js`, Branch tree 툴바에서 연다). 우클릭 팝업 메뉴는 `view-menu.js` 파일이 그린다.
- **점검 화면** (`view-icon-sheet.js`): Icon theme이 돌려줄 수 있는 아이콘 전부를 격자로 그리고
  앱 안에서 조회 속도를 잰다. 어느 화면에서도 열리지 않고 `tab.new` 명령으로만 연다. 글자는 영어다.

## 3. 구조

### 파일 지도

| 묶음 | 파일 | 책임 |
|---|---|---|
| 길잡이 | `main.js` | 사본을 만들고 화면에 버스·잠금·언어를 넘긴 뒤 `props.view`로 화면을 고른다(`VIEWS` 표) |
| 공용 부품 | `ui.js` | 저장소 찾기, 행·버튼·체크박스, 보이는 행만 그리는 `WindowedList`, 창과 메뉴 열기, `uiGlyph`·`iconButton`, 쓰기 잠금과 창 요청의 화면 쪽, 실패 띠의 "콘솔에서 보기" |
| 화면 쪽 등록과 파일 | `serve-actions.js`, `app-files.js`, `space-tabs.js`, `log-pick.js`, `log-rewrite.js` | 창이 패널에 요청하는 쓰기의 표(`SERVE_ACTIONS`), 앱 홈 `git-tools` 폴더의 기록·설정 파일, 종류마다 하나인 space 탭, Log panel 쪽의 Cherry-Pick·Revert와 히스토리 편집 처리 |
| 화면 | `view-*.js`, `commit-form.js`, `commit-stash-tab.js`, `log-branches.js`, `log-list.js`, `log-details.js`, `log-filters.js` | 그리기와 사람의 입력 |
| git | `git.js`, `git-status.js`, `git-commit.js`, `git-rollback.js`, `git-snapshot.js`, `git-diff.js`, `git-push.js`, `git-log.js`, `git-log-filter.js`, `git-branch.js`, `git-show.js`(`readLastCommit` 포함), `files-data.js` | git과 폴더 읽기 명령을 부르고 결과를 해석한다 |
| git 동작 | `git-operation.js`, `git-conflict.js`, `git-smart.js`, `git-stash.js`, `git-reset.js`, `git-rewrite.js`, `git-changes.js`, `git-remote.js`, `git-refs.js`, `git-compare.js`, `git-revision.js`, `git-worktree.js`, `git-heads.js` | Operation in progress 읽기와 merge·rebase·cherry-pick·revert의 실행·판정, 충돌 파일 쓰기, Smart operation, stash, reset과 하드 전 기록, 히스토리 다시 쓰기, 파일 단위 되돌리기·체리픽, pull·업데이트, 태그·이름 변경·원격, 비교·패치·가져오기, 리비전의 파일과 하위 커밋, 새 워크트리, VCS widget이 보일 브랜치 |
| 순수 계산 | `graph.js`, `tree.js`, `bus.js`, `lock.js`, `i18n.js`, `icon-theme.js`, `files-tree.js`, `editor-language.js`, `merge-chunks.js`, `conflicts-model.js`, `merge-revisions-model.js`, `rebase-plan.js`, `log-menus.js`, `log-select.js`, `log-options.js`, `branch-order.js`, `vcs-ops.js`, `git-console.js`, `ui-icons.js` | 그래프 배치, 경로 트리와 3상태 체크, 버스와 잠금 값, 언어와 문장, 아이콘 고르기, Files panel의 줄·표시·찾기 순위·키, 미리보기의 구문 색, 병합 덩어리, 두 충돌 창이 보일 것과 켜질 것, 리베이스 계획과 편집 판정, Log panel의 메뉴·툴바 표, 여러 커밋 고르기, 그래프·표시 옵션 값, 브랜치 순서와 즐겨찾기, VCS Operations popup의 항목, 콘솔 기록의 꼴, UI icon 대응 |
| 데이터 | `messages-*.js`, `icon-theme-data.js`, `icons/theme/`, `icons/ui/`(그 밖의 `icons/` 파일 포함) | 문구 표, 생성한 아이콘 규칙, 아이콘 파일 |

저장소 루트에는 레이아웃 변환 `layout.mjs`, 설치 `install.sh`, 키 `keys.json`, 아이콘 생성기
`tools/gen-icon-theme.mjs`가 있다. 각 모듈의 책임과 함정은 그 파일의 머리 주석에 있다.

### 화면 코드와 git 코드의 경계

git 모듈과 순수 계산 모듈은 `herdr`를 import하지 않는다. 그래서 node가 이 모듈들을 그대로
불러 테스트할 수 있다.

- `git.js`의 `makeGit(exec, on)`이 실행기를 만든다. `exec`는 인자로 받고, `on`은 git을 돌릴
  머신이다. 다른 git 모듈은 모두 이 `git`과 저장소 루트를 받는다.
- 함수는 예외를 던지지 않고 `{ ok, code, out, err, … }` 꼴의 결과를 돌려준다. 실패하면 화면은
  그 글을 패널이나 창의 오류 띠에 보인다.
- 읽기 명령에는 `READ`(`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`)를
  붙인다. Commit panel이 저장소 폴더를 감시하므로, 읽기가 `.git` 아래를 고치면 그 변경이 다음
  읽기를 부르고 새로고침이 끝없이 돈다.
- 판단은 git 모듈과 순수 모듈에 둔다. 되살릴지, 누구를 걸지, 어떤 아이콘인지, 어느 언어인지를
  화면이 정하지 않는다. 화면에는 자동 테스트가 없기 때문이다.

### 사본과 상태

패널, 창, 팝업, 탭은 모두 따로 도는 사본이다. 사본 사이에는 모듈 변수로 아무것도 건네지
않는다. 모듈 코드를 사본들이 함께 쓰는지가 Herdr 빌드마다 다르므로, 모듈 수준에는 상수와 순수
함수만 두고 사본의 상태는 인스턴스에 둔다.

- **`localStorage`**: 사본마다 따로이고 재시작해도 남으며, 같은 props의 사본들은 함께 쓴다. 키는
  `commit.grouped`(보기), `commit.copy`·`compare.copy`(기록에 쓰는 사본 식별자),
  `log.branches`·`log.details`(열 폭)다.
- **공유 값**: Herdr의 공유 상태에 키 세 개를 둔다. 값을 쓰면 창 전체가 다시 그려지고 값은
  저장된 상태에 남으므로 작게 두고 git 쓰기 뒤에만 쓴다.
  - `git-tools.bus`: 사본 사이의 알림. 최근 사건 8개와 번호만 둔다(`bus.js`). 사건은 이름과 짧은
    인자뿐이다: `changed`, 창의 요청과 답, `console`(콘솔 기록이 늘었다), `log-options`(그래프·표시
    옵션을 바꿨다), `rewrite-target`(픽스업·스쿼시 대상 커밋, 메시지는 받는 쪽이 읽는다). 큰 글은
    싣지 않는다. Merge Revisions dialog가 저장할 결과 글은 그 머신의 임시 파일
    `git-tools-result.XXXXXXXX`(이 컴퓨터는 앱 홈의 `git-tools` 폴더, 원격은 `$TMPDIR`나 `/tmp`,
    권한 0600)에 쓰고 요청에는 경로만 담는다. 패널은 저장한 뒤 그 파일을 지운다.
  - `git-tools.lock`: 저장소별 쓰기 잠금(`lock.js`).
  - `git-tools.lang`: 마지막으로 읽은 시스템 언어, `"en"` 또는 `"ko"`.
- **앱 홈의 파일**: 앱 전체의 값은 앱 홈의 `git-tools` 폴더에 둔다(`app-files.js`).
  `console.jsonl`은 Git console의 기록이고, `settings.json`은 JSON 객체 하나다(키
  `updateProject.method`, `updateProject.skipDialog`, `pull.branches`, `rewrite.dropDontAsk`,
  `log.options`, `branchTree`). 두 파일 모두 `writeTextFile`의 기대값 비교로 쓰고, 그사이 다른
  사본이 썼으면 다시 읽어 합친 뒤 다시 쓴다(세 번까지).
- **저장소의 설정**: 저장소에 매인 값은 그 저장소의 로컬 git 설정에 `gittools.` 키로 둔다:
  `gittools.favorite`(여러 값, 전체 ref 이름), `gittools.unfavorite`(즐겨찾기를 푼 main·master),
  `gittools.smart-stash`(멈춘 Smart operation이 남긴 stash), 그리고 기존의 `gittools.scripted`.
  저장소 설정은 worktree끼리 함께 쓰므로 Smart의 표식 값은 "stash 해시 + 절대 git 폴더"이고 여러
  개일 수 있다. 사용자의 다른 git 설정은 바꾸지 않는다.
- **쓰기 잠금**: 한 저장소에서는 git-tools의 쓰기가 한 번에 하나다. 키는 머신과 루트의 쌍이다.
  잡은 사본은 쓰기가 5초보다 길면 5초마다 살아 있다고 적고, 15초 동안 적지 않은 기록은 죽은
  것으로 본다. 그래서 사본이 `close` 없이 사라져도 15초 뒤에는 다른 화면이 쓸 수 있다. 이
  잠금은 git-tools끼리만 줄을 세운다. 터미널의 `git`이나 git 자신의 `index.lock`은 따로다.
- **사본 사이의 알림**: 한 사본이 다른 사본에 약속(promise)이나 콜백을 넘기지 않는다. 받는
  쪽이 시작한 일은 그 호출을 돌린 사본의 것이어서, 그 사본이 닫히면 끝나지도 실패하지도 않고
  버려진다. 그래서 사건은 공유 값에 쓰고, 각 사본이 자기 `render`에서 새 번호를 보고 자기
  타이머에서 받는다. 8개보다 많이 놓친 사본은 모두 다시 읽으라는 사건을 받는다.
- **창의 쓰기**: 창은 git 쓰기를 직접 하지 않는다. 창을 연 패널 사본(`props.owner`)에 요청하고,
  그 패널이 잠금을 잡고 실행한다. Herdr는 Esc로 창을 닫는 것을 막지 못하게 하고, 닫힌 사본의
  다음 `await` 뒤는 실행되지 않는다. 패널이 실행하면 창이 닫혀도 쓰기, 다시 읽기, 실패 표시가
  끝까지 간다. 3초 남짓 안에 패널이 요청을 받았다고 답하지 않으면 창은 요청을 버리고 아무것도
  시작하지 않았다고 알린다. Push, Rollback, Restore, New Branch, Delete Branch, Deleted Branches는
  각 패널의 `serve`가, 그 밖의 요청(충돌 수락·저장·되돌리기, stash, reset, 3-way Restore, Smart,
  히스토리 편집, 태그·이름 변경·원격, pull·업데이트, 병합·리베이스 시작, 패치 파일, 새 워크트리)은
  `serve-actions.js`의 `SERVE_ACTIONS` 표가 받는다. 표의 한 줄은 이름, 쓰기 잠금 문구 키, 실행
  함수다. 이 표를 Commit panel, Log panel, VCS widget 블록이 모두 받는다.
- **창 없이 하는 쓰기**는 그 동작을 연 사본의 것이다: 메뉴의 바로 실행(병합, 리베이스, Cherry-Pick,
  커밋 되돌리기 등)은 메뉴를 연 패널, VCS widget의 중단·이어가기·체크아웃·삭제·태그 푸시·리비전
  체크아웃은 위젯을 그린 사본이 잠금을 잡고 한다. 예외 둘: 리비전·브랜치에서 가져오기는 Log
  panel이나 비교 탭이 스스로 잠금을 잡고 실행한다(재시작 뒤 props로 되살아난 탭에는 요청을 받을
  패널 id가 없다). 즐겨찾기 표시는 저장소 설정 한 줄이라 잠금을 잡지 않고 쓴 뒤 `changed`를 알린다.
- **동작이 멈추면** 그 동작을 실행한 사본이 Conflicts dialog를 연다(`openConflictsIfStopped`). 로컬
  변경 때문에 거절되면 같은 사본이 Smart dialog를 연다(`offerSmart`).

### 설치와 레이아웃

Herdr의 내장 `main` 레이아웃은 구조 변경을 받지 않는다. 그래서 `install.sh`가 `main`을 복제한
`main-git`을 만들고 네 곳만 바꾼다([ADR 0001](adr/0001-clone-main-layout.md)).

- `panel-body`의 `changes` 블록은 id를 그대로 두고 내용만 Commit panel로 바꾼다. 탭 바의
  Changes 버튼이 이 id를 열기 때문이다.
- 같은 이유로 `panel-body`의 `files` 블록도 id를 두고 내용만 Files panel로 바꾼다. Git 버튼과
  달리 모든 OS에서 바꾼다.
- `work` column은 크기를 조절할 수 없으므로, `work-body`를 새 column `git-work`로 감싸고 그
  아래에 Log panel 블록 `git-log`(기본 320px, 숨김, 120~900px)를 넣는다.
- 탭 바 블록 `tabs`를 새 row `git-tabs`로 감싸고 오른쪽에 240px 블록 `git-vcs-widget`(VCS
  widget)과 64px 블록 `git-log-button`(Git 버튼)을 차례로 둔다. 탭 바의 mod는 Files와 Changes
  버튼을 직접 그리고 다른 버튼을 받지 않기 때문이다. row가 탭 바의 높이를 받고 블록 사이에는
  끌 수 있는 경계가 없다. 블록 너비는 레이아웃이 정하므로 위젯은 고정 너비이고 긴 브랜치 이름은
  줄인다. 두 블록은 창의 오른쪽 위 모서리라서 탭 바의 `window_drag`를 따른다(둘레를 끌면 창이
  움직인다). macOS에서만 넣는다. 다른 OS에서는 탭 바의 오른쪽 끝에 창 버튼(최소화, 최대화,
  닫기)이 있어서 블록이 그 바깥에 놓이기 때문이다. 그런 OS에서는 Log panel이 Commit list 툴바
  왼쪽 끝에 같은 위젯을 그린다.
- 변환은 `layout.mjs`의 순수 함수 `toMainGit`이다. 기대하는 노드(`work`, `tabs`,
  `work-body`, `panel-body`, `changes`, `files`)가 없으면 아무것도 쓰지 않고 없는 노드를 알린다.
  짐작해서 고치지 않는 것은, Herdr 업데이트로 `main`의 구조가 바뀐 것을 알아채야 하기
  때문이다.
- `install.sh`는 앞의 네 검사(node, `main.json`, 변환 가능, Herdr 실행 중) 가운데 하나라도
  실패하면 `Nothing was changed.`로 멈춘다. `main-git.json`과 `keys.json`은 임시 파일에 다
  쓴 뒤 이름을 바꿔 덮는다. `keys.json`에는 비어 있는 키만 더한다.
- **mod 폴더는 내용이 다른 파일만 쓴다**(`layout.mjs`의 `copyChanged`). Herdr는 mod 폴더의
  파일이 하나 저장될 때마다 모든 사본을 다시 불러오고, 이 mod는 파일이 2,500개가 넘는다.
  쓸 파일은 제자리 옆에 숨은 이름으로 다 쓴 뒤 차례로 이름을 바꿔 넣는다. Herdr는 숨은
  파일에는 다시 불러오지 않으므로 반쯤 쓰인 파일을 읽지 않는다. 앱 홈에만 있는 파일은
  그대로 둔다.
- `main-git`은 복제본이라 Herdr의 `main` 변경을 따라가지 않는다. Herdr를 업데이트한 뒤에는
  `install.sh`를 다시 돌린다.
- `cmd-k`는 mod 명령이 아니다. 숨은 사본은 명령을 받지 못하고, 숨은 부모를 보이며 stack의 자식을
  고르는 앱 명령이 없다. 그래서 키가 1×1 팝업을 열고, 그 사본이 `layout.select`와 `layout.show`를
  부른 뒤 스스로 닫는다.
- `cmd-shift-v`는 mod 명령 `git-tools.vcs-ops`다. 명령은 보이는 사본 모두에 가므로, 받을 사본은
  `vcs-ops.js`의 `takesVcsOps`가 고른다: Commit panel이 보이면 Commit panel, 아니면 Log panel.
  그 사본이 VCS Operations popup의 주인이 되어 고른 항목을 자기 일로 실행한다. 둘 다 숨어
  있으면(Files panel만 보일 때) 받을 사본이 없어 아무 일도 없다. `ctrl-v`는 터미널의 붙여넣기와
  겹쳐 쓰지 않는다.

## 4. 동작 규칙과 이유

### 커밋

- **체크한 파일만 커밋한다.** git의 스테이징 상태는 보지 않는다. 체크한 파일 가운데 추적하지
  않는 것은 먼저 `add --intent-to-add`로 알리고, `commit --only -m <메시지> -- <경로들>`로
  커밋한다. 체크하지 않은 파일의 스테이징은 커밋 뒤에도 그대로다.
- 메시지는 인자로 넘긴다. `exec`에는 stdin이 없고, 원격 머신에 파일을 쓸 수 없다.
- 커밋 훅은 그대로 돈다. 훅이 몇 분 걸릴 수 있으므로 커밋의 시간 한도는 플랫폼 최대인
  10분이다. git이 커밋을 거부하면 이번 커밋이 더한 `--intent-to-add`만 되돌린다.
- **Amend**는 마지막 커밋만 고친다. 켜면 빈 입력란에 마지막 메시지를 채우고, 마지막 커밋이
  이미 원격에 있으면 다음 푸시가 강제 푸시가 된다고 알린다. 체크한 파일이 없으면 메시지만
  고친다. 커밋이 없는 저장소에서는 꺼져 있다. 켜진 동안 버튼은 `Amend Commit`과
  `Amend Commit and Push…`이고, 목록 맨 아래에 HEAD 커밋의 파일 묶음(Last commit group)이 붙는다.
  묶음은 `git-show.js`의 `readLastCommit`으로 읽는다. 읽기마다 HEAD의 해시만 묻고, HEAD가
  움직였을 때만 파일을 다시 읽는다. 묶음의 파일에는 체크박스가 없어서 커밋과 Rollback의 대상이
  아니고, Diff는 그 커밋과 첫 부모의 차이다. Amend가 꺼지면(끄기, 커밋 성공, 패널이 다른
  저장소로 옮겨 감) 묶음도 사라진다.
- **충돌 파일이 있는 동안에는 아무것도 커밋하지 않는다.** `commit()`이 커밋 직전에 상태를 다시
  읽고, 충돌 경로가 하나라도 있으면 이유와 함께 돌려준다(Amend 포함). 화면이 버튼을 끄는 것만으로는
  다른 사본이나 스크립트의 길을 막지 못하고, 충돌 표시(`<<<<<<<`)가 든 파일이 그대로 커밋되면
  revert는 그 커밋으로 끝나 버리기 때문이다.
- **진행 중의 커밋은 그 동작을 잇는다.** Operation in progress가 있으면 커밋 버튼은 체크한 다른
  변경을 `add`한 뒤 Continue를 부른다. 동작이 스테이징한 파일(merge가 들여온 파일, 해결한 파일)은
  체크된 채 잠긴다. Amend는 진행 중에 꺼진다. 메시지 칸은 그 동작의 기본 메시지(`MERGE_MSG`의
  주석 줄을 뺀 것)로 채우되 이미 쓴 글은 덮지 않는다.
- **Commit and Push…**는 커밋이 성공했을 때만 Push dialog를 연다.
- **푸시**는 창이 보여 준 계획대로만 나간다. 패널이 `git push` 직전에 계획을 다시 읽고,
  브랜치·원격·대상·맨 위 커밋 중 하나라도 다르면 푸시하지 않고 새 계획을 보여 준다.
- **Force Push**는 언제나 `--force-with-lease=refs/heads/<대상>:<마지막으로 본 해시>`다. 옵션
  없는 `--force`, `-f`, `+refspec`은 `git-push.js` 어디에서도 만들지 않는다. 현재 브랜치나
  대상 브랜치의 이름이 `main`·`master`(Protected branch)면 Force Push는 꺼진다.
- push와 fetch는 `GIT_TERMINAL_PROMPT=0`으로 돈다. 자격 증명을 물을 곳이 없으므로, 묻는
  원격에서는 기다리지 않고 git의 오류로 실패한다.
- 브랜치와 원격의 이름은 `--end-of-options` 뒤나 `refs/heads/…` 전체 이름으로 넘긴다. 이름이
  `-f`인 브랜치가 옵션으로 읽히지 않게 하기 위해서다. 경로는 `--literal-pathspecs`나
  `:(literal)`로 넘겨 `*.ts` 같은 이름이 다른 파일에 맞지 않게 한다.

### Rollback snapshot과 Restore

Rollback은 Rollback dialog의 버튼으로만 실행되고, 쓰기 전에 버릴 파일들을 Rollback snapshot으로
남긴다([ADR 0002](adr/0002-rollback-snapshots-in-a-private-ref.md)).

- **숨은 ref.** 기록은 커밋 객체다. 첫 부모는 그때의 HEAD이고, 트리는 HEAD에 되돌릴 경로들의
  작업 트리 상태를 얹은 것이다. 그래서 기록과 첫 부모의 차이가 곧 버린 변경이다. 기록은
  `refs/git-tools/rollback`의 reflog에 쌓인다. 브랜치나 태그가 아니어서 Commit list, Branch
  tree, push에 나오지 않는다. 목록은 최근 50개를 첫 부모와의 차이로 읽는다
  (`--diff-merges=first-parent`, git 2.31 이상).
- **두 번째 부모는 스테이징이다.** 같은 HEAD 위의 커밋이고, 트리는 HEAD에 되돌릴 경로들의 인덱스
  항목(stage 0)을 얹은 것이다. 스테이징된 삭제는 그 트리에도 없다. 충돌 중이던 경로(stage 1~3)는
  트리에 담을 수 없어 HEAD의 것으로 두고, 기록 메시지 끝에 `Conflict: <경로의 JSON 문자열>` 줄로
  싣는다. 커밋이 없는 저장소의 기록에는 부모가 없고 인덱스도 담지 않는다.
- **`git add -N`으로 알리기만 한 경로(intent-to-add)는 따로 싣는다.** 그 항목은 `ls-files -s`에서
  빈 파일을 스테이징한 것처럼 보인다. 그대로 담으면 Restore가 빈 내용을 실제로 스테이징하고,
  그 뒤 경로 없는 `git commit`이 빈 파일을 커밋한다. 그래서 실제 인덱스의 `diff-files --raw`에서
  상태가 `A`인 경로(git이 실제로 담은 항목은 이 상태가 될 수 없다)를 두 번째 부모 트리에서 빼고,
  충돌 줄 다음에 `Intent: <경로의 JSON 문자열>` 줄로 싣는다. 이 줄을 모르는 읽기는 그 경로를
  스테이징 없이 되살리므로 빈 내용이 스테이징되지 않는다.
- **기록을 만들지 못하면 Rollback하지 않는다.** 되돌릴 것이 없으면 기록도 만들지 않는다.
- **임시 인덱스는 사본마다 따로다.** 기록은 `GIT_INDEX_FILE`을 `<git 폴더>/git-tools-rollback-index-<id>`로
  두고 만들어서 실제 인덱스와 작업 트리를 건드리지 않는다. `<id>`는 Commit panel 사본이
  `localStorage`에 한 번 만들어 두는 16진 20자리다. 쓰기 잠금은 한 Herdr 앱 안에서만 줄을
  세우므로, 파일 이름이 하나면 다른 앱의 사본이 단계 사이에 같은 파일을 써서 틀린 트리가
  기록될 수 있다. 식별자가 없거나 16진이 아니면 기록도 Restore도 하지 않는다.
- 임시 인덱스는 끝나면 비운다. git만으로는 파일을 지울 수 없으므로, 그 저장소에서 Rollback이나
  Restore를 한 식별자마다 작은 파일 하나가 남는다.
- 만든 트리는 되돌릴 경로 밖이 HEAD와 같아야 한다. 다르면 기록도 Rollback도 하지 않는다.
- **Restore는 파일과 스테이징을 되살린다.** 수정됐던 파일은 그 내용으로, 삭제됐던 파일은 다시
  없는 상태로, 추가됐던 파일은 다시 있는 상태로 돌아온다. 그다음 되살린 경로의 인덱스 항목을 두
  번째 부모의 것으로 돌린다. 스테이징을 되살리는 것은 Rollback이 파일과 함께 스테이징도 HEAD로
  돌리기 때문이고, 되살린 뒤 `git status`가 Rollback 직전과 같아야 다음 커밋이 사람이 고른 그대로
  나가기 때문이다. 인덱스는 지금 HEAD의 항목(HEAD에 없는 경로는 항목 없음)일 때만, 그리고 기록의
  스테이징이 그때의 HEAD와 다를 때만 쓴다. 그사이 다른 내용을 스테이징했거나 충돌 중이던
  경로는 파일만 되살리고 인덱스를 그대로 둔 채 "스테이징만 못 되살린 경로"로 이유와 함께 알린다.
  `Intent:` 줄의 경로는 `add -N -f`로 다시 알린다(`.gitignore`에 걸린 파일도 `-f`로 알렸을 수
  있다). 인덱스 쓰기는 묶음마다 한 호출이고 한 호출은 전부 쓰거나 아무것도 쓰지 않는다. 인덱스
  읽기나 쓰기가 실패하면 그 묶음과 뒤 묶음의 경로를 "스테이징하기 전에 git이 실패했다"는 이유로
  같은 단락에 적고, 결과는 실패로 git의 글을 마지막 줄에 붙인다(git이 아무 글 없이 실패하면, 예를
  들어 시간 한도로 끊기면, 그 자리에 모듈의 대체 문구를 두고, 다른 모듈 문장처럼 화면의 언어로
  짓는다). 파일은 되살린 그대로다. 결과를
  오류 띠가 아니라 결과 줄로 보이는 것은 무엇이 되살아났는지가 그 결과의 요점이기 때문이다.
  두 번째 부모가 없는 기록(스테이징을 담기 전의 꼴, 커밋 없는 저장소의 기록)은 인덱스를 바꾸지
  않아서, 추가됐던 파일은 추적하지 않는 파일로 돌아온다. 기록은 Restore 뒤에도 남고, Restore는
  새 기록을 만들지 않는다.
- **그사이 바뀐 것은 덮지 않는다.** 경로마다 처음 맞는 이유로 건너뛰고 그 이유를 알린다: 이
  기록에 없는 경로, `assume-unchanged`나 `skip-worktree` 표시, 지금 HEAD의 내용이 기록의 부모와
  다름, 추가됐던 파일을 git이 지금 추적함, 수정·삭제됐던 파일의 작업 트리가 HEAD와 다름, 추가됐던
  파일 자리에 무언가 있음, git이 쓰다 실패해 파일이 HEAD와도 기록과도 다름. 건너뛴 경로는
  인덱스도 그대로다. 이와 따로, 파일은 되살렸지만 스테이징만 못 되살린 경로(지금 다른 내용이
  스테이징됨, 충돌 중이던 경로)를 결과의 다른 단락에 적는다.
- **되살린 것으로 세는 경우.** 추가됐던 파일 자리에 git이 기록과 같게 기록할 파일이 이미 있으면
  쓰지 않고 되살린 것으로 센다. "Delete local copies of added files"를 끄고 롤백하면 새 파일이
  디스크에 그대로 남기 때문이다.
- 무엇이 같은 자리인지는 디스크가 정한다. 대소문자나 유니코드 형태만 다른 이름을 맞혀 보지
  않고, 있는 것을 덮지 않는 방식(`--force` 없는 `checkout-index`)으로 써서 git이 거부하게 한다.
- 보관은 git의 reflog 정리를 따른다. ref가 더 가리키지 않는 기록은 기본 30일 뒤 gc 때 사라지고,
  가장 최근 기록은 ref가 가리키는 동안 남는다. mod는 기록을 지우지 않는다.

### 지운 브랜치의 Restore

- Delete는 로컬 브랜치만 한다. 다른 로컬 브랜치, 원격 브랜치, 태그, HEAD 어디에도 없는 커밋이
  있으면 그 수를 알리고 확인을 받은 뒤에 지운다.
- **지우기 전에 저장소에 기록한다**([ADR 0003](adr/0003-deleted-branches-in-a-reflog.md)). 숨은 ref
  `refs/git-tools/deleted-branches`를 그 브랜치의 커밋으로 옮겨 reflog에 이름과 추적 정보를 남기고,
  곧바로 HEAD 역사의 뿌리 커밋으로 되돌려 세운다. 지운 커밋은 그 reflog에만 남아서
  `git log --all`, 브랜치 목록, 태그 목록에 나오지 않는다. 기록하지 못하면 지우지 않는다. 기록은
  저장소 안에 있으므로 다른 worktree와 그 저장소를 연 다른 Herdr에서도 같은 목록이 보인다.
- **다른 worktree가 체크아웃한 브랜치는 기록하기 전에 거부한다**(`for-each-ref`의
  `%(worktreepath)`, git 2.23 이상). git이 `branch -D`를 거부할 브랜치를 기록해 두면, 그 브랜치가
  움직였을 때 지운 적 없는 브랜치가 목록에 나오기 때문이다. 오류는 그 worktree의 경로를 말한다.
- **기록이 중간에 실패하면 ref를 세워 둘 커밋으로 되돌린다.** ref가 비켜 선 커밋(부모 없는
  `git-tools: deleted-branches`)에 남으면 `git log --all`에 보이기 때문이다. 그다음 실패를 알리고
  지우지 않는다.
- 되살리는 길은 둘이다. 지운 직후 Log panel 아래 알림 줄의 Restore는 그 Log panel 사본이
  마지막으로 지운 하나를 되살린다. Branch tree 툴바의 Deleted Branches dialog는 reflog를 최신순으로
  50개까지 읽어 여러 개를 골라 되살린다. 같은 이름·같은 해시는 한 줄이고, 같은 이름의 브랜치가
  지금 같은 커밋에 있으면 목록에서 빠지며, 다른 커밋에 있으면 고를 수 없게 이유와 함께 보인다.
  창에서 되살린 브랜치가 알림 줄의 브랜치면 알림 줄도 지운다.
- 되살리기는 `update-ref refs/heads/<이름> <해시> ""`를 쓴다. 빈 옛 값은 "없을 때만"을 뜻하므로
  같은 이름이 생겼으면 덮지 않는다. `git branch`는 `-f` 같은 이름을 거부하므로 쓰지 않는다. 여러
  개를 되살릴 때 하나가 실패해도 나머지는 계속한다.
- 추적 브랜치는 `branch -D` 전에 읽어 두었다가 `branch.<이름>.remote`와 `.merge`로 되돌린다.
  체크아웃은 하지 않는다. 여러 개를 되살릴 때 되살렸는지는 `update-ref`의 결과로 가른다.
  브랜치는 만들었는데 추적 설정만 실패하면 되살린 수에 넣고 "추적 브랜치는 되돌리지 못한 브랜치"
  단락에 git의 글과 함께 적는다. 브랜치가 있는지로 가르면 "같은 이름이 지금 있다"로 잘못
  알리고, 목록에서도 빠져 추적이 빠진 것을 알 길이 없기 때문이다. Deleted Branches dialog는 이
  결과도 오류 띠가 아니라 결과 줄로 보인다.
- 보관은 git의 reflog 정리를 따른다. ref가 더 닿지 않는 커밋이라 `gc.reflogExpireUnreachable`(기본
  30일) 뒤 gc가 돌 때 사라진다. mod는 기록을 지우지 않고 저장소 설정을 바꾸지 않는다.

### git 동작의 공통 바탕

- **동작 모듈 하나**(`git-operation.js`)가 Operation in progress를 읽고, merge·rebase·체크아웃하고
  리베이스·cherry-pick·revert와 Continue·Abort·Skip을 실행한다. 결과는 한 꼴이다(`outcome`):
  `done`(끝남), `stopped`(충돌이나 편집 중단으로 멈춤, 뒤의 진행 중 상태 포함), `empty`(빈
  cherry-pick·revert), `refused`(로컬 변경이 막음, 막는 파일 `blocked`와 다시 돌릴 `request`),
  `failed`(그 밖, git의 글). pull·업데이트(`git-remote.js`)와 다시 쓰기(`git-rewrite.js`)도 같은 꼴로
  돌려준다. 동작별 git의 차이(종료 코드, 상태 파일, 편집기, sequencer)는 모두 이 뒤에 숨는다.
- **git의 문구로 판단하지 않는다.** git의 출력은 사용자의 로캘로 나온다. 끝났는지, 멈췄는지,
  무엇이 막았는지는 종료 코드, 상태 파일, `status --porcelain=v2`, 실행 전후의 HEAD로 가른다(`settle`).
  종료 코드만으로는 알 수 없다: 빈 cherry-pick은 충돌 없는 exit 1이고, `rebase -i`의 edit은 exit 0으로
  멈춘다. git의 글은 보여 주기만 한다.
- **상태 파일**은 `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`,
  `sequencer`를 `rev-parse --absolute-git-dir --git-path …`로 찾고, git 폴더 안에서
  `git grep --no-index`로 읽는다. 그래서 연결된 worktree에서도 맞고 읽기가 `.git` 아래를 고치지
  않는다. `ORIG_HEAD`와 `AUTO_MERGE`는 지난 동작이 남긴 것일 수 있어 보지 않는다. stash 적용이
  충돌한 상태는 git이 진행 중 표시를 남기지 않으므로 "진행 중 없음 + 충돌 파일"로 읽는다.
- **편집기를 띄우지 않는다.** 이어가기와 다시 쌓기는 모두 `GIT_EDITOR=true`로 돈다.
  `merge --continue`와 `rebase --continue`는 비대화식에서도 편집기를 띄우기 때문이다. 메시지는
  mod가 인자나 변수로 넘긴다. merge의 Continue는 경로 없는 `commit -m`, cherry-pick·revert는 커밋 뒤
  sequencer가 있으면 `--continue`, rebase는 `--continue`(메시지를 바꿨으면 그 메시지로)다. 해결 결과가
  비면 `--skip`으로 정리한다.
- **빈 cherry-pick은 진행 중 상태를 남기지 않는다.** `--skip`으로 정리하고 알림으로 알린다.
- **원격과 주고받는 동작**(fetch, pull, 업데이트, 여기까지 푸시, 태그 푸시, 원격 편집 뒤 fetch)은 모두
  `GIT_TERMINAL_PROMPT=0`으로 돈다. 비밀번호를 칠 곳이 없으므로 묻는 원격은 기다리지 않고 git의
  글과 "credential helper나 SSH agent를 설정한다"는 안내로 실패한다. 시간 한도는 fetch가 5분,
  merge·rebase 단계와 푸시처럼 훅을 돌릴 수 있는 단계가 10분이다.
- **사용자의 git 설정은 그대로 둔다.** `pull.rebase`, `rebase.updateRefs`, `commit.gpgSign`, 훅은 git이
  따르는 대로 따른다. 옵션 없이 갈라진 브랜치를 풀하면 git이 "어떻게 합칠지 지정하라"고 실패하는
  것도 그대로 보인다.
- **보이는 자리.** 진행 중 상태는 VCS widget("⚠ main 병합 중", 초록 ≫, 빨간 ■), Commit panel의 진행
  중 줄과 "충돌 병합" 노드, Log panel HEAD 줄의 "⚠ 분리된 HEAD"(rebase 중)에 같은 이름으로 보인다.
  이름은 현재 브랜치이고, 병합 대상은 `MERGE_MSG` 첫 줄의 이름(로컬 브랜치 우선)이다. ■은 확인
  창을 거친다. 터미널에서 시작한 동작도 같은 읽기로 보이고 화면의 Continue·Abort·Skip이 그대로
  쓰인다.

### 충돌 해결

- **판단과 쓰기를 나눈다.** 병합 덩어리 계산은 순수 모듈 `merge-chunks.js`, 두 창이 보일 것과 켜질
  것은 `conflicts-model.js`와 `merge-revisions-model.js`, 파일 쓰기는 `git-conflict.js`다. 창에는
  자동 테스트가 없기 때문이다.
- **"내 변경 내용"은 git의 ours(stage 2)다.** 단 rebase에서는 git의 theirs, 곧 다시 쌓는 커밋이다.
  rebase에서 ours는 다시 쌓을 바탕이라, 사람이 "내 것"이라고 여기는 쪽과 반대이기 때문이다.
- **한쪽 수락**은 그 판을 작업 파일과 인덱스에 쓴다(삭제된 쪽이면 지운다). 사람이 git이 남긴 뒤
  파일을 고쳤으면 덮어쓰기 확인을 거친다. "이미 고친 파일"은 충돌 블록마다 한쪽을 취한 글이 그
  쪽으로 취한 병합 결과와 양쪽 다 같지 않은 파일이다. 판정이 git이 아니라 `merge-chunks.js`와
  견주므로, 둘이 덩어리를 다르게 자르는 파일에서는 고치지 않았어도 한 번 더 물을 수 있다.
- **해결 되돌리기**는 git이 남긴 해결 기록을 쓴다(`update-index --unresolve` 뒤 `checkout -m`).
  충돌한 적 없는 경로에서는 git이 조용히 성공하므로 다시 읽어 거절한다.
- **모든 간단한 충돌 해결**은 간단한 덩어리(양쪽이 서로 다른 줄만 바꿈)만 있는 파일만 저장한다.
  한쪽 삭제, 이진, 진짜 충돌이 남은 파일은 그대로 둔다.
- **"승인하고 끝내기"는 창만 닫는다.** 동작을 잇는 것은 Commit panel의 커밋 버튼과 VCS widget의 ≫다.
  동작마다 이어가기 전에 할 일(메시지, 남은 커밋)이 달라서 한 길로 모은다.
- **Merge Revisions dialog의 가운데 칸은 그림이다.** Herdr 편집기는 줄 색을 칠하지 못하므로 덩어리
  색과 버튼을 직접 그린다. "결과 직접 편집"이 가운데를 색 없는 편집기로 바꾸고, 다시 누르면 고친
  글에서 그대로 남은 "같음" 덩어리를 닻으로 덩어리를 다시 나눈다. 글이 바뀐 덩어리는 해결된
  것으로 센다. 적용하면 경로순으로 다음 충돌 파일을 열고, 남은 파일이 없으면 닫는다.
- **이진으로 다루는 파일**: NUL 바이트, UTF-8이 아닌 글(`exec` 출력에 U+FFFD가 생기면 되쓸 때 바이트가
  바뀐다), `.gitattributes`에서 diff가 꺼진 파일, 링크, 서브모듈. 세 칸을 그리지 않고 수락 버튼 둘만
  보인다. 줄 끝(LF·CRLF)과 마지막 줄의 개행 유무는 결과에 보존한다.
- **결과 글을 쓰는 길.** 이 컴퓨터는 `writeTextFile`에 지금 내용을 기대값으로 넘긴다. 다른 머신은
  `exec`에 stdin이 없고 원격에 파일을 쓰는 API가 없으므로, 첫 조각은 `cp -p`로 만든 사본 위에 쓰고
  나머지를 96 KiB 조각으로 이어 쓴 뒤 `mv`로 바꾼다(Linux의 한 인자 한도는 128 KiB). 실패하면 임시
  파일을 지운다.
- 창은 2초마다 다시 읽고(터미널·편집기에서 고친 것), git-tools의 쓰기는 `changed`를 받는 즉시 다시
  읽는다. Merge Revisions dialog는 열린 동안 다시 읽지 않는다. 고른 결정을 잃기 때문이다.

### Smart operation

- **거절 판정은 mod가 한다.** 동작이 실패했고, 진행 중 상태가 생기지 않았고, HEAD가 그대로이고,
  그 동작이 건드릴 파일에 로컬 변경이 있으면 "거절"이다. git의 글을 읽지 않으려고 막는 파일을 직접
  계산한다(`git-smart.js`).
  - merge, pull(merge 방식), cherry-pick, revert: 로컬 변경 ∩ 그 동작이 바꿀 파일. 스테이징된
    변경이 하나라도 있으면 그 파일들도 더한다(git은 무관한 스테이징에도 거절한다).
  - rebase, pull(rebase 방식), 체크아웃하고 리베이스, 히스토리 다시 쓰기: 추적 파일의 로컬 변경 전부.
  - 체크아웃: 로컬 변경 ∩ 두 커밋 사이에서 다른 파일.
  - 추적하지 않는 파일은 세지 않는다. stash가 그 파일을 치우지 않기 때문이다.
- **Smart 실행**은 추적 파일의 작업 트리와 스테이징을 stash에 넣고(메시지
  `Uncommitted changes before <동작> at <YYYY-MM-DD HH:MM>`), 동작하고, `stash apply --index` 뒤 drop으로
  되돌린다. `--index`가 거절되면 `--index` 없이 다시 적용한다(스테이징은 잃고 변경은 남는다).
  `--autostash`는 쓰지 않는다. 적용이 충돌하면 git이 exit 0으로 끝나고 stash를 남기기 때문이다.
  stash에 넣기가 실패하면 동작하지 않는다.
- **동작이 멈추면** stash를 그대로 두고 표식(`gittools.smart-stash`)을 남긴다. 그 동작이 어디서든
  끝나거나 중단되면 Commit panel의 다음 새로고침이 "진행 중 없음 + 표식"을 보고 되돌린다. 표식은
  `config --fixed-value --unset`으로 먼저 지운 사본만 되돌려서 같은 stash를 두 번 적용하지 않는다.
  되돌리기가 충돌하면 stash는 목록에 남고 충돌은 Unstash 충돌로 Conflicts dialog에 보인다.
- **강제 체크아웃은 먼저 추적 변경 전부를 기록한다**(동작 이름 `Checkout`). `checkout --force`는 막지
  않는 파일과 스테이징한 새 파일까지 지우므로, 막는 파일만 기록하면 그 변경을 잃는다. 기록하지
  못하면 체크아웃하지 않는다.

### Stash

- **삭제와 팝은 번호로만 된다**(`drop <해시>`는 git이 거절한다). 그사이 번호가 바뀌었을 수 있으므로
  실행 직전에 목록을 다시 읽어 그 해시의 지금 `stash@{n}`을 찾고, 없으면 아무것도 하지 않고 이유를
  돌려준다. 적용은 해시로 바로 한다.
- **넣을 변경이 없으면** git이 exit 0으로 아무것도 만들지 않으므로, 목록이 늘었는지로 판단해
  "저장할 변경 사항이 없습니다"를 보인다.
- **줄의 브랜치는 stash 줄 글에서 읽는다.** `git stash list`의 `%gs`(`On <브랜치>: …`,
  `WIP on <브랜치>: …`)는 한국어 로캘에서도 영어다.
- `-u` stash의 추적 안 함 파일은 부모 없는 세 번째 부모 커밋에 있어, 그 커밋으로 Diff tab을 연다.
  새 브랜치로 적용은 `git stash branch`라 색인 복구와 팝이 따라온다.
- 적용·팝이 충돌하면 stash는 남고 Conflicts dialog(Unstash)가 뜬다. stash 목록은 worktree끼리
  공유되므로 Stash tab은 다른 루트의 `changed`와 10초 새로고침에서도 다시 읽는다.

### Merge, Rebase, Pull, 업데이트

- **브랜치 메뉴의 바로 실행**(병합, 리베이스, 체크아웃하고 리베이스, 체크아웃 후 업데이트, 업데이트,
  원격 브랜치의 풀 처리)은 창 없이 돈다. 병합…·리베이스…·풀… 창은 옵션을 고를 때 쓴다. 대상은
  `--end-of-options` 뒤에, 새 베이스는 `--onto=<값>`으로 넘긴다.
- 리베이스… 창에는 `--interactive`와 `--autosquash`가 없다. 편집기 없이 돌면 그냥 일반 리베이스가
  되기 때문이다. 대화식 리베이스는 커밋 리베이스 창이 한다. `--update-refs`는 git 2.38부터 있어 그보다
  오래된 git에서는 git의 오류로 실패한다(하한은 그대로 2.37).
- 원격 브랜치에서 체크아웃하고 리베이스는 로컬이 없으면 추적 브랜치를 만든 뒤 돈다. 추적 파일에
  변경이 있으면 브랜치를 만들지 않고 거절한다.
- **pull은 fetch를 먼저 따로 한다**(`fetch <원격>` 5분 뒤 `pull [옵션] --end-of-options <원격>
  refs/heads/<브랜치>` 10분). fetch 실패(자격 증명 안내 대상)를 merge 단계 실패와 git의 글 없이
  가르기 위해서다. 대가로 네트워크 왕복이 한 번 는다. 실패해도 fetch가 원격 브랜치를 옮겼을 수
  있으므로 `changed`를 알린다. 풀 창은 고른 원격 브랜치를 머신·루트·브랜치마다 기억한다.
- **현재 아닌 브랜치 업데이트**는 `fetch . <추적 ref>:refs/heads/<브랜치>`다. git이 빨리 감기가 아닌
  갱신과 어느 worktree에든 체크아웃된 브랜치를 거절한다. 체크아웃 후 업데이트는 갈라졌으면
  체크아웃도 하지 않는다.
- **프로젝트 업데이트**는 모든 원격을 fetch한 뒤 현재 브랜치에 추적 브랜치를 고른 방법(병합·
  리베이스)으로 반영하고, 로컬 변경은 Smart operation으로 치워 둔다. "다시 표시 안 함"을 켜면 다음부터
  창 없이 마지막 방법으로 하고, VCS Operations popup에서 Option을 누른 채 고르면 창이 다시 뜬다.
  "원격 브랜치로 재설정"은 확인 뒤 하드 전 기록을 남기고 추적 브랜치로 하드 reset한다. 추적 브랜치가
  없거나 HEAD가 분리됐으면 반영하지 않고 이유를 알린다.
- **Update Info tab**은 업데이트 전후 사이의 커밋을 `log --cherry-pick --right-only <전>...<후>`로
  보이고 파일 수는 `diff --name-only`로 센다. Smart로 다시 돈 pull은 이 탭을 열지 않는다.

### Cherry-Pick과 Revert Commit

- 고른 커밋은 Commit list 순서(새 것부터)로 받는다. cherry-pick은 순서를 뒤집어 오래된 것부터, revert는
  그대로 새 것부터 넘긴다. git은 날짜로 정렬하지 않고 넘긴 순서대로 적용한다. `-x`는 붙이지 않고
  커밋마다 바로 커밋한다. 이미 적용된 커밋은 건너뛰고 알린다.
- merge 커밋과 현재 브랜치에 이미 있는 커밋에서는 꺼진다. 진행 중 동작이 있으면 거절한다.
- **파일 단위**(`git-changes.js`)는 고른 파일만 바꾸는 커밋을 임시 인덱스
  `<git 폴더>/git-tools-changes-index`(쓴 뒤 비운다)로 만들고 `cherry-pick --no-commit`으로 3-way
  적용한다. 되돌리기도 "거꾸로 만든 커밋"을 cherry-pick한다. `revert -n`은 충돌하면 `REVERT_HEAD`를
  남겨 진행 중으로 보이기 때문이다. 되돌리기는 바뀐 파일만 `commit --only`로 커밋하고, 체리픽은
  커밋하지 않고 스테이징된 채 둔다(변경 목록이 없으므로 창 없이 로컬 변경으로).

### Reset과 하드 전 기록

- reset은 `git-reset.js`가 한다: 소프트, 혼합, 하드, 유지. 유지가 거절되면 아무것도 바뀌지 않고 git의
  글을 보인다.
- **로컬 변경을 지우는 쓰기 앞에는 기록을 남긴다**: 하드 reset(`Reset: N files`), 강제 체크아웃
  (`Checkout: N files`), 원격 브랜치로 재설정. 경로는 로컬 변경 전부(`diff HEAD`와 `diff --cached HEAD`의
  합)이고 추적 안 함 파일은 뺀다(그 쓰기들이 지우지 않는다). 기록하지 못하면 그 쓰기를 하지 않는다.
- 기록의 첫 부모가 지금 HEAD와 다르면 Restore는 기록 전체를 `stash apply --index <기록>`으로 한 번에
  3-way 적용한다. 그런 기록은 Restore dialog에서 경로를 고를 수 없다. 꼴과 이유는
  [ADR 0002](adr/0002-rollback-snapshots-in-a-private-ref.md)에 있다.

### 히스토리 다시 쓰기

- 메시지 편집, 커밋 삭제, 커밋 스쿼시, 픽스업·다음으로 스쿼시, 파일 단위 추출·삭제, 대화식 리베이스는
  모두 한 길로 다시 쌓는다: `rebase-plan.js`가 동작 목록을 할 일 목록으로 바꾸고 `git-rewrite.js`가
  `git rebase -i`에 넣는다. 메시지와 경로는 `exec` 줄이 변수로 받는다. 이유와 대안은
  [ADR 0004](adr/0004-rewrite-through-one-rebase-plan.md)에 있다. HEAD 하나의 메시지 편집은
  `commit --amend --only -m`, 커밋 실행 취소는 `reset --soft`라 다시 쌓지 않는다.
- **편집 판정은 순수 모듈이다**(`rebase-plan.js`의 `editCheck`, 사실은 `git-rewrite.js`의
  `readEditFacts`가 읽는다). 메뉴를 열 때 읽어 꺼진 항목에 사유를 보인다. 꺼지는 경우: merge 커밋,
  현재 브랜치 밖, 진행 중 동작, 보호 브랜치에 푸시됨(현재 브랜치의 추적 원격 브랜치가 Protected
  branch이고 그 커밋이 거기서 닿음, HEAD 커밋 포함), 다시 쌓는 범위에 merge 커밋, 실행 취소는 마지막
  커밋에서만(첫 커밋은 막음), 픽스업·다음으로 스쿼시는 로컬 변경이 없을 때(추적 안 함 파일도
  변경으로 센다, Commit panel이 그 파일도 커밋하므로), 커밋 스쿼시는 둘 이상 고를 때만, 파일 단위
  추출·삭제는 커밋의 파일을 모두 고르면. 첫 커밋 편집은 막지 않고 확인을 거친다.
- **픽스업·다음으로 스쿼시**는 Commit panel을 그 커밋을 대상으로 하는 상태로 바꾼다. 버튼이 체크한
  파일을 `fixup! <제목>`(`squash!`) 커밋으로 만든 뒤 mod의 할 일 목록으로 대상 바로 뒤에 합친다.
  멈춘 뒤 Abort하면 그 커밋이 남고, git의 `--autosquash`가 알아보는 꼴이다.
- **파일 단위 추출**은 추출한 커밋을 원래 커밋 뒤에 두고 원래 작성자를 쓴다. 경로는 `GITTOOLS_PATHS_n`
  변수에 한 줄에 하나씩 넣고 `GIT_LITERAL_PATHSPECS=1 git restore --pathspec-from-file=-`로 쓴다.
- 스쿼시 결과는 가장 오래된 커밋 자리에 두고 그 작성자를 쓴다. 이미 원격에 있는 커밋을 고치면 다음
  푸시가 강제 푸시가 된다고 창에 알린다.
- 대화식 리베이스의 시작은 넘긴 목록이 고른 커밋부터 HEAD까지와 같은지 확인하고, 그사이 바뀌었으면
  거절한다. 모두 삭제하면 할 일 없음 확인 뒤 고른 커밋의 부모로 간다. 편집 중단(edit)에서 멈추면 rebase
  진행 중이 되고, VCS widget과 Commit panel에서 잇거나 중단한다.

### 태그, 브랜치 이름 변경, 여기까지 푸시, 원격

- 새 태그는 가벼운 태그(`tag --end-of-options <이름> <해시>`), 이름 변경은 `branch -m`이다. 같은 이름이나
  틀린 이름은 git의 거절을 보인다. 추적 설정은 git이 함께 옮긴다.
- **여기까지 푸시**는 Push dialog를 그 커밋까지로 연다(`push … <해시>:refs/heads/<대상>`). 해시를
  소스로 푸시하면 `--set-upstream`이 추적을 설정하지 않으므로, 추적이 없던 브랜치는 성공 뒤
  `branch --set-upstream-to`를 따로 부른다. 푸시 직전 다시 읽기와 Force Push 규칙은 보통 푸시와 같다.
- 원격 편집은 `remote rename`·`set-url` 뒤 "원격으로 가져오기"가 켜져 있으면 그 원격만
  `fetch --prune`한다. 원격 제거는 그 원격 추적 브랜치도 git이 지운다. 태그 푸시는
  `push <원격> refs/tags/T:refs/tags/T`다.
- 추적된 브랜치와 태그 푸시의 하위 메뉴는 두 번째 메뉴로 연다. 팝업 메뉴에 하위 메뉴가 없기 때문이다.

### 비교와 보기 탭

- **같은 종류의 탭은 하나다.** `space-tabs.js`의 `openSpaceTab`이 보이는 space에서 탭 이름 틀로 찾아,
  있으면 새 탭을 먼저 열고 옛 탭을 닫는다. space의 마지막 탭을 닫으면 space가 닫히기 때문이다. 그래서
  새 탭은 옛 자리에 오지 않는다. 탭 정보에 props가 없어 이름으로 찾으므로, 사용자가 이름을 바꾼 탭은
  다른 탭이 된다.
- 작업 트리 비교는 git이 추적하는 파일만 본다(`git diff <ref>`). 브랜치 비교는 현재 브랜치를 먼저 둔다.
- **가져오기**(리비전에서, 브랜치에서)는 그 판의 파일로 작업 트리와 인덱스를 바꾸고, 판에 없는 파일은
  `git rm`으로 지운다. 로컬 변경이 있는 경로만 먼저 Rollback snapshot으로 남기고, 남기지 못하면 아무것도
  바꾸지 않는다.
- **패치**는 `git diff --output`으로 space의 머신에 쓴다(`--binary -M --no-ext-diff --no-textconv`).
  첫 커밋은 빈 트리와 비교한다. 베이스 경로가 저장소 루트면 그대로, 저장소를 담은 폴더면 그 사이
  폴더가 경로 앞에 붙고, 저장소 안 폴더면 `--relative`, 그 밖이면 거절한다. 떨어진 여러 커밋의 패치는
  가장 오래된 커밋의 부모부터 가장 새 커밋까지라 사이의 고르지 않은 커밋도 들어간다.
- 하위 커밋은 Log가 보이는 범위(`--branches --remotes --tags HEAD`, 브랜치를 골랐으면 그 브랜치)에서
  찾고, 여럿이면 고르는 팝업을 연다.
- 소스 편집은 mod가 파일을 열 편집기가 없어 읽기 전용 미리보기 탭으로 연다.

### Branch tree의 순서와 즐겨찾기

- 순서는 현재 → Favorite branch → 이름순이고 원격도 같다(`branch-order.js`). VCS widget 팝업도 같은
  순서와 별을 보인다. 팝업은 읽기만 하는 설계라 팝업의 별은 보이기만 한다.
- main·master는 처음부터 Favorite branch다. 사용자가 풀면 `gittools.unfavorite`에 남는다.
- 내 브랜치 표시는 `user.email`의 커밋을 하나라도 담은 브랜치만 보인다(`for-each-ref --contains`).
  `user.email`이 없으면 설정하라는 안내만 보인다.
- 패널 설정(한 번 클릭, 디렉터리별 그룹화, 태그 표시, 내 브랜치, 숨김)은 앱 설정 `branchTree`에 둔다.
  숨기면 툴바 폭(30px)만 남는다.

### Commit list의 그래프와 표시 옵션

- 값은 앱 설정 `log.options` 하나다. 잘못된 값은 항목마다 기본값으로 돌아간다. 저장한 뒤 버스 사건
  `log-options`로 다른 Log panel이 다시 읽는다.
- 정렬과 첫 번째 상위 항목은 `git log` 인자다. 병합 없음은 git의 `--no-merges`가 부모를 다시 쓰지
  않으므로, 병합을 JS에서 빼고 그 첫 부모로 선을 잇는다.
- 선형 브랜치 접기는 부모 하나·자식 하나·Ref label 없는 커밋을 숨기고 숨긴 구간을 점선으로 그린다.
  긴 엣지를 끄면 30행 넘는 선은 양 끝 한 행만 그리고 끊긴 자리에 화살표를 둔다. Cherry-Pick된 커밋이
  아님은 다른 브랜치로 한정했을 때만 `git cherry HEAD <브랜치>`로 가른다.

### Git console

- 기록은 실행기(`makeGit`의 `record`)가 한 곳에서 남긴다. `READ` 명령과 주기 읽기는 남기지 않는다.
  시각, 저장소, 머신, 명령 줄, 종료 코드, 출력(4,000자에서 자름)을 앱 홈 `git-tools/console.jsonl`에 한
  줄씩 쌓고, 512 KiB를 넘으면 오래된 것부터 버린다. 한 사본의 순서를 지키려고 기록은 명령마다
  기다린다.
- 기록이 늘면 버스로 `console`만 알린다. 기록 자체는 공유 값에 넣지 않는다.
- 모든 실패 띠에 "콘솔에서 보기"가 있어 콘솔 탭을 고르거나 연다.

### VCS widget과 VCS Operations popup

- 위젯은 시작할 때, 따라가는 폴더가 바뀔 때, 그 저장소의 `changed`, 보이는 동안 10초마다 읽는다
  (`git-heads.js`의 `widgetFace`가 무엇을 보일지 정한다). 최근 브랜치는 HEAD reflog의
  `checkout: moving from X to Y`에서 최대 5개, 지금 있는 로컬 브랜치만이다. 팝업은 380×520 고정이고
  거르면 항목만 준다.
- VCS Operations popup의 항목 표는 `vcs-ops.js`의 `VCS_OPS`, 처리는 `view-vcs-ops.js`의 `VCS_ACTIONS`다.
  처리가 없는 항목은 보이지 않는다. 보이는 앞 10개에 1~9·0이 붙고, 꺼진 항목의 번호는 아무것도 고르지
  않는다. 팝업은 고른 것을 주인 패널에 버스로 답하고 그 패널이 실행한다(메뉴와 같은 방식). 푸시와
  롤백은 Commit panel만 처리하므로 Log panel이 주인이면 빠진다. 변경 내용 스태시 취소…는 가장 최근
  stash로 연다.
- 메뉴 막대 API가 없어 Git 메뉴 대신 이 팝업이 같은 항목을 모은다.

### Log의 읽기와 필터

- 커밋은 1,000개씩 읽고 끝에 가까워지면 다음 1,000개를 읽는다. 그래프는 앞 묶음의 레인 상태를
  이어받고, 그래프 부분은 Commit list 폭의 절반까지 넓어진 뒤 가로로 스크롤된다.
- 저장소, 브랜치 한정, 필터가 바뀐 첫 화면은 두 번 읽는다. 태그를 뺀 읽기를 먼저 보이고 전체
  읽기로 바꾼다. 태그가 아주 많은 저장소에서 전체 읽기는 느리기 때문이다. 다음 묶음은 전체 읽기
  뒤에만 이어 읽는다.
- 필터는 화면에서 거르지 않고 `git log` 인자로 만든다(`git-log-filter.js`의 `filterArgs`). 아직
  읽지 않은 커밋까지 걸러진다. 검색과 User는 git의 확장 정규식이고, 그냥 친 글자는 이스케이프한다.
  Date의 시작은 `--since-as-filter`여서 git 2.37 이상이 필요하다.
- **User 필터의 일치 규칙.** 목록에서 고른 이름은 `--author=^<이름> <`이어서 그 이름과 정확히
  같은 작성자만 건다. 직접 친 글자는 이름과 이메일의 일부로 찾는다. 여러 명을 고르면 그 가운데
  누구의 커밋이든 남는다.
- **대소문자.** git에는 `--grep`과 `--author`가 함께 쓰는 대소문자 스위치가 하나뿐이다. 고른
  이름만 있으면 스위치를 꺼서 대소문자까지 같은 이름만 건다. Match Case를 끈 검색이나 직접 친
  글자가 함께 걸리면 스위치가 켜져 고른 이름도 대소문자를 가리지 않는다.
- **`.mailmap` 이름.** 작성자 목록은 `log --use-mailmap --format=%aN%x00%aE`로 읽고, 필터에도
  `--use-mailmap`을 붙인다. git의 `--author`는 매핑된 이름에 맞추기 때문이다. Commit list,
  Commit details, Push dialog도 매핑된 이름(`%aN`)을 보여 주어 목록과 화면의 이름이 같다.
- 작성자 목록은 팝업을 열 때 읽고, 저장소마다 마지막 목록을 8개 저장소까지 Log panel 사본의
  인스턴스에 둔다.

### Diff tab

- **이름이 바뀐 파일.** Commit details는 이름 변경을 감지해(`diff-tree -M`) 옛 경로를 Diff tab에
  넘긴다. Diff tab은 경로로 묻지 않고 두 파일 자체를 비교한다
  (`git diff <부모>:<옛 경로> <커밋>:<경로>`). git이 둘을 다시 짝짓는지에 기대지 않으려는
  것이다. 부모에 그 경로가 없으면 보통의 커밋 파일처럼 읽는다. 이름만 바뀐 파일은 줄이 없다.
- **작업 파일은 파일을 따라간다.** 다시 읽는 때는 넷이다: 저장소 루트의 폴더 감시가 이 diff를
  바꿀 수 있는 변경을 알릴 때(이 컴퓨터만), 10초마다, 다른 사본이 git 쓰기를 알릴 때, Refresh.
  커밋의 diff는 바뀌지 않으므로 한 번만 읽는다.
- **어떤 변경이 이 diff를 바꾸는가**는 `git-diff.js`의 `touchesDiff`가 정한다. 그 파일, 그 위의
  폴더, 그 이름 아래의 경로(폴더가 그 자리를 차지함), 루트의 `.git` 아래(`objects` 제외. HEAD나
  브랜치가 움직였다)다. 루트 아래로 볼 수 없는 경로는 변경으로 친다. 감시가 "모두 다시 읽으라"는
  뜻으로 루트를 보내고, 다르게 적힌 경로는 판단할 수 없기 때문이다.
- **가려진 탭은 읽지 않는다.** 사본은 다른 탭 뒤에서도 살아 있고 타이머와 감시도 계속 돈다.
  그래서 감시와 타이머는 "마지막으로 읽은 뒤 그려진 탭"만 다시 읽는다. 읽기는 언제나 다시
  그리기로 끝나므로 화면에 있는 탭은 다음에도 읽고, 가려진 탭은 표시만 해 두었다가 다시 보일
  때 한 번 읽는다.

### Files panel

- **폴더는 펼칠 때 읽는다.** 뿌리와 펼친 폴더만 `sh`(Windows의 이 컴퓨터는 PowerShell)로 읽고,
  폴더당 500개, 전체 5,000개까지 둔다. 아주 큰 폴더도 한도에서 읽기를 멈추므로, 잘릴 때 남는
  항목은 정렬 전 읽은 순서다. 폴더를 닫으면 그 아래 읽은 것을 버려 전체 한도의 자리를 돌려준다.
  `.git`은 보이지 않는다.
- **펼쳤지만 아직 읽지 못한 폴더 아래에는 "로드 중" 줄이 있다.** 판단은 순수 모듈
  (`visibleRows`)이 한다: 열렸고 항목이 아직 없고 읽기에 실패하지 않은 폴더. 키보드는 그 줄을
  건너뛴다. 읽기에 실패하거나 사라진 폴더는 아래가 비고 오류는 오류 띠에 보인다. 실패한 폴더에
  "로드 중"이 남으면 끝나지 않는 읽기처럼 보이기 때문이다.
- **권한이 없어 읽을 수 없는 폴더는 오류다.** `sh`의 목록은 권한이 없어도 항목 0개로 성공하므로,
  읽기 전에 읽기(`-r`)와 들어가기(`-x`) 권한을 보고 아니면 따로 알린다. 뿌리면 안내 자리에,
  펼친 폴더면 오류 띠에 "<폴더> 폴더를 읽을 권한이 없습니다"가 보인다. 문구는 그릴 때 짓는다
  (데이터 모듈은 언어를 모른다). PowerShell 쪽은 따로 가리지 않고 그 오류 글을 보인다.
- **닫은 폴더 읽기 오류는 그 오류가 이어지는 동안 다시 띄우지 않는다.** 새로고침은 실패한 폴더를
  모두 모으고, 순수 모듈(`stripFailure`)이 손으로 닫지 않은 첫 실패를 고른다. 같은 폴더의 같은
  오류만 닫힌 채로 남고, 다른 폴더나 바뀐 오류, 한 번 사라졌다 돌아온 오류는 다시 뜬다. 권한 없는
  폴더를 펼쳐 둔 채 띠를 닫아도 10초마다 다시 뜨지 않게 하려는 것이다. 폴더를 눌러 펼칠 때의 오류는
  닫은 적이 있어도 보이고(누른 사람이 물은 것이다), 그 오류는 닫힌 목록에서 빠져(`pressFailure`)
  다시 닫을 때까지 다음 새로고침에도 남는다.
- **새로고침은 그동안 펼친 폴더의 읽기를 덮지 않는다.** 화면은 폴더별 읽기 결과 하나를 들고,
  새로고침은 마지막 기다림 뒤 곧바로 자기 결과에 그사이 펼쳐 읽은 폴더를 합쳐 갈아 끼운다
  (`keepPressed`). 새로고침이 git 표시를 기다리는 사이 끝난 펼침이 덮이면 펼친 폴더가 다음
  새로고침까지 빈 채로 보이기 때문이다. 잘림 표시도 폴더별 결과에서 다시 만든다. 단, 위의 폴더
  하나라도 읽기가 실패(권한, 사라짐)한 폴더의 결과는 옛 것이든 그사이 펼친 것이든 남기지 않는다.
  갈아 끼운 뒤에 끝난 펼침도 쓰기 전에 위의 폴더가 모두 읽혀 있는지 보고 아니면 버린다(`pressLands`).
  보이지 않는 폴더가 잘림 안내를 남기거나 다른 폴더의 몫을 줄이지 않게 하려는 것이다.
- **git 표시는 한 번의 `status`로 읽는다**(`--ignored=matching --untracked-files=normal`). 무시된
  폴더와 추적하지 않는 폴더가 한 줄로 와서 출력이 바뀐 파일 수 정도로 작다. 그 아래 경로의 표시는
  `files-tree.js`의 `markLookup`이 가장 가까운 조상 폴더로 정한다. 폴더의 점은 아래에 바뀐
  파일(삭제 포함, 무시 제외)이 있다는 뜻이다. 뿌리가 추적하지 않는 폴더나 무시된 폴더 안이면
  git은 그 폴더 한 줄만 내므로, 그 표시를 뿌리 자체의 표시(키 `""`)로 두고 안의 모든 경로가
  마지막 기본값으로 받는다. 더 가까운 표시가 있으면 그것이 이긴다.
- **git 읽기 실패는 보이지 않는다.** 지난 표시를 그대로 둔다. git의 오류는 Commit panel이
  보이고, git이 없는 머신에서 10초마다 오류가 뜨지 않게 하기 위해서다. 폴더 읽기 실패만 보인다.
- **읽기는 `.git` 아래를 고치지 않는다**(`READ`). 감시가 자기 읽기에 다시 깨지 않게 하기
  위해서다. 감시(이 컴퓨터만)와 10초 타이머로 다시 읽고, 패널이 가려진 동안에도 읽는다.
- **찾기 목록은 찾기를 시작할 때 읽는다**(찾는 중 폴더가 바뀌면 다시). 찾는 동안 새로고침(감시,
  10초 타이머)이 오면 마지막 목록이 들어온 지 10초가 지났을 때만 다시 읽고, 새 목록이 올 때까지
  옛 결과를 그대로 보인다. 다시 읽기가 실패하면 옛 목록을 둔다. 저장소 밖의 20,000개 훑기를 감시
  이벤트마다 돌리지 않고, 결과가 "로드 중"으로 깜박이지 않게 하려는 것이다.
- 저장소 안은 추적 파일(`ls-files --cached`)과 새 파일(`ls-files --others --exclude-standard`)을
  따로 읽어 이어 붙이고, 디스크에서 지운 것과 서브모듈을 뺀다. 서브모듈은 `.gitmodules`가 이름한
  경로만 `ls-files --stage`로 찾아 모드 `160000`인 것이다. 색인 전체의 모드를 읽으면 경로마다 약
  50바이트가 더 붙어 큰 저장소에서 출력 한도에 일찍 닿기 때문이다. `.gitmodules`가 이름하지 않은
  gitlink(`.gitmodules` 없이 더한 중첩 저장소, 깨졌거나 작업 트리에서 지워진 `.gitmodules`)는
  걸러지지 않고 파일처럼 나온다.
  저장소 밖은 폴더를 직접 훑는다(`.git` 제외, 폴더 링크를 따라가지 않음). 어느 쪽이든 20,000개에서
  자르고 잘렸다고 알린다. 저장소 안에서는 추적 파일(경로순)이 먼저 남고 새 파일은 그 뒤다.
  `.gitignore`에 빠진 생성 폴더가 새 파일 수만 개를 내도 추적 파일이 밀려나지 않게 하려는 것이다
  (`--cached --others`를 한 번에 읽으면 git이 새 파일을 먼저 낸다). 순위는 경로의
  일부를 대소문자 없이 찾고, 파일 이름에 든 것이 먼저, 각각 경로순, 200개까지다.
- **미리보기는 `readTextFile`로 읽는다.** 1 MiB보다 큰 파일과 읽을 수 없는 파일은 미리 볼 수 없다고
  하고, NUL이 든 파일은 이진 파일로 본다. 400,000자에서 자른다.
- **구문 색은 파일 이름으로 고른다** (`editor-language.js`의 `editorLanguage`). Herdr 편집기는
  syntect 기본 문법 묶음만 갖고 있고, 언어 이름을 그 문법들의 확장자로 찾는다. 묶음에 없는 흔한
  형식은 가장 가까운 문법을 빌린다: HCL(`.tf`, `.hcl`)·Elixir·Julia·CoffeeScript는 Ruby,
  `.env`·Dockerfile·ignore 파일·CMake·PowerShell·GraphQL·`.conf`는 셸, INI·`.gitconfig`·
  `.editorconfig`는 Java Properties, TOML은 YAML, Kotlin은 Scala, Swift·Protocol Buffers는 Go,
  Dart는 Java, Zig는 Rust, F#은 OCaml, Elm은 Haskell, 셰이더는 C, SCSS·LESS는 CSS, 템플릿
  (Astro, Handlebars, Jinja 등)은 HTML, Starlark(Bazel)는 Python. 빌린 문법은 주석·문자열·숫자를
  맞게 칠하고, 키워드는 두 언어가 같은 것만 칠한다. 이름으로 정하는 파일(`Makefile`,
  `Gemfile`, `Dockerfile`, `.bashrc`, `BUILD.bazel` 등)은 확장자보다 먼저 본다.
- **Show Diff**는 git 표시가 있는 파일에만 있고, Commit panel의 작업 파일과 같은 Diff tab(HEAD →
  작업 트리)을 연다. Reveal in Finder는 macOS 창이고 space가 이 컴퓨터일 때만 있다(`open -R`).
- 키보드는 줄이나 찾기 칸을 누른 뒤에 받는다. mod가 `focusable`이 아니어서 Herdr가 키보드를
  넘겨주지 않기 때문이다.

### Icon theme

- 출처는 Atom Material Icons(`AtomMaterialUI/iconGenerator`, MIT)의 커밋
  `90e051eecb393c6380be18a1941c3096170c15d6`이다. 라이선스 전문과 출처는
  `mods/git-tools/icons/theme/` 폴더의 `LICENSE`와 `NOTICE.md`에 있다.
- **고르는 규칙.** 이름 **전체**에 맞는 규칙 가운데 우선순위 숫자가 가장 큰 것이 이기고, 같으면
  원본에서 먼저 나온 규칙이 이긴다. `/`가 든 규칙은 저장소 기준 경로에 맞춘다. `ANGULAR` 묶음은
  뺀다. 맞는 규칙이 없으면 기본 `file`·`folder` 아이콘이다. 예: `package.json`은 JSON(1)보다
  NPM(100).
- **생성물.** `tools/gen-icon-theme.mjs`가 고정 커밋의 압축을 푼 폴더를 받아 `icons/theme/`과
  `icon-theme-data.js`를 만든다. 내려받지 않고, 규칙 파일 둘의 SHA-256이 다르면 거부하며, 같은
  입력에는 같은 바이트를 쓴다. 생성물은 커밋하고 손으로 고치지 않는다. 잘못 그려지는 아이콘은
  `icon-theme.js`의 `DEFAULT_EXCLUDE`에 그 규칙의 이름을 넣어 기본 아이콘으로 돌린다. 지금은
  `Zeit Now Ignore` 하나다. 거의 검은 아이콘인데 어두운 배경용 변형이 없다.
- **조회 힌트.** 생성기가 규칙의 패턴을 읽어 규칙마다 `names`(맞을 수 있는 이름 전부),
  `exts`(끝 확장자), `sure`, `needles`, `path`, `rank`를 싣는다. mod는 패턴을 해석하지 않고
  규칙을 이름과 확장자 아래에 순위대로 꽂아 둘 뿐이다. 조회는 그 이름과 끝 확장자 아래의 규칙과
  힌트 없는 규칙만, 순위대로, 필요할 때 만든 정규식으로 시험한다. 결과는 이름마다 기억한다.
- **변형.** 열린 폴더는 `foldersOpen/`의 아이콘이다(`plastic`은 닫힌 것뿐이다). `_dark` 변형이
  있는 파일 아이콘은 행이 칠해진 배경색이 어두울 때 쓴다. 배경의 상대 휘도가 약 0.179 아래면
  어둡다고 본다. Herdr의 밝음·어두움 설정은 그 색을 읽지 못할 때만 쓴다. 설정과 실제 배경색이
  다를 수 있기 때문이다.
- 변경 파일 트리, Files panel의 트리와 찾기 결과, Diff tab의 머리줄에 쓴다. 버튼, 메뉴, Branch tree의
  행과 폴더는 아래 UI icon이다.

### UI icon

- 출처는 같은 저자의 `AtomMaterialUI/a-file-icon-idea` 커밋
  `12c2ce7a0dd4c00f92437034417d44dfbc8f7976`(210.0.2), MIT다. 파일은 원본 바이트 그대로이고 원본의
  `common/src/main/resources/` 아래 경로를 그대로 쓴다. 라이선스와 출처는 `mods/git-tools/icons/ui/` 폴더의
  `LICENSE`와 `NOTICE.md`에 있다.
- 이름 → 파일, 컬러인지 글자색인지는 데이터다(`ui-icons.js`). `ui-icons.test.mjs`가 모든 파일이 있는지
  본다. 화면은 `uiGlyph`·`iconButton`으로만 그린다. `svg(icon(…))`는 spinner와 체크박스 표시에만 쓰고,
  테스트가 다른 자리를 막는다.
- **컬러**: 툴바·메뉴의 동작 아이콘과 브랜치 행(현재 브랜치, 브랜치, 태그, 별)은 파일의 색 그대로
  `image()`로 그린다. **글자색**: 트리 화살표, 폴더, 검색 칸 돋보기, 메뉴 체크는 같은 모양을 `svg()`로
  글자색에 칠한다.
- **꺼진 버튼**은 같은 모양을 `t.dim`에 opacity 0.5로 칠한다. mod에는 회색 필터가 없다. 컬러 아이콘은
  hover에 밝아지지 않는다.
- **크기**는 16px이고 버튼 칸은 24px다. 트리 화살표 자리도 16px라 폴더 행과 파일 행의 줄이 맞는다.
- 어두운 변형(`_dark`)이 있는 8개는 버튼 바탕(`t.background`)의 휘도로 고른다.
- 아이콘이 없는 동작은 가장 가까운 모양을 쓴다: Restore는 시계, 필터 지우기는 깔때기, pull은 들어오는
  업데이트, Unstash는 꺼내기, 가져오기는 업데이트. 받아 둔 묶음에 맞는 모양이 없는 자리(Merge Revisions
  dialog의 화살표와 덩어리 버튼, 커밋 리베이스 창의 위·아래·되돌리기)는 글자 버튼이다.

### 언어

- **판정.** 창이 있는 컴퓨터의 첫 번째 선호 언어가 `ko`로 시작하면 한국어, 그 밖은 영어다
  (`i18n.js`의 `pickLang`). macOS는 `defaults read -g AppleLanguages`, Linux는 `LC_ALL`,
  `LC_MESSAGES`, `LANG` 가운데 처음 설정된 값을 읽는다. Windows는
  `powershell -NoProfile -Command "(Get-UICulture).Name"`의 출력(표시 언어, `ko-KR` 꼴)을 읽고,
  빈 출력은 모름(null)이다. space가 다른 머신이어도 창의 컴퓨터를 읽는다. 플랫폼에 언어를 알려
  주는 API가 없어서 명령으로 읽는다. Windows의 판정은 실제 기기에서 확인하지 못했다.
- **모르는 것은 영어가 아니다.** 앱이 막 시작해 창 정보가 아직 없거나 명령이 실패하면
  `i18n.js`의 `systemLang`은 null을 돌려준다. 그때 사본은 쓰던 언어를 그대로 두고 1초, 3초,
  10초 뒤에 다시 묻는다. 이것을 영어로 확정하면 한국어 컴퓨터에서 앱을 켠 직후의 화면이
  영어로 굳는다.
- **처음 그리는 언어.** 사본은 `props.lang`이 있으면 그것으로 고정한다. 없으면 공유 값
  `git-tools.lang`으로 시작하고(처음이면 영어), 시스템 언어를 다시 읽어 다르면 바꿔 다시 그린다.
  한 사본이 읽어 공유 값이 바뀌면 고정되지 않은 다른 사본도 다음 `render`에서 그 언어로
  따라간다. 창과 팝업 메뉴는 연 쪽의 언어를 `props.lang`으로 받아 첫 프레임부터 그 언어다.
  탭은 props가 저장되므로 언어를 넣지 않고 스스로 읽는다.
- **문구 표.** 화면의 글자는 모두 `t(key, args)`에서 나온다. 표는 영역별 `messages-<영역>.js`이고,
  각 파일이 `en`과 `ko`를 같은 키와 같은 자리표시자로 내보낸다. 없는 키는 키 자체를 보여 준다.
- **git 모듈의 `msg`.** git 모듈이 스스로 짓는 문장은 영어 `err`(건너뛴 경로는 `reason`)에
  `msg: { key, args }`를 함께 돌려준다. 화면은 `msg`가 있으면 자기 언어로 짓고, 없으면 받은 글을
  그대로 보인다. git 자신의 출력은 번역하지 않는다.
- 브랜치 이름, 경로, 해시, 커밋 메시지, 작성자 이름, 그리고 `HEAD`, `Diff`, `Git`은 번역하지
  않는다. 저장되거나 props로 오가는 값(날짜 프리셋 `"Last 24 hours"` 등)은 언어와 관계없이
  영어다. 쓰기 잠금은 도는 일을 메시지 키로 실어서 각 사본이 자기 언어로 짓는다.

## 5. 플랫폼의 제약이 설계에 준 것

Herdr는 mod를 QuickJS로 돌린다. JIT가 없고, 한 호출이 너무 오래 걸리면 Herdr가 끊는다
(`git-tools did not load: interrupted`). 플랫폼의 사실은 [docs/herdr-mod-platform.md](herdr-mod-platform.md)
파일에 있다.

- **한 호출의 시간 한도.** 큰 일을 한 호출에 몰지 않는다. 점검 화면은 조회 속도를 잴 때
  `cx.timer.after(0, …)`로 단계를 나누고, 한 단계는 조회 16번까지, 4 ms가 지나면 다음 조회를
  시작하지 않는다. 아이콘 규칙을 꽂는 일은 `main.js`의 `init`에서 한 번 하고(`warmIcons`), 화면은
  보이는 행의 이름만 조회한다.
- **정규식.** QuickJS의 정규식은 캡처 그룹 255개를 넘으면 거부하고, 긴 선택지를 느리게 돈다.
  그래서 규칙을 하나의 큰 정규식으로 합치지 않고 규칙마다 자기 정규식을 필요할 때 만든다.
- **조회 표를 생성할 때 만드는 이유.** mod가 시작할 때 규칙의 패턴을 읽어 이름과 확장자를 뽑는
  일은 QuickJS에서 느려서, 느린 컴퓨터에서는 `init` 한 호출의 한도를 넘는다. 그래서 그 일은
  node에서 도는 생성기가 하고, mod는 결과를 받아 꽂기만 한다.
- **다시 불러오기의 비용.** mod 폴더의 파일을 하나 저장하면 모든 사본이 다시 불려 오고, 그때마다
  Herdr의 메모리가 늘어 줄지 않는다. 수십 번 쌓이면 모든 mod의 화면이 `out of memory`로 멈추고
  앱을 다시 시작해야 한다. 그래서 설치는 내용이 다른 파일만 쓴다.
- **`render` 안에서 하지 않는 일.** `render`는 Herdr 데이터가 바뀔 때마다 창 전체로 다시 돈다.
  그 안에서 `cx.notify()`는 예외를 던지고 `cx.spawn`은 첫 부분을 그 자리에서 돈다. 그래서 읽기
  시작, 저장소 이동 처리, 입력 상자를 다시 만드는 일은 `cx.timer.after`로 미룬다. 파싱, 트리,
  그래프, 라벨 맞추기는 데이터가 올 때 한 번 계산해 둔다.
- **목록.** 가상 리스트는 행 안에 핸들러를 달 수 없어서, 체크박스·펼침·선택이 있는 목록은
  `WindowedList`가 보이는 행만 직접 그리고 휠과 스크롤 막대를 처리한다. 줄 높이가 그려 봐야
  아는 커밋 메시지만 `gpui-kit`의 `list`를 쓴다.
- **`exec`.** stdin과 env 옵션이 없다. 경로와 메시지는 인자로 넘기고, 변수는 `env VAR=… git …`로
  넘긴다. Rollback은 경로를 한 호출에 1,000개, 60,000바이트까지로 나눈다. 기본 시간 한도는
  30초이고, 커밋·푸시·merge·rebase·pull 단계는 10분, fetch와 stash는 5분까지 기다린다. 할 일 목록과
  커밋 메시지도 같은 이유로 환경 변수로 건넨다([ADR 0004](adr/0004-rewrite-through-one-rebase-plan.md)).
- **팝업의 높이.** `kind: "popup"` 오버레이는 mod가 그린 내용의 높이를 따르고, 그 안의 `size_full()`·
  `flex_1()`은 0이 된다. 그래서 목록이 든 팝업(VCS widget 팝업, VCS Operations popup)은 칸마다 높이를
  px로 준다.
- **알림의 버튼은 하나다.** `notify`는 동작 하나만 받는다. 그래서 편집 중단·충돌 알림에 "계속 · 중단"
  두 버튼을 달지 못하고, 어디서 잇는지를 문장으로 알린다.
- **전역 키가 먼저 받는다.** Herdr 전역 키(F2의 탭 이름 바꾸기 등)는 mod의 `on_key_down`보다 먼저
  가져간다. 그래서 Branch tree의 이름 변경은 메뉴로만 한다.
- **메뉴 막대.** mod가 메뉴 막대에 항목을 넣는 API를 찾지 못했다. 그래서 git 메뉴는 VCS Operations
  popup이다. 팝업 메뉴에는 하위 메뉴가 없어 하위 메뉴는 두 번째 메뉴로 연다.
- **명령.** `git-tools.<명령>`은 보이는 모든 사본에 한꺼번에 가고 어느 사본을 뜻하는지 말할 수
  없다. 그래서 저장소를 바꾸는 명령은 `props.folder`로 연 사본이나
  `git config --local gittools.scripted true`인 저장소에서만 듣는다. Rollback을 실행하는 명령은
  없다.

## 6. 테스트

- **진짜 임시 저장소로 보는 git 모듈.** 테스트가 `mkdtemp`로 저장소를 만들고 함수를 부른 뒤,
  저장소의 상태(커밋에 든 파일, 인덱스, 작업 트리, ref, 원격)를 git으로 다시 읽어 확인한다.
  어떤 git 명령을 불렀는지는 보지 않는다. 예외는 "옵션 없는 `--force`를 만들지 않는다"는
  규칙으로, 실행 인자를 기록해 확인한다. 푸시는 로컬 bare 저장소를 원격으로 쓴다.
  잡는 실패: 엉뚱한 파일이 커밋됨, 스테이징이 망가짐, Protected branch에 강제 푸시가 나감, 롤백이
  다른 파일을 건드림, 기록에 틀린 내용이 들어가거나 브랜치·태그에 섞임, Restore가 그사이 고친
  파일이나 스테이징을 덮음, Restore 뒤 `git status`가 Rollback 직전과 다름, 지운 브랜치가 다른
  커밋이나 추적으로 돌아옴, 지운 브랜치가 기록되지 않았는데 지워짐, 지운 커밋이 `git log --all`에
  보임, 필터가 틀린 커밋을 돌려줌, 지난 커밋 묶음의 파일이 틀림, Files panel의 git 표시·폴더
  읽기·찾기 목록이 틀리거나 읽기가 `.git` 아래를 고침.
  지운 브랜치의 보관은 `GIT_COMMITTER_DATE`를 넣어 29일·31일 전 기록을 만들고 git의 기본 정리를
  돌려 본다. Files panel의 폴더 읽기와 찾기 훑기는 node가 도는 컴퓨터의 `sh` 길만 테스트한다.
- **git 동작의 테스트.** 같은 방식으로 저장소 상태(작업 트리, 인덱스, ref, reflog, stash, 상태 파일)를
  다시 읽는다. 테스트 파일은 맨 위에서 `GIT_CONFIG_GLOBAL=/dev/null`과 `GIT_CONFIG_NOSYSTEM=1`을 걸어
  사용자 설정을 받지 않고, `rebase.updateRefs`·`pull.rebase` 같은 경우는 저장소 설정으로 따로 켠다.
  "편집기를 띄우지 않는다"는 `core.editor`와 `GIT_EDITOR`를 실패하는 명령으로 둔 저장소에서 결과로
  본다. 동작 모듈과 충돌 모듈 테스트는 한국어 로캘과 `C` 로캘에서 같게 통과한다. 원격 쓰기 길은 이
  컴퓨터의 `sh`로 300 KB 글을 같은 바이트로 쓰는지 본다.
  잡는 실패: 진행 중 상태를 잘못 읽음, 끝났는데 멈춘 것으로 봄(또는 반대), 편집기를 기다리다 멈춤,
  로컬 변경 거절을 잘못 가름, 충돌 표시가 커밋됨, Abort가 시작 전으로 안 돌아감, Smart가 변경이나
  스테이징을 잃음, stash를 엉뚱한 번호로 지움, reset 모드가 틀림, 하드 전 기록 없이 지움, 3-way 적용이
  변경을 잃음, 다시 쌓기가 틀린 히스토리나 메시지를 냄(따옴표·줄바꿈·`$`가 든 메시지 포함), pull과
  업데이트가 틀린 위치로 감, 묻는 원격에서 기다림, 비교·패치·가져오기의 파일이 틀림, 새 워크트리가
  쓰이는 브랜치를 받음, 콘솔 기록이 빠지거나 섞임.
- **순수 계산.** 그래프 레인, 트리와 3상태 체크, 버스와 잠금 값, 레이아웃 변환, 아이콘 조회, 언어
  판정과 문구, Files panel의 보이는 줄·무시와 점 판정·찾기 순위·키 이동(`files-tree.test.mjs`), 병합
  덩어리와 두 충돌 창의 판단, 리베이스 계획과 편집 판정, Log panel의 메뉴 표와 여러 커밋 고르기, 그래프·
  표시 옵션의 기본값, 브랜치 순서, VCS Operations popup의 항목, 콘솔 기록의 꼴과 자르기, UI icon 대응
  (`ui-icons.test.mjs`는 모든 파일이 있는지와 `svg(icon(…))`를 쓰는 자리도 본다). `i18n.test.mjs`는 문구 표를 모두 찾아 두 언어의 키·자리표시자·빈 값을 대조하고,
  소스의 글자 그대로의 키가 표에 있는지 본다. `icon-theme.test.mjs`는 mod 안의 생성물을 읽는다.
  잡는 실패: 레인이 끊기거나 엉킴, 폴더 체크가 자식과 어긋남, 구조가 다른 `main`을 조용히 통과함,
  틀린 아이콘이나 없는 아이콘 파일, 두 언어의 키가 어긋남, 덩어리와 결과 글이 틀리거나 줄 끝이 바뀜,
  편집 판정이 켜지면 안 될 때 켜짐, 할 일 목록이 틀림, 정렬·선택이 틀림.
- **앱에서 눈으로만 볼 수 있는 것.** 그려진 모양과 색, 클릭·키·창의 동작, 창과 패널 사이의 요청,
  원격 space, 큰 저장소의 체감 속도, 한국어 문장이 자연스러운지. 화면에는 자동 테스트가 없어서
  바꿀 때마다 사람이 다시 본다. 확인 절차는 RECIPE의 "Done when"에 있다.

**전체 오프라인 검사:** `node tools/check.mjs`가 한 번에 돌린다. 루트의 `node layout.test.mjs`,
`mods/git-tools`의 `*.test.mjs` 48개 각각, `node tools/gen-icon-theme.test.mjs`가 모두 `ok`를 찍고,
`herdr-app check mods/git-tools`가 통과한다. 테스트는 node 내장 모듈(`node:assert/strict` 등)만 쓴다.

**느린 엔진의 예산:** `icon-theme.test.mjs`가 JIT를 끈 node로 규칙을 꽂는 시간을 재서, 규칙을
힌트 아래에 꽂기만 하는 단순한 순회의 8배 안인지 본다. 시작할 때 규칙마다 하는 계산이 다시
늘어나면 여기서 걸린다. 처음 보는 이름 하나가 돌리는 정규식의 수(평균 4, 최대 16 이하)도 같은
파일이 센다.

**생성물 재현 검사:** `ICON_THEME_SOURCE=<폴더> node tools/gen-icon-theme.test.mjs`가 임시 폴더에
테마를 다시 만들어 커밋된 생성물과 바이트 단위로 비교한다. 변수가 없으면 `skip: …`과 `ok`만
찍는다.

## 7. 알려진 한계

- Restore는 그사이 다른 내용을 스테이징한 경로와 충돌 중이던 경로의 스테이징을 되살리지 않는다
  (파일은 되살리고 결과에 알린다). 스테이징을 담기 전의 기록과 커밋 없는 저장소의 기록은 파일만
  되살린다.
- `Intent:` 줄을 싣기 전의 꼴인 기록은 `git add -N`으로 알리기만 한 파일을 빈 파일의 스테이징으로
  담고 있어 가를 수 없다. 그런 기록에서는 Restore 뒤 빈 내용이 스테이징된 파일(`AM`)로 돌아오고,
  경로 없는 `git commit`이 빈 파일을 커밋한다. Rollback 때 디스크에 없는 intent-to-add 파일도
  `diff-files`가 삭제로 보여 가르지 못한다.
- submodule(gitlink) 경로를 Rollback하면 인덱스만 HEAD로 돌아가고 submodule의 체크아웃은
  그대로다. 그래서 Restore는 그 경로를 "롤백한 뒤에 변경되었습니다"로 건너뛰고, 스테이징했던
  gitlink는 되살아나지 않는다. 그 이유 문장도 실제와 맞지 않는다.
- Restore의 인덱스 쓰기가 중간에 실패하면 앞 묶음에서 쓴 스테이징은 남는다. 결과는 쓰지 못한
  경로와 git의 글을 알린다. 남은 `index.lock`은 파일을 쓰기 전에 Restore 전체를 멈추므로, 이
  결과는 파일을 쓴 뒤 다른 git이 인덱스를 잡은 경우에만 생긴다.
- Restore의 "그사이 바뀐 것"은 시작할 때의 디스크다. 확인과 쓰기 사이(파일 몇 개면 수십~100 ms)에
  다른 프로그램이 같은 파일을 고치면 그 내용이 덮일 수 있다. 확인과 쓰기를 한 번에 하는 git
  호출이 없다. Rollback의 확인과 쓰기 사이에도 같은 종류의 틈이 있다.
- Herdr 앱 홈을 다른 컴퓨터로 복사하거나 동기화하면 두 앱의 사본 식별자가 같아질 수 있다. 그런
  두 앱이 같은 순간에 같은 저장소를 롤백하면 기록이 섞일 수 있다.
- 가장 최근 Rollback snapshot과 그 두 번째 부모는 `git log --all`처럼 모든 ref를 보는 명령에
  커밋으로 보인다. `git log --all --decorate`에는 HEAD 역사의 뿌리 커밋에
  `refs/git-tools/deleted-branches` 장식이 붙는다(새 커밋이 보이지는 않는다).
- 지운 브랜치는 약 30일(git의 reflog 정리 기본값) 동안만 남고 mod가 늘리지 않는다. 목록은 최근
  50개까지다. 기록은 그 저장소(그 머신의 그 클론)에만 있다: `push --all`과 clone은 옮기지 않고,
  `push --mirror`는 ref만 옮기고 reflog는 옮기지 않는다.
- 지운 브랜치의 reflog가 가리키는 커밋 객체가 사라진 저장소(손상)에서는 목록 전체가 git의 오류가
  될 수 있다.
- 이 사본의 worktree를 포함해 어느 worktree든 분리된 HEAD에서 그 브랜치를 rebase·bisect하는
  중이면 그 브랜치는 현재 브랜치도 아니고(HEAD가 분리됨) `%(worktreepath)`도 비어 체크아웃으로
  보이지 않는다. 그 브랜치는 기록된 뒤 git이 지우기를 거부하고 기록은 남는다.
  목록에서는 같은 이름·같은 해시로 빠지지만, 그 브랜치가 움직이면 "같은 이름의 브랜치가 지금 다른
  커밋에 있습니다"로 지운 적 없는 브랜치가 보인다.
- 기록이 중간에 실패하고 ref를 되돌리기도 실패하면 ref는 비켜 선 커밋에 남아, 다음 Delete가 ref를
  다시 옮길 때까지 `git log --all`에 보인다. `deleted …` 항목을 쓴 뒤 되돌아오는 이동만 실패하면
  지우지 않은 브랜치의 항목이 reflog에 남아 위와 같이 보일 수 있다.
- 여러 개 되살리기에서 `.remote`는 썼는데 `.merge`만 실패하면 `branch.<이름>.remote`만 남는다(한 개
  되살리기도 같다).
- 언어를 mod 안에서 바꾸는 방법이 없다.
- Windows에서는 실제 기기로 확인하지 못했다. 언어 판정(PowerShell을 PATH로 찾는지, 출력의 꼴과
  인코딩, 5초 안에 답하는지, 표시 언어와 지역 형식이 다른 기기에서 어느 쪽을 바라는지), Files
  panel의 폴더 읽기와 찾기 훑기(PowerShell, 폴더 링크를 따라가는지), 권한 없는 폴더의 오류, Copy
  Path의 구분자가 모두 미확인이다.
- Files panel의 찾기 목록을 다시 읽는 주기는 마지막 목록이 들어온 때부터 잰다. 10초 타이머와
  겹치면 실제 간격은 10~20초가 될 수 있다.
- 저장소 안의 찾기 목록은 git이 추적 파일 전체와 새 파일 전체를 각각 한 번에 내고 그 뒤
  20,000개에서 자른다. 한 출력은 경로마다 경로 길이에 1바이트를 더한 크기라, 경로가 평균 60바이트면
  추적 파일(또는 새 파일)이 약 14만 개를 넘을 때 `exec`의 출력 한도(8 MiB)를 넘는다. 그때나 한
  호출의 시간 한도를 넘을 때 목록을 읽지 못할 수 있다(한도를 넘은 `exec`의 동작은 확인하지 않았다).
  저장소 밖 큰 폴더를 훑는 시간은 재 보지 않았다.
- 새로고침이 읽은 폴더는 새로고침의 결과가 이긴다. 새로고침이 도는 사이 같은 폴더를 닫았다 다시
  펼쳐 더 새로 읽었으면 다음 새로고침까지 한 번 옛 항목이 보인다.
- Git 버튼과 VCS widget 블록은 macOS에만 있다. 다른 OS에서는 `cmd-shift-g`와 Commit panel의 Git Log
  버튼으로 Log panel을 열고, VCS widget은 Commit list 툴바 왼쪽 끝에 있다. 버튼은 탭 바 밖의 블록이어서 Changes 버튼과의 간격이 13px로, 탭 바 안의
  버튼 사이(3px)보다 넓다.
- User 필터에서 고른 이름은 대소문자까지 같은 작성자만 건다. 다만 Match Case를 끈 검색이나 직접
  친 글자가 함께 걸린 동안에는 대소문자만 다른 작성자(`bob`과 `Bob`)도 걸린다.
- 영어 시스템과 Windows·Linux에서는 화면을 확인하지 못했다. 한국어 macOS에서만 확인했다.
- 원격 space에서 Last commit group은 화면으로 확인하지 못했다.
- Commit은 체크한 경로를 한 호출로 넘기므로, 아주 많은 파일을 체크하면 시스템의 인자 길이 한도에
  걸릴 수 있다.
- 비밀번호, passphrase, GPG PIN 입력 창이 없다. `exec`에 입력을 넘길 길이 없고, 받으려면 비밀번호가
  디스크 파일을 거치는 도우미가 필요하기 때문이다. 입력을 요구하는 원격에서는 푸시, fetch, pull,
  업데이트, 태그 푸시가 기다리지 않고 바로 실패하고 credential helper나 SSH agent를 설정하라고 안내한다.
- 메뉴 막대가 없다. git 메뉴는 VCS Operations popup(`cmd-shift-v`)이다. `cmd-shift-v`는 Commit
  panel이나 Log panel이 보일 때만 열린다.
- 알림에는 버튼을 하나만 달 수 있다. 리베이스가 편집 중단에서 멈춘 알림에는 "계속 · 중단" 버튼이
  없고, VCS widget이나 Commit panel에서 잇거나 중단한다.
- Branch tree의 F2는 Herdr 전역 키(탭 이름 바꾸기)가 먼저 가져가므로 쓰지 않는다. 브랜치 이름은
  우클릭 메뉴의 "이름 변경…"으로 바꾼다.
- 팝업 메뉴에 하위 메뉴가 없다. 현재 브랜치의 추적된 브랜치와 태그 푸시는 두 번째 메뉴로 열린다.
- VCS widget 팝업의 별은 보이기만 한다. 즐겨찾기는 Branch tree에서 바꾼다. 위젯은 240px 고정이라
  긴 브랜치 이름은 줄여 보인다.
- Merge Revisions dialog의 가운데 칸은 줄 색이 있는 편집기가 아니다. 결과를 직접 고치려면 "결과
  직접 편집"으로 색 없는 편집기 모드로 바꾸고, 다시 눌러 그림으로 돌아온다. 열린 동안 다른 쓰기를
  받아 다시 읽지 않는다.
- Conflicts dialog의 덮어쓰기 확인은 고치지 않은 파일에서도 한 번 더 뜰 수 있다(잃는 쪽은 없다).
- 멈춘 Smart operation이 남긴 stash는 Commit panel의 새로고침이 되돌린다. Commit panel이 닫혀 있으면
  그때까지 미뤄진다.
- 픽스업·다음으로 스쿼시의 커밋은 됐는데 다시 쌓기가 그 뒤에 실패하면 `fixup!` 커밋이 남는다.
  Commit panel이 다른 저장소를 보고 있으면 대상 커밋을 받지 않고 아무 일도 일어나지 않는다.
- 리베이스… 창에는 `--interactive`가 없다(커밋 리베이스 창을 쓴다). `--update-refs`는 git 2.38부터라
  하한(2.37)의 git에서는 git의 오류로 실패한다.
- 여러 커밋을 고른 Commit details에서 파일의 Diff는 그 파일을 고친 가장 새 커밋의 변경이다.
- Stash tab의 Diff 표시는 stash 전체가 아니라 파일 하나의 Diff tab이다.
- 작업 트리 비교는 추적하는 파일만 본다. 추적하지 않는 새 파일은 목록에 없다. 교체된 비교 탭은
  옛 자리가 아니라 새 자리에 열린다.
- 떨어진 여러 커밋의 패치는 사이의 고르지 않은 커밋도 담는다.
- 새 워크트리의 위치는 전체 경로만 받는다(`~`와 상대 경로는 거절). 새 space가 열리지 않아도 따로
  알리지 않는다.
- Git console은 쓰기 흐름 안에서 `READ` 없이 부르는 읽기도 기록한다. 쓰기 명령마다 기록 파일(최대
  512 KiB)을 다시 쓰고 창을 다시 그리므로, 명령이 많은 동작(Rollback 등)은 한 번에 십수 번 다시 그린다.
- 커밋 리베이스 창은 Esc로 닫으면 닫기 확인 없이 닫힐 수 있다(Herdr가 창을 스스로 닫는다).
- Windows와 Linux에서는 git 동작의 화면(VCS widget의 Log panel 자리, 원격 쓰기 길 포함)을 확인하지
  않았다.
- diff는 통합 보기뿐이고 구문 색이 없다. Commit panel은 이름 변경을 감지하지 않아서, 이름이
  바뀐 작업 파일은 삭제된 파일과 추가된 파일로 따로 보이고 추가된 쪽의 diff는 파일 전체다.
- Files 미리보기는 편집기 문법 묶음에 없는 언어를 가까운 문법으로 칠하므로, 그 언어에만 있는
  키워드는 색이 없다. 가까운 문법이 없는 형식(Vim script, Nix, Pug, Stylus, AsciiDoc, CSV,
  `yarn.lock` 등)은 색 없이 보인다. Sass 들여쓰기 문법(`.sass`)은 편집기 스스로 Haml 문법으로
  칠한다. CSS 문법은 중괄호 없는 이 문법에 색을 하나도 내지 않아서 빌리지 않는다.
- 원격 space는 폴더 감시가 안 되어 10초 타이머로만 새로 읽는다. 저장소는 한 번에 하나다.
- 다른 worktree의 git 폴더는 저장소 루트 밖에 있어 감시되지 않는다. 그런 worktree에서 터미널로
  커밋하면 작업 파일의 Diff tab은 다음 10초 읽기에 따라온다.
