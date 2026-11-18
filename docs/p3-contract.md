# 3단계(P3) 작업 계약서 — 알림과 설정

기획안 `docs/p3-plan.md`를 구현하기 위한 역할 간 약속이다. 1·2단계 계약서(`docs/p0-contract.md`, `docs/p2-contract.md`)의 규칙·형식은 그대로 두고 **추가·변경분만** 적는다.
API·연동 방식을 바꿔야 하면 구현 전에 총괄 PM에게 먼저 알린다. 작성: 총괄 PM, 2026-11-18.

## 진행 순서
| 묶음 | 기능 |
|---|---|
| 3-A | S1 설정 화면 틀 · N1 미리 보기 · N2 알림음 · N3 잠시 끄기 · N4 키워드 알림 · N5 작업표시줄 |
| 3-B | N6 알림 센터 · N7 중요 메시지 · N8 공지 확인 요청 |
| 3-C | P1 내 정보 · P2 화면 · P3 대화 · P4 보안·개인정보 · P5 PC 앱 |
| 3-D | D1 관리자 정책 |

- 백엔드는 **목업(`web/dev/mock-server.mjs`)을 가장 먼저** 맞춘다. 묶음 순서와 관계없이 API를 한꺼번에 만들어도 된다.
- 프론트는 목업과 v4 시안으로 묶음 순서대로 붙인다. 시안이 없는 부분은 v3 시안의 컴포넌트를 재사용해 먼저 만들고, 시안이 오면 맞춘다.
- 묶음마다 QA(`qa-tester`) → 리뷰(`reviewer`) → PM 커밋.

## 공통: 사용자 설정(`prefs`) 확장
`GET /api/prefs`, `PATCH /api/prefs`(부분 갱신, 보낸 필드만 바꾼다). 저장 위치는 지금처럼 `web/data/prefs.json`이다.
`favorites`, `muted`, `dnd`는 2단계와 같다.

```json
{ "favorites": [], "muted": [], "dnd": { "enabled": false, "from": "18:00", "to": "09:00", "weekends": true },
  "notify": {
    "preview": "full" | "name" | "none",
    "sound": "default" | "im" | "mail" | "reminder" | "none",
    "flash": true,
    "snoozeUntil": null | "2026-11-18T18:00:00+09:00",
    "replyBypassMute": true
  },
  "display": { "theme": "system" | "light" | "dark", "fontSize": "small" | "normal" | "large", "density": "comfortable" | "compact" },
  "chat": { "enterSends": true, "autoShowImages": true, "roomSort": "recent" | "name" },
  "presence": { "awayMinutes": 10 },
  "lock": { "minutes": null | 0..1440 } }
```
- 서버가 값을 검사하고, 범위를 벗어나면 400과 한국어 오류를 돌려준다. 저장된 파일에 없는 필드는 위 기본값으로 채워 돌려준다.
- `notify.snoozeUntil`: 과거 시각이면 서버가 `null`로 돌려준다. 최대 7일 뒤까지 허용한다.
- `presence.awayMinutes`: 5, 10, 15, 30, 60 중 하나.
- `lock.minutes`: `null`이면 관리자 값을 따른다. 관리자 값(`AUTO_LOCK_MINUTES`)보다 크면 400을 돌려준다. 0(끔)은 관리자 값이 0일 때만 허용한다.
- 관리자 정책(D1)으로 고정된 값을 바꾸려 하면 403 "기관 정책으로 고정된 설정입니다."를 돌려준다.

## 3-A
### S1 설정 화면 틀
- **프론트**:
  - 레일 아래 톱니 버튼 → 설정 모달을 띄운다. 탭: 내 정보 · 알림 · 화면 · 대화 · 보안·개인정보 · PC 앱(데스크톱일 때만).
  - 지금 흩어진 설정을 이 화면으로 옮긴다: 방해 금지(상태 창 → 알림 탭), 알림 끈 대화방 목록(알림 탭, 여기서 끌 수 있음). 시작 시 실행은 P5에서 옮긴다.
  - 바꾸면 바로 `PATCH /api/prefs`로 저장한다. 실패하면 값을 되돌리고 오류를 표시한다.
  - 정책으로 고정된 항목은 비활성화하고 "기관 정책으로 고정됨"을 표시한다.
