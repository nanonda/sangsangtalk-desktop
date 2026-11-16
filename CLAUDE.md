# 상상톡 (SangsangTalk)

Zulip을 백엔드로 쓰는 로컬 메신저. 세 부분으로 구성된다.

## 구성
- `compose.yaml` — 로컬 테스트용 Zulip 12.3 스택(postgres 14, memcached, rabbitmq, redis, zulip).
  `https://localhost.localdomain:9991` (자체서명 인증서). 비밀번호는 `.env`에서 읽는다.
- `web/` — 의존성 없는 Node 서버 `server.mjs`. `http://127.0.0.1:43123`에서 정적 UI(`web/public/`)를 제공하고
  Zulip API를 프록시한다(브라우저는 Zulip을 직접 호출하지 않음). 환경변수: `PORT`, `ZULIP_ORIGIN`.
  쪽지 인덱스는 `web/lib/note-store.mjs` → `web/data/notes.json`(메시지 본문·비밀정보는 저장하지 않음).
- `desktop/` — Tauri 2(Rust) Windows 셸. `127.0.0.1:43123`을 웹뷰로 띄우고, 트레이 아이콘으로
  로그인/연결 상태를 표시하며 자동 시작을 지원한다. 핵심 코드는 `desktop/src-tauri/src/lib.rs`.

## 실행
```powershell
docker compose up -d                 # Zulip (C:\SangsangTalk 에서)
cd web; npm start                    # 웹 서버 :43123
cd desktop; npm install; npm run dev # Tauri 개발 실행
cd desktop; npm run build            # NSIS 설치파일 빌드
```

## 검사 / 빌드
- `node web/session-status.check.mjs` — Zulip 없이 세션 상태 API 계약을 검사한다.
- Windows 빌드 절차와 사전 요구사항은 `BUILD.md`, CI는 `.github/workflows/windows.yml`.

## 팀 운영
사용자는 지시를 메인 세션(총괄 PM)에게만 한다. PM이 작업을 나누고, 결과를 검수하고, 커밋·푸시를 맡는다.
에이전트 정의는 `.claude/agents/`에 있다.

| 에이전트 | 범위 | 비고 |
|---|---|---|
| `frontend-dev` | `web/public/` | 시안(`design/`) 적용, 화면 상태·반응형 |
| `backend-dev` | `web/server.mjs`, `web/lib/`, `compose.yaml` | Zulip API 연동. 응답 형태를 바꾸면 mock도 맞춤 |
| `desktop-dev` | `desktop/`, `BUILD.md` | Tauri 트레이·자동 시작·알림, NSIS 빌드 |
| `qa-tester` | 읽기·실행만 | 브라우저와 검사 스크립트로 확인, 재현 절차 보고 |
| `reviewer` | 읽기만 | 커밋 전 diff 리뷰(버그·보안·규칙) |
| 디자이너(사람) | `design/` | GitHub 브랜치/PR로 전달, 사용자가 완료를 알리면 적용 |

- 같은 파일은 한 번에 한 에이전트만 고친다. 범위가 겹치는 작업은 순서대로 진행한다.
- 큰 기능은 별도 세션으로, 조사·검증·리뷰는 서브에이전트로 맡긴다.
- 흐름: 개발 → `qa-tester` 확인 → `reviewer` 리뷰 → PM이 커밋.
- Zulip 없이 화면 확인: `node web/dev/mock-server.mjs` → http://127.0.0.1:43190 (launch.json `ui-mock`).

## 규칙
- `.env`는 절대 커밋하지 않는다. 새 키를 추가하면 `.env.example`에도 빈 값으로 추가한다.
- 포트 43123은 `web/server.mjs`와 `desktop/src-tauri/src/lib.rs`(APP_URL 등) 양쪽에 있으므로 함께 바꾼다.
- UI 문구는 한국어.
