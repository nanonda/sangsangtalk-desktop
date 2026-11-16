# 상상톡 인증서(PKI)

기준: `docs/migration-prep.md` M13. 2대 구성(① 웹, ② WAS·DB)에서 TLS가 쓰이는 곳은 세 군데다.

| 구간 | 서버 인증서 | 이름(SAN) | 인증서를 검증하는 쪽 |
|---|---|---|---|
| 직원 PC → ① nginx 443 | 웹 | `PUBLIC_ORIGIN`·`SANGSANGTALK_APP_URL`의 호스트(예 `talk.eumseong.local`) | 직원 PC(WebView2 = Windows 인증서 저장소) |
| ① 웹 서버(Node)·관리자 PC → ② Zulip 443 | Zulip | `ZULIP_EXTERNAL_HOST`의 호스트(포트 제외, 예 `zulip.eumseong.local`) | 웹 서버 `ZULIP_CA_FILE`, 관리자 PC 브라우저 |
| ② Zulip → PostgreSQL 44703 | DB | 2대: `database`(compose 서비스 이름). 3계층: `ZULIP_DB_HOST` 값 | Zulip 컨테이너(`ZULIP_DB_CA_FILE`, `verify-full`) |

## 어떤 인증서를 쓰나

**Let's Encrypt는 쓰지 않는다.** 폐쇄망에서는 도메인 검증(HTTP-01/DNS-01)을 할 수 없고, 90일마다 갱신 인증서를 반입해야 한다.

1. **1순위: 기관 인증서** — 기관(전산 담당)이 발급하는 서버 인증서(GPKI 등). 그 루트가 직원 PC에 이미 배포돼 있으면 PC 배포 작업이 필요 없다.
   웹·Zulip 두 이름(SAN)으로 신청한다. 받은 인증서는 아래 "넣는 위치"에 같은 이름으로 넣는다(중간 인증서가 있으면 서버 인증서 뒤에 이어 붙인 체인 파일).
   - 확인 필요: 기관 인증서를 내부 전용 도메인(예 `*.eumseong.local`)으로 발급받을 수 있는지, 발급 기간·절차.
   - DB 인증서는 Zulip 컨테이너만 검증하므로 기관 인증서를 쓰더라도 **아래 내부 CA로 발급해도 된다**(직원 PC 배포와 무관).
2. **2순위: 자체 내부 CA** — `ops/pki/make-internal-ca.sh`. 이 경우 루트 인증서를 직원 PC·관리자 PC에 배포해야 한다.

## 발급 (`make-internal-ca.sh`)

리눅스(② 서버 또는 별도 관리용 리눅스)에서 root로 실행하는 것을 권장한다. Windows Git Bash에서도 동작하지만 NTFS에서는 0600 권한이 지켜지지 않는다.

```bash
ops/pki/make-internal-ca.sh --out /root/sangsangtalk-pki \
  --web   talk.eumseong.local \
  --zulip zulip.eumseong.local \
  --db    database
# 3계층이면 --db 에 앱 서버가 접속하는 이름/IP:  --db db.eumseong.local,10.0.30.10
```

- 루트 CA: 10년(3650일). 서버 인증서: 825일. RSA 3072, SHA-256. 서버 인증서는 `serverAuth`, SAN 필수(첫 이름이 CN).
- 출력 폴더는 저장소 밖이어야 한다(저장소 안이면 스크립트가 거부). 기본값 `~/sangsangtalk-pki`, 이 이름은 `.gitignore`에도 있다.
- 키 파일은 0600, 폴더는 0700으로 만든다. 같은 폴더로 다시 실행하면 루트 CA를 재사용하고, 이미 있는 서버 인증서는 건너뛴다.

출력:

```
<OUT>/ca/ca.crt        루트 인증서(공개)
<OUT>/ca/ca.key        루트 키 — 발급이 끝나면 서버에서 지우고 오프라인 매체(암호화 USB 등)에 보관
<OUT>/web/server.crt, server.key
<OUT>/zulip/zulip.combined-chain.crt, zulip.key
<OUT>/db/server.crt, server.key
```

