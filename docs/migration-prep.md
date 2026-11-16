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

---

# 2차 사전 수정(M10~M14) — 2026-11-16 결정 반영

사용자 결정: 직원 1,000명, 첨부 하루 약 100MB, Rocky Linux 9.5 가상 서버 **2대(① 웹 / ② WAS·DB)**, 첨부는 ② 서버 디스크,
**내부 메일 서버 없음**, 앱↔DB 구간 **암호화 + 포트 44703**, 웹 화면은 관리(CMS) 전용이고 **직원은 앱에서만 로그인**,
직원 계정은 조직도로 미리 만들고 비정규직은 CMS에서 만든다(CMS·조직도 연계는 다음 개발 단계, 이번 범위 아님).
보안성 검토는 보류, 시범 운영은 홍보실(조직도 연계 후).

위 원칙(개발 환경 불변, 환경변수, `.env` 금지, 커밋은 PM)은 그대로다.

## 목표 구조(2대)
```
직원 PC(상상톡 앱) ──443──▶ ① 웹: nginx ─▶ 상상톡 웹 서버(127.0.0.1:43123)
                                     │ 443 HTTPS(내부 CA 검증)
관리자 PC ──443(Zulip 관리 화면)──▶ ② WAS·DB: Zulip + RabbitMQ·Redis·Memcached
                                     │ 44703 TLS(컨테이너 내부망, 호스트에 publish 안 함)
                                     ▼
                                   PostgreSQL + 첨부파일(같은 서버 디스크)
```
3계층 파일(`compose.app.yaml`/`compose.db.yaml`)은 지우지 않고, 보안성 검토에서 DB 분리를 요구할 때 쓰도록 44703·TLS를 같이 맞춘다.

## M10. DB 포트 44703 + TLS (빌드·배포)
- 운영 compose 전부(2대용 새 파일, `compose.db.yaml`, `compose.app.yaml`)에서 PostgreSQL이 **44703**에서 듣고, **TLS 필수**.
  - 서버: `ssl=on`, 인증서·키는 호스트 경로를 읽기 전용으로 마운트(키 권한 0600, postgres 소유). 비TLS 접속은 pg_hba에서 거부(`hostssl`만 허용).
  - Zulip: 원격 DB 포트 44703, sslmode는 가능하면 `verify-full`(DB 인증서를 M13의 내부 CA로 발급), 안 되면 `require`로 하고 이유를 남긴다.
    정확한 설정 이름(`SETTING_REMOTE_POSTGRES_SSLMODE` 등)은 docker-zulip 12.x 문서·이미지로 확인.
  - 2대 구성에서는 DB 포트를 호스트에 publish하지 않는다. 3계층 `compose.db.yaml`은 `ZULIP_DB_BIND_ADDRESS:44703:44703`.
- 개발용 `compose.yaml`은 바꾸지 않는다.
- 검증: 별도 compose 프로젝트 이름으로 실제 기동해 TLS 접속 성공·비TLS 거부·포트 44703을 확인하고 정리한다. 기존 개발 스택·볼륨은 건드리지 않는다.

## M11. 2대 구성 + Rocky Linux 9 (빌드·배포)
- `ops/compose/compose.was-db.yaml`: ② 서버용 올인원(Zulip+PostgreSQL+RabbitMQ+Redis+Memcached). 볼륨·비밀값 이름은 기존과 같게,
  M6 외부 접속 끄기 설정 포함, 443은 `ZULIP_APP_BIND_ADDRESS`에만 publish.
- `ops/rocky9.md`: Rocky 9 설치 절차 — Docker CE 오프라인 RPM(Podman 아님), SELinux enforcing 유지(`httpd_can_network_connect` 등 필요한 boolean·볼륨 라벨),
  firewalld 명령(서버별), Node.js 24 공식 tarball 설치(`/opt/node`), nginx(AppStream), chrony. **9.5는 이미 보안 업데이트가 끝난 마이너 버전**이므로 반입 시점 최신 9.x를 권장한다고 적는다.
