# Rocky Linux 9 서버 준비 (2대 구성)

기준: `docs/migration-prep.md` M11. 서버 ① 웹(nginx + 상상톡 웹 서버), ② WAS·DB(Docker: Zulip + PostgreSQL 등).
모든 명령은 root 셸(`sudo -i`)에서 실행한다. 예시 IP·이름은 `ops/firewall.md`와 같다.

## 0. 버전

- **Rocky Linux 9.5는 이미 보안 업데이트가 끝난 마이너 버전이다.** Rocky(RHEL 계열)는 같은 메이저(9) 안에서 최신 마이너만 업데이트를 받으므로,
  **반입 시점의 최신 9.x 설치 이미지(DVD ISO)로 설치하는 것을 권장**한다. 2026-11-16 기준 `rockylinux/rockylinux:9` 컨테이너는 9.8이었다.
- 이미 9.5로 설치된 가상 서버를 받는다면, 최신 9.x DVD ISO를 로컬 저장소로 걸어 `dnf update`로 올린다(아래 1절의 ISO 저장소).
- 반입 패키지의 RPM(`make-offline-bundle.sh --with-rocky9`)은 받을 때의 최신 9.x 기준이다. 서버와 마이너 버전이 다르면
  `--rocky-image rockylinux/rockylinux:9.X`로 맞춰 받는다(태그 존재 여부는 받을 때 확인).

## 1. 설치·공통 설정 (①·②)

- 설치: **최소 설치를 전제로 한다**(`Rocky-9.x-x86_64-minimal.iso`, 또는 DVD ISO에서 "Minimal Install"). 반입 RPM과 의존성 검사도 이 전제에 맞춰 만든다. 시간대 Asia/Seoul. ②는 `/var/lib/docker`에 첨부·DB·이미지가 쌓이므로 디스크를 넉넉히(아래 용량 참고).
- 호스트 이름: ① `web01`, ② `was01` 등(기관 규칙).
- SELinux: **enforcing 유지**. 확인 `getenforce` → `Enforcing`. 끄지 않는다.

반입 패키지 검증과 위치:

```bash
mkdir -p /opt && cd /opt
# USB 등에서 복사한 뒤
cd /opt/sangsangtalk-offline-<커밋12자리>
sha256sum -c SHA256SUMS          # 모두 OK여야 함
ln -sfn "$PWD" /opt/sangsangtalk-offline
```

반입 RPM(`rpms/`)은 `make-offline-bundle.sh --with-rocky9`가 만든다.

- `dnf download --resolve --alldeps`로 **의존성 전체**를 받는다(받는 컨테이너에 이미 깔린 것도 받으므로 최소 설치 서버에 무엇이 빠져 있어도 된다).
- 반입 전 의존성 검사: 스크립트가 새 Rocky 컨테이너에서 **빈 설치 루트**(`dnf --installroot`)에 반입 저장소만 켜고
  ① 묶음(`nginx chrony policycoreutils-python-utils`)과 ② 묶음(`docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin chrony policycoreutils-python-utils`)을
  실제로 설치해 본다. 하나라도 실패하면 패키지를 만들지 않고 중단한다(2026-11-16 시험: Rocky 9.8 기준 RPM 155개·175MB, 두 묶음 모두 통과).
- 반입 RPM에는 glibc 등 기본 패키지의 더 새 버전도 들어 있으므로, 서버가 더 오래된 9.x면 설치할 때 일부 기본 패키지가 함께 올라갈 수 있다(같은 9.x 안의 갱신).

반입 RPM을 로컬 dnf 저장소로 등록(`rpms/`에 repodata와 Docker 서명 키가 들어 있다):

```bash
cat >/etc/yum.repos.d/sangsangtalk-offline.repo <<'EOF'
[sangsangtalk-offline]
name=SangsangTalk offline packages
baseurl=file:///opt/sangsangtalk-offline/rpms
enabled=0
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-9 file:///opt/sangsangtalk-offline/rpms/docker-ce.gpg
EOF
restorecon -Rv /opt/sangsangtalk-offline/
D=(dnf -y --disablerepo='*' --enablerepo=sangsangtalk-offline --setopt=install_weak_deps=False)

# 설치 전 미리보기(실제로 설치하지 않음. --assumeno 라 끝에 "Operation aborted"와 종료 코드 1이 정상)
dnf --disablerepo='*' --enablerepo=sangsangtalk-offline --setopt=install_weak_deps=False install --assumeno nginx      # ①
dnf --disablerepo='*' --enablerepo=sangsangtalk-offline --setopt=install_weak_deps=False install --assumeno docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin   # ②
```

