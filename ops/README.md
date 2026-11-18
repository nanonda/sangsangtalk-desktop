# ops — 상상톡 운영(폐쇄망) 파일

기준 문서: `docs/migration-prep.md`(2차: M10~M13). 예시 도메인: 웹 `talk.eumseong.local`, Zulip `zulip.eumseong.local`.

**기본 구성은 Rocky Linux 9 가상 서버 2대다.**

```
직원 PC(상상톡 앱) ──443──▶ ① 웹: nginx ─▶ 상상톡 웹 서버(127.0.0.1:43123)
                                     │ 443 HTTPS(내부 CA 검증)
관리자 PC ──443(Zulip 관리 화면)──▶ ② WAS·DB: Zulip + RabbitMQ·Redis·Memcached
                                     │ 44703 TLS(컨테이너 내부망, 호스트에 publish 안 함)
                                     ▼
                                   PostgreSQL + 첨부파일(같은 서버 디스크)
```

**보안 전제: 직원 PC는 ②(Zulip 주소·포트)에 직접 닿지 못하게 둔다.** ②의 443에 닿는 것은 ① 웹 서버와 관리자 PC뿐이다.
Zulip 사진 주소(`/user_avatars/…`)는 로그인 없이 열리고, Zulip 웹으로 직접 쓰면 상상톡의 "중요 메시지" 표식을 흉내 낼 수 있기 때문이다(아래 "3단계 운영 반영" 1절, `firewall.md` "열지 않는 것").

> 주의: `.local`은 mDNS(멀티캐스트 DNS, RFC 6762) 예약 도메인이라 Windows·macOS·Linux(avahi)에서 내부 DNS 대신 mDNS로 이름을 찾으려 해 접속이 늦거나 실패할 수 있다. 운영에는 기관 내부 DNS가 실제로 쓰는 도메인(예: `talk.<기관 내부 도메인>`)을 쓴다. 문서의 `.local`은 예시일 뿐이다.

| 파일 | 서버 | 용도 |
|---|---|---|
| `compose/compose.was-db.yaml` | ② | **기본.** Zulip + PostgreSQL(44703, TLS 필수) + RabbitMQ + Redis + Memcached, 외부 접속 끄기(M6), 메일 끄기(M12) |
| `nginx/sangsangtalk.conf` | ① | HTTPS 443 → 127.0.0.1:43123, 롱폴링·업로드 설정, 보안 헤더 |
| `systemd/sangsangtalk-web.service` | ① | 상상톡 웹 서버(Node, `/opt/node/bin/node`) 서비스, 전용 계정, `/etc/sangsangtalk/web.env` |
| `rocky9.md` | ①·② | Rocky 9 설치: 오프라인 RPM 저장소, Docker CE, SELinux, Node.js 24, nginx, chrony |
| `firewall.md` | 전체 | 2대 허용 포트 표, firewalld·DOCKER-USER 예시, 3계층 표(부록) |
| `pki/make-internal-ca.sh`, `pki/README.md` | 관리용 | 내부 CA·서버 인증서(웹·Zulip·DB) 발급, 배치 위치, 직원 PC 루트 배포, 갱신 |
| `backup.sh` / `backup.ps1` | ②·① / 개발 PC | Zulip 공식 백업 + 쪽지 인덱스 사본(`backup.sh`는 2·3단계 `web/data` 파일도) |
| `restore.md` | | 백업·복원 절차(Windows, 리눅스) |
| `make-offline-bundle.sh` | 반입 준비 PC | 소스 + 이미지 5개 `docker save` + (`--with-rocky9`) RPM·Node.js + SHA256SUMS |
| `compose/compose.app.yaml`, `compose/compose.db.yaml` | 3계층 | 보안성 검토에서 DB 서버 분리를 요구할 때. DB 44703·TLS(`verify-full`)를 똑같이 맞춰 둠 |

개발용 올인원 `compose.yaml`(저장소 루트)은 그대로다(5432, TLS 없음, 메일·외부 접속 설정 없음). 값이 없으면 `localhost.localdomain:9991`, 9991.

## 배치 순서(2대)

1. 인터넷 PC: `ops/make-offline-bundle.sh <커밋> --with-rocky9`(`.gitattributes`의 `export-ignore`가 커밋된 이후의 커밋) → 패키지 반입.
   각 서버에서 **`sha256sum -c SHA256SUMS`가 검증 기준**이다(모두 OK여야 함).
   `images.txt`의 이미지 ID·digest는 참고용이다. Docker 이미지 저장소 방식에 따라 load 뒤 값이 다르다:
   containerd 저장소는 이미지 ID = 레지스트리 digest이고 RepoDigests가 남는다. 기존 overlay2(graphdriver) 저장소는 이미지 ID = 설정(config) digest이고 RepoDigests가 비어 있다.
   만든 쪽과 반입 쪽 방식이 다르면 ID가 달라 보이는 것이 정상이다(`docker info -f '{{.DriverStatus}}'`로 확인).
   소스는 맨 위 폴더를 벗겨 푼다: `tar -xzf source-<커밋>.tar.gz -C /opt/sangsangtalk --strip-components=1`.
2. 인증서: 기관 인증서(1순위) 또는 `ops/pki/make-internal-ca.sh`(2순위)로 웹·Zulip·DB 인증서를 준비한다(`pki/README.md`). DB 인증서 SAN은 `database`.
3. ①·② 공통: `rocky9.md` 1절(최신 9.x, SELinux enforcing, 오프라인 저장소, chrony) → `firewall.md`의 firewalld.
4. ②: `rocky9.md` 2절(Docker CE) → `/etc/sangsangtalk/zulip.env`(0600 root)에 아래 값 → 인증서 배치(`pki/README.md`) →
   `docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.was-db.yaml up -d` → `firewall.md`의 DOCKER-USER
   (443은 ① 웹 서버와 관리자 PC만 허용하고 **직원 PC 대역은 허용하지 않는다** — "3단계 운영 반영" 1절).
   이미지 자체 자동 백업은 꺼져 있고(`AUTO_BACKUP_ENABLED: "False"`) `ops/backup.sh`를 cron으로 돌린다(`restore.md`).
   처음 기동 후 조직 만들기·관리자 계정·조직 설정은 아래 "M12" 절, 이어서 "2단계 운영 반영" 절(읽음 확인·수정 제한 조직 설정, CMS 관리 계정의 `can_create_users`),
   "3단계 운영 반영" 4절(프로필 사진 변경을 막을지 정하기).
   한국어 검색(PGroonga)이 켜져 있어 **처음 기동할 때 검색 색인 마이그레이션이 돈다**(기존 데이터가 있으면 오래 걸린다. "2단계 운영 반영" 1절).