- `ops/firewall.md`: 2대 기준 표로 고치고(3계층 표는 부록), firewalld + Docker(`DOCKER-USER`) 예시. DB 포트는 44703.
- `ops/make-offline-bundle.sh`: (선택 옵션) `rockylinux:9` 컨테이너에서 `dnf download --resolve`로 Docker CE·nginx RPM을 받고, Node.js 24 linux-x64 tarball을 받아 묶음에 넣는다. 해시 목록에 포함.
- `ops/README.md`: 2대 구성을 기본으로 안내.

## M12. 메일 없이 운영 (빌드·배포)
- 운영 compose에서 메일 발송을 쓰지 않는 상태를 명시하고, 메일에 기대는 기능을 끈다: 새 기기 로그인 메일, 놓친 메시지·요약(digest) 메일,
  초대·가입 메일, 비밀번호 재설정 메일 링크. 서버 설정(SETTING_*)과 조직 설정(관리자 화면/관리 명령)을 구분해 `ops/README.md`에 적는다.
- 비밀번호 초기화는 관리자가 서버 명령으로 한다(절차를 `ops/README.md`에). CMS가 생기면 그 화면으로 옮긴다.
- 설정 이름은 Zulip 12.x 문서로 확인, 확인 못 한 것은 "확인 필요".

## M13. 내부 인증서 (빌드·배포)
- Let's Encrypt는 쓰지 않는다(폐쇄망에서 도메인 검증 불가, 90일마다 갱신 반입 필요).
  1순위: 기관 인증서(GPKI 등 기관이 발급하는 서버 인증서, 루트가 직원 PC에 이미 있으면 배포 불필요) — 문서로 안내.
  2순위: 자체 내부 CA.
- `ops/pki/make-internal-ca.sh`(openssl): 루트 CA 1개 + 서버 인증서(웹 도메인, Zulip 도메인, DB) 발급. SAN 필수, 서버 인증서 유효기간 825일, 루트 10년.
  출력은 기본 저장소 밖 경로(인자로 지정). 키 파일은 0600. 저장소에 키·인증서가 들어가지 않게 `.gitignore`에 출력 기본 폴더를 넣는다.
- `ops/pki/README.md`: 발급·갱신 절차, 직원 PC 루트 배포(GPO 또는 배포 시스템), 웹 서버 `ZULIP_CA_FILE`, nginx·Zulip·PostgreSQL에 넣는 위치.

## M14. 직원은 앱에서만 로그인 (백엔드 + 프론트)
- 백엔드: 환경변수 `APP_ONLY_LOGIN=1`이면 `POST /api/login`이 요청 헤더 `X-SangsangTalk-Client: desktop`이 없을 때
  403 `{ error: "상상톡 로그인은 데스크톱 앱에서만 할 수 있습니다." }`. 기본은 꺼짐(개발 환경 불변). `.env.example`에 추가. mock 서버도 같은 변수를 흉내 낸다.
- 프론트: 데스크톱 앱 안(`window.__TAURI_INTERNALS__` 있음)에서는 로그인 요청에 위 헤더를 붙인다. 403이면 서버의 문구를 로그인 화면에 보여 준다.
- 한계(문서화): 헤더는 위조할 수 있어 **보안 통제가 아니라 안내용**이다. 실제 차단은 방화벽(직원 PC → Zulip 불가)과 Zulip 관리 화면의 관리자 PC 제한이다.

## 완료 기준(2차)
- 빌드·배포: `bash -n`, compose `config` 렌더링(2대·3계층), M10 실기동 확인, 개발 `compose.yaml` 렌더링 결과 불변.
- 백엔드: `node --check`, `node web/session-status.check.mjs`, 변수 켬/끔 두 경우 로그인 동작 확인(mock 또는 실서버).
- 프론트: mock(`ui-mock`)에서 `APP_ONLY_LOGIN=1`일 때 브라우저 로그인 거부 문구 표시 확인.
- 커밋 금지. 끝나면 바꾼 파일·확인 결과·확인 못 한 것을 PM에게 보고.
