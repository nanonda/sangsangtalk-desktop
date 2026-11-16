# 상상톡 폐쇄망 방화벽 허용 목록

기준 구조(`docs/migration-prep.md` 2차, **2대 구성**):

```
직원 PC ──443──▶ ① 웹: nginx → 상상톡 웹 서버(127.0.0.1:43123)
                    │ 443 (HTTPS, 내부 CA 검증)
관리자 PC ──443────▶ ② WAS·DB: Zulip + RabbitMQ·Redis·Memcached + PostgreSQL(44703 TLS)
                       (DB·큐·캐시는 compose 내부망에만 있고 호스트에 publish하지 않음)
```

원칙: **표에 없는 것은 모두 거부.** 서버에서 인터넷으로 나가는 연결은 없다(Zulip 외부 접속 설정은 `ops/README.md` M6).
주소는 예시이며 실제 IP·대역은 망 담당이 정한다. 예시: 직원 PC 대역 `10.1.0.0/16`, 관리자 PC `10.0.99.5`, ① `10.0.10.10`, ② `10.0.20.10`, NIC `ens192`.

## 허용 포트 (2대)

| # | 출발 | 도착 | 포트/프로토콜 | 용도 | 막는 곳 |
|---|---|---|---|---|---|
| 1 | 직원 PC 대역 | ① | 443/tcp | 상상톡 앱 → nginx(HTTPS) | ① firewalld |
| 2 | ① | ② | 443/tcp (`ZULIP_HTTPS_PORT`) | 상상톡 웹 서버 → Zulip API (`ZULIP_ORIGIN`) | ② DOCKER-USER |
| 3 | 관리자 PC | ② | 443/tcp | Zulip 관리 화면(조직 설정, 사용자 관리) | ② DOCKER-USER |
| 4 | 관리자 PC | ①·② | 22/tcp | SSH 운영 접속 | 각 서버 firewalld |
| 5 | ② | 백업 저장소 | 저장소 방식에 따름(NFS 2049/tcp, SMB 445/tcp, rsync/SSH 22/tcp 중 하나) | `ops/backup.sh` 결과(`/var/backups/sangsangtalk`) 외부 보관 | 망 장비 |
| 6 | ① | 백업 저장소 | 5번과 같음 | 쪽지 인덱스 사본(`backup.sh --notes-only`) | 망 장비 |
| 7 | ①·② | 내부 NTP | 123/udp | 시간 동기화(chrony. TLS·세션 만료·백업 이름) | — |
| 8 | ①·② | 내부 DNS | 53/udp·tcp | `talk.…`, `zulip.…` 이름 해석 | hosts 파일을 쓰면 불필요 |

선택:

| 출발 | 도착 | 포트 | 용도 |
|---|---|---|---|
| 직원 PC 대역 | ① | 80/tcp | HTTP → HTTPS 리다이렉트(`ops/nginx/sangsangtalk.conf` 주석 블록). 열지 않는 것을 권장 |

메일: 내부 메일 서버가 없으므로 SMTP(25/587)는 열지 않는다(`ops/README.md` M12).

## 열지 않는 것

- 직원 PC → ② (Zulip·DB 직접 접속). **직원은 상상톡 앱으로만 쓰고, 이것이 "앱에서만 로그인"의 실제 통제다**(M14의 헤더 검사는 안내용).
- ① 43123/tcp — 웹 서버는 loopback(`HOST=127.0.0.1`)에서만 듣는다.
- ② PostgreSQL 44703, RabbitMQ 5672, Redis 6379, Memcached 11211 — compose 내부망에만 있고 호스트에 publish하지 않는다
  (`compose.was-db.yaml`에 `ports:`가 없음). 방화벽 규칙도 필요 없다.
- 모든 서버 → 인터넷(push.zulipchat.com, gravatar.com, meet.jit.si 등). M6 설정으로 접속 시도 자체를 끈다.

## firewalld 예시 (Rocky 9)

firewalld는 **호스트에서 듣는 포트**(① nginx 443, 양쪽 SSH)에 쓴다. Docker가 publish한 포트(② 443)는 firewalld 존 규칙이 적용되지 않으므로 아래 DOCKER-USER로 막는다.

공통(①·②): 기본 존에서 SSH·cockpit 등을 빼고, 관리자 PC만 SSH를 허용하는 존을 만든다.

```bash
firewall-cmd --get-default-zone                                  # 보통 public
firewall-cmd --permanent --zone=public --remove-service=ssh
firewall-cmd --permanent --zone=public --remove-service=cockpit
firewall-cmd --permanent --zone=public --remove-service=dhcpv6-client
firewall-cmd --permanent --new-zone=sstalk-admin
firewall-cmd --permanent --zone=sstalk-admin --add-source=10.0.99.5/32   # 관리자 PC (여러 대면 반복)
firewall-cmd --permanent --zone=sstalk-admin --add-service=ssh
```

① 웹 서버: 직원 PC 대역에서 443만.

```bash
firewall-cmd --permanent --zone=public --add-rich-rule='rule family="ipv4" source address="10.1.0.0/16" service name="https" accept'
# 관리자 PC도 상상톡 웹 화면을 확인하려면:
firewall-cmd --permanent --zone=sstalk-admin --add-service=https
firewall-cmd --reload
firewall-cmd --list-all --zone=public ; firewall-cmd --list-all --zone=sstalk-admin
```

