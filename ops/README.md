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

> 주의: `.local`은 mDNS(멀티캐스트 DNS, RFC 6762) 예약 도메인이라 Windows·macOS·Linux(avahi)에서 내부 DNS 대신 mDNS로 이름을 찾으려 해 접속이 늦거나 실패할 수 있다. 운영에는 기관 내부 DNS가 실제로 쓰는 도메인(예: `talk.<기관 내부 도메인>`)을 쓴다. 문서의 `.local`은 예시일 뿐이다.

| 파일 | 서버 | 용도 |
|---|---|---|
| `compose/compose.was-db.yaml` | ② | **기본.** Zulip + PostgreSQL(44703, TLS 필수) + RabbitMQ + Redis + Memcached, 외부 접속 끄기(M6), 메일 끄기(M12) |
| `nginx/sangsangtalk.conf` | ① | HTTPS 443 → 127.0.0.1:43123, 롱폴링·업로드 설정, 보안 헤더 |
| `systemd/sangsangtalk-web.service` | ① | 상상톡 웹 서버(Node, `/opt/node/bin/node`) 서비스, 전용 계정, `/etc/sangsangtalk/web.env` |
| `rocky9.md` | ①·② | Rocky 9 설치: 오프라인 RPM 저장소, Docker CE, SELinux, Node.js 24, nginx, chrony |
| `firewall.md` | 전체 | 2대 허용 포트 표, firewalld·DOCKER-USER 예시, 3계층 표(부록) |
| `pki/make-internal-ca.sh`, `pki/README.md` | 관리용 | 내부 CA·서버 인증서(웹·Zulip·DB) 발급, 배치 위치, 직원 PC 루트 배포, 갱신 |
| `backup.sh` / `backup.ps1` | ②·① / 개발 PC | Zulip 공식 백업 + 쪽지 인덱스 사본 |
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
   `docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.was-db.yaml up -d` → `firewall.md`의 DOCKER-USER.
   이미지 자체 자동 백업은 꺼져 있고(`AUTO_BACKUP_ENABLED: "False"`) `ops/backup.sh`를 cron으로 돌린다(`restore.md`).
   처음 기동 후 조직 만들기·관리자 계정·조직 설정은 아래 "M12" 절.
5. ①: `rocky9.md` 3절(Node.js 24 → `/opt/node`, nginx) → `systemd/sangsangtalk-web.service`(설치 명령은 파일 머리 주석),
   `/etc/sangsangtalk/web.env`(`ZULIP_ORIGIN=https://zulip.eumseong.local`, `ZULIP_CA_FILE=/etc/sangsangtalk/ca/eumseong-root-ca.pem`, `PUBLIC_ORIGIN=https://talk.eumseong.local`) → nginx.
6. 직원 PC: (내부 CA면) 루트 인증서를 Windows 인증서 저장소에 배포(`pki/README.md`)하고, `SANGSANGTALK_APP_URL=https://talk.eumseong.local/`로 빌드한 설치파일을 배포(`BUILD.md`).

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
  API 키 재발급 관리 명령은 12.3에 없다(`do_regenerate_api_key`는 코드에만 있음) — 확인 필요: 관리 화면에서 사용자 비활성화(`deactivate_user`) 후 재활성화로 대신할지, 백엔드 담당과 상의.
- 직원에게 초기 비밀번호를 전달하는 방법(대면·내부 메신저 등)은 기관 절차를 따른다. 첫 로그인 뒤 직원이 바꾸게 하는 기능은 상상톡에 없다 — CMS 단계에서 다룬다.

## 앱 계층 메모

- Zulip은 상상톡 웹 서버(Node)의 IP 하나로 모든 요청을 받는다. Zulip의 IP 기준 요청 제한(rate limit)에 여러 사용자가 함께 걸릴 수 있는지 **확인 필요**(로그인 `fetch_api_key` 등). 필요하면 백엔드 담당과 상의.
- `ZULIP_EXTERNAL_HOST`는 웹 서버의 `ZULIP_ORIGIN` 호스트, Zulip 인증서의 이름과 같아야 한다.
- Zulip↔DB 구간은 44703 TLS(`verify-full`)다(위 M10).