- 화면 하단에 앱 버전을 표시한다. 웹 버전은 `/api/session`의 `version`, 데스크톱 버전은 브리지 `appInfo()`에서 가져온다.

### N1 미리 보기
- `notify.preview`:
  - `full`: 보낸 사람과 본문을 보여 준다.
  - `name`: 보낸 사람과 "새 메시지"만 보여 준다.
  - `none`: "상상톡"과 "새 메시지가 왔습니다"만 보여 준다.
- 프론트가 `notify()`를 부르기 전에 적용한다.

### N2 알림음
- `notify.sound`를 데스크톱 `notify`에 넘긴다. 데스크톱은 Windows 알림 소리를 쓴다.
  - `default`: 기본 소리
  - `im`: `ms-winsoundevent:Notification.IM`
  - `mail`: `Notification.Mail`
  - `reminder`: `Notification.Reminder`
  - `none`: 소리 없음
- 설정 화면에 "소리 들어 보기" 버튼을 둔다(데스크톱이면 테스트 알림을 띄운다).
- 브라우저에서는 소리를 고를 수 없으므로 안내 문구만 보여 준다.

### N3 잠시 끄기
- `notify.snoozeUntil`을 쓴다. 고르는 값: 1시간, 3시간, 오늘 하루(그날 23:59까지), 직접 입력.
- 끈 동안에는 멘션도 알리지 않는다. 중요 메시지(N7)만 알린다.
- 레일의 종 아이콘에 "꺼짐"과 남은 시간을 표시한다. 시간이 끝나면 프론트가 표시를 지운다.

### N4 키워드 알림
- API:
  - `GET /api/keywords` → `{ keywords: ["예산", "감사"] }`
  - `POST /api/keywords` `{ keyword }`
  - `DELETE /api/keywords?keyword=`
  - 서버는 Zulip `/users/me/alert_words`를 쓴다.
  - 키워드는 최대 20개, 각 2~30자. 앞뒤 공백을 지우고, 이미 있는 키워드는 무시한다.
- 메시지 형식에 `alerted: boolean`을 추가한다(Zulip `has_alert_word` 플래그).
- 프론트:
  - `alerted`이면 멘션처럼 알린다. 알림 끈 방에서도 알리고, 방해 금지 중에는 알리지 않는다.
  - 말풍선 안의 키워드를 강조한다(키워드 목록으로 표시만 한다).

### N5 작업표시줄
- 데스크톱:
  - 안읽음이 있으면 작업표시줄 아이콘에 배지(오버레이 아이콘)를 단다. `set_unread`가 이미 받는 숫자를 쓴다.
  - 새 `notify`가 오고 창이 앞에 없으면 작업표시줄을 깜박인다(`request_user_attention`).
- `notify`에 새 인자를 추가한다. 기존 호출과 호환되도록 모두 선택 인자다.
  - `flash`(기본 true)
  - `sound`(기본 "default")
  - `urgent`(N7, 기본 false)

## 3-B
### N6 알림 센터
- `GET /api/activity?kind=all|mention|reply|reaction|notice|keyword&before=` → `{ items: [...], hasOlder, unseen }`.
  - 각 항목은 아래와 같다.
    `{ id, kind, at, view, userId?, groupId?, messageId, actorId, actorName, excerpt, emoji?, seen }`
  - `excerpt`는 80자 이내다. 회수된 메시지면 "회수된 메시지입니다"다.
  - 최신순으로 한 번에 50개를 돌려준다. 최근 30일, 종류마다 최대 200개다.
- 출처:
  - **mention**: Zulip 검색 `is:mentioned`
  - **keyword**: `is:alerted`
  - **reply**: 남의 답장이 내 메시지를 가리킬 때. 서버가 `POST /api/messages`의 `replyToId`를 보고 활동 저장소에 기록한다.
  - **reaction**: 남이 내 메시지에 반응을 눌렀을 때. 우리 반응 API를 거친 것만 활동 저장소에 기록하고, 반응을 취소하면 항목을 지운다.
  - **notice**: 내가 볼 수 있는 대화방에 공지가 등록될 때. 공지 저장소에서 가져온다.