## 넣는 위치

### ① 웹 서버

```bash
# nginx (ops/nginx/sangsangtalk.conf 의 경로)
install -d -o root -g root -m 0700 /etc/sangsangtalk/tls
install -o root -g root -m 0644 <OUT>/web/server.crt /etc/sangsangtalk/tls/talk.fullchain.pem
install -o root -g root -m 0600 <OUT>/web/server.key /etc/sangsangtalk/tls/talk.key
nginx -t && systemctl reload nginx

# 상상톡 웹 서버(Node)가 Zulip 인증서를 검증할 CA (web.env 의 ZULIP_CA_FILE)
install -d -o root -g sangsangtalk -m 0750 /etc/sangsangtalk/ca
install -o root -g sangsangtalk -m 0640 <OUT>/ca/ca.crt /etc/sangsangtalk/ca/eumseong-root-ca.pem
# /etc/sangsangtalk/web.env:  ZULIP_CA_FILE=/etc/sangsangtalk/ca/eumseong-root-ca.pem
systemctl restart sangsangtalk-web
```

SELinux: `/etc/sangsangtalk/tls`는 nginx(`httpd_t`)가 읽어야 한다. `/etc` 아래 새 파일은 보통 `etc_t`로 라벨링되어 읽을 수 있지만,
다른 곳에서 `mv`로 옮긴 파일은 원래 라벨이 남으므로 `restorecon -Rv /etc/sangsangtalk`를 한 번 실행한다(`ops/rocky9.md`).

### ② WAS·DB 서버

```bash
# DB 인증서와 DB 검증용 CA (zulip.env 의 ZULIP_DB_TLS_DIR, ZULIP_DB_CA_FILE)
install -d -o root -g root -m 0700 /etc/sangsangtalk/pki /etc/sangsangtalk/pki/db
install -o root -g root -m 0644 <OUT>/db/server.crt /etc/sangsangtalk/pki/db/server.crt
install -o root -g root -m 0600 <OUT>/db/server.key /etc/sangsangtalk/pki/db/server.key
install -o root -g root -m 0644 <OUT>/ca/ca.crt     /etc/sangsangtalk/pki/ca.crt
# SELinux: 컨테이너가 읽을 수 있게 영구 라벨(container_file_t) 규칙을 등록한다(처음 한 번).
#   compose의 :z 라벨만으로는 누가 restorecon을 돌리면 etc_t로 되돌아가 DB·Zulip이 인증서를 못 읽는다.
semanage fcontext -a -t container_file_t '/etc/sangsangtalk/pki(/.*)?'
restorecon -Rv /etc/sangsangtalk/pki
# /etc/sangsangtalk/zulip.env:
#   ZULIP_DB_TLS_DIR=/etc/sangsangtalk/pki/db
#   ZULIP_DB_CA_FILE=/etc/sangsangtalk/pki/ca.crt

# Zulip HTTPS 인증서: zulip 볼륨의 /data/certs/manual/ (CERTIFICATES=manual)
cd /opt/sangsangtalk
C=(docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.was-db.yaml)
"${C[@]}" create            # 처음이면 볼륨(sangsangtalk_zulip)을 compose 라벨로 만든다
install -d -o root -g root -m 0700 /etc/sangsangtalk/pki/zulip
install -o root -g root -m 0644 <OUT>/zulip/zulip.combined-chain.crt /etc/sangsangtalk/pki/zulip/
install -o root -g root -m 0600 <OUT>/zulip/zulip.key                /etc/sangsangtalk/pki/zulip/
restorecon -Rv /etc/sangsangtalk/pki    # 위 규칙으로 새 파일도 container_file_t
docker run --rm -v sangsangtalk_zulip:/data -v /etc/sangsangtalk/pki/zulip:/src:ro,z \
  --entrypoint sh ghcr.io/zulip/zulip-server:12.3-0 -c \
  'install -d -m 0755 /data/certs/manual &&
   install -m 0600 /src/zulip.key /data/certs/manual/zulip.key &&
   install -m 0644 /src/zulip.combined-chain.crt /data/certs/manual/zulip.combined-chain.crt'
"${C[@]}" up -d
```

