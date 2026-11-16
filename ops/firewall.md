# 상상톡 폐쇄망 방화벽 허용 목록

기준 구조(`docs/migration-prep.md`):

```
직원 PC ──443──▶ [웹] nginx → 상상톡 웹 서버(127.0.0.1:43123)
                    │ 443 (HTTPS, 내부 CA 검증)
                    ▼
                 [앱] Zulip + RabbitMQ·Redis·Memcached (컨테이너 내부망)
                    │ 5432
                    ▼
                 [DB] PostgreSQL
```

원칙: **표에 없는 것은 모두 거부.** 서버에서 인터넷으로 나가는 연결은 없다(Zulip 외부 접속 설정은 `ops/README.md` M6).
주소는 예시이며 실제 IP·대역은 망 담당이 정한다.

## 허용 포트

| # | 출발 | 도착 | 포트/프로토콜 | 용도 | 비고 |
|---|---|---|---|---|---|
| 1 | 직원 PC 대역 | [웹] | 443/tcp | 상상톡 앱·브라우저 → nginx(HTTPS) | 직원 PC에 열리는 유일한 포트 |
| 2 | [웹] | [앱] | 443/tcp (`ZULIP_HTTPS_PORT`) | 상상톡 웹 서버 → Zulip API (HTTPS) | 웹 서버의 `ZULIP_ORIGIN` |
| 3 | 관리 PC | [앱] | 443/tcp | Zulip 관리 화면(조직 설정, 사용자 관리) | 관리 PC IP만. 직원 PC 대역은 거부 |
| 4 | [앱] | [DB] | 5432/tcp | Zulip → PostgreSQL | 앱 서버 IP만 |
| 5 | 관리 PC | [웹]·[앱]·[DB] | 22/tcp | SSH 운영 접속 | 관리 PC IP만 |
| 6 | [앱] | 백업 저장소 | (저장소 방식에 따름: NFS 2049/tcp, SMB 445/tcp, rsync/SSH 22/tcp 중 하나) | `ops/backup.sh` 결과(`/var/backups/sangsangtalk`)를 외부 보관 | 백업 파일에 Zulip 비밀값 포함 → 저장소 접근 권한 최소화 |
| 7 | [웹] | 백업 저장소 | 6번과 같음 | 쪽지 인덱스(`web/data/notes.json`) 사본(`backup.sh --notes-only`) | |
| 8 | [웹]·[앱]·[DB] | 내부 NTP | 123/udp | 시간 동기화(TLS·세션 만료·백업 이름) | 기관 NTP가 있으면 |
| 9 | [웹]·[앱]·[DB] | 내부 DNS | 53/udp·tcp | `talk.eumseong.local`, `zulip.eumseong.local` 등 이름 해석 | 이름 대신 hosts 파일을 쓰면 불필요 |

선택:

| 출발 | 도착 | 포트 | 용도 |
|---|---|---|---|
| 직원 PC 대역 | [웹] | 80/tcp | HTTP → HTTPS 리다이렉트(`ops/nginx/sangsangtalk.conf`의 주석 블록). 열지 않는 것을 권장 |
| [앱] | 내부 SMTP 릴레이 | 25 또는 587/tcp | Zulip 메일 발송을 켤 때만(`compose.app.yaml`의 `SETTING_EMAIL_*`) |

## 열지 않는 것

- 직원 PC → [앱] (Zulip 직접 접속), 직원 PC → [DB]
- [웹] 서버의 43123/tcp — 웹 서버는 loopback(`HOST=127.0.0.1`)에서만 듣는다. 외부 인터페이스에 열지 않는다.
- [앱]의 RabbitMQ(5672)·Redis(6379)·Memcached(11211) — compose 내부망에만 있고 호스트에 publish하지 않는다.
- 모든 서버 → 인터넷(push.zulipchat.com, gravatar.com, meet.jit.si 등). M6 설정으로 접속 시도 자체를 끈다.

## Docker 주의 ([앱]·[DB])

Docker가 publish한 포트(`ports:`)는 iptables `DOCKER` 체인으로 처리되어 ufw/firewalld의 일반 INPUT 규칙을 **우회**할 수 있다.

- 먼저 바인드 주소를 내부 NIC로 고정한다(둘 다 필수 변수, 0.0.0.0에 열지 않음):
  [DB] `ZULIP_DB_BIND_ADDRESS`(compose.db.yaml), [앱] `ZULIP_APP_BIND_ADDRESS`(compose.app.yaml).
- 그 위에 허용 IP 제한을 `DOCKER-USER` 체인에 넣는다. 예([DB], 앱 서버 10.0.20.10만 허용, 외부 NIC eth0):
  ```
  iptables -I DOCKER-USER -i eth0 -p tcp --dport 5432 ! -s 10.0.20.10 -j DROP
  ```
  (DNAT 후에도 컨테이너 포트가 5432로 같으므로 `--dport 5432`가 맞는다. 재부팅 후에도 유지되도록 기관 표준 방식으로 저장한다.)
- IPv6가 켜져 있으면 같은 규칙을 `ip6tables`에도 넣는다(Docker는 IPv6 포트를 `ip6tables`의 `DOCKER-USER`로 처리한다.
  바인드 주소를 IPv4로 고정했다면 IPv6로는 열리지 않지만, 정책 일관성을 위해 넣어 둔다). 예([DB], 앱 서버 fd00:20::10만 허용):
  ```
  ip6tables -I DOCKER-USER -i eth0 -p tcp --dport 5432 ! -s fd00:20::10 -j DROP
  ```
- [앱]의 443도 같은 방식(IPv4·IPv6)으로 [웹] 서버와 관리 PC만 허용한다. 출발지가 둘 이상이면 허용 규칙(`-s … -j RETURN`)을 먼저 넣고 마지막에 DROP 한다:
  ```
  iptables -I DOCKER-USER 1 -i eth0 -p tcp --dport 443 -j DROP
  iptables -I DOCKER-USER 1 -i eth0 -p tcp --dport 443 -s 10.0.10.10 -j RETURN   # [웹] 서버
  iptables -I DOCKER-USER 1 -i eth0 -p tcp --dport 443 -s 10.0.99.5  -j RETURN   # 관리 PC
  ```

## 확인 필요

- 앱↔DB 5432 구간 암호화: `zulip/zulip-postgresql:14` 이미지는 기본으로 TLS를 켜지 않는 것으로 보인다(앱은 `sslmode=prefer`). 망 분리로 충분한지, DB TLS를 켤지 보안 담당 결정 필요.
- 백업 저장소 종류(NFS/SMB/전용 백업 서버)와 포트.
- 관리 PC를 별도로 둘지, [웹] 서버를 거치는 SSH 터널로 Zulip 관리 화면에 접속할지.