- 활동 저장소: `web/data/activity.json`. 메시지 본문은 저장하지 않고 id만 둔다. 읽을 때 Zulip에서 `excerpt`를 가져온다.
- `POST /api/activity/seen` `{ upTo: "<id>" | "all" }`. `unseen`은 안 본 항목 수다.
- `/api/events`에 `activity: { unseen }`을 추가한다. 새 항목이 생길 때만 보낸다.
- 프론트:
  - 레일에 종 아이콘(안 본 개수 배지)을 둔다. 누르면 오른쪽 서랍이 열린다. 탭: 전체 · 멘션 · 답장·반응 · 공지.
  - 항목을 누르면 그 메시지로 이동한다(2단계의 원문 이동을 재사용). "모두 확인"이 있다.
  - 답장 알림: 내 글에 단 답장(`replyTo`가 내 메시지)은 알림 끈 방에서도 알린다(`notify.replyBypassMute`).

### N7 중요 메시지
- `POST /api/messages`에 `urgent: true`를 넣는다(선택). 메시지 형식에 `urgent: boolean`을 추가한다.
  - 저장 방식은 백엔드가 정해 PM에게 알린다. 권장은 Zulip 본문의 표식이다(다른 클라이언트에서도 보이고 저장소를 잃어도 남는다). 본문에서 표식은 지우고 `urgent`로 옮긴다.
  - 사용자가 직접 쓴 표식 문법은 무력화한다(2단계의 멘션·인용과 같다).
- 제한:
  - 전체 대화방은 관리자만 쓸 수 있다(그 외 403 "전체 대화방의 중요 메시지는 관리자만 보낼 수 있습니다.").
  - 한 사람이 시간당 10번까지 보낼 수 있다(넘으면 429 "중요 메시지는 1시간에 10번까지 보낼 수 있습니다.").
  - 쪽지·투표·할 일·예약 메시지는 대상이 아니다(400).
  - 감사 로그 action은 `urgent_send`다.
- 받는 사람의 프론트는 방해 금지·알림 끄기·잠시 끄기와 관계없이 `notify({ urgent: true })`를 부른다. 미리 보기 정책(N1·D1)은 그대로 따른다.
- 데스크톱:
  - `urgent`면 사용자가 닫을 때까지 남는 알림(`scenario="reminder"`)을 띄운다. 소리는 `Notification.Reminder`이고, `sound: "none"`이어도 소리를 낸다.
  - 작업표시줄 깜박임은 창이 앞으로 올 때까지 계속된다.
- 화면: 보내기 메뉴 "중요 메시지로 보내기", 말풍선에 붉은 띠와 "중요" 표시.

### N8 공지 확인 요청
- `POST /api/notices`(2단계)에 `ackRequired: true`(선택)를 넣는다. 공지 형식에 다음을 추가한다.
  `ackRequired, ackCount, ackTotal, ackedByMe`
- 확인 API:
  - `POST /api/notices/ack` `{ view, userId?, groupId? }`: 지금 공지를 확인한다. 같은 사람이 다시 확인해도 그대로다.
  - `GET /api/notices/acks?view=&groupId=` → `{ acked: [{ userId, name, at }], pending: [{ userId, name }] }`
  - 목록은 공지를 등록한 사람과 관리자만 볼 수 있다(그 외 403).
  - `ackTotal`은 등록 시점의 대화방 인원에서 등록한 사람을 뺀 수다.
- 감사 로그 action은 `notice_ack`다. 공지가 해제·교체돼도 감사 로그는 남는다.
- `/api/events`의 공지 변경 알림(`noticesChanged`)에 확인 수 변화도 포함한다.
- 화면:
  - 받는 사람: 공지 바에 "확인" 버튼이 있고, 누르면 "확인함"으로 바뀐다.
  - 등록한 사람: "확인 N/M명"을 누르면 목록 창이 열린다.
  - 확인 요청 공지는 활동 센터(notice)에도 들어간다.