(DVD ISO도 저장소로 쓸 수 있다: `mount -o loop,ro Rocky-9.x-x86_64-dvd.iso /mnt/iso` 후 `baseurl=file:///mnt/iso/BaseOS`, `file:///mnt/iso/AppStream` 두 저장소. 반입 RPM은 의존성을 모두 담고 있어 보통 필요 없고, 미리보기에서 누락이 나올 때나 서버 자체를 최신 9.x로 올릴 때 쓴다.)

시간 동기화(chrony, 최소 설치에 보통 들어 있음):

```bash
rpm -q chrony || "${D[@]}" install chrony
# /etc/chrony.conf: 외부 pool 줄을 주석 처리하고 기관 NTP를 넣는다
sed -i 's/^pool /#pool /' /etc/chrony.conf
echo 'server ntp.<기관 내부 도메인> iburst' >> /etc/chrony.conf
systemctl enable --now chronyd
chronyc sources -v ; timedatectl
```

SELinux 도구(`semanage`):

```bash
"${D[@]}" install policycoreutils-python-utils
```

방화벽(firewalld)은 `ops/firewall.md`의 서버별 명령을 따른다.

## 2. ② WAS·DB 서버: Docker CE (Podman 아님)

Rocky 기본 저장소의 Podman이 아니라 Docker 공식 RPM(Docker CE)을 쓴다. 운영 compose 파일(`docker compose`)과 백업 스크립트가 Docker 기준이다.

