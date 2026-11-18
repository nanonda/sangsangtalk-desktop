# 2단계(P2) 작업 계약서

범용 메신저 기능 비교(2026-11-17)에서 고른 1~3순위 기능을 구현하기 위한 역할 간 약속이다.
1단계 계약서(`docs/p0-contract.md`)의 공통 규칙·메시지 형식은 그대로 유지하고, 여기서는 **추가·변경분만** 적는다.
API·연동 방식을 바꿔야 하면 구현 전에 총괄 PM에게 먼저 알린다. 작성: 총괄 PM, 2026-11-17.

## 진행 순서
세 묶음을 차례로 진행한다. 앞 묶음이 QA·리뷰를 통과하면 다음 묶음으로 간다(백엔드는 목업을 먼저 맞추므로 한 묶음 앞서가도 된다).

| 묶음 | 기능 |
|---|---|
| 2-A (1순위) | A1 읽음 확인 · A2 검색 · A3 답장(인용)·@멘션 · A4 수정·회수 · A5 공지 · A6 부서 대화방 |
| 2-B (2순위) | B1 이모지 반응 · B2 수동 상태 · B3 이미지 크게 보기 · B4 즐겨찾기·별표 · B5 알림 끄기·방해 금지 · B6 입력 중 표시 · B7 예약 메시지 · B8 파일 모아 보기 |
| 2-C (3순위) | C1 CMS 관리자 화면 · C2 감사 로그 · C3 워터마크·캡처 방지 · C4 자동 잠금 · C5 투표·할 일 |

하지 않는 것: 화상·음성 통화, 모바일 앱, 외부 연동 봇.

## PM이 정한 기본값(사용자 확인 전 잠정)
- **회수**: 보낸 사람이 10분(Zulip 수정 제한 600초) 안에만 할 수 있다. 본문을 "회수된 메시지입니다"로 **수정**하는 방식이라 원문은 Zulip 수정 이력에 남는다(관리자 열람). "사용자 삭제 금지" 보존 정책과 충돌하지 않는다.
- **읽음 확인**: 1:1·그룹에서 **내가 보낸 메시지**에 안 읽은 사람 수를 표시한다. 전체 대화방(general)은 인원이 많아 숫자 없이 "읽은 사람 보기"만 둔다.
- **공지**: 대화방마다 1개. 그룹·1:1은 참여자 누구나, 전체 대화방은 관리자만 등록·해제한다.
- **부서 대화방**: 조직도 연계 전에는 직원 프로필의 "부서" 필드 기준으로 만든다. 관리자가 CMS에서 "부서방 동기화"를 누르면 부서별 비공개 채널을 만들고 인원을 맞춘다. 조직도가 들어오면 같은 동기화가 조직도를 원본으로 쓴다.
- **방해 금지·알림 끄기·즐겨찾기**는 Zulip에 맞는 기능이 없거나 1:1에 쓸 수 없어 상상톡 서버의 사용자 설정(`web/data/prefs.json`)에 둔다.

## 메시지 형식 추가 필드
```json
{ "...1단계 필드": "",
  "edited": false, "recalled": false,
  "replyTo": { "id": 120, "senderName": "김도윤", "excerpt": "앞 80자" } | null,
  "mentions": [5, 7], "mentionedMe": false,
  "reactions": [ { "emoji": "thumbs_up", "count": 2, "userIds": [5, 7], "mine": true } ],
  "starred": false,
  "unreadCount": 1 | null,
  "poll": null | { "question": "...", "options": [ { "key": "0,1", "text": "...", "voterIds": [5] } ] },
  "todo": null | { "title": "...", "items": [ { "key": "...", "text": "...", "done": false, "doneBy": 5 | null } ] } }
```
- 모든 배열 필드는 비어도 `[]`. `unreadCount`는 1:1·그룹에서 내 메시지일 때만 숫자, 나머지는 `null`.
- `recalled:true`면 `content`는 "회수된 메시지입니다", `attachments`는 `[]`.
- 서버는 Zulip 본문의 인용 블록·멘션 문법·투표/할 일 위젯을 위 필드로 옮기고 `content`에서는 사람이 읽을 글자만 남긴다.

