# ops — 상상톡 운영(폐쇄망 3계층) 파일

기준 문서: `docs/migration-prep.md`. 예시 도메인: 웹 `talk.eumseong.local`, 앱(Zulip) `zulip.eumseong.local`.

> 주의: `.local`은 mDNS(멀티캐스트 DNS, RFC 6762) 예약 도메인이라 Windows·macOS·Linux(avahi)에서 내부 DNS 대신 mDNS로 이름을 찾으려 해 접속이 늦거나 실패할 수 있다. 운영에는 기관 내부 DNS가 실제로 쓰는 도메인(예: `talk.<기관 내부 도메인>`)을 쓴다. 문서의 `.local`은 예시일 뿐이다.

| 파일 | 계층 | 용도 |
|---|---|---|
| `compose/compose.app.yaml` | [앱] | Zulip + RabbitMQ + Redis + Memcached, 원격 DB 접속, 외부 접속 끄기(M6) |
| `compose/compose.db.yaml` | [DB] | PostgreSQL 14만. 5432는 앱 서버에만 연다 |
| `nginx/sangsangtalk.conf` | [웹] | HTTPS 443 → 127.0.0.1:43123, 롱폴링·업로드 설정, 보안 헤더 |
| `systemd/sangsangtalk-web.service` | [웹] | 상상톡 웹 서버(Node) 서비스, 전용 계정, `/etc/sangsangtalk/web.env` |
| `firewall.md` | 전체 | 계층별 허용 포트 표 |
| `backup.sh` / `backup.ps1` | [앱]·[웹] / 개발 PC | Zulip 공식 백업 + 쪽지 인덱스 사본 |
| `restore.md` | | 백업·복원 절차(Windows, 리눅스) |
| `make-offline-bundle.sh` | 반입 준비 PC | 소스(git archive) + 이미지 5개 `docker save` + SHA256SUMS |

개발용 올인원 `compose.yaml`(저장소 루트)은 그대로다. 바뀐 점은 `ZULIP_EXTERNAL_HOST`, `ZULIP_HTTPS_PORT` 두 변수로 받을 수 있게 된 것뿐이며, 값이 없으면 지금과 같다(`localhost.localdomain:9991`, 9991).

## 배치 순서(요약)

1. 인터넷 PC: `ops/make-offline-bundle.sh <커밋>`(`.gitattributes`의 `export-ignore`가 커밋된 이후의 커밋) → 패키지 반입.
   각 서버에서 **`sha256sum -c SHA256SUMS`가 검증 기준**이다(모두 OK여야 함). 그다음 `docker load -i images/*.tar`(파일마다).
   `images.txt`의 이미지 ID·digest는 참고용이다. Docker 이미지 저장소 방식에 따라 load 뒤 값이 다르다:
   containerd 저장소는 이미지 ID = 레지스트리 digest이고 RepoDigests가 남는다. 기존 overlay2(graphdriver) 저장소는 이미지 ID = 설정(config) digest이고 RepoDigests가 비어 있다.
   만든 쪽과 반입 쪽 방식이 다르면 ID가 달라 보이는 것이 정상이다(`docker info -f '{{.DriverStatus}}'`로 확인).
   소스는 맨 위 폴더를 벗겨 푼다: `tar -xzf source-<커밋>.tar.gz -C /opt/sangsangtalk --strip-components=1`.
2. [DB]: `/etc/sangsangtalk/zulip.env`(0600 root)에 `ZULIP__POSTGRES_PASSWORD`, `ZULIP_DB_BIND_ADDRESS`(DB 서버 내부 IP) → `docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.db.yaml up -d` → 방화벽(5432는 앱 서버만).
3. [앱]: 같은 env 파일에 비밀값 6개와 `ZULIP_EXTERNAL_HOST`, `ZULIP_ADMINISTRATOR`, `ZULIP_DB_HOST`, `ZULIP_APP_BIND_ADDRESS`(앱 서버 내부 IP) → 기관 인증서를 `zulip` 볼륨의 `/data/certs/manual/zulip.key`, `/data/certs/manual/zulip.combined-chain.crt`에 넣는다 → `docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.app.yaml up -d`. 이미지 자체 자동 백업은 꺼져 있고(`AUTO_BACKUP_ENABLED: "False"`) `ops/backup.sh`를 cron으로 돌린다(`restore.md`).
4. [웹]: Node 24 설치, 소스를 `/opt/sangsangtalk`에(`--strip-components=1`), `systemd/sangsangtalk-web.service`(설치 명령은 파일 머리 주석)와 `/etc/sangsangtalk/web.env`(`ZULIP_ORIGIN=https://zulip.eumseong.local`, `ZULIP_CA_FILE=/etc/sangsangtalk/ca/…`), `nginx/sangsangtalk.conf`(인증서·키는 `/etc/sangsangtalk/tls/`, 0700 root).
5. 직원 PC: 기관 루트 인증서를 Windows 인증서 저장소에 배포하고, `SANGSANGTALK_APP_URL=https://talk.eumseong.local/`로 빌드한 설치파일을 배포(`BUILD.md`).

`--env-file`을 주지 않으면 compose는 compose 파일이 있는 폴더(`ops/compose/`)의 `.env`를 읽는다. 저장소 루트 `.env`는 읽지 않는다.

## M6. 폐쇄망 외부 접속 끄기 (`compose/compose.app.yaml`에만 적용)

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

- **이메일**: `EMAIL_HOST`가 비어 있으면 Zulip은 `django.core.mail.backends.dummy.EmailBackend`를 쓰고 `WARN_NO_EMAIL=True`로 관리자에게 경고만 띄운다(`computed_settings.py`). docker-zulip 템플릿은 `EMAIL_HOST`를 설정하지 않는다. 내부 SMTP 릴레이가 생기면 `SETTING_EMAIL_HOST` 등(compose.app.yaml 주석)과 `ZULIP__EMAIL_PASSWORD`를 쓴다. 출처: [Outgoing email (12.3)](https://zulip.readthedocs.io/en/12.3/production/email.html), prod_settings_template.py.
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

## 앱 계층 메모

- Zulip은 상상톡 웹 서버(Node)의 IP 하나로 모든 요청을 받는다. Zulip의 IP 기준 요청 제한(rate limit)에 여러 사용자가 함께 걸릴 수 있는지 **확인 필요**(로그인 `fetch_api_key` 등). 필요하면 백엔드 담당과 상의.
- `ZULIP_EXTERNAL_HOST`는 웹 서버의 `ZULIP_ORIGIN` 호스트, 기관 인증서의 이름과 같아야 한다.
- 앱↔DB 5432 구간은 기본 TLS가 아니다(`ops/firewall.md` 확인 필요 항목).