```bash
# Podman·runc가 있으면 충돌하므로 제거(최소 설치에는 보통 없음)
dnf -y remove podman buildah runc 2>/dev/null || true
"${D[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

`/etc/docker/daemon.json`:

```json
{
  "selinux-enabled": true,
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
```

- `selinux-enabled: true` — Docker CE는 기본값이 꺼짐이라 컨테이너가 SELinux로 격리되지 않는다. 켜면 컨테이너는 `container_t`로 돌고,
  이름 있는 볼륨은 Docker가 알아서 라벨링한다.
- 바인드 마운트하는 호스트 파일(`/etc/sangsangtalk/pki/`: `ZULIP_DB_TLS_DIR`, `ZULIP_DB_CA_FILE`)은 **영구 라벨 규칙**으로 `container_file_t`를 준다.
  compose의 `:z`도 컨테이너를 만들 때 같은 라벨을 붙이지만, 그 뒤 누가 `restorecon`을 돌리면 정책 기본값(`etc_t`)으로 되돌아가
  컨테이너를 다시 만들 때까지 DB·Zulip이 인증서를 못 읽는다. 규칙을 등록해 두면 `restorecon`을 돌려도 `container_file_t`가 유지된다.

  ```bash
  semanage fcontext -a -t container_file_t '/etc/sangsangtalk/pki(/.*)?'
  restorecon -Rv /etc/sangsangtalk/pki
  ls -Z /etc/sangsangtalk/pki /etc/sangsangtalk/pki/db     # container_file_t 확인
  ```

  이 폴더는 ② 컨테이너 전용이다(① 웹 서버의 nginx 인증서 `/etc/sangsangtalk/tls`는 기본 라벨 그대로 둔다).
- 확인 필요(실서버): `selinux-enabled: true`에서 Zulip 이미지(supervisord, nginx, cron 등)가 AVC 거부 없이 도는지.
  `ausearch -m AVC -ts recent`로 확인하고, 문제가 있으면 원인을 남긴 뒤 판단한다(SELinux 자체를 끄지는 않는다).

```bash
systemctl enable --now docker
docker info --format '{{.ServerVersion}} {{.Driver}} selinux={{.SecurityOptions}}'
docker compose version
# 이미지 반입
for f in /opt/sangsangtalk-offline/images/*.tar; do docker load -i "$f"; done
```

소스와 설정:

```bash
install -d -m 0755 /opt/sangsangtalk
tar -xzf /opt/sangsangtalk-offline/source-*.tar.gz -C /opt/sangsangtalk --strip-components=1
install -d -o root -g root -m 0700 /etc/sangsangtalk
install -o root -g root -m 0600 /dev/null /etc/sangsangtalk/zulip.env   # 값은 ops/README.md 2대 구성 절
# 인증서: ops/pki/README.md "② WAS·DB 서버"
cd /opt/sangsangtalk
docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.was-db.yaml up -d
```

Docker 포트 제한(`DOCKER-USER`)은 `ops/firewall.md`.

## 3. ① 웹 서버: Node.js 24, nginx

### Node.js 24 (공식 tarball → `/opt/node`)

배포판 모듈이 아니라 Node.js 공식 linux-x64 tarball을 쓴다(개발·CI와 같은 메이저 24).

```bash
cd /opt/sangsangtalk-offline/node
ls node-v24.*-linux-x64.tar.xz                     # 반입한 버전 확인(MANIFEST.txt 의 node: 줄과 같음)
NODE_VER=v24.22.3                                  # ↑ 에서 본 버전으로 바꾼다
NODE_DIR=/opt/node-$NODE_VER-linux-x64
grep "  node-$NODE_VER-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -   # 공식 해시와 대조
tar -xJf "node-$NODE_VER-linux-x64.tar.xz" -C /opt
chown -R root:root "$NODE_DIR"
restorecon -R "$NODE_DIR"
ln -sfn "$NODE_DIR" /opt/node                      # 버전을 올릴 때는 새 버전을 풀고 이 링크만 바꾼다
/opt/node/bin/node --version                       # $NODE_VER 와 같아야 함
```

- systemd 유닛 `ops/systemd/sangsangtalk-web.service`는 `/opt/node/bin/node`를 쓴다(설치 명령은 파일 머리 주석).
- `/opt` 아래 실행 파일은 SELinux 라벨 `usr_t`/`bin_t`로 systemd에서 `unconfined_service_t`로 실행된다. 확인: `ps -eZ | grep node`.
- 확인 필요: SHASUMS256.txt의 GPG 서명(`SHASUMS256.txt.asc`) 검증은 반입 패키지에 넣지 않았다. 필요하면 인터넷 PC에서
  Node.js 릴리스 키로 `gpg --verify` 한 결과를 함께 반입한다.

### nginx (AppStream)

```bash
"${D[@]}" install nginx
cp /opt/sangsangtalk/ops/nginx/sangsangtalk.conf /etc/nginx/conf.d/sangsangtalk.conf   # server_name·인증서 경로 확인
# 인증서: ops/pki/README.md "① 웹 서버"
restorecon -Rv /etc/nginx/conf.d /etc/sangsangtalk
setsebool -P httpd_can_network_connect 1     # nginx(httpd_t)가 127.0.0.1:43123 으로 프록시하도록
nginx -t && systemctl enable --now nginx
```

- `httpd_can_network_connect`는 nginx가 모든 TCP 포트로 나가는 연결을 허용한다. 더 좁히려면 boolean 대신
  `semanage port -a -t http_port_t -p tcp 43123` 후 `setsebool -P httpd_can_network_relay 1`을 쓸 수 있다 — 확인 필요(실서버에서 AVC 없이 되는지).
- 기본 `/etc/nginx/nginx.conf`의 `server { listen 80 default_server; … }` 블록은 지우거나 주석 처리한다(80은 열지 않음).
- nginx 업로드 크기·롱폴링 타임아웃은 `ops/nginx/sangsangtalk.conf` 주석 참고.

### 상상톡 웹 서버

`ops/systemd/sangsangtalk-web.service` 머리 주석의 설치 명령(전용 계정 `sangsangtalk`, `/etc/sangsangtalk/web.env`)대로 한다.
`web.env`의 `ZULIP_ORIGIN=https://<ZULIP_EXTERNAL_HOST>`, `ZULIP_CA_FILE=/etc/sangsangtalk/ca/eumseong-root-ca.pem`.

## 4. 용량 참고 (② 서버)

- 첨부: 하루 약 100MB → 1년 약 36GB(`zulip` 볼륨 `/data/uploads`).
- **백업**: `manage.py backup`은 매번 DB와 **첨부 전체**를 담는다. 30일 보관이면 첨부 크기의 약 30배가 필요하다
  (1년 뒤 첨부 36GB면 백업 폴더 약 1TB). 백업 저장소 용량에 맞춰 `--retention-days`를 정하거나, 첨부를 따로 증분 백업하는 방식을 검토한다 — 확인 필요.
- 이미지·컨테이너: 약 5GB. DB: 직원 1,000명 기준 연 수 GB 수준으로 예상(실측 필요).

## 확인 필요 요약

- `selinux-enabled: true`에서 Zulip 컨테이너 동작(AVC).
- `httpd_can_network_relay` + `semanage port` 조합으로 충분한지.
- 실제 최소 설치 서버에서 반입 RPM 설치(빈 설치 루트 검사는 통과했지만 실서버에서는 아직 해 보지 않음. 먼저 `--assumeno` 미리보기).
- `semanage fcontext` 규칙과 `:z`를 함께 쓸 때 실서버에서 AVC가 없는지.
- firewalld + Docker 29의 DOCKER-USER 규칙 유지(`ops/firewall.md`).
