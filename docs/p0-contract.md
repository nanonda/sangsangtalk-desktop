# 1단계(P0) 작업 계약서

기획안 v1(https://claude.ai/artifact/25pciFZEztojVnSaoh7jcz)의 1단계를 구현하기 위한 역할 간 약속이다.
여기 적힌 API·연동 방식이 기준이며, 바꿔야 하면 구현 전에 총괄 PM에게 먼저 알린다. 작성: 총괄 PM, 2026-11-16.

## 범위(1단계)
| # | 기능 | 담당 |
|---|---|---|
| A | 과거 기록 끝까지 불러오기 | 백엔드 + 프론트 |
| B | 그룹 대화방(만들기·이름 바꾸기·초대·나가기·대화) | 백엔드 + 프론트 |
| C | 파일 전송(보내기·진행 표시·받기·크기/형식 제한) | 백엔드 + 프론트 (+ 데스크톱: 내려받기 저장) |
| D | 자동 근무 상태(사용 중·자리비움·오프라인) 표시 | 백엔드 + 프론트 |
| E | Windows 알림·트레이 안읽음 표시 | 데스크톱 + 프론트 |
| F | 기록 보존: 보존 기간 무제한, 사용자 삭제 금지 | 백엔드 |
| G | 백업·복원 스크립트 | 빌드·배포 |
| H | v2 시안(그룹 만들기·파일 카드·업로드 진행·상태 점) | 디자이너 |

1단계에서 하지 않는 것: 수동 상태(회의 중 등)와 거돌이 이미지, 검색, 읽음 표시, 부서 대화방, 공지 바, 미리보기 크게 보기.

## 공통
- 브라우저는 항상 `/api/*`만 부른다. Zulip 주소·자격증명은 브라우저로 나가지 않는다.
- 오류 응답은 `{ "error": "<한국어 문장>" }`. 401은 다시 로그인.
- `web/dev/mock-server.mjs`는 아래 API를 모두 흉내 낸다(백엔드 담당, **가장 먼저** 맞춘다). 프론트는 이것으로 먼저 개발한다.

## 메시지 형식
```json
{ "id": 123, "senderId": 5, "senderName": "김도윤", "senderEmail": "...", "timestamp": 1763251200,
  "topic": "...", "content": "본문(첨부 링크 줄은 빠짐)",
  "kind": "channel" | "dm" | "group", "peerId": 5 | null, "groupId": 12 | null,
  "attachments": [ { "name": "회의자료.pdf", "url": "/api/files/user_uploads/...", "size": 2400000 | null, "type": "application/pdf" | "" } ] }
```
- `attachments`는 항상 배열(없으면 `[]`). `size`를 모르면 `null`.

## A. 과거 기록
- `GET /api/messages?view=dm&userId=5&before=<messageId>` (view=`general` | `dm` | `group`, group은 `groupId`)
- `before`가 없으면 최신 100개, 있으면 그 id보다 오래된 100개. 응답 `{ messages, hasOlder }` (오래된 순 정렬).
- 프론트: 맨 위까지 스크롤하면 이전 100개를 불러와 위에 붙이고 보던 위치를 유지한다. `hasOlder:false`면 "대화의 처음입니다".

## B. 그룹 대화방
Zulip 비공개 채널(초대 전용) 하나 = 그룹 대화방 하나. 메시지 주제(topic)는 `대화`로 고정한다. `general`은 그룹 목록에 넣지 않는다.
| 요청 | 본문 | 응답 |
|---|---|---|
| `GET /api/groups` | — | `{ groups: [ { groupId, name, memberIds } ] }` (내가 속한 것만) |
| `POST /api/groups` | `{ name, memberIds }` (나 자동 포함, 이름 없으면 참여자 이름 3명까지 + "외 N명") | `{ group }` |
| `PATCH /api/groups/:groupId` | `{ name }` | `{ group }` |
| `POST /api/groups/:groupId/members` | `{ userIds }` | `{ group }` |
| `DELETE /api/groups/:groupId/members/me` | — | `{ ok: true }` |
| `GET /api/messages?view=group&groupId=12` | (A와 같음) | |
| `POST /api/messages` | `{ view: "group", groupId, content, attachments? }` | `{ message }` |
- `/api/events` 응답에 내가 그룹에 추가·제외·이름 변경되면 `groupsChanged: true`를 넣는다. 프론트는 그때 `/api/groups`를 다시 읽는다.
- 프론트: 목록 "고정됨"(general) 아래 "그룹" 구역, 새 대화(+) → "1:1 / 그룹" 선택, 그룹은 직원 여러 명 체크 + 이름. 대화창 머리글에 인원 수, 메뉴로 이름 바꾸기·초대·나가기(나가기는 확인 후).

## C. 파일 전송
- 업로드: `POST /api/files` — 본문은 파일 그대로(raw), 헤더 `content-type`, `x-file-name: encodeURIComponent(파일명)`.
  - 응답 `{ file: { name, size, type, path } }` (`path`는 Zulip의 `/user_uploads/...`).
  - 413 `{error}`: 상한 초과(환경변수 `MAX_UPLOAD_MB`, 기본 100). 415 `{error}`: 막는 형식(.exe .bat .cmd .ps1 .js .vbs .msi .scr .com .jar).
- 보내기: `POST /api/messages`에 `attachments: [ { name, path, size, type } ]`. 본문 `content`는 비어도 된다. 서버가 Zulip 본문 끝에 `[name](path)` 줄로 붙인다.
- 받기: `GET /api/files/user_uploads/...` — 서버가 세션으로 Zulip에서 받아 그대로 넘긴다. `content-disposition: attachment; filename*=UTF-8''<이름>`.
  다른 경로는 404. 이미지는 `?inline=1`이면 inline으로(말풍선 썸네일용).
- 서버는 Zulip 본문에서 `[이름](/user_uploads/...)` 줄을 찾아 `attachments`로 옮기고 `content`에서 뺀다.
- 쪽지(`note: true`)에도 첨부할 수 있다.
- 프론트: 입력창 첨부 버튼·끌어다 놓기·붙여넣기, 여러 개, 진행률(XHR `upload.onprogress`)·취소·실패 시 다시 시도, 보내기 전 크기·형식 검사(서버도 검사). 말풍선 파일 카드(형식·이름·크기·내려받기), 이미지는 작은 썸네일.

## D. 자동 근무 상태
- `POST /api/presence` `{ status: "active" | "idle" }` — 프론트가 60초마다 보낸다. 마지막 입력(키·마우스) 후 10분이 지나면 `idle`.
- `GET /api/presence` → `{ presence: { "<userId>": "active" | "idle" | "offline" } }` — 프론트가 60초마다 읽는다.
- 표시: 사용 중 = 연두 `--lime-500`, 자리비움 = `#f3b63f`, 오프라인 = `#b8c1ca`. 아바타 오른쪽 아래 점 + 이름 옆 글자(마우스 올림 title). 대상: 직원 목록, 1:1 대화 목록, 대화창 머리글, 내 프로필(레일).

## E. 알림·트레이 (웹 ↔ 데스크톱)
원격 페이지에는 Tauri 명령을 주지 않는다는 기존 원칙은 유지하되, 아래 두 명령만 `http://127.0.0.1:43123` 출처에 한정해 연다(데스크톱 담당이 capability로 제한, 리뷰 필수).
| 명령 | 인자 | 하는 일 |
|---|---|---|
| `notify` | `{ title, body, target }` (`target` 예: `#/dm/5`) | Windows 알림. 누르면 창을 앞으로 띄우고 `location.hash = target` |
| `set_unread` | `{ count }` | 트레이 툴팁 "상상톡 · 안읽음 N", 아이콘에 표시(가능하면 작업표시줄 배지) |
- 프론트는 `web/public/desktop-bridge.js` 하나로 감싼다: `window.__TAURI_INTERNALS__?.invoke`가 있으면 그것을, 없으면 브라우저 `Notification`(권한 있을 때)을, 둘 다 없으면 아무것도 안 한다.
- 알림 조건: 남이 보낸 새 메시지 + (창이 안 보이거나 포커스 없음, 또는 그 대화가 열려 있지 않음). 본문은 80자로 자른다. 첨부만 있으면 "파일: 이름".
- 해시 경로(프론트가 지원): `#/general`, `#/dm/<userId>`, `#/group/<groupId>`, `#/notes/<userId>`. 해시가 바뀌면 그 화면을 연다.
- 내려받기: 웹뷰에서 `/api/files/...`만 허용하고, 저장 위치를 묻지 않고 다운로드 폴더에 바로 저장한다(같은 이름이면 `이름 (n).확장자`). 끝나면 "내려받기 완료" 알림, 누르면 탐색기에서 그 파일을 보여 준다. (2026-11-16 PM 확정)

## F. 기록 보존(백엔드, 로컬 Zulip 설정)
- 조직 메시지 보존 기간 = 무제한. 사용자 본인 메시지 삭제 = 관리자만. 수정은 허용(이력 유지).
- 적용 방법(스크립트/명령)을 `web/dev/` 또는 문서로 남겨 다시 적용할 수 있게 한다.

## G. 백업(빌드·배포)
- `ops/backup.ps1`: Zulip 백업(`manage.py backup`)을 받아 `C:\SangsangTalk-backup\<날짜>`에 저장, 30일 지난 것 삭제. `ops/restore.md`: 복원 절차.
- Windows 작업 스케줄러 등록 방법은 문서로만 적는다(자동 등록하지 않음).

## 구현 중 확정된 변경(2026-11-16, 백엔드 보고 → PM 승인)
- Zulip이 저장 경로에서 비ASCII 파일명을 지우므로, 원래 이름은 본문 링크 글자에서 가져온다. `attachments.url`과 업로드 응답 `file.url`에 `?name=<원래이름>`이 붙는다. 썸네일은 `&inline=1`을 덧붙인다. 프론트는 url을 그대로 쓴다.
- 업로드는 Zulip tus 경로(일반 경로의 nginx 25MB 제한 회피). `content-length` 필수(없으면 411).
- 받는 쪽 `attachments.size`는 `null`(Zulip 본문에 크기 없음) → 화면은 "크기 모름".
- 그룹 이름이 겹치면 " (2)"를 붙인다.
- Zulip 요청 한도 초과는 429 + 한국어 안내.
- 메시지 수정 제한 시간은 Zulip 기본값(600초) 유지.

## 완료 기준
- 각 담당: 문법 검사, `node web/session-status.check.mjs`, 자기 범위의 동작 확인(실제 Zulip, 테스트 계정 `.credentials/test-accounts.md`).
- 데스크톱: `cargo check` 통과(설치파일 빌드는 PM 지시 때).
- 커밋 금지. 끝나면 바꾼 파일·확인 결과·못 한 것을 PM에게 보고.