## 2-A
### A1 읽음 확인
- Zulip 조직 설정 `enable_read_receipts`를 켠다(적용 방법을 `web/dev/` 또는 문서에 남긴다, 1단계 F와 같은 방식).
- `GET /api/messages`: 1:1·그룹 응답의 내 메시지 중 최근 30개에 `unreadCount`를 채운다(서버 15초 캐시). 나머지는 `null`.
- `GET /api/messages/:id/readers` → `{ readIds: [...], unreadIds: [...] }` (나 제외).
- 프론트: 내 말풍선 옆에 노란 숫자(0이면 숨김). 숫자·메뉴 "읽은 사람 보기"를 누르면 읽음/안 읽음 목록. 열린 대화는 30초마다 숫자를 다시 읽는다(남의 읽음은 이벤트로 오지 않음).

### A2 검색
- **먼저 확인(백엔드)**: Zulip 기본 검색은 한국어 형태소를 못 나눈다. PGroonga(`SETTING_USING_PGROONGA`)를 켜서 한국어 부분 검색이 되는지 로컬에서 확인하고 `compose.yaml`·`ops/compose/*`에 반영한다. 안 되면 PM에게 보고.
- `GET /api/search?q=<검색어>&view=all|general|dm|group&userId=&groupId=&before=` → `{ messages, hasOlder }` (최신순 50개, 각 메시지에 `kind`·`peerId`·`groupId`가 있어 어느 대화인지 안다). 쪽지는 검색하지 않는다.
- 프론트: 목록 위 검색창에 "메시지 검색" 탭, 대화창 머리글에 "이 대화방에서 검색". 결과를 누르면 그 대화를 열고 그 메시지로 스크롤·강조(앞뒤 기록은 `GET /api/messages?...&around=<id>`로 불러온다 — 서버에 `around` 추가).

### A3 답장(인용)·@멘션
- `POST /api/messages`에 `replyToId`(선택). 서버가 Zulip 인용 블록을 본문 앞에 붙이고, 읽을 때 `replyTo`로 돌려준다.
- 멘션: 프론트가 `@`를 치면 직원 자동완성, 보낼 때 `{ mentions: [userId] }`를 함께 보낸다. 서버가 Zulip 문법 `@**이름|id**`로 바꾸고, 읽을 때 `mentions`·`mentionedMe`(Zulip `mentioned` 플래그)로 돌려준다. 본문 글자에는 `@이름`이 남는다.
- 프론트: 말풍선 메뉴 "답장", 입력창 위 인용 미리보기(취소 가능), 말풍선 위 인용 상자(누르면 원문으로 이동). 나를 멘션한 메시지는 강조하고, 알림 끈 대화방이어도 알린다.

### A4 수정·회수
- `PATCH /api/messages/:id` `{ content }` → `{ message }` (내 메시지, 10분 안). 그 뒤는 403 + "보낸 지 10분이 지나 수정할 수 없습니다."
- `POST /api/messages/:id/recall` → `{ message }` (같은 조건). 첨부 줄도 지운다(파일 자체는 Zulip에 남음).
- `/api/events`에 `updated: [message]`를 넣는다(수정·회수·반응·투표 변경 공통).
- 프론트: 말풍선 메뉴 "수정"(입력창에서 고치기)·"회수"(확인 후). 수정된 말풍선에 "(수정됨)", 회수된 말풍선은 흐린 글자.

