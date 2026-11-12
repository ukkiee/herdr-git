# herdr-git

[English](README.md) | **한국어**

[Herdr](https://herdr.dev) 데스크톱 앱에 Git 도구를 더하는 mod입니다. 탭 바의
Changes 버튼으로 여는 Commit panel, Files 버튼으로 여는 Files panel, 작업 영역 아래의 Git
Log panel이 있습니다. 커밋할 파일을 골라 커밋하거나 고쳐 쓰고, 미리 보고 푸시하고, 파일을
되돌리고 되살리고, 지운 브랜치를 되살리고, 파일을 git 상태와 함께 둘러보고, 커밋 그래프와
검색·필터로 브랜치와 기록을 살펴봅니다.

![git-tools](preview.ko.png)

- **Commit panel**(Changes 버튼, `cmd-k`): 바뀐 파일과 추적하지 않는 파일을 체크박스
  트리로 보여 줍니다. git에 스테이징된 것과 상관없이 체크한 파일만 커밋합니다. Amend,
  Commit and Push…, Rollback…, Restore Rolled-Back Changes…, Show Diff가 있습니다. Amend를
  켜면 마지막 커밋의 파일이 맨 아래에 보입니다.
- **Files panel**(Files 버튼): 포커스된 pane의 폴더를 트리로 보여 줍니다. 이름은 git 상태의
  색으로, 안에 바뀐 파일이 있는 폴더는 옆에 점으로 표시하고, 경로의 일부로 파일을 찾는
  찾기 칸과 누른 파일의 읽기 전용 미리보기가 있습니다. 줄을 우클릭하면 Show Diff, Copy
  Path, Copy Relative Path, Reveal in Finder가 있습니다.
- **Log panel**(Changes 옆의 Git 버튼, `cmd-shift-g`): Branch tree(체크아웃, 새 브랜치,
  삭제, 삭제된 브랜치, fetch), 그래프와 함께 보는 모든 커밋, 글자나 해시로 찾기, Branch /
  User / Date / Path 필터, 고른 커밋의 파일과 메시지.
- **Diff tab**: 파일 하나의 통합 diff를 줄 번호와 함께 보여 줍니다. 어느 패널에서든
  엽니다. 작업 파일의 탭은 파일이 바뀌면 따라서 바뀝니다.

### 롤백과 브랜치 삭제 되살리기

- **Rollback**은 버릴 파일들을 먼저 저장소 안에 기록합니다. 롤백 직후 Commit panel 아래에
  `N개 파일을 롤백했습니다.`(영어 화면은 `Rolled back N files.`)와 **복원…** 버튼이 있는
  줄이 뜹니다. 나중에는 툴바의 **롤백된 변경 내용 복원…**(Restore Rolled-Back Changes…)이
  최근 롤백 50개를 보여 줍니다. 하나를 고르고 파일을 체크해(더블클릭하면 그 diff를 봅니다)
  복원을 누릅니다. 롤백한 뒤 다시 고친 파일은 덮지 않고 건너뛰며 이유를 알려 줍니다.
  기록된 그대로 디스크에 남아 있는 새 파일(추가된 파일의 로컬 복사본 삭제를 끄고 롤백한
  경우)은 복원한 것으로 셉니다. 스테이징했던 것도 돌아와서 `git status`가 롤백 전과 같아집니다.
  그사이 다른 내용을 스테이징한 파일은 그 스테이징을 그대로 두고, 창이 그렇다고 알려 줍니다.
- **브랜치를 지우면** 먼저 저장소에 기록한 뒤 Log panel 아래에 `삭제된 브랜치: 'x' (1a2b3c4)`(영어
  화면은 `Deleted branch 'x' (1a2b3c4).`)와 **복원** 버튼이 있는 줄이 뜹니다. 같은 커밋, 같은
  추적 브랜치로 되살리고 체크아웃하지는 않습니다. 나중에는 Branch tree의 **삭제된 브랜치…**
  (Deleted Branches…) 버튼이 이 저장소에서 지운 브랜치를 최신순으로 보여 줍니다. 여러 개를
  체크하고 복원을 누릅니다. git이 약 30일 동안 보관합니다. 그사이 같은 이름의 브랜치가
  생겼으면 그대로 둡니다.

### User 필터

몇 글자만 치면 저장소의 작성자 목록이 좁혀집니다. 클릭하거나 ↑ ↓와 Enter로 여러 명을
체크하면 그 가운데 누구의 커밋이든 남습니다. 아무 줄도 고르지 않고 Enter를 누르면 친
글자를 이름·이메일의 일부로 찾는 조건으로 더합니다.

### 파일 아이콘

변경 파일 트리와 Files panel의 파일·폴더, Diff tab 머리줄에
[Atom Material Icons](https://github.com/AtomMaterialUI/iconGenerator) 아이콘이
보입니다(Herdr의 밝음·어두움에 맞는 변형). 라이선스는 아래 "아이콘과 크기"에 있습니다.

### 언어

컴퓨터의 첫 번째 선호 언어가 한국어면 화면이 한국어, 그 밖에는 영어입니다. mod 안에서
바꾸는 방법은 없습니다. macOS는 시스템의 선호 언어 목록을, Linux는 `LC_ALL`,
`LC_MESSAGES`, `LANG` 변수를, Windows는 표시 언어를 읽습니다(Windows는 아직 실제 기기에서
확인하지 못했습니다). 다른 머신의 space에서도
창이 있는 컴퓨터의 언어를 따릅니다. 시스템 언어를 바꾸면 Herdr를 다시 시작하세요. git
자신의 메시지는 git이 쓴 그대로 보입니다.

모두 Herdr의 `main`을 복사한 `main-git` 레이아웃 안에 있습니다. Herdr의 원래 레이아웃과
Changes·Files 패널은 그대로 둡니다.

## 추가하기 전에

- **실행하는 프로그램**: 포커스된 pane의 저장소에서 `git`을 실행합니다(space가 다른
  머신에 있으면 그 머신에서). git에 `GIT_TERMINAL_PROMPT=0`을 넘기려고 `env`도
  실행합니다. Files panel은 space가 도는 곳에서 `sh`(Windows 컴퓨터의 폴더는 PowerShell)로
  폴더를 읽고, Reveal in Finder는 `open -R`을 실행합니다. 언어를 고르려고 내 컴퓨터에서
  `defaults read -g AppleLanguages`(macOS), `LC_ALL`, `LC_MESSAGES`, `LANG`을 찍는
  `sh -c 'printf …'`(Linux), `powershell -NoProfile -Command "(Get-UICulture).Name"`(Windows)를
  실행합니다.
- **네트워크**: Fetch를 누르면 `git fetch --all --prune`, Push나 Force Push를 누르면
  `git push`를 합니다. 그 밖에는 밖으로 나가지 않습니다.
- **저장소에 쓰는 일**: 버튼을 눌렀을 때만 씁니다(커밋, amend, 롤백, 복원, 체크아웃, 새
  브랜치, 브랜치 삭제, 브랜치 복원, fetch, push). `reset --hard`, 강제 체크아웃, 옵션 없는
  `--force`는 쓰지 않습니다. 한 저장소에서는 이 가운데 하나만 돌고, 도는 동안에는 그
  저장소를 보여 주는 모든 git-tools 화면에서 다른 쓰기 버튼이 꺼집니다.
- **롤백 기록**: Rollback마다 숨은 ref `refs/git-tools/rollback`(과 그 reflog)에 커밋 객체를
  하나 더하고, git 폴더에 비워 둔 파일 `git-tools-rollback-index-<id>` 하나를 그곳에서
  롤백이나 복원을 한 Commit panel 식별자마다 남깁니다(`<id>`는 사본의 저장소에 두는
  식별자라 같은 props로 연 사본들은 하나를 함께 쓰고, 저장소를 쓸 수 없는 사본은 실행마다
  파일이 하나씩 늡니다. SHA-1 저장소에서 65바이트, SHA-256 저장소에서 89바이트). 브랜치나 태그가 아니어서 푸시되지
  않지만, **가장 최근 기록 하나는 `git log --all`과 모든 ref를 그리는 도구에 커밋으로
  보입니다**(`git stash`와 같습니다). ref가 더 가리키지 않는 기록은 30일 뒤 `gc` 때 git의
  reflog 정리로 사라지고(기본값), 가장 최근 기록은 ref가 가리키는 동안 남습니다.
  git-tools가 직접 지우지는 않습니다. 기록은 스테이징했던 것도 담는데, 이것은 두 번째
  커밋이라 `git log --all`에서 가장 최근 기록 옆에 보입니다.
- **지운 브랜치 기록**: Delete마다 지우기 전에 브랜치를 숨은 ref
  `refs/git-tools/deleted-branches`의 reflog에 기록합니다. 이 ref는 HEAD 역사의 첫 커밋에
  서 있어서 `git log --all`에 새 커밋이 보이지 않습니다(첫 커밋에 이 ref의 이름만 붙습니다).
  기록은 약 30일 뒤 `gc` 때 git의 reflog 정리로 사라지고, git-tools가 직접 지우거나 이를 위해
  git 설정을 바꾸지 않습니다. 기록은 그 클론에만 있습니다: `push --all`과 clone은 옮기지
  않습니다. 지운 브랜치를 복원하면 그 브랜치의 `branch.<name>.remote`, `.merge` 설정도
  되돌립니다.
- **Herdr 앱 홈의 파일**(`~/.config/herdr-app` 또는 `$HERDR_APP_HOME`): `install.sh`가
  `mods/git-tools/`와 `layouts/main-git.json`을 쓰고 `keys.json`에 키 두 개를 더합니다.
  mod는 `shared.json`에 작은 값 세 개를 둡니다. `git-tools.bus`는 화면끼리 저장소가
  바뀌었다고 알리는 데, `git-tools.lock`은 어느 저장소에서 git-tools의 쓰기가 돌고 있는지
  적는 데, `git-tools.lang`은 마지막으로 읽은 시스템 언어(`"en"` 또는 `"ko"`)를 적는 데
  씁니다. 클립보드에는 Copy Revision Number, Copy Path, Copy Relative Path를 누를 때만 씁니다.

구조와 주의점은 [RECIPE.md](RECIPE.md)에 있습니다.

## 설치

실행 중인 Herdr와 `node`, 그리고 space가 도는 모든 머신에 `git` 2.37 이상이 필요합니다.

```sh
git clone https://github.com/ukkiee/herdr-git
cd herdr-git && ./install.sh
```

`install.sh`는 mod를 복사하고(설치된 것과 다른 파일만), 지금의 `main` 레이아웃으로 `main-git`을 만들어 그리로
바꾸고, 키를 더합니다. `main` 레이아웃의 구조가 예상과 다르면 어느 부분이 없는지 알리고
아무것도 바꾸지 않습니다.

### 키

| 키 | 하는 일 |
|---|---|
| `cmd-k` | Commit panel을 엽니다 |
| `cmd-shift-g` | Log panel을 보이거나 숨깁니다 |

두 키는 `main-git` 레이아웃에서만 동작합니다. 이미 다른 기능에 쓰는 키는 건드리지
않습니다. `install.sh`가 그 사실을 알려 주니, `keys.json`에서 다른 키에 묶으면 됩니다.

### Herdr를 업데이트한 뒤

`main-git`은 복사본이라 Herdr가 `main`에 준 변경을 따라가지 않습니다. **Herdr를
업데이트할 때마다 `./install.sh`를 다시 실행하세요**(이 저장소를 `git pull`한 뒤에도).
지금의 `main`으로 `main-git`을 다시 만듭니다. `main-git.json`을 손으로 고친 내용은 이때
사라집니다.

### `main`으로 돌아가기

`cmd-shift-l`(Herdr의 레이아웃 전환 키)을 누르세요. 누를 때마다 다음 레이아웃으로
넘어가니, 레이아웃이 둘보다 많으면 `main`이 보일 때까지 누릅니다. Herdr의 원래 Changes
패널이 그대로 있습니다. 돌아오려면 `main-git`이 보일 때까지 누르거나 `./install.sh`를
실행하세요.

### 지우기

먼저 `main`으로 바꾼 뒤, 앱 홈에서 `mods/git-tools/`와 `layouts/main-git.json`을 지우고
`keys.json`의 `layout:main-git` 절을 지우세요. Herdr가 `layouts/.state/main-git.json`과
`shared.json`의 `git-tools.bus`, `git-tools.lock`, `git-tools.lang` 키를 남겨 두었을 수
있는데, 모두 지워도 됩니다. 롤백 기록과 지운 브랜치 기록은 git이 정리할 때까지 각 저장소에
남습니다. 그 저장소에서 `git update-ref -d refs/git-tools/rollback`과
`git update-ref -d refs/git-tools/deleted-branches`를 실행하면 바로 지워집니다(그 뒤에는
복원할 수 없습니다).

## 강제 푸시

- Force Push는 Push dialog의 Push 옆 ▾ 안에 있습니다. 언제나 `--force-with-lease`라서,
  마지막 fetch 뒤에 누군가 그 원격 브랜치에 푸시했으면 git이 거부합니다. 옵션 없는
  `--force`는 쓰지 않습니다.
- `main`과 `master`에서는 비활성입니다. 원격의 `main`이나 `master`로 푸시하는 브랜치도
  마찬가지입니다.
- 비밀번호, 암호 문구, GPG PIN을 입력할 곳이 없습니다. 입력을 요구하는 원격에서는 멈춰
  기다리지 않고 푸시가 실패하며, 창에 git의 오류를 보여 줍니다. 커밋은 이미 되어
  있으니 credential helper나 SSH agent를 설정하고 Push를 다시 누르면 됩니다.

## 아이콘과 크기

- 파일·폴더 아이콘은 Elior "Mallowigi" Boukhobza의 **Atom Material Icons**(MIT 라이선스)이고,
  [`AtomMaterialUI/iconGenerator`](https://github.com/AtomMaterialUI/iconGenerator)의 커밋
  `90e051eecb393c6380be18a1941c3096170c15d6`에서 가져왔습니다(Atom Material Icons
  210.0.2의 규칙과 아이콘). 파일 아이콘 1,797개와 폴더 아이콘
  351개(닫힘·열림)입니다. 라이선스 전문과 출처는
  [`mods/git-tools/icons/theme/LICENSE`](mods/git-tools/icons/theme/LICENSE)와
  [`NOTICE.md`](mods/git-tools/icons/theme/NOTICE.md)에 있습니다. 제품의 로고나 상표를
  그린 아이콘은 그 소유자의 것입니다.
- 이 아이콘들로 저장소와 설치된 mod 폴더가 **파일 2,502개, 약 5.6 MB** 커집니다.
- `node tools/gen-icon-theme.mjs <압축을 푼 iconGenerator 폴더>`로 다시 만듭니다. 폴더를
  받는 방법은 스크립트 머리말에 있습니다.

## 알려진 한계

- 한 번에 저장소 하나, 포커스된 pane의 저장소만 보여 줍니다. 서브모듈은 따로 보여 주지
  않습니다.
- stash·shelve, merge, rebase, pull, cherry-pick, revert, reset이 없습니다.
- diff는 통합 보기뿐입니다. 좌우 나란히 보기와 구문 색이 없습니다. Commit panel에서 이름이
  바뀐 파일은 삭제된 파일과 추가된 파일로 따로 보이고, 추가된 파일의 diff는 파일 전체입니다.
- Amend는 마지막 커밋만 고치고, 커밋은 줄 단위가 아니라 파일 단위입니다.
- 다른 머신의 space에서는 파일을 감시하지 못합니다. 작업 파일의 Diff tab은 화면에 보이는
  동안 10초마다 다시 읽습니다.
- Git 버튼은 macOS에만 있습니다. Windows와 Linux에서는 `cmd-shift-g`나 Commit panel의 Git
  Log 버튼으로 Log panel을 엽니다.
- Log panel 폭이 약 930px보다 좁으면 Commit details가 숨습니다.
- Commit details는 커밋을 포함한 브랜치를 12개까지 적고, 나머지는 `and N more`로 줄입니다.
- 화면 언어는 영어와 한국어뿐이고, 시스템 설정으로만 정해집니다.
- Windows는 실제 기기로 확인하지 못했습니다: 언어 판정, 그리고 그곳에서의 Files panel 폴더
  목록과 찾기. Linux와 영어 macOS도 실제 기기로 확인하지 못했습니다.
- 롤백한 뒤 다른 내용을 스테이징한 파일과 충돌 중이던 파일은 복원해도 스테이징이 돌아오지
  않습니다. 파일은 돌아옵니다.
- 지운 브랜치는 약 30일(git의 reflog 정리 기본값) 동안 남고, 삭제된 브랜치 목록은 최근
  50개를 보여 주며, 기록은 그 클론에만 있습니다.
- Files panel은 찾기를 시작할 때 찾을 목록을 읽습니다. 찾는 동안 새로 만든 파일은 다음
  찾기부터 나옵니다. 저장소 밖에서는 처음 20,000개 파일에서만 찾습니다. 트리는 폴더당
  500개, 전체 5,000개까지 보여 줍니다.
- 복원은 시작할 때 변경 여부를 확인합니다. 그 확인과 쓰기 사이(파일 몇 개면 수십~100 ms)에
  다른 프로그램이 같은 파일을 고치면 그 내용이 덮일 수 있습니다. git 자신의 체크아웃에도
  같은 틈이 있습니다.
- Herdr 앱 홈을 다른 컴퓨터로 복사하거나 두 컴퓨터 사이에 동기화하면 두 앱의 Commit panel
  식별자가 같아질 수 있습니다. 그런 두 앱이 같은 순간에 같은 저장소를 롤백하면 기록이 섞일
  수 있습니다.
- `.mailmap`이 있는 저장소에서 User 필터, Commit list, Commit details, Push dialog는
  매핑된 이름을 보여 줍니다. 이름만 체크했을 때 `bob`은 `bob`만 겁니다.
  Match Case를 끄고 텍스트를 검색하는 동안, 또는 User 팝업에 직접 친 글자가 걸려 있는
  동안(Match Case를 켠 텍스트 검색이 없을 때)에는 `Bob`도 함께 걸립니다. git의 대소문자
  설정이 텍스트와 작성자에 하나뿐이어서입니다.