## 3-C
### P1 내 정보
- 비밀번호 변경: 이미 있는 `POST /api/session/password`를 쓴다. 설정에 "비밀번호 바꾸기"(현재 비밀번호, 새 비밀번호, 확인)를 둔다.
- 프로필 사진: **먼저 조사(백엔드)**.
  - Zulip API로 본인 사진을 올리고 지우는 방법과, 관리자가 남의 사진을 바꾸는 방법을 조사해 PM에게 보고한다.
  - 정해지기 전까지 API는 없다. 화면에는 사진과 "사진 변경은 준비 중입니다"만 표시한다.
  - 정해지면 다음 형태로 한다.
    - `POST /api/me/avatar`(multipart, png/jpg 5MB 이하)
    - `DELETE /api/me/avatar`
    - 메시지·사람 목록의 `avatarUrl`
- 이름·부서·직책은 표시만 한다("관리자가 관리합니다").

### P2 화면
- `display.theme`, `fontSize`, `density`를 쓴다. 프론트는 `<html data-theme data-font data-density>`로 적용한다.
- `system`이면 `prefers-color-scheme`을 따른다.
- 어두운 테마는 색을 CSS 변수로 모은 뒤 만든다. 관리자 화면(`admin.css`)도 같은 변수를 쓴다.
- 로그인 전 화면은 마지막 값을 `localStorage`에서 읽어 깜박임을 막는다. 개인정보가 아니므로 저장해도 된다.

### P3 대화
- `chat.enterSends`:
  - `true`면 엔터로 보내고 Shift+엔터로 줄을 바꾼다.
  - `false`면 Ctrl+엔터로 보내고 엔터로 줄을 바꾼다.
- `chat.autoShowImages`가 `false`면 이미지 자리에 "사진 보기" 버튼만 둔다. 썸네일도 누르기 전에는 받지 않는다.
- `chat.roomSort`는 대화방 목록 정렬이다. 즐겨찾기 구역은 항상 맨 위다.

### P4 보안·개인정보
- 개인 자동 잠금: `lock.minutes`를 쓴다. 프론트는 `min(관리자 값, 개인 값)`을 적용한다. 서버의 잠금 강제(423)는 2단계와 같다.
- 자동 자리 비움: `presence.awayMinutes` 동안 입력이 없으면 프론트가 `idle`을 보고한다.
- 내 로그인 목록:
  - `GET /api/me/sessions` → `{ sessions: [{ id, current, client: "desktop" | "browser", createdAt, lastSeenAt, ip }] }`
    - `id`는 세션 키가 아니라 서버가 만든 짧은 해시다.
    - `client`는 요청 헤더로 판단한다.
    - `lastSeenAt`은 1분 단위로만 갱신한다(쓰기 부하).
  - `DELETE /api/me/sessions/:id`: 그 세션만 로그아웃시킨다. 현재 세션은 400이다(로그아웃 버튼을 쓴다).
  - `DELETE /api/me/sessions?others=1`: 다른 세션을 모두 로그아웃시킨다.
  - 감사 로그 action은 `session_revoke`다.
- 공개 설정:
  - `GET /api/me/privacy` → `{ readReceipts, presence, typing }`
  - `PATCH /api/me/privacy`
  - Zulip 개인 설정에 대응한다.
    - `readReceipts` → `send_read_receipts`
    - `presence` → `presence_enabled`
    - `typing` → `send_private_typing_notifications`·`send_stream_typing_notifications` 둘 다
  - 끄면 내 정보가 남에게 안 보인다는 안내를 붙인다.

### P5 PC 앱(데스크톱)
- 새 브리지 명령. 모두 `require_app_caller`로 호출한 곳을 확인한다.
  - `app_info` → `{ version, captureBlock }`
  - `get_autostart`·`set_autostart { enabled }`: 트레이 메뉴와 같은 상태를 쓴다.
  - `get_close_action`·`set_close_action { action: "tray" | "quit" }`
    - 기본 `tray`. 앱 데이터 폴더에 저장한다(서버 아님, 기기별 설정).
  - `get_hotkey`·`set_hotkey { enabled, accelerator }`
    - 기본은 꺼짐, 단축키 `Ctrl+Shift+Space`.
    - 다른 프로그램이 이미 쓰면 오류를 돌려준다. 프론트는 "다른 프로그램이 쓰는 단축키입니다"를 표시한다.
    - 의존성 `tauri-plugin-global-shortcut`을 추가한다. Cargo.lock은 v4를 유지한다.