5. ①: `rocky9.md` 3절(Node.js 24 → `/opt/node`, nginx) → `systemd/sangsangtalk-web.service`(설치 명령은 파일 머리 주석),
   `/etc/sangsangtalk/web.env`(`ZULIP_ORIGIN=https://zulip.eumseong.local`, `ZULIP_CA_FILE=/etc/sangsangtalk/ca/eumseong-root-ca.pem`, `PUBLIC_ORIGIN=https://talk.eumseong.local`,
   2단계 `AUDIT_KEEP_MONTHS`·`WATERMARK`·`AUTO_LOCK_MINUTES`·`LOGIN_DOMAIN`은 비우면 기본값 — "2단계 운영 반영" 4절) → nginx(감사 로그 IP용 `X-Forwarded-For` 포함).
6. 직원 PC: (내부 CA면) 루트 인증서를 Windows 인증서 저장소에 배포(`pki/README.md`)하고, `SANGSANGTALK_APP_URL=https://talk.eumseong.local/`로 빌드한 설치파일을 배포(`BUILD.md`).
   직원 PC에서 ②에 닿지 않는지 확인한다: PowerShell `Test-NetConnection zulip.eumseong.local -Port 443`의 `TcpTestSucceeded`가 `False`여야 한다.

② `/etc/sangsangtalk/zulip.env` 값(`compose.was-db.yaml`):

| 변수 | 예 | 설명 |
|---|---|---|
| `ZULIP__POSTGRES_PASSWORD` 등 `ZULIP__*` 6개 | (비밀값) | 개발 `compose.yaml`과 같은 이름. `ZULIP__EMAIL_PASSWORD`는 메일을 쓰지 않으므로 아무 값 |
| `ZULIP_EXTERNAL_HOST` | `zulip.eumseong.local` | Zulip 주소(웹 서버 `ZULIP_ORIGIN`의 호스트, Zulip 인증서 이름과 같음) |
| `ZULIP_ADMINISTRATOR` | `admin@eumseong.local` | 서버 관리자 주소(메일은 가지 않음) |
| `ZULIP_APP_BIND_ADDRESS` | `10.0.20.10` | ② 내부 IP. Zulip 443을 이 주소에만 publish |
| `ZULIP_HTTPS_PORT` | `443`(기본) | 선택 |
| `ZULIP_DB_TLS_DIR` | `/etc/sangsangtalk/pki/db` | DB `server.crt`·`server.key`가 있는 호스트 폴더(0700 root, 키 0600) |
| `ZULIP_DB_CA_FILE` | `/etc/sangsangtalk/pki/ca.crt` | DB 인증서를 발급한 CA 루트(PEM). Zulip이 `verify-full`로 검증 |

`--env-file`을 주지 않으면 compose는 compose 파일이 있는 폴더(`ops/compose/`)의 `.env`를 읽는다. 저장소 루트 `.env`는 읽지 않는다.

## M10. DB 44703 + TLS

- PostgreSQL은 `PGPORT=44703`으로 듣고 `ssl=on`, `ssl_min_protocol_version=TLSv1.2`. pg_hba는 컨테이너가 시작할 때 만든다:
  `local all all trust`(컨테이너 안 소켓, 이미지 기본과 같음), `hostnossl all all all reject`, `hostssl all all all scram-sha-256`.
- 인증서·키는 호스트 폴더(`ZULIP_DB_TLS_DIR`)를 읽기 전용(`:ro,z`)으로 마운트하고, 시작할 때 postgres 소유 0600으로 복사해 쓴다
  (호스트에서 postgres uid(이 이미지는 Alpine, 70)를 맞출 필요가 없게).
