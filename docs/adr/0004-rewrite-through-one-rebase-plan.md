---
status: accepted
---

# 히스토리 편집은 하나의 길로 다시 쌓는다: mod가 만든 할 일 목록을 `git rebase -i`에 넣고, 메시지는 `exec` 줄로 넣는다

옛 커밋의 메시지 편집, 커밋 삭제, 커밋 스쿼시와 그 위에 얹는 편집(픽스업·스쿼시, 파일 단위 추출·삭제, 대화식 리베이스)은 모두 현재 브랜치를 가장 오래된 대상 커밋부터 다시 쌓는다. 이 길은 하나다.

1. 순수 모듈 `rebase-plan.js`가 화면의 동작 목록(pick, reword, edit, squash, fixup, drop과 순서)을 git의 할 일 목록으로 바꾼다.
2. `git-rewrite.js`가 `git rebase -i --autostash <대상>^`(첫 커밋이면 `--root`)를 돌리고, 시퀀스 편집기로 `sh -c 'printf "%s\n" "$GITTOOLS_TODO" > "$1"' -`를 준다. 목록은 환경 변수로 건넨다.
3. 메시지가 필요한 커밋(reword, 메시지를 준 squash)은 그 커밋(또는 합쳐지는 묶음의 끝) 뒤에 `exec git commit --amend --allow-empty -q -m "$GITTOOLS_MSG_<n>"` 줄을 둔다. 메시지 자체는 줄에 넣지 않고 변수로 건넨다.
4. 끝은 실행 전후의 진행 중 상태와 HEAD로 판정한다(`git-operation.js`의 `settle`). 충돌로 멈추면 Conflicts dialog를 연다.

HEAD 하나의 메시지만 바꿀 때는 다시 쌓지 않고 `commit --amend --only -m`으로 메시지만 고친다. 커밋 실행 취소는 `reset --soft`다.

## 왜

- `exec`에는 stdin이 없고, 원격 머신에는 파일을 쓸 수 없다. 할 일 목록과 메시지를 git에 건넬 길은 명령 인자와 환경 변수뿐이다. 시퀀스 편집기와 `exec` 줄은 둘 다 git이 기다리지 않고 셸로 돌리는 자리여서, 변수에 담은 글을 그대로 쓸 수 있다.
- 메시지는 여러 줄이고 따옴표, `$`, 백틱, `#`으로 시작하는 줄(이슈 번호)을 가질 수 있다. 할 일 목록은 한 줄이 한 명령이고 `exec` 줄은 셸이 읽으므로, 메시지를 줄 안에 넣으면 따옴표 처리 하나만 틀려도 다른 메시지가 커밋되거나 명령이 실행된다. 변수로 건네면 셸은 `"$이름"`만 펼친다.
- 메시지를 준 squash는 git의 `squash`가 아니라 `fixup`으로 합치고, 메시지는 묶음 끝에 한 번 넣는다. `squash`는 합친 메시지를 편집기로 묻고, 묶음 중간에 메시지를 넣으면 다음에 합쳐지는 커밋이 자기 메시지를 다시 붙인다.
- 시퀀스 편집기는 `-c sequence.editor` 설정이 아니라 `GIT_SEQUENCE_EDITOR` 변수로 준다. git은 변수를 설정보다 먼저 보므로, 사람이 셸에 내보낸 `GIT_SEQUENCE_EDITOR`가 있으면 `-c` 설정은 진다. 변수로 주면 사용자의 `sequence.editor`, `core.editor`, 내보낸 편집기 변수가 모두 무관하다. `GIT_EDITOR=true`도 함께 줘서 git이 다른 이유로 편집기를 찾아도 기다리지 않는다.
- `--autostash`: rebase는 추적하는 파일이 바뀌어 있으면 시작하지 않는다. 편집은 작업 트리와 관계없는 일이므로 로컬 변경을 옆에 뒀다가 되돌린다.

## Considered Options

- **편집기 흉내만**(`GIT_EDITOR`에 메시지를 쓰는 스크립트, `reword` 줄): 여러 커밋의 메시지를 고칠 때 git이 편집기를 부르는 순서에 기대야 하고, 어느 호출이 어느 커밋인지 git의 글로 가려야 한다. git의 글은 사용자의 로캘로 나온다.
- **`--autosquash`만**(`fixup!`·`squash!` 커밋을 만들고 git이 순서를 잡게 함): 픽스업·다음으로 스쿼시에는 맞지만 삭제, 순서 바꾸기, 여러 커밋 스쿼시, 메시지 편집을 나타낼 수 없다. 사용자의 `rebase.autoSquash`에 따라 다른 결과가 나온다.
- **직접 cherry-pick 사슬**(대상 앞 커밋으로 브랜치를 옮기고 한 커밋씩 cherry-pick): 중간에 멈추면 git이 아는 진행 중 상태가 없어서 Continue·Abort를 mod가 따로 만들어야 하고, 터미널의 `git rebase --continue`가 통하지 않는다. 브랜치를 먼저 옮기므로 실패하면 사람의 브랜치가 중간 상태에 남는다.
- **`--rebase-merges`**: 다시 쌓는 범위에 병합 커밋이 있어도 되지만, 할 일 목록이 label·reset·merge 줄을 가져야 하고 충돌 해결이 merge까지 번진다. 지금은 병합 커밋이 범위에 있으면 편집 판정이 끈다("현재 브랜치에서 선택한 커밋 뒤에 병합 커밋이 있습니다").

## Consequences

- 멈춘 다시 쌓기는 git의 보통 rebase다. 편집 중단(edit)이나 충돌에서 멈추면 동작 모듈이 rebase 진행 중으로 읽고, 화면의 Continue·Abort·Skip과 터미널의 `git rebase --continue`가 모두 통한다.
- 사용자의 `rebase.updateRefs`가 켜져 있으면 mod의 목록이 git이 만든 목록을 대신하므로, git이 넣었을 `update-ref` 줄을 mod가 같은 규칙으로 넣는다: 범위 안의 커밋에 있는 로컬 브랜치 가운데 어느 worktree에도 체크아웃되지 않은 것, 그 커밋(또는 그 커밋이 합쳐지는 묶음, 삭제된 커밋이면 그 앞) 뒤에. 설정이 꺼져 있으면 넣지 않는다. `update-ref` 줄은 git 2.38부터 있고, 그보다 오래된 git에는 이 설정도 없다.
- `--autostash`는 스테이징한 변경을 스테이징 없는 변경으로 되돌린다(git의 동작). Commit panel은 스테이징을 보지 않고 체크한 파일만 커밋하므로 커밋 결과는 같다.
- 훅은 그대로 돈다. 메시지를 넣는 `exec` 줄의 `commit --amend`마다 `commit-msg` 훅이 돈다. 훅이 거부하면 rebase는 그 줄에서 멈추고 진행 중으로 남는다.
- 메시지 변수의 이름(`GITTOOLS_MSG_<n>`)과 목록 변수(`GITTOOLS_TODO`)는 git에게 건네는 이름일 뿐 저장되지 않는다. 바꿔도 옛 상태를 읽을 필요가 없다.