- `desktop-bridge.js`(프론트)에 위 함수와 `notify`의 새 인자(`sound`, `flash`, `urgent`)를 추가한다. 브라우저에서는 없는 기능으로 처리하고 PC 앱 탭을 숨긴다.
- 웹 버전: `/api/session`에 `version`(`web/package.json`의 version)을 추가한다.

## 3-D
### D1 관리자 정책
- `GET /api/admin/policy`, `PATCH /api/admin/policy`(관리자만, 감사 로그 `admin_policy`)
  ```json
  { "forcePreviewHidden": false, "blockedExtensions": ["exe", "bat"], "maxUploadMb": 100 }
  ```
  - 저장 위치는 `web/data/policy.json`이다.
  - `blockedExtensions`:
    - 지금 서버에 박혀 있는 차단 목록(`BLOCKED_EXTENSIONS`)은 항상 차단한다(목록에 `builtIn`으로 표시, 빼지 못함).
    - 관리자는 그 위에 추가만 할 수 있다. 확장자는 영문·숫자 1~10자, 최대 50개다.
  - `maxUploadMb`는 읽기 전용(`MAX_UPLOAD_MB`)이다. PATCH에 넣으면 400.
- `/api/session`의 `limits.blockedExtensions`는 합친 목록이다. 새 필드 `policy: { forcePreviewHidden }`를 추가한다.
- `forcePreviewHidden`이면 `notify.preview`는 `none`으로 고정된다. PATCH하면 403, GET에는 `"none"`과 `locked: ["notify.preview"]`가 온다.
- 업로드 차단은 서버가 다시 검사한다. 차단된 확장자는 415 "기관 정책으로 막힌 파일 형식입니다."다.
- 관리자 화면(`admin.html`)에 "정책" 탭을 추가한다.

## 메시지·이벤트 형식 추가
- 메시지 형식에 다음을 추가한다.
  - `alerted: false`(N4)
  - `urgent: false`(N7)
  - `avatarUrl`(P1, 조사 결과에 따라)
- `/api/events`에 다음을 추가한다.
  - `activity: { unseen }`(N6)
  - `prefsChanged: true`: 다른 기기·창에서 설정을 바꿨을 때. 프론트는 `GET /api/prefs`를 다시 부른다.
  - `policyChanged: true`(D1)

## 역할
| 역할 | 범위 |
|---|---|
| 백엔드 | 위 API 전부. 목업 **가장 먼저**. `prefs` 확장·검사, `activity`·`policy` 저장소(`web/lib/`), 키워드·공개 설정 Zulip 연동, 중요 메시지·공지 확인, 내 세션 목록, 프로필 사진 조사 보고, `.env.example`(새 키가 있으면) |
| 프론트엔드 | `web/public/` 전부: 설정 모달, 알림 센터, 중요 메시지·공지 확인 화면, 테마·글자·밀도, 엔터 보내기, 사진 자동 표시, 목록 정렬, `desktop-bridge.js` 확장, `admin.html` 정책 탭 |
| 데스크톱 | N2 소리, N5 배지·깜박임, N7 중요 알림, P5 브리지 명령(app_info, autostart, close_action, hotkey). 설치 파일은 로컬에서 빌드하지 않는다(`cargo check`·`cargo test`까지) |
| 디자이너 | v4 시안: 설정 모달(탭 6개), 알림 센터 서랍, 종 아이콘 상태(배지·꺼짐), 중요 메시지 말풍선, 공지 확인 바·목록, 어두운 테마 색 체계, 관리자 정책 탭 |
| 빌드·배포 | 3단계 끝에 `ops/`(백업 대상에 `activity.json`·`policy.json`), BUILD.md(새 플러그인) |

