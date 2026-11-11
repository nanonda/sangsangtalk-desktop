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

## 규칙
- `.env`는 절대 커밋하지 않는다. 새 키를 추가하면 `.env.example`에도 빈 값으로 추가한다.
- 포트 43123은 `web/server.mjs`와 `desktop/src-tauri/src/lib.rs`(APP_URL 등) 양쪽에 있으므로 함께 바꾼다.
- UI 문구는 한국어.