### A5 공지
- 저장: `web/data/notices.json` (`{ key: "general" | "dm:<작은id>-<큰id>" | "group:<id>", messageId, setBy, setAt }`). 메시지 본문은 저장하지 않는다.
- `GET /api/messages` 응답에 `notice: { message, setByName, setAt } | null`.
- `POST /api/notices` `{ view, userId?, groupId?, messageId }`, `DELETE /api/notices?view=&userId=&groupId=` → `{ notice }`. 권한은 위 기본값. `/api/events`에 `noticesChanged: true`.
- 프론트: 말풍선 메뉴 "공지로 등록", 대화창 위 공지 바(한 줄, 펼치기·닫기·해제). 닫기는 그 공지에 한해 내 화면에서만.

### A6 부서 대화방
- 부서방은 그룹 대화방과 같은 구조(비공개 채널)에 `kind: "dept"` 표시를 붙인다. `GET /api/groups` 항목에 `dept: true | false`. 부서방은 사용자가 나가거나 초대·이름 변경할 수 없다(403).
- 동기화는 C1의 관리자 API `POST /api/admin/dept-sync`가 한다. 이름은 부서명 그대로.
- 프론트: 목록 "고정됨" 아래 "내 부서" 구역(그룹보다 위).

## 2-B
| # | API | 프론트 |
|---|---|---|
| B1 반응 | `POST /api/messages/:id/reactions` `{ emoji }`, `DELETE` 같은 경로 `?emoji=`. 쓸 수 있는 것: `thumbs_up` `check` `smile` `clap` `pray` `open_mouth` | 말풍선에 마우스를 올리면 반응 고르기, 아래에 반응 칩(누르면 토글, 올리면 누가 눌렀는지) |
| B2 수동 상태 | `POST /api/status` `{ code: "meeting" \| "trip" \| "leave" \| "outside" \| "training" \| "", text }` → Zulip `/users/me/status`. `GET /api/presence` 항목을 `{ presence, status: { code, text } }`로 넓힌다 | 내 프로필에서 상태 고르기·문구 입력, 자동 상태 점 옆에 상태 글자. 거돌이 이미지는 디자이너 시안이 오면 |
| B3 이미지 보기 | — | 썸네일을 누르면 크게 보기(대화방 안 이미지 좌우 넘기기, 내려받기, Esc 닫기) |
| B4 즐겨찾기·별표 | 즐겨찾기 대화방은 `GET/PATCH /api/prefs` (`favorites: ["dm:5", "group:12"]`). 별표는 `POST/DELETE /api/messages/:id/star`, `GET /api/starred` | 목록 맨 위 "즐겨찾기" 구역, 말풍선 메뉴 "나중에 보기", 레일에 "별표 메시지" |
| B5 알림 끄기·방해 금지 | `prefs`에 `muted: ["group:12", ...]`, `dnd: { enabled, from: "18:00", to: "09:00", weekends: true }` | 대화방 메뉴 "알림 끄기"(안읽음 숫자는 회색), 설정에 방해 금지. 꺼진 대화·방해 금지 중엔 `notify`를 부르지 않되 나를 멘션하면 알린다 |
| B6 입력 중 | `POST /api/typing` `{ view, userId?, groupId?, op: "start" \| "stop" }`. `/api/events`에 `typing: [{ view, userId?, groupId?, senderId }]` | 입력창 위 "○○님이 입력 중…"(3명 이상은 "여러 명이") |
| B7 예약 메시지 | `GET/POST /api/scheduled`, `DELETE /api/scheduled/:id` (Zulip `/scheduled_messages`, 첨부 가능) | 보내기 버튼 옆 메뉴 "예약 보내기"(날짜·시간), 대화창에 "예약 N개" 보기·취소 |
| B8 파일 모아 보기 | `GET /api/files/list?view=&userId=&groupId=&before=` → `{ files: [ { ...attachment, messageId, senderName, timestamp } ], hasOlder }` | 대화창 머리글 메뉴 "파일 모아 보기"(이미지/문서 탭) |