## 완료 기준
- 2단계와 같다.
  - 문법 검사
  - `node web/session-status.check.mjs`
  - 자기 범위의 동작 확인(목업 → 실제 Zulip, 테스트 계정 `.credentials/test-accounts.md`)
- 커밋 금지. 끝나면 바꾼 파일, 확인 결과, 못 한 것을 PM에게 보고한다.
- 구현 중 계약을 바꾸면 PM이 이 문서 끝의 "구현 중 확정된 변경"에 적는다.

## 구현 중 확정된 변경
- (2026-11-18, 디자이너 → PM) 잠시 끄는 동안 레일 종은 안 본 개수 배지를 숨기고 남은 시간을 표시한다. 알림 센터 탭은 전체·멘션·답장·반응·공지 4개("답장·반응" 하나)이고, 키워드 항목은 "전체" 탭에만 나온다.
- (2026-11-18, 프론트 → PM) 메시지의 `replyTo`에 `senderId`를 추가한다. 원문이 화면에 없을 때도 "내 글에 단 답장"을 판정하기 위해서다. 원문이 회수됐어도 `senderId`는 그대로 둔다.
- (2026-11-18, 디자이너 → PM 승인)
  - **테마(P2)**
    - `<html data-theme>`에는 실제로 적용되는 값(`light` 또는 `dark`)만 넣는다.
    - `system`이면 프론트가 `matchMedia`로 둘 중 하나를 골라 넣는다.
  - **공지 등록**
    - 공지를 등록할 때 작은 대화상자를 거친다. 대화상자에는 본문 미리 보기와 "확인 요청" 체크(기본 꺼짐)가 있다.
  - **어두운 테마 색:** 내 말풍선 색은 `#13867b`다.
  - **중요 메시지 남은 횟수:** "이번 1시간에 N번 더" 문구는 남은 횟수를 알 수 없으면 뺀다.
  - **관리자 감사 로그 필터:** "동작" 거르기에 다음 4개를 추가한다.
    - `urgent_send`
    - `notice_ack`
    - `session_revoke`
    - `admin_policy`
