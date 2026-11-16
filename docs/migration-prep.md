# 폐쇄망 이관 사전 수정 계약서

이관 계획서(https://claude.ai/artifact/MJhmWCPqtP3t7VXUxduZgg)의 "사전 수정"을 구현하기 위한 역할 간 약속이다.
작성: 총괄 PM, 2026-11-16. 바꿔야 하면 구현 전에 PM에게 먼저 알린다.

## 원칙
- **개발 환경은 지금처럼 동작해야 한다.** 새 설정은 모두 환경변수로 받고, 값이 없으면 현재 개발 기본값을 쓴다.
- 운영 값(도메인, 인증서 경로 등)은 아직 정해지지 않았다. 예시 값은 `talk.eumseong.local`을 쓴다.
- 새 환경변수는 `.env.example`에 빈 값과 설명 주석으로 추가한다. `.env`는 읽지도 커밋하지도 않는다.
- 커밋은 PM이 한다.

## 목표 구조
```
직원 PC(상상톡 앱) ──HTTPS 443──▶ [웹] nginx ─▶ 상상톡 웹 서버(Node, 127.0.0.1:43123)
                                           │ HTTPS(내부 인증서 검증)
                                           ▼
                                      [앱] Zulip + RabbitMQ·Redis·Memcached
                                           │ 5432
                                           ▼
                                      [DB] PostgreSQL + 첨부파일 볼륨
```
nginx와 상상톡 웹 서버는 같은 서버에 둔다. 웹 서버는 계속 loopback에서만 듣고 nginx가 외부 HTTPS를 받는다.

## M1. 데스크톱 앱 주소 설정화 (데스크톱 담당)
- 빌드할 때 환경변수 `SANGSANGTALK_APP_URL`로 앱 주소를 정한다. 없으면 `http://127.0.0.1:43123/`.
  운영 예: `https://talk.eumseong.local/` (끝 `/` 포함, https 또는 http, 경로 없음).
- 이 값 하나가 다음에 모두 반영되어야 한다: 웹뷰 시작 주소, `is_app_url`/`navigation_allowed`, 상태 확인(지금은 127.0.0.1:43123에 직접 TCP — https면 TLS로), `notify` 클릭 이동, 내려받기 허용 판별,
  `capabilities/web-bridge.json`의 remote URL(빌드 때 생성하거나 런타임 capability로 추가), `tauri.conf.json`의 devUrl(개발용은 그대로).
- 잘못된 값(경로 포함, 스킴 오류)이면 빌드가 실패해야 한다.
- 내부 인증서: Windows 인증서 저장소를 따르는 WebView2·HTTP 클라이언트를 쓰면 기관 루트 인증서를 PC에 배포하는 것으로 충분하도록 한다(앱에 인증서를 넣지 않음). 상태 확인 요청도 같은 저장소를 쓰는지 확인.
- `BUILD.md`에 운영 빌드 방법 한 단락은 빌드·배포 담당이 쓴다(데스크톱은 변수 이름·규칙을 보고).

## M2~M4. 웹 서버 (백엔드 담당)
- **M2 바인딩·프록시**: `HOST`(기본 `127.0.0.1,::1`), `PORT`(기존). 프록시 뒤에서 동작:
  - `PUBLIC_ORIGIN`(예: `https://talk.eumseong.local`)이 있으면 sameOrigin 검사는 Origin을 이 값과 비교한다(없으면 지금처럼 Host 헤더 비교).
  - `PUBLIC_ORIGIN`이 https면 세션 쿠키에 `Secure`를 붙인다.
  - `X-Forwarded-*`는 신뢰하지 않는다(PUBLIC_ORIGIN으로 해결).
- **M3 세션 유지**: 서버를 다시 켜도 로그인이 유지되도록 세션을 디스크에 저장한다.
  - 파일 `web/data/sessions.json`(이미 git 무시 대상), **AES-256-GCM으로 암호화**, 키는 환경변수 `SESSION_KEY`(32바이트 base64). 키가 없으면 지금처럼 메모리만 쓰고 시작 로그에 한 줄 경고.
  - 저장 내용: sid, 이메일, userId, 이름, Zulip API 키, 만료 시각. 이벤트 큐 id는 저장하지 않는다(재시작 후 새로 등록).
  - 만료(12시간)·로그아웃 시 삭제, 쓰기는 원자적으로(임시 파일 후 rename), 파일 권한 최소화.
- **M4 Zulip TLS 검증**: `ZULIP_CA_FILE`(PEM 경로)이 있으면 그 CA로 검증한다. `ZULIP_TLS_INSECURE=1`이면 검증 끔(개발용).
  둘 다 없으면 **ZULIP_ORIGIN이 기본 개발 주소(localhost.localdomain)일 때만** 검증을 끄고, 그 밖의 주소면 검증을 켠다.
- 공통: `.env.example`에 `HOST`, `PUBLIC_ORIGIN`, `SESSION_KEY`, `ZULIP_CA_FILE`, `ZULIP_TLS_INSECURE` 추가. `web/session-status.check.mjs` 통과 유지. mock은 바꿀 필요 없음.

## M5~M8. 서버 구성·운영 (빌드·배포 담당)
- **M5 compose 설정화**: `compose.yaml`의 `SETTING_EXTERNAL_HOST`를 `${ZULIP_EXTERNAL_HOST:-localhost.localdomain:9991}`로, 포트 매핑도 `${ZULIP_HTTPS_PORT:-9991}:443`으로.
  3계층용 `ops/compose/compose.app.yaml`(Zulip+RabbitMQ+Redis+Memcached, 원격 DB 접속)과 `ops/compose/compose.db.yaml`(PostgreSQL만, 5432를 앱 서버에만 열 것을 주석으로)을 만든다. 볼륨·비밀값 이름은 지금과 같게. 기존 `compose.yaml`(올인원 개발용)은 그대로 동작해야 한다.
- **M6 외부 접속 끄기**: 폐쇄망에서 Zulip이 인터넷에 접속하지 않도록 SETTING_* 환경변수를 정리한다(모바일 푸시 bouncer, Gravatar, 업데이트·텔레메트리, 외부 이메일 등). docker-zulip 12.x 공식 문서로 정확한 설정 이름을 확인하고, 운영 compose에만 넣는다. 확인하지 못한 항목은 문서에 "확인 필요"로 남긴다.
- **M7 리눅스 백업**: `ops/backup.sh`(bash) — `ops/backup.ps1`과 같은 동작(Zulip `manage.py backup` + `web/data/notes.json` 사본, 보관 일수, 로그, 실패 시 종료 코드). `ops/restore.md`에 리눅스 절차 추가. cron 예시는 문서로만.
- **M8 웹 계층 설정 파일**: `ops/nginx/sangsangtalk.conf`(HTTPS 443 → 127.0.0.1:43123, `/api/events` 롱폴링 타임아웃 90초 이상, 업로드 `client_max_body_size`를 MAX_UPLOAD_MB와 맞춤, 보안 헤더), `ops/systemd/sangsangtalk-web.service`(node 서비스, 환경파일 `/etc/sangsangtalk/web.env`, 재시작 정책, 전용 계정), `ops/firewall.md`(계층별 허용 포트 표).
- **반입 패키지 스크립트**: `ops/make-offline-bundle.sh` — 지정한 커밋의 소스 압축, 이미지 5개 `docker save`(태그를 digest로 고정해 기록), SHA-256 목록 생성. 실제 실행은 이미지 저장 용량이 크므로 문법·드라이런 수준으로 확인.

## 완료 기준
- 각 담당: 자기 범위의 문법 검사·빌드 검사, 기본값(개발 환경)에서 지금과 동작이 같음을 확인.
- 데스크톱: `cargo check` + 기본값과 `SANGSANGTALK_APP_URL=https://talk.eumseong.local/` 두 경우 모두 빌드 검사.
- 백엔드: `node --check`, `node web/session-status.check.mjs`, 실서버 재시작 후 로그인 유지 확인(SESSION_KEY를 준 경우).
- 커밋 금지. 끝나면 바꾼 파일·확인 결과·확인 못 한 것을 PM에게 보고.