## 2-C
### C1 CMS 관리자 화면
- `APP_ONLY_LOGIN=1`이어도 Zulip **관리자·소유자** 역할은 브라우저 로그인을 허용한다(그 외는 지금처럼 403). 관리자 화면은 `/admin`(`web/public/admin.html`), 관리자 아닌 세션은 403.
- API(모두 관리자만, 모두 C2 감사 로그에 남김):
  - `GET /api/admin/users` → `{ users: [ { userId, fullName, loginId, department, position, role, active } ] }`
  - `POST /api/admin/users` `{ fullName, loginId, department, position, password }` — 비정규직 등 개별 생성. Zulip `POST /users`(관리 계정에 `can_create_users` 권한 필요 — 부여 절차를 `ops/README.md`에 적는다).
  - `PATCH /api/admin/users/:id` `{ fullName?, department?, position?, role? }`, `POST /api/admin/users/:id/deactivate`·`/reactivate`(퇴직·복귀)
  - `POST /api/admin/users/:id/password` — **먼저 조사(백엔드)**: Zulip API에는 관리자가 남의 비밀번호를 바꾸는 기능이 없다. 가능한 방법(② 서버의 관리 명령 연동 등)과 보안 영향을 PM에게 보고한 뒤 정한다. 정해지기 전까지 화면은 "서버 관리자에게 요청" 안내.
  - `POST /api/admin/dept-sync` → `{ created, added, removed }` (A6)
  - `GET /api/admin/audit?from=&to=&userId=&action=` (C2)
- 로그인 ID: 메일이 없으므로 Zulip 이메일 칸에 `<사번>@<내부도메인>` 형식을 넣는 것을 기본으로 한다(도메인은 이관 때 확정).

### C2 감사 로그
- 서버가 `web/data/audit/YYYY-MM.jsonl`에 한 줄씩 남긴다: `{ at, userId, ip, action, target, ok }`. action: `login` `login_fail` `logout` `file_download` `file_upload` `recall` `admin_*`. **메시지 본문·비밀번호는 남기지 않는다.**
- 보존 기간 환경변수 `AUDIT_KEEP_MONTHS`(기본 12), 지난 파일은 서버가 시작할 때 지운다. `.env.example`에 추가.