- Zulip: `SETTING_REMOTE_POSTGRES_PORT=44703`, `SETTING_REMOTE_POSTGRES_SSLMODE=verify-full`.
  이름 확인: docker-zulip 12.3 `entrypoint.sh`가 `SETTING_REMOTE_POSTGRES_SSLMODE`(기본 `prefer`)를 Zulip 설정 `REMOTE_POSTGRES_SSLMODE`로 넘기고,
  Zulip `computed_settings.py`가 `DATABASES["default"]["OPTIONS"]["sslmode"]`에 넣는다(이미지 안 코드와
  [docker-zulip 12.3-0 entrypoint.sh](https://github.com/zulip/docker-zulip/blob/12.3-0/entrypoint.sh)로 확인).
- `verify-full`의 루트 인증서: Zulip은 `sslrootcert`를 따로 넘기지 않으므로 `ZULIP_DB_CA_FILE`을 두 가지로 준다.
  1. libpq 기본 위치에 읽기 전용 마운트: `/home/zulip/.postgresql/root.crt`(zulip 계정), `/root/.postgresql/root.crt`(root로 도는 명령).
     이미지 안 cron 작업(`manage.py clearsessions` 등)은 컨테이너 환경변수를 받지 못할 수 있는데, 이 파일 덕분에 환경변수 없이도 `verify-full`이 된다.
     실기동 확인: `env -i HOME=/home/zulip`(PG 환경변수 없음)에서 psycopg2·psql `verify-full` 성공, root(`HOME=/root`)도 성공, root.crt가 없는 HOME이면 실패.
  2. 환경변수 `PGSSLROOTCERT=/etc/sangsangtalk/db-ca.crt`, `PGSSLMODE=verify-full`: sslmode를 따로 주지 않는 libpq 도구
     (`manage.py backup`의 `pg_dump`, entrypoint의 `pg_isready`·`psql`, 복원용 `pg_restore`)도 `prefer`가 아니라 `verify-full`로 접속하게 한다.
     환경변수가 없는 곳에서도 서버가 비TLS를 거부하므로 접속은 TLS이고, 1번 파일이 있으면 libpq가 인증서도 검증한다.
- 2대에서는 DB 포트를 publish하지 않는다. 3계층 `compose.db.yaml`은 `ZULIP_DB_BIND_ADDRESS:44703:44703`, `compose.app.yaml`은 `ZULIP_DB_PORT`(기본 44703)와 같은 TLS 설정.
  3계층에서는 DB 인증서 SAN에 `ZULIP_DB_HOST` 값이 있어야 한다.
- 기존 데이터: 볼륨의 PostgreSQL 데이터는 그대로 쓴다(포트·TLS·pg_hba는 실행 인자로만 바꾸므로 데이터 디렉터리의 설정 파일은 건드리지 않는다).
  개발 볼륨을 운영으로 옮긴다면 그 비밀번호가 scram 방식으로 저장돼 있어야 `scram-sha-256` 규칙을 통과한다(PostgreSQL 14 기본은 scram) — 옮길 때 확인.

## M6. 폐쇄망 외부 접속 끄기 (운영 compose `compose.was-db.yaml`, `compose.app.yaml`에만 적용)

확인 기준: **실행 중인 `ghcr.io/zulip/zulip-server:12.3-0` 컨테이너 안의 코드**(`/sbin/entrypoint.sh`, `/home/zulip/deployments/current/zproject/default_settings.py`, `computed_settings.py`, ZULIP_VERSION=12.3)와 아래 공식 문서.

docker-zulip 12.3 entrypoint의 `SETTING_*` 변환 규칙(`/sbin/entrypoint.sh`의 `setConfigurationValue`): 값이 `True`/`False`/`None`이면 파이썬 불리언·None, 숫자면 정수, `[...]`/`(...)`/`{...}`면 그대로, 나머지는 문자열. **빈 값은 무시된다**(빈 문자열로 설정할 수 없음).

| 설정 | 값 | 기본값(12.3) | 막는 외부 접속 | 출처 |
|---|---|---|---|---|
| `SETTING_ZULIP_SERVICES_URL` | `None` | `"https://push.zulipchat.com"` | 모바일 푸시 bouncer·사용 통계·보안 알림 전송처(push.zulipchat.com). 아래 서비스가 모두 꺼져 있으면 `None`이어도 된다(`computed_settings.py`의 assert는 서비스가 켜졌을 때만) | [prod_settings_template.py (12.x)](https://github.com/zulip/zulip/blob/12.x/zproject/prod_settings_template.py), [Mobile push notifications (12.3)](https://zulip.readthedocs.io/en/12.3/production/mobile-push-notifications.html), 컨테이너 `default_settings.py`·`computed_settings.py` |
| `SETTING_ZULIP_SERVICE_PUSH_NOTIFICATIONS` | `False` | `False` | 모바일 푸시 알림 서비스(명시적으로 끔) | 같음 |
| `SETTING_ZULIP_SERVICE_SUBMIT_USAGE_STATISTICS` | `False` | `None`(푸시를 켜면 자동 `True`) | 사용 통계 전송 | 같음 |
| `SETTING_ZULIP_SERVICE_SECURITY_ALERTS` | `False` | `False` | 보안 알림 수신 등록 | 컨테이너 `default_settings.py` |
| `SETTING_ENABLE_GRAVATAR` | `False` | `True` | gravatar.com 기본 아바타 | [prod_settings_template.py (12.x)](https://github.com/zulip/zulip/blob/12.x/zproject/prod_settings_template.py) |
| `SETTING_INLINE_URL_EMBED_PREVIEW` | `False` | `True` | 메시지 속 링크의 웹페이지 미리보기(서버가 외부 사이트 접속) | 같음 |
| `SETTING_JITSI_SERVER_URL` | `None` | `"https://meet.jit.si"` | 화상회의 기본 제공자 meet.jit.si | 같음, 컨테이너 `default_settings.py` |
| `SETTING_NAVIGATION_TOUR_VIDEO_URL` | `None` | `static.zulipchat.com/...mp4` | 새 사용자 안내 영상(브라우저가 외부에서 받음) | 컨테이너 `default_settings.py` ("Set it to None to disable it") |
| `SETTING_PROMOTE_SPONSORING_ZULIP` | `False` | `True` | 후원 안내 외부 링크 표시(접속은 아님, 화면 정리용) | 컨테이너 `default_settings.py` |

설정하지 않아도 외부 접속이 없는 것(확인함):

- **이메일**: `EMAIL_HOST`가 비어 있으면 Zulip은 `django.core.mail.backends.dummy.EmailBackend`를 쓰고 `WARN_NO_EMAIL=True`로 관리자에게 경고만 띄운다(`computed_settings.py`). docker-zulip 템플릿은 `EMAIL_HOST`를 설정하지 않는다. 메일 없이 운영하는 방법은 아래 M12. 출처: [Outgoing email (12.3)](https://zulip.readthedocs.io/en/12.3/production/email.html), prod_settings_template.py.
- **Sentry 오류 보고**: `SENTRY_DSN`·`SENTRY_FRONTEND_DSN` 기본 `None`.
- **GIF 검색(GIPHY·Tenor·KLIPY)**: API 키(비밀값)가 없으면 꺼짐.
- **BigBlueButton·Zoom·Webex·Nextcloud Talk·Constructor**: 설정하지 않으면 꺼짐.
- **AI 주제 요약**: `TOPIC_SUMMARIZATION_MODEL` 기본 `None`.
- **Tor 출구 노드 목록 받기**(cron `fetch-tor-exit-nodes`, 매시): `RATE_LIMIT_TOR_TOGETHER`(기본 `False`)가 꺼져 있으면 아무것도 하지 않는다(`fetch_tor_exit_nodes.py`).
- **Let's Encrypt**: `CERTIFICATES=manual`이므로 certbot을 쓰지 않는다(certbot cron은 있으나 갱신할 인증서가 없음).
- **서버 업데이트 확인**: Zulip 서버에는 별도 업데이트 확인 기능이 없고, 서버 정보 전송은 위 `ZULIP_SERVICE_*`로만 이뤄진다(12.3 `default_settings.py` 기준).

남는 것·확인 필요:

- **Camo 이미지 프록시**(`CAMO_URI="/external_content/"`, docker-zulip 템플릿 값): 메시지에 외부 이미지 URL이 있으면 서버가 가져오려고 시도한다(폐쇄망에서는 실패만 함). `SETTING_`으로는 빈 문자열을 줄 수 없어 끄지 않았다. 완전히 끄려면 `ZULIP_CUSTOM_SETTINGS` 환경변수(`CAMO_URI = ""` 줄을 settings.py 끝에 덧붙임)를 쓸 수 있으나 **시험하지 않음 — 확인 필요**. 출처: [Customizing the outgoing HTTP proxy (12.3)](https://zulip.readthedocs.io/en/12.3/production/deployment.html#customizing-the-outgoing-http-proxy).
- **Smokescreen 외부 HTTP 프록시**(컨테이너 안 127.0.0.1:4750): 외부로 나가는 HTTP를 모두 이 프록시로 보내며 끌 수 있는 설정은 찾지 못했다. 폐쇄망 방화벽에서 막히므로 영향은 실패 로그뿐. 출처: 같은 문서, [docker-zulip: Outgoing proxies](https://zulip.readthedocs.io/projects/docker/en/latest/how-to/compose-outgoing-proxy.html)(latest=13.x 문서).
- **`INLINE_IMAGE_PREVIEW`**(기본 `True`): 외부 이미지 미리보기도 Camo를 거치므로 위와 같다. 업로드한 이미지 미리보기에도 영향이 있을 수 있어 끄지 않았다 — 확인 필요.
- **데스크톱 앱 다운로드 페이지**(`/apps`): GitHub에서 최신 데스크톱 버전을 조회하는 코드(`zerver/lib/github.py`)가 있다. 상상톡은 이 페이지를 쓰지 않으며 폐쇄망에서는 실패만 한다 — 확인 필요.
- **모바일 앱 푸시**: bouncer를 끄면 공식 모바일 앱 푸시 알림은 오지 않는다(폐쇄망에서는 원래 불가).
- docker-zulip 문서 사이트(zulip.readthedocs.io/projects/docker)는 현재 13.x 기준만 있어서 12.x 이미지 동작은 **컨테이너 안 entrypoint를 직접 읽어** 확인했다.

## M12. 메일 없이 운영

내부 메일 서버가 없다. 운영 compose는 `EMAIL_HOST`를 설정하지 않으므로 Zulip은 `django.core.mail.backends.dummy.EmailBackend`를 써서
**어떤 메일도 보내지 않고**(오류도 나지 않음), 관리자 화면에 "메일이 설정되지 않음" 경고를 띄운다(`WARN_NO_EMAIL`, 12.3 `computed_settings.py`).
그래도 메일에 기대는 기능은 사용자에게 "메일을 보냈다"고 안내하므로 아래처럼 끄거나 다른 절차로 바꾼다.
SMTP 포트는 방화벽에서도 열지 않는다. `ZULIP__EMAIL_PASSWORD` 비밀값은 compose가 요구하므로 아무 값이나 넣어 둔다.

### 서버 설정 (`SETTING_*`, compose에 들어 있음)

| 설정 | 값 | 기본값(12.3) | 끄는 것 | 확인 |
|---|---|---|---|---|
| (`SETTING_EMAIL_HOST` 없음) | — | `None` | 모든 메일 발송(dummy 백엔드) | `computed_settings.py` |
| `SETTING_SEND_LOGIN_EMAILS` | `False` | `True` | 새 기기 로그인 알림 메일 | `default_settings.py`, `zerver/signals.py`(`if not settings.SEND_LOGIN_EMAILS: return`) |
| `SETTING_SEND_DIGEST_EMAILS` | `False` | `True` | 요약(digest) 메일 서버 전체 | `default_settings.py` |

### 조직 설정 (Zulip 관리 화면 또는 API, 서버 설정이 아님)

관리자 PC에서 `https://<ZULIP_EXTERNAL_HOST>`에 조직 관리자로 로그인해 바꾼다. 괄호 안은 API 필드 이름(12.3 `zerver/models/realms.py`, `users.py`에서 확인).

| 항목 | 값 | 이유 |
|---|---|---|
| 조직 설정 → 기본 사용자 설정 → 알림: 놓친 메시지 이메일 알림(`enable_offline_email_notifications`) | 끔 | 놓친 메시지 메일. **새로 만드는 사용자의 기본값**이므로 직원 계정을 만들기 전에 바꾼다 |
| 같은 곳: 요약 메일(`enable_digest_emails`), 로그인 알림(`enable_login_emails`), 안내 메일(`enable_marketing_emails`) | 끔 | 서버 설정으로도 꺼져 있지만 사용자 설정 화면에서 혼동하지 않게 |
| 조직 설정 → 조직 권한: 초대 필요(`invite_required`) | 켬(12.3 기본값 켬) | 스스로 가입 막기. 계정은 조직도·CMS(다음 단계)·관리 명령으로만 만든다 |
| 같은 곳: 사용자 초대 권한(`can_invite_users_group`) | 관리자만 | 초대 메일은 가지 않는다. 필요하면 관리자가 "초대 링크"를 만들어 직접 전달 |
| 같은 곳: 이메일 주소 변경 금지(`email_changes_disabled`) | 켬 | 이메일 변경은 확인 메일이 있어야 끝나므로 막는다(로그인 ID 고정) |
| 요약 메일(`digest_emails_enabled`, 조직 단위) | 끔(12.3 기본값 끔) | 확인만 |

- 이미 있는 사용자의 개인 설정은 기본값 변경으로 바뀌지 않는다. 시범 운영 전에 바꾸면 따로 할 일은 없다.
- 확인 필요: 관리 화면의 한국어 메뉴 이름(위 이름은 의역). API로는 `PATCH /api/v1/realm`(조직), `PATCH /api/v1/realm/user_settings_defaults`(기본 사용자 설정)로 같은 필드를 바꿀 수 있다.

### 계정 만들기·비밀번호 초기화 (관리자, ② 서버 root 셸)

비밀번호 재설정 메일은 가지 않는다(Zulip 로그인 화면의 "비밀번호 찾기"는 메일을 보냈다고 안내하지만 실제로는 보내지 않는다. 직원은 Zulip 화면을 쓰지 않는다). **비밀번호 초기화는 관리자가 서버 명령으로 한다.** CMS가 생기면 그 화면으로 옮긴다.

```bash
cd /opt/sangsangtalk
C=(docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.was-db.yaml)
M=(exec -u zulip zulip /home/zulip/deployments/current/manage.py)

# 조직 ID 확인(루트 도메인 조직의 string_id 는 빈 문자열 "". 숫자 id를 -r 에 줘도 된다)
"${C[@]}" "${M[@]}" list_realms

# 비밀번호 초기화: 새 비밀번호를 두 번 입력(화면에 보이지 않음, 3번 틀리면 중단)
"${C[@]}" "${M[@]}" change_password -r '' hong@eumseong.local

# (조직도 연계 전) 계정 하나 만들기: 초기 비밀번호를 파일로 넘긴다(명령줄·셸 기록에 남기지 않게)
umask 077; read -rs -p '초기 비밀번호: ' pw; echo; printf '%s' "$pw" > /root/pw.tmp; unset pw
"${C[@]}" cp /root/pw.tmp zulip:/tmp/pw.tmp && "${C[@]}" exec zulip chown zulip /tmp/pw.tmp
"${C[@]}" "${M[@]}" create_user -r '' hong@eumseong.local '홍길동' --password-file /tmp/pw.tmp
"${C[@]}" exec zulip rm -f /tmp/pw.tmp; shred -u /root/pw.tmp
```

- `change_password`는 비밀번호만 바꾼다(12.3 코드: `set_password` 후 저장). **API 키는 그대로**다.
  Zulip 웹 세션은 Django 기본 동작(세션 해시)으로 끊기는 것으로 보이나 확인 필요.
  상상톡 웹 서버는 로그인 때 받은 API 키로 일하므로, 계정 탈취가 의심되면 비밀번호 변경과 함께 API 키도 바꿔야 한다.
  API 키 재발급 관리 명령은 12.3에 없다. `manage.py shell`로 `do_regenerate_api_key`를 부르는 절차는 아래 "2단계 운영 반영" 3절.
- 직원에게 초기 비밀번호를 전달하는 방법(대면·내부 메신저 등)은 기관 절차를 따른다. 초기화 뒤에는 CMS에서 "다음 로그인 때 비밀번호 바꾸기"를 켠다(아래 3절).
  계정 만들기는 2단계부터 CMS(`/admin`)에서도 할 수 있다(관리 계정에 `can_create_users` 필요, 아래 2절). CMS로 만든 계정은 첫 로그인 때 비밀번호를 바꾸게 된다.

## 2단계 운영 반영 (`docs/p2-contract.md`)

아래 명령은 ② 서버 root 셸, 저장소 `/opt/sangsangtalk` 기준이다(3계층이면 compose 파일만 `compose.app.yaml`, DB 명령은 [DB] 서버에서 `compose.db.yaml`).

```bash
cd /opt/sangsangtalk
C=(docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.was-db.yaml)
M=(exec -u zulip zulip /home/zulip/deployments/current/manage.py)
MT=(exec -T -u zulip zulip /home/zulip/deployments/current/manage.py)   # 표준입력으로 파이썬을 넘길 때(-T: TTY 없음)
```

### 1. 한국어 검색(PGroonga)

- `compose.was-db.yaml`·`compose.app.yaml`의 zulip 환경에 `SETTING_USING_PGROONGA: "True"`(개발 `compose.yaml`과 같음). 기본 전문 검색은 단어 단위라
  조사가 붙은 말("회의자료를")이나 단어 안쪽 일부를 찾지 못한다.
- 확장: `zulip/zulip-postgresql:14` 이미지의 초기화 스크립트(`/docker-entrypoint-initdb.d/zulip-create-pgroonga.sql`)가 **DB를 처음 만들 때** `CREATE EXTENSION pgroonga`를 한다.
  이 이미지로 만든 볼륨이면 이미 있다. 확인(버전 한 줄이 나오면 됨, 개발 PC는 `4.0.4`):
  `"${C[@]}" exec -T database psql -U zulip -d zulip -Atc "select extversion from pg_extension where extname='pgroonga'"`
- **처음 켜고 시작할 때 기존 메시지 색인 마이그레이션이 돈다.** docker-zulip 12.3 entrypoint가 시작할 때마다 `manage.py migrate`를 돌리는데,
  `USING_PGROONGA`를 켜면 `pgroonga` 앱의 마이그레이션 3개가 처음 적용된다(12.3 `pgroonga/migrations/`에서 확인):
  0001 `zerver_message.search_pgroonga` 열 추가 → 0002 **모든 기존 메시지**의 검색 열 채우기(UPDATE) → 0003 `CREATE INDEX CONCURRENTLY`로 PGroonga 색인.
  - 메시지 수에 비례해 오래 걸리고, 끝날 때까지 Zulip이 응답하지 않는다(상상톡 로그인·대화 불가). 업무 시간 밖에, **먼저 백업(`backup.sh`)** 하고 한다.
  - 진행은 `"${C[@]}" logs -f zulip`(마지막에 `Database migrations completed.`). 도중에 컨테이너를 끄지 않는다.
    색인 만들기가 중단되면 쓸 수 없는(INVALID) 색인이 남을 수 있다 — 그때 다시 시작하면 0003이 `DROP INDEX IF EXISTS` 후 다시 만드는 것으로 보이나 **확인 필요**.
  - 빈 DB로 새로 설치하면 처음부터 켜진 채로 만들어지므로 오래 걸리지 않는다.
  - 소요 시간은 운영 규모로 재 보지 않았다 — 개발 볼륨을 옮기는 경우 시험 서버에서 먼저 재 본다(확인 필요).
- 백업·복원: `pg_dump`에 검색 열·색인이 같이 들어간다. 복원 대상 DB에도 `pgroonga` 확장이 있어야 한다(같은 이미지면 있음).

### 2. 조직 설정과 CMS 관리 계정 권한

**2-1. 읽음 확인 켜기·수정 제한 600초** (A1 `enable_read_receipts = true`, A4 `message_content_edit_limit_seconds = 600` — 상상톡 서버의 10분 수정·회수 제한과 같은 값)

개발 PC에서는 `node web/dev/apply-p2-settings.mjs`가 한다. 이 스크립트는 **저장소 루트의 개발용 `compose.yaml`** 에 `docker compose exec`로 `manage.py shell`을 부르므로
운영에서는 그대로 쓰지 않는다: ① 웹 서버에는 Docker와 Zulip 컨테이너가 없어 실행되지 않고, ②에는 Node가 없으며 있더라도 다른 compose 파일을 가리킨다.
같은 파이썬(스크립트 안 내용과 같음, 다시 돌려도 안전)을 ②에서 직접 넘긴다:

```bash
"${C[@]}" "${MT[@]}" shell <<'PY'
import json
from zerver.models.realms import get_realm
from zerver.actions.realm_settings import do_set_realm_property

realm = get_realm("")   # 루트 도메인 조직(string_id ""). 다른 조직이면 list_realms 의 string_id
if not realm.enable_read_receipts:
    do_set_realm_property(realm, "enable_read_receipts", True, acting_user=None)
if realm.message_content_edit_limit_seconds != 600:
    do_set_realm_property(realm, "message_content_edit_limit_seconds", 600, acting_user=None)
realm.refresh_from_db()
print("P2_RESULT " + json.dumps({
    "enable_read_receipts": realm.enable_read_receipts,
    "message_content_edit_limit_seconds": realm.message_content_edit_limit_seconds,
}))
PY
```

마지막 줄이 `P2_RESULT {"enable_read_receipts": true, "message_content_edit_limit_seconds": 600}`이면 된다.
(개발 PC에서 같은 방식(`exec -T … shell <<'PY'`)으로 값 읽기만 확인했다. 운영 서버 실행은 아직 안 해 봄.)
관리자 PC의 Zulip 관리 화면(조직 설정의 읽음 확인, 메시지 수정 시간 제한)으로 바꿔도 같다 — 한국어 메뉴 이름은 확인 필요.

**2-2. CMS 직원 생성 권한(`can_create_users`)**

CMS(`/admin`)의 "직원 추가"는 상상톡 서버가 **로그인한 관리자 본인의 Zulip API 키**로 Zulip `POST /users`를 부른다. 그래서 CMS로 직원을 만들 관리자 계정마다
Zulip 관리자(또는 소유자) 역할과 별도로 `can_create_users` 권한이 있어야 한다. 없으면 CMS에 "관리 계정에 직원 생성 권한(can_create_users)이 없습니다"가 뜬다.

```bash
# CMS에 들어가려면 관리자·소유자 역할(이미 관리자면 생략)
"${C[@]}" "${M[@]}" change_user_role -r '' <관리자 로그인ID> admin
# 직원 생성 권한 주기 / 회수(--revoke)
"${C[@]}" "${M[@]}" change_user_role -r '' <관리자 로그인ID> can_create_users
"${C[@]}" "${M[@]}" change_user_role -r '' --revoke <관리자 로그인ID> can_create_users
```

(12.3 `change_user_role --help`에서 역할 값 `can_create_users`와 `--revoke`를 확인함.) 로그인 ID는 Zulip 이메일 칸 값(`<사번>@<내부도메인>`)이다.

### 3. 운영 절차(관리자)

**3-1. 비밀번호 초기화.** CMS의 비밀번호 초기화는 아직 없다(누르면 "서버 관리자에게 요청하세요"). ② 서버에서 바꾼 뒤 CMS에서 첫 로그인 변경을 켠다.

1. `"${C[@]}" "${M[@]}" change_password -r '' <로그인ID>` (위 "계정 만들기·비밀번호 초기화" 절과 같음)
2. 새 비밀번호를 기관 절차로 직원에게 전달한다.
3. CMS → 그 직원 편집 → **"다음 로그인 때 비밀번호 바꾸기"** 를 켜고 저장. 직원은 다음 로그인 때 새 비밀번호를 정해야 메신저를 쓸 수 있고, 바꾸면 자동으로 풀린다(관리자 본인 계정에는 이 칸이 없다).

**3-2. 로그인 30분 차단 풀기.** Zulip은 같은 로그인 ID로 30분 안에 5번 비밀번호가 틀리면 30분 동안 로그인을 막는다(Zulip 응답 HTTP 429).
상상톡 잠금 화면에서 5번 틀려 로그아웃된 경우도 같다. 기다리지 않고 풀려면:

```bash
"${C[@]}" "${M[@]}" reset_authentication_attempt_count -u <로그인ID>
```

- Zulip은 **로그인 때 입력한 문자열 그대로**를 기준으로 횟수를 센다(12.3 `zproject/backends.py` `RateLimitedAuthenticationByUsername`, 대소문자 구분. 상상톡 서버는 앞뒤 공백만 지운다).
  직원이 대문자를 섞어 입력했으면 그대로 넣는다. 풀리지 않으면 직원이 실제로 입력한 형태를 확인한다.
  잠금 화면에서 틀린 경우는 직원이 입력한 문자열이 아니라 Zulip에 저장된 로그인 ID(이메일 형식, 보통 소문자)로 세어진다(추정). 두 형태를 모두 풀어 본다.

**3-3. 계정 도용 대응.** Zulip은 비밀번호를 바꿔도 API 키를 유지하고, 상상톡 세션은 API 키로 일한다. 그래서 세 가지를 함께 한다(공격자가 사이에 다시 로그인하지 못하게 이 순서로):

1. 비밀번호 바꾸기: 3-1의 1번.
2. Zulip API 키 재발급(아래). 옛 키를 쓰는 모든 연결(상상톡 서버의 그 사람 세션 포함)이 Zulip에서 거부된다.
3. CMS → 그 직원 → **"세션 끊기"**: 상상톡 세션과 이벤트 큐를 끊는다(감사 로그 `admin_user_logout`). 응답의 `apiKeyRenewed`는 늘 `false`다 — 키 재발급은 2번이 한다.
4. 필요하면 CMS에서 "다음 로그인 때 비밀번호 바꾸기"를 켠다. 퇴직이면 CMS "퇴직 처리"(세션은 자동으로 끊긴다).

API 키 재발급(관리 명령이 없어 `manage.py shell`로 Zulip 내부 함수 `do_regenerate_api_key`를 부른다):

```bash
"${C[@]}" "${MT[@]}" shell <<'PY'
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email
from zerver.actions.user_settings import do_regenerate_api_key

realm = get_realm("")
user = get_user_by_delivery_email("<도용된 로그인ID>", realm)
admin = get_user_by_delivery_email("<처리하는 관리자 로그인ID>", realm)   # Zulip 감사 기록의 처리자
do_regenerate_api_key(user, admin)   # 새 키는 출력하지 않는다
print("API_KEY_RENEWED", user.id)
PY
```

- **확인 필요(운영 실행 미검증):** 12.3 컨테이너 코드에서 함수 이름·인자(`do_regenerate_api_key(user_profile, acting_user)`, `@transaction.atomic(durable=True)`)와
  두 import가 되는 것까지만 확인했다. 실제 키를 바꿔 보지는 않았다(개발 Zulip 계정에도 하지 않음). 시험 계정으로 한 번 해 보고 그 계정의 상상톡 세션이 끊기는지 본다.
- Zulip 웹·공식 앱으로 로그인한 세션도 끊으려면 Zulip 관리 화면에서 비활성화 후 재활성화하는 방법이 있다(직원은 Zulip 화면을 쓰지 않으므로 보통 필요 없음).

### 4. 웹 서버 환경변수(① `/etc/sangsangtalk/web.env`)

`.env.example`과 `systemd/sangsangtalk-web.service` 머리 주석의 예시에 있다. 비우거나 줄을 빼면 기본값. 범위를 벗어나면 설정 오류로 서버가 시작하지 않는다(journal에 한국어 오류).

| 변수 | 기본 | 설명 |
|---|---|---|
| `AUDIT_KEEP_MONTHS` | `12` | 감사 로그(`web/data/audit/YYYY-MM.jsonl`) 보존 개월 수(1~120). 지난 파일은 **서버가 시작할 때** 지운다. 기관 보존 기준에 맞춘다 |
| `WATERMARK` | 켬 | 대화창 배경 워터마크(이름·로그인ID 앞부분·날짜). 정확히 `0`이면 끔 |
| `AUTO_LOCK_MINUTES` | `30` | 입력이 없는 채로 이 분(0~1440)이 지나면 잠금 화면. `0`이면 끔 |
| `LOGIN_DOMAIN` | 없음 | CMS 직원 추가 때 로그인 ID `사번@<도메인>`의 도메인(예: `eumseong.local`). 비우면 관리자 본인 이메일의 도메인. 점이 있는 도메인 이름만 받고, 잘못된 값이면 서버가 시작하지 않는다 |

바꾼 뒤 `systemctl restart sangsangtalk-web`. 데스크톱 캡처 방지(`SANGSANGTALK_CAPTURE_BLOCK`)는 서버 설정이 아니라 설치파일 빌드 옵션이다(`BUILD.md`).

### 5. 감사 로그 IP와 nginx

웹 서버는 `PUBLIC_ORIGIN`이 있고 요청이 127.0.0.1·::1(nginx)에서 오면 `X-Forwarded-For`의 **마지막 값**을 감사 로그 IP로 쓴다.
`nginx/sangsangtalk.conf`는 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`로 직원 PC 주소(`$remote_addr`)를 맨 뒤에 붙인다.
직원 PC가 이 헤더를 꾸며 보내도 앞쪽에 남을 뿐이다. nginx 앞에 다른 프록시(L4/L7 부하분산 등)를 두면 마지막 값이 그 프록시 주소가 되므로 그때는 다시 정한다.

### 6. 백업

`backup.sh`가 [웹] 서버의 `web/data` 2단계 파일(`notices.json`, `prefs.json`, `admin-meta.json`, `audit/`)을 회차 폴더의 `web-data/`에 함께 복사한다(`sessions.json`은 뺀다). 표와 복원은 `restore.md`.

## 3단계 운영 반영 (`docs/p3-contract.md`)

### 1. 보안 전제: 직원 PC는 Zulip에 직접 닿지 않는다

직원 PC에서 ②의 Zulip(`ZULIP_EXTERNAL_HOST`, 443/`ZULIP_HTTPS_PORT`)으로 가는 연결은 막는다. ②의 443에 닿는 것은 ① 웹 서버(`ZULIP_ORIGIN` 호출, `firewall.md` 2번)와
관리자 PC(Zulip 관리 화면, 3번)뿐이다. 2단계의 "앱에서만 로그인"과 같은 통제이고, 3단계에서 이유가 두 가지 늘었다.

1. **Zulip 사진 주소는 로그인 없이 열린다.** Zulip은 프로필 사진을 `/user_avatars/<조직 번호>/<해시>.png` 같은 주소로 주는데, 이 주소는 로그인하지 않아도 열린다.
   상상톡은 사진을 Zulip 주소 그대로 넘기지 않고, 로그인한 사람에게만 웹 서버의 `/api/avatar/<사용자ID>`로 대신 받아 준다. 그래서 직원 PC가 Zulip에 닿을 필요가 없다.
2. **Zulip 웹으로 직접 쓰면 "중요 메시지" 표식을 흉내 낼 수 있다.** 중요 메시지는 Zulip 본문 첫 줄의 `:rotating_light: **[중요]**` 표식으로 저장된다.
   상상톡 서버는 직원이 직접 입력한 같은 표식을 무력화하지만, Zulip 웹·공식 앱으로 보내면 이 검사를 거치지 않는다.
   그러면 상상톡 화면에 중요 메시지로 보이고, 전체 대화방 관리자 제한·시간당 10회 제한을 피하며, 감사 로그(`urgent_send`)에도 남지 않는다.

- 관리자 계정도 Zulip 화면에서 같은 일을 할 수 있다. 관리자 PC 허용은 꼭 필요한 주소만 둔다(`firewall.md` 3번).
- 확인: 직원 PC에서 `Test-NetConnection <ZULIP_EXTERNAL_HOST> -Port 443`이 실패(`TcpTestSucceeded : False`)하고, 상상톡 앱의 사진·대화는 정상이어야 한다.

### 2. 백업·복원

`backup.sh`가 3단계 파일 `activity.json`(알림 센터의 답장·반응 기록과 확인 시각)과 `policy.json`(관리자 정책)도 회차 폴더의 `web-data/`에 복사한다.
저장 도중에만 생기는 직전 사본(`<파일>.bak`)이 있으면 함께 복사한다. `sessions.json`은 지금처럼 빼고, 새 환경변수·옵션은 없다(cron 줄 그대로). 표와 복원 명령은 `restore.md`.

**`policy.json`이 깨졌을 때:** 본 파일과 `.bak`을 둘 다 읽지 못하면 웹 서버는 돌지만 **파일 올리기가 모두 503**("파일 정책을 읽지 못해 파일 올리기를 막았습니다…")으로 막히고,
관리자 화면 "정책" 탭도 503이다(journal에 `관리자 정책 파일을 읽지 못했습니다`). 백업 사본으로 되돌리거나, 두 파일을 다른 이름으로 옮기면 기본값
(미리 보기 강제 꺼짐, 추가 차단 확장자 없음. 서버에 박힌 차단 목록과 `MAX_UPLOAD_MB`는 그대로)으로 읽는다. 재시작은 필요 없다.
절차는 `restore.md` "관리자 정책 파일(`policy.json`)이 깨졌을 때".

### 3. 중요 메시지 시간당 10회 제한

한 사람이 1시간에 중요 메시지를 10번까지 보낼 수 있다(넘으면 429 "중요 메시지는 1시간에 10번까지 보낼 수 있습니다.").
이 횟수는 **웹 서버 메모리에만** 있다. `systemctl restart sangsangtalk-web`, 서버 재부팅, 비정상 종료 뒤 자동 재시작을 하면 모두 0으로 돌아가고,
그 시간 안에 다시 10번 보낼 수 있다. 파일에는 남지 않으므로 백업·복원과도 관계없다.
보낸 기록은 감사 로그 `urgent_send`(메시지 ID)에 남으므로, 많이 보냈는지는 관리자 화면 감사 로그의 "동작" 거르기로 본다.

### 4. 프로필 사진

- 사진은 **직원 본인만** 바꾼다: 상상톡 설정 → 내 정보(PNG·JPG, 5MB 이하. 기본 사진으로 되돌리기도 된다). 상상톡 서버가 본인의 Zulip API 키로 Zulip `/users/me/avatar`에 넘기고, 감사 로그 `avatar_change`를 남긴다.
  사진 파일은 Zulip 업로드에 저장되므로 `manage.py backup`(Zulip 백업)에 들어간다.
- 직원이 사진을 바꾸지 못하게 하려면 조직 설정 `avatar_changes_disabled`를 켠다. 켜면 상상톡에 "기관 설정으로 사진을 바꿀 수 없습니다."(403)가 뜬다.
  - 관리자 PC의 Zulip 관리 화면(조직 설정 → 조직 권한의 사진 변경 금지 항목)에서 바꾼다. 한국어 메뉴 이름은 확인 필요.
  - API로는 `PATCH /api/v1/realm`의 `avatar_changes_disabled` 필드다(위 M12 조직 설정과 같은 방식). 12.3 `zerver/models/realms.py`에서 조직 설정 항목임을 확인했다.
  - Zulip 12.3 코드(`zerver/views/user_settings.py`)는 이 설정이 켜져 있어도 **조직 관리자·소유자는 자기 사진을 바꿀 수 있게** 한다. 일반 직원만 막힌다.
  - 서버 전체 설정 `AVATAR_CHANGES_DISABLED`도 있으나(같은 파일) 운영 compose에는 넣지 않았다.
- **관리자가 다른 직원의 사진을 바꾸는 방법: 확인 필요.** 상상톡에는 그 기능이 없고(Zulip API에도 남의 사진을 바꾸는 API가 없다),
  12.3 `manage.py` 관리 명령에서도 사진을 바꾸는 명령을 찾지 못했다. Zulip이 공식으로 안내하는 서버 관리자 절차를 확인하기 전까지는 명령을 적지 않는다.
  그동안은 직원 본인이 바꾸게 한다. 사진 변경을 막아 둔 경우에는 관리자가 잠시 풀고, 직원이 바꾼 뒤 다시 막는다.
- nginx: 일반 요청 한도(`client_max_body_size 1m`)로는 1MB가 넘는 사진이 nginx에서 413으로 막히므로 `nginx/sangsangtalk.conf`에 `/api/me/avatar`만 6MB로 둔다(사진 5MB + 여유).
  이미 설치한 ① 서버는 이 파일을 다시 복사하고 `nginx -t && systemctl reload nginx`.

### 5. 환경변수·버전·PC 앱 설정

- 3단계에는 **새 환경변수가 없다**(`/etc/sangsangtalk/web.env`·`zulip.env` 그대로). 업로드 최대 크기는 계속 `MAX_UPLOAD_MB`이고, 관리자 정책 화면에서는 읽기만 한다.
  자동 잠금의 기관 값도 계속 `AUTO_LOCK_MINUTES`다(직원은 이보다 짧게만 정할 수 있다).
- 웹 버전은 `web/package.json`의 `version`(지금 0.1.0)이고, 설정 화면 아래에 PC 앱 버전과 함께 보인다. 새 판을 배포할 때 설치파일과 웹 소스의 버전을 함께 올린다(`BUILD.md`).
- PC 앱의 기기별 설정(창 닫기 동작, 단축키)은 직원 PC의 `%LOCALAPPDATA%\com.sangsangtalk.desktop\settings.json`에 있다. 서버 백업 대상이 아니고, 지우면 기본값(트레이로 숨기기, 단축키 꺼짐)이 된다.

## 앱 계층 메모

- Zulip은 상상톡 웹 서버(Node)의 IP 하나로 모든 요청을 받는다. Zulip의 IP 기준 요청 제한(rate limit)에 여러 사용자가 함께 걸릴 수 있는지 **확인 필요**(로그인 `fetch_api_key` 등). 필요하면 백엔드 담당과 상의.
- `ZULIP_EXTERNAL_HOST`는 웹 서버의 `ZULIP_ORIGIN` 호스트, Zulip 인증서의 이름과 같아야 한다.
- Zulip↔DB 구간은 44703 TLS(`verify-full`)다(위 M10).