② WAS·DB 서버: firewalld에는 SSH(위 공통)만. 443은 DOCKER-USER에서 처리한다.

```bash
firewall-cmd --reload
```

## Docker 포트 제한: DOCKER-USER (②)

Docker가 publish한 포트는 nat 테이블에서 DNAT된 뒤 FORWARD로 가므로 firewalld/INPUT 규칙을 **우회**한다.

- 먼저 바인드 주소를 내부 NIC로 고정한다(필수 변수, 0.0.0.0에 열지 않음): `ZULIP_APP_BIND_ADDRESS`(`compose.was-db.yaml`).
- 출발지 제한은 Docker가 건드리지 않는 `DOCKER-USER` 체인에 넣는다. DNAT 뒤이므로 원래 목적지 포트는 conntrack으로 본다
  (`--ctorigdstport`, `--ctdir ORIGINAL`: 컨테이너가 바깥으로 연 연결의 응답 패킷은 걸리지 않게).
  출처: [Docker docs — Packet filtering and firewalls / iptables](https://docs.docker.com/engine/network/firewall-iptables/).

`/usr/local/sbin/sangsangtalk-docker-user.sh` (0700 root):

```bash
#!/bin/bash
# ② WAS·DB: Zulip 443(Docker publish)은 ① 웹 서버와 관리자 PC만.
set -euo pipefail
IF=ens192                    # 내부 NIC
PORT=443                     # ZULIP_HTTPS_PORT
ALLOW=(10.0.10.10 10.0.99.5) # ① 웹 서버, 관리자 PC
iptables -F DOCKER-USER
iptables -A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
for src in "${ALLOW[@]}"; do
    iptables -A DOCKER-USER -i "$IF" -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -s "$src" -j RETURN
done
iptables -A DOCKER-USER -i "$IF" -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL -j DROP
iptables -A DOCKER-USER -j RETURN
```

재부팅 뒤에도 적용되게 Docker 다음에 실행하는 유닛 `/etc/systemd/system/sangsangtalk-docker-user.service`:

```ini
[Unit]
Description=SangsangTalk DOCKER-USER allow list
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/sangsangtalk-docker-user.sh

[Install]
WantedBy=docker.service
```

```bash
systemctl daemon-reload && systemctl enable --now sangsangtalk-docker-user
iptables -S DOCKER-USER
# 확인: 직원 PC에서 https://<② IP> 접속이 시간 초과, ① 서버에서 curl --cacert … https://zulip.… 는 성공
```

- IPv6: `ZULIP_APP_BIND_ADDRESS`를 IPv4로 고정하면 IPv6로는 열리지 않는다. IPv6 주소에 바인딩한다면 같은 규칙을 `ip6tables`로도 넣는다.
- 확인 필요(실서버): Rocky 9의 iptables-nft + firewalld(nftables 백엔드)에서 `firewall-cmd --reload` 후에도 DOCKER-USER 규칙이 남는지,
  Docker 29가 firewalld 연동(`docker` 존·`docker-forwarding` 정책)을 만든 상태에서 위 규칙 순서가 그대로 적용되는지. 위 유닛을 docker와 함께 재시작하면 다시 채워진다.
- firewalld `--direct` 규칙으로도 넣을 수 있으나 direct 인터페이스는 폐기 예정이고 Docker가 체인을 만드는 시점과 순서가 꼬일 수 있어 쓰지 않았다.

## 부록: 3계층 구성(보안성 검토에서 DB 분리를 요구할 때)

`compose.app.yaml`([앱]) + `compose.db.yaml`([DB]) + [웹].

| # | 출발 | 도착 | 포트 | 용도 | 막는 곳 |
|---|---|---|---|---|---|
| A1 | 직원 PC 대역 | [웹] | 443/tcp | 상상톡 앱 → nginx | [웹] firewalld |
| A2 | [웹] | [앱] | 443/tcp | 웹 서버 → Zulip API | [앱] DOCKER-USER |
| A3 | 관리자 PC | [앱] | 443/tcp | Zulip 관리 화면 | [앱] DOCKER-USER |
| A4 | [앱] | [DB] | **44703/tcp (TLS 필수)** | Zulip → PostgreSQL (`verify-full`) | [DB] DOCKER-USER |
| A5 | 관리자 PC | [웹]·[앱]·[DB] | 22/tcp | SSH | 각 서버 firewalld |
| A6~ | | | | 백업·NTP·DNS는 2대 표와 같음([앱]·[DB] 모두) | |

[DB] 서버 DOCKER-USER: 위 스크립트에서 `PORT=44703`, `ALLOW=(10.0.20.10)`([앱] 서버). `ZULIP_DB_BIND_ADDRESS`는 DB 서버 내부 IP.
DB는 pg_hba에서 비TLS(`hostnossl`) 접속을 거부하고, 출발지 제한은 방화벽이 맡는다.

## 확인 필요

- 백업 저장소 종류(NFS/SMB/전용 백업 서버)와 포트.
- 관리자 PC를 별도로 둘지, ① 서버를 거치는 SSH 터널로 Zulip 관리 화면에 접속할지.
- 실제 NIC 이름·IP·직원 PC 대역(망 담당).