- (2026-11-18, 백엔드 → PM 승인)
  - **공지 확인**
    - 공지 형식에 `ackTarget`(내가 확인 대상인지)과 `canViewAcks`(확인 목록을 볼 수 있는지)를 추가한다.
    - 등록한 사람과 등록 뒤에 들어온 사람은 확인 대상이 아니다. 이들이 확인하면 403 "이 공지의 확인 대상이 아닙니다."를 돌려준다.
  - **관리자 정책**
    - `GET/PATCH /api/admin/policy`의 `blockedExtensions`는 합친 목록이다(문자열, 점 없음). 뺄 수 없는 기본 목록은 `builtInExtensions`로 따로 준다.
    - PATCH는 문자열 목록을 받는다. 기본 목록을 빼고 보내도 기본 목록은 항상 남긴다.
  - **설정(prefs)**
    - 응답에 항상 `locked: []`를 넣는다. 정책으로 고정되면 `["notify.preview"]`다.
    - 각 묶음은 부분 갱신할 수 있다. `dnd`도 마찬가지다.
  - **설정 변경 알림:** `prefsChanged`는 같은 사용자의 모든 세션에 보낸다. 설정을 바꾼 세션도 받는다.
  - **활동(알림 센터)**
    - 항목 `id`는 문자열이다(`"mention:248"`, `"reaction:249:2:clap"`).
    - `at`은 초 단위다.
    - `before`에는 항목 id를 넣는다.
    - 멘션이면서 키워드인 메시지는 mention 하나로만 보인다.
    - notice 항목에 `ackRequired`가 들어간다.
    - `seen`은 "이 시각까지 본 것" 방식이다.
  - **세션 종료:** `DELETE /api/me/sessions/...`는 `{ ended: n }`을 돌려준다.
  - **오류 문구:** 백엔드 보고대로 한다(공지 확인, 중요 메시지, 키워드, 잠금, 잠시 끄기, 정책 확장자, `maxUploadMb`).
  - **버전:** `web/package.json`에 `version`(0.1.0, 데스크톱과 같게)을 추가했다. 이 값이 `/api/session`의 `version`이 된다.
  - **P1 프로필 사진(조사 후 확정)**
    - API
      - `POST /api/me/avatar`: multipart, png·jpg, 5MB 이하. Zulip `/users/me/avatar`로 넘긴다.
      - `DELETE /api/me/avatar`: 기본 사진으로 되돌린다.
      - 감사 로그 action은 `avatar_change`다.
      - 바꾼 사진이 다른 사람 화면에 바로 보이도록 `avatarUrl`에 `?v=<버전>`을 붙인다.
    - 관리자가 남의 사진을 바꾸는 기능은 만들지 않는다. Zulip에 API가 없어서, 필요하면 서버 관리자 절차로 처리한다.
    - 조직 설정 `avatar_changes_disabled`가 켜져 있으면 403을 돌려준다.
    - 운영: Zulip의 사진 주소는 로그인 없이 열린다. 직원 PC가 Zulip 포트에 직접 닿지 않게 배치해야 한다(ops에 적는다).
  - **N7 중요 메시지 저장 방식**
    - Zulip 본문 첫 줄에 `:rotating_light: **[중요]**`를 둔다. 답장 인용이 있으면 인용 바로 다음 줄이다.
    - 서버는 읽을 때 이 줄을 지우고 `urgent: true`로 돌려준다.
    - 수정해도 표식은 유지되고, 회수하면 사라진다.
    - 사용자가 직접 입력한 같은 표식은 U+200B를 넣어 무력화한다.
  - **N6 알림 센터 보완(프론트 요청)**
    - `POST /api/activity/seen`은 `{ ids: ["mention:248", ...] }`(최대 50개)도 받는다. 이 경우 그 항목만 확인 처리하고, `upTo` 방식도 그대로 둔다.
    - `GET /api/activity` 응답과 `/api/events`의 `activity`에 종류별 안 본 수를 함께 싣는다.
      `unseenByKind: { mention, reply, reaction, notice, keyword }`
  - **데스크톱 리뷰 후 보완(PM)**
    - 창이 트레이로 숨겨져 있으면 작업표시줄 버튼이 없다. 그래서 깜박임은 보이지 않고, 대신 트레이 아이콘의 안읽음 표시로 알린다(한계).
    - 단축키는 수정키 2개 이상이거나 Win 키를 포함해야 한다.
    - 알 수 없는 `sound` 값은 `default`로 처리한다.
    - 프론트는 PC 앱 탭을 열 때마다 `get_autostart`를 다시 읽는다. 트레이 메뉴에서 바꾼 값을 반영하기 위해서다.
  - **프론트 3-C 후(PM)**
    - `display.theme`의 기본값은 `light`다(계약 초안은 `system`). 업데이트 직후 Windows 어두운 모드를 쓰는 직원의 화면이 갑자기 바뀌지 않게 하기 위해서다. 직원이 설정에서 "시스템"을 고를 수 있다.
    - `avatarUrl`이 `""`이면 기존 시안대로 거북이 기본 그림을 쓴다.
    - 어두운 테마의 내 말풍선 색은 `#128277`이다. 흰 글자와의 대비는 4.68이다(초안의 `#13867b`를 대체).
  - **QA 후 공지 활동 기록(PM 결정, 백엔드 방식 승인)**
    - 공지 활동은 공지가 해제되거나 교체돼도 알림 센터에 남는다.
    - `activity.json`의 `notices` 목록에 방 단위로 1건씩 기록한다. 필드는 `key`, `messageId`, `setBy`, `setAt`, `ackRequired`다.
    - 보관 규칙은 30일, 방 전체 200개다.
    - 누가 보는지는 읽을 때 지금 그 방에 있는지로 판정한다. 등록 뒤 들어온 사람은 보고, 나간 사람은 안 본다. 등록한 사람 자신에게는 보이지 않는다.
    - 항목의 `current`는 그 공지가 아직 지금 공지인지를 나타낸다.
  - **목업 흉내 요청:** `simulate`에 `reply`, `keyword`, `urgent`, `reactMine`, `ack`, `notice{ackRequired}`, `prefs`, `policy{forcePreviewHidden}`를 추가한다.