- 갱신 등으로 `/etc/sangsangtalk/pki` 아래 파일을 바꾼 뒤에도 `restorecon -Rv /etc/sangsangtalk/pki`를 한 번 돌린다(`ls -Z`로 `container_file_t` 확인).
  Zulip 컨테이너는 같은 CA를 `/etc/sangsangtalk/db-ca.crt`, `/home/zulip/.postgresql/root.crt`, `/root/.postgresql/root.crt`로 읽는다.
- PostgreSQL 컨테이너는 시작할 때 `ZULIP_DB_TLS_DIR`의 키를 postgres 소유 0600으로 복사해 쓴다. 그래서 호스트 파일은 root 0600이면 된다.
- Zulip은 `/data/certs/manual/`의 두 파일을 컨테이너 시작 때 연결한다(docker-zulip entrypoint, 이미지에서 확인). 파일을 바꾼 뒤에는 `"${C[@]}" restart zulip`.
- 3계층: [DB] 서버에 `db/` 두 파일(`ZULIP_DB_TLS_DIR`), [앱] 서버에 `ca.crt`(`ZULIP_DB_CA_FILE`)와 Zulip 인증서.

### 직원 PC·관리자 PC (내부 CA를 쓸 때만)

상상톡 앱(WebView2)과 브라우저는 Windows 인증서 저장소를 쓴다. `ca/ca.crt`를 **신뢰할 수 있는 루트 인증 기관**(로컬 컴퓨터)에 넣는다.

- GPO: 그룹 정책 관리 → 대상 OU의 GPO 편집 → 컴퓨터 구성 → 정책 → Windows 설정 → 보안 설정 → 공개 키 정책 →
  신뢰할 수 있는 루트 인증 기관 → 가져오기 → `ca.crt`. (`gpupdate /force` 또는 다음 재부팅 때 적용)
- 배포 시스템(PMS 등)·수동: 관리자 권한으로 `certutil -addstore -f Root ca.crt`
- 확인: `certutil -store Root "Eumseong-gun SangsangTalk Internal Root CA"`(CN은 `--org` 값에 따라 다름)
- Firefox 등 자체 저장소를 쓰는 브라우저는 별도 설정 필요(관리자 PC에서 쓸 때만). 확인 필요: 기관 표준 브라우저.

## 갱신

- 서버 인증서 유효기간은 825일이다. **만료 30일 전**에 갱신 일정을 잡는다. 만료일 확인:
  `openssl x509 -in /etc/sangsangtalk/tls/talk.fullchain.pem -noout -enddate` (Zulip·DB 인증서도 같은 방법)
- 갱신: 오프라인 보관한 `ca/`를 출력 폴더에 되돌려 놓고 같은 이름으로 `--renew`를 붙여 실행한다.
  기존 파일은 `<이름>.<시각>.bak`으로 남는다.
  ```bash
  ops/pki/make-internal-ca.sh --out /root/sangsangtalk-pki --renew --web talk.eumseong.local
  ```
  그다음 위 "넣는 위치"대로 바꾸고 다시 읽게 한다: nginx `systemctl reload nginx`, Zulip `restart zulip`, DB `restart database`
  (DB 재시작 동안 Zulip 요청이 잠깐 실패할 수 있으므로 업무 외 시간에). 루트가 같으므로 직원 PC 작업은 없다.
- 루트 CA(10년)를 바꾸면 새 루트를 직원 PC에 먼저 배포하고(옛 루트와 함께 두었다가) 서버 인증서를 새 루트로 다시 발급한다.
- 키가 유출됐다고 의심되면 해당 서버 인증서를 즉시 다시 발급한다. 이 스크립트는 CRL/OCSP를 제공하지 않으므로 루트 키 유출 시에는 루트부터 교체한다.
