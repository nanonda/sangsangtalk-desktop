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
사용자는 지시를 **총괄 PM** 세션에게만 한다. PM이 작업을 나누고, 결과를 검수하고, 커밋·푸시를 맡는다.
상주 역할은 Code 탭의 세션(사이드바 그룹 "상상톡 팀")이고, 필요할 때 부르는 역할은 서브에이전트다.
역할별 지침은 `.claude/agents/<에이전트>.md`에 있으며 세션도 같은 지침을 따른다.

| 역할 | 형태 | 에이전트 | 범위 |
|---|---|---|---|
| 총괄 PM | 세션 | — | 지시 접수, 분배, 검수, 커밋·푸시 |
| 프론트엔드 개발 | 세션 | `frontend-dev` | `web/public/`, 시안 적용 |
| 백엔드 개발 | 세션 | `backend-dev` | `web/server.mjs`, `web/lib/`, `compose.yaml`, `web/dev/mock-server.mjs` |
| 데스크톱 개발 | 세션 | `desktop-dev` | `desktop/` |
| 디자이너 | 세션 + 사람 | — | `design/`. 디자이너(사람)의 GitHub PR 접수, 구현과 시안 대조 |
| 빌드·배포 | 서브에이전트 | `release-engineer` | `.github/workflows/`, `BUILD.md`, 버전 |
| QA | 서브에이전트 | `qa-tester` | 읽기·실행만. 동작 확인과 재현 절차 |
| 코드 리뷰 | 서브에이전트 | `reviewer` | 읽기만. 커밋 전 diff 리뷰 |

- 모든 세션은 같은 작업 폴더(`C:\SangsangTalk`, `main`)를 쓴다. 자기 범위 밖 파일은 고치지 않고, 브랜치를 바꾸거나 커밋·푸시하지 않는다.
- 범위 밖 변경이 필요하면 PM에게 보고하고, PM이 담당에게 넘긴다. 같은 파일은 한 번에 한 역할만 고친다.
- 흐름: 개발 세션 작업 → `qa-tester` 확인 → `reviewer` 리뷰 → PM이 커밋·푸시.
- Zulip 없이 화면 확인: `node web/dev/mock-server.mjs` → http://127.0.0.1:43190 (launch.json `ui-mock`).

## 규칙
- `.env`는 절대 커밋하지 않는다. 새 키를 추가하면 `.env.example`에도 빈 값으로 추가한다.
- 포트 43123은 `web/server.mjs`와 `desktop/src-tauri/src/lib.rs`(APP_URL 등) 양쪽에 있으므로 함께 바꾼다.
- UI 문구는 한국어.