### C3 워터마크·캡처 방지
- 워터마크(프론트): 대화창 배경에 "이름 · 로그인ID 앞부분 · 날짜"를 옅게 반복. 설정 `WATERMARK=1`(기본 켬)을 `/api/session`에 실어 준다.
- 캡처 방지(데스크톱): 빌드 때 `SANGSANGTALK_CAPTURE_BLOCK=1`이면 창에 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`를 건다. 기본은 끔(업무 캡처를 막기 때문).

### C4 자동 잠금
- 입력이 없는 채로 `AUTO_LOCK_MINUTES`(기본 30, 0이면 끔)가 지나면 프론트가 잠금 화면을 띄운다(대화 내용 가림). 값은 `/api/session`에 실어 준다.
- `POST /api/session/unlock` `{ password }` → `{ ok: true }` 또는 401. 서버는 Zulip으로 비밀번호를 확인하고, 5회 틀리면 로그아웃시킨다.

### C5 투표·할 일
- 보내기: `POST /api/messages`에 `{ poll: { question, options: [...] } }` 또는 `{ todo: { title, items: [...] } }` → Zulip `/poll`·`/todo` 위젯 메시지.
- 참여: `POST /api/messages/:id/poll` `{ key }`(토글), `POST /api/messages/:id/todo` `{ key }`(완료 토글) → Zulip submessage. 결과는 메시지 `poll`·`todo` 필드와 `updated` 이벤트.
- 프론트: 입력창 "+" 메뉴 "투표 만들기"·"할 일 만들기", 말풍선 안 투표 카드(누른 사람 수·이름)·체크리스트.

## 역할
| 역할 | 범위 |
|---|---|
| 백엔드 | 위 API 전부, 목업(`web/dev/mock-server.mjs`) **가장 먼저**, PGroonga·읽음 확인 조직 설정, `prefs`·`notices`·`audit` 저장소(`web/lib/`), `.env.example` |
| 프론트엔드 | `web/public/` 화면 전부(관리자 화면 `admin.html` 포함). 목업으로 먼저 개발 |
| 데스크톱 | C3 캡처 방지 옵션. 멘션 알림·방해 금지는 프론트가 `notify` 호출 여부로 처리하므로 셸 변경 없음(필요하면 PM에게) |
| 디자이너 | v3 시안: 읽음 숫자, 인용·답장, 공지 바, 반응 칩, 상태 고르기, 이미지 보기, 검색 결과, 잠금 화면, 관리자 화면, 투표 카드 |
| 빌드·배포 | `ops/` 반영(PGroonga, `can_create_users`, 새 환경변수), BUILD.md |

## 구현 중 확정된 변경(2026-11-17, 백엔드 보고 → PM 승인)
- `/api/session`·`/api/login` 응답에 `role`("owner"|"admin"|"moderator"|"member"|"guest")과 `isAdmin`.
- `GET /api/messages`에 `after=<id>`(아래쪽 더 불러오기)와 응답 `hasNewer`. `before`·`after`·`around`는 하나만(둘 이상이면 400). 보통 응답의 `hasNewer`는 `false`.
- 부서방 메시지의 `kind`는 `"group"` 그대로, 그룹 항목에만 `dept: true`.
- `/api/events` 응답에 `updated: []`, `noticesChanged: false`가 늘 들어간다.
- 오류: 남의 메시지 수정·회수 403 "내가 보낸 메시지만 고칠 수 있습니다.", 회수된 메시지 수정 400, 다른 대화 메시지에 답장 400, 쪽지에 답장·멘션 400, 부서방 변경 403 "부서 대화방은 이름을 바꾸거나 초대·나가기를 할 수 없습니다.", 관리자 아닌 사람의 전체방 공지 변경 403.
- 검색 결과에서 회수된 메시지는 뺀다.
- 검색: Zulip `SETTING_USING_PGROONGA: "True"`로 한국어 부분 검색(조사 붙은 말, 단어 안쪽 일부)을 지원한다. `zulip/zulip-postgresql:14`에 확장이 이미 있다. `ops/compose/compose.app.yaml`에도 같은 줄(빌드·배포).
- 비밀번호 초기화(C1): 당분간 운영 절차(② 서버에서 `manage.py change_password`), CMS는 안내만. Zulip은 비밀번호를 바꿔도 API 키를 유지하므로, 도용 대응 때는 관리자 API "세션 끊기"(상상톡 세션 삭제 + API 키 재발급)를 함께 쓴다. 관리자가 직접 초기화하는 좁은 도우미 방식은 사용자 결정 전까지 보류.
- 읽음 표시: `POST /api/messages/read { messageIds }`. 프론트는 대화를 열 때와, 창이 보이는 동안 열린 대화에 새 메시지가 오면 부른다(이게 없으면 상대 쪽 읽음 숫자가 줄지 않는다).
- 회수해도 첨부 줄은 Zulip 본문에 남기고 화면에서만 숨긴다(`attachments: []`). 줄을 지우면 Zulip의 연결 안 된 파일 정리 작업이 파일을 지워 보존 정책과 충돌한다.
- 부서방 표시: Zulip 채널 설명이 "[상상톡 부서 대화방]"으로 시작하면 `dept: true`. dept-sync가 이 설명으로 만든다.
- 읽음 숫자는 최신 내 메시지부터 확인해 모두 읽은 메시지가 나오면 그 이전은 0으로 본다(15초 캐시). 이벤트로 온 메시지의 `unreadCount`는 `null`.
- 회수된 메시지를 공지로 등록하면 400. 쪽지는 공지·답장 대상이 아니다(404).
- 조직 설정 적용 스크립트: `web/dev/apply-p2-settings.mjs`(읽음 확인 켜기, 수정 제한 600초).
- (2-B) `GET /api/presence` 형식 변경: `{ presence: { "<id>": { presence, status: { code, text } } } }`, 상태 없으면 `code: ""`. 상태 문구 60자까지.
- (2-B) `/api/events`에 `typing: [{ view, userId?, groupId?, senderId, op: "start"|"stop" }]`가 늘 들어간다. 프론트는 15초 동안 새 start가 없으면 숨긴다.
- (2-B) 반응·별표 응답은 `{ message }`, 반응은 남에게 `updated` 이벤트. 6종 밖 반응·회수된 메시지 반응은 400.
- (2-B) `PATCH /api/prefs`는 보낸 필드만 바꾸고 전체를 돌려준다. `GET /api/starred?before=` → `{ messages(최신순 100), hasOlder }`.
- (2-B) 예약 항목 `{ id, view, userId, groupId, content, attachments, mentions, scheduledAt(유닉스 초) }`, 1분 뒤~1년 안.
- (2-B) 파일 목록은 최신순, 다음 페이지는 마지막 `messageId`를 `before`로.
- (2-B) 상태 코드는 Zulip 상태 이모지로 저장한다(meeting→calendar, trip→airplane, leave→palm_tree, outside→walking, training→books), 문구는 status_text. Zulip 웹에서 붙인 6종 밖 반응은 상상톡에 보이지 않는다. `/api/events`는 heartbeat로 가끔 빈 응답이 오며 프론트는 그냥 다시 폴링한다.
- (2-C) 비밀번호 초기화 API는 당분간 501 "서버 관리자에게 요청하세요".
- (2-C) `/admin`은 관리자가 아니면 403. `/api/session`에 `watermark`(bool)·`autoLockMinutes`(0=끔). 잠금 풀기 실패는 401 `{ error, signedOut: false, remaining }`, 5번째는 401 `{ signedOut: true }`로 로그아웃 — 프론트는 `signedOut`으로 "다시 로그인"과 구분한다.
- (2-C) 투표·할 일 메시지는 `content: ""`, 카드는 `poll`·`todo`로 그린다. 키는 Zulip 위젯과 같다(투표 "canned,0", 할 일 "0,canned"). 투표 질문 1 + 항목 2~10, 할 일 제목 1 + 항목 1~30(각 100자). 쪽지로는 400.
- (2-C) 관리 API: 하나는 `{ user }`, 목록은 `{ users }`. 자기 자신의 역할 변경·퇴직 처리는 400. `GET /api/admin/audit` → `{ entries }`(최신순 1000개), `from`·`to`는 YYYY-MM-DD, 항목 `{ at(ISO), userId, ip, action, target, ok }`.
- (QA 후 PM 결정) 공지로 등록된 메시지가 회수되면 공지를 자동 해제한다(`noticesChanged`). 원문이 회수된 답장의 `replyTo`는 `excerpt: "회수된 메시지입니다"`, `recalled: true`로 돌려준다(옛 원문이 인용에 남지 않게).
- (2-C) 부서방 동기화 결과 `{ created, restored, added, removed, conflicts }`: 보관된 부서방은 보관을 풀어 쓰고, 같은 이름의 일반 그룹이 있으면 `conflicts`에 넣고 건너뛴다.
- (2-C) `/admin`: 로그인 전 "/"로 302, 관리자 아님 403. 감사 IP는 프록시 뒤에서 X-Forwarded-For의 마지막 값(nginx `proxy_add_x_forwarded_for` 필요). 썸네일(inline=1)은 다운로드 기록에서 뺀다.
- (2-C) Zulip은 같은 ID로 30분에 5번 비밀번호가 틀리면 30분 동안 로그인을 막는다(429). 잠금 화면 실패 안내에 "5번 틀리면 로그아웃되고 30분 동안 로그인할 수 없습니다"를 넣는다. 풀기: `manage.py reset_authentication_attempt_count -u <로그인ID>`(운영 문서).
- (2-C) 직원 생성에는 관리 계정의 `can_create_users`가 필요(`manage.py change_user_role -r '' <관리자> can_create_users`, 운영 문서). "/poll"·"/todo"로 시작하는 일반 글은 앞에 U+200B를 붙여 글로 보낸다. 투표·할 일 메시지는 수정 불가(400).
- (후속) `replyTo.recalled`(평소 false). 이미 화면에 있는 답장에는 이벤트가 오지 않으므로, 프론트는 `updated`로 회수된 메시지를 받으면 그 id를 `replyTo.id`로 가진 말풍선도 바꾼다.
- (후속) `GET /api/admin/dept-sync?dryRun=1` → `{ dryRun, created, restored, added, removed, conflicts, details: [{ name, action: "create"|"restore"|"update"|"none"|"conflict", add, remove }] }`(바꾸지 않음). POST도 `details`를 준다. dryRun 없는 GET은 400.
- (후속) 관리 사용자 항목에 `deactivatedAt`(상상톡에서 퇴직 처리한 경우만, 아니면 null)·`mustChangePassword`. 저장 `web/data/admin-meta.json`. `/api/session`에 `department`·`position`·`mustChangePassword`.
- (후속) `POST /api/admin/users/:id/logout` → `{ ended, apiKeyRenewed: false }`(세션·이벤트 큐 끊기, 퇴직 처리 때 자동). Zulip API 키 재발급은 관리자 API가 없어 운영 절차로.
- (후속) 첫 로그인 비밀번호 변경: 관리자가 만든 계정은 `mustChangePassword: true`, `PATCH /api/admin/users/:id { mustChangePassword }`로도 켠다. 본인 변경 `POST /api/session/password { oldPassword, newPassword }` → `{ ok: true }`(8자 이상, Zulip 강도 검사). 감사 action `admin_user_logout`·`admin_dept_sync_preview`·`password_change`.
- (리뷰 후 PM 결정) 잠금과 첫 로그인 비밀번호 변경은 서버에서도 강제한다. `mustChangePassword`면 session·password·logout 외 `/api/*`는 403 `{ mustChangePassword: true }`. 프론트가 잠글 때 `POST /api/session/lock`을 부르고, 잠긴 동안 session·unlock·logout·lock 외 `/api/*`는 423 `{ locked: true }`. `/api/session`에 `locked`. 잠금 풀기 중 Zulip 429는 401 `{ signedOut: true }`로 로그아웃.
- (리뷰 후) 투표·할 일은 수정·회수 모두 400. 답장 없이 보낸 본문의 인용 문법과 직접 쓴 멘션 문법은 무력화한다(검증된 `mentions`만 멘션).
- (리뷰 후) `GET /api/admin/audit?action=admin_*` 접두어 필터("*"는 끝에만). 새 환경변수 `LOGIN_DOMAIN`(비우면 null, 점 있는 도메인만, 잘못된 값이면 서버가 시작하지 않음) → `/api/session`·로그인 응답의 `loginDomain`. 잠금 423·비밀번호 변경 전 403은 관리 API에도 걸린다.
- 목업 전용: `POST /api/dev/simulate` `{ type: "mention"|"read"|"edit"|"recall"|"notice" }`, `MOCK_ROLE=member`로 띄우면 관리자 아님.

## 완료 기준
- 1단계와 같다: 문법 검사, `node web/session-status.check.mjs`, 자기 범위의 동작 확인(실제 Zulip, 테스트 계정 `.credentials/test-accounts.md`).
- 묶음마다 QA(`qa-tester`) → 리뷰(`reviewer`) → PM 커밋.
- 커밋 금지. 끝나면 바꾼 파일·확인 결과·못 한 것을 PM에게 보고한다.
