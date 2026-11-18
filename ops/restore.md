# 상상톡 Zulip 백업·복원

## 백업 파일

- 만드는 스크립트: `ops/backup.ps1` (Windows PowerShell 5.1)
- 위치: `C:\SangsangTalk-backup\<yyyyMMdd-HHmmss>\zulip-backup-<yyyyMMdd-HHmmss>.tar.gz`
- 쪽지 인덱스 사본: 같은 폴더의 `notes.json`(`C:\SangsangTalk\web\data\notes.json` 복사본, 원본이 없으면 경고 로그만 남기고 생략)
- 2·3단계 상상톡 데이터(`web\data`의 `notices.json`·`prefs.json`·`admin-meta.json`·`audit\`·`activity.json`·`policy.json`)는 `backup.ps1`(개발 PC용)이 복사하지 **않는다**. 개발 PC에서 필요하면 `web\data` 폴더를 직접 복사해 둔다. 운영(리눅스) `backup.sh`는 복사한다(아래 리눅스 절).
- 로그: `C:\SangsangTalk-backup\backup.log`
- 보관: 30일 지난 날짜 폴더는 백업이 성공할 때 자동 삭제(`-RetentionDays`로 변경). 이름이 `yyyyMMdd-HHmmss` 형식인 폴더만 지운다.
- 내용(Zulip 공식 `manage.py backup` 형식):
  - `zulip-backup/database/` — PostgreSQL 덤프(`pg_dump --format=directory`)
  - `zulip-backup/uploads/` — 업로드 파일(`/data/uploads`)
  - `zulip-backup/settings/` — 컨테이너의 `/etc/zulip`(**`zulip-secrets.conf` 포함**)
  - `zulip-backup/zulip-version`, `os-version`, `postgres-version`

> 백업 파일에는 비밀값(`zulip-secrets.conf`)이 들어 있다. 백업 폴더를 공유하거나 저장소에 넣지 말 것.
> 저장소의 `.env`는 백업에 들어가지 않는다. 다른 PC로 옮겨 복원하려면 `.env`를 따로 안전하게 보관해야 한다.

수동 실행:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\SangsangTalk\ops\backup.ps1
# 옵션: -BackupRoot D:\zulip-backup -RetentionDays 14
```

종료 코드 0이면 성공, 1이면 실패(원인은 콘솔과 `backup.log`의 `[ERROR]` 줄).

## 복원 절차 (같은 PC, 실행 중인 스택에 덮어쓰기)

**주의: 현재 Zulip 데이터(메시지·사용자·업로드)가 백업 시점으로 덮어써진다.** 복원 전에 지금 상태를 한 번 더 백업해 둔다.
아래 명령은 PowerShell에서 `C:\SangsangTalk` 기준이다. Git Bash에서 실행할 때는 컨테이너 경로가 변환되지 않도록 앞에 `MSYS_NO_PATHCONV=1`을 붙인다.

```powershell
cd C:\SangsangTalk
$stamp = '20261116-110146'   # 복원할 백업 폴더 이름
$file  = "C:\SangsangTalk-backup\$stamp\zulip-backup-$stamp.tar.gz"

# 0) 지금 상태 백업
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\backup.ps1

# 1) 백업 파일을 컨테이너로 복사하고 풀기
docker compose exec -T zulip sh -c "rm -rf /tmp/restore && mkdir -p /tmp/restore"
docker compose cp $file zulip:/tmp/restore/backup.tar.gz
docker compose exec -T zulip tar -xzf /tmp/restore/backup.tar.gz -C /tmp/restore

# 2) Zulip 앱 서버 중지(컨테이너는 그대로 둔다)
docker compose exec -T -u zulip zulip /home/zulip/deployments/current/scripts/stop-server

# 3) 데이터베이스 복원 (이미지의 app:restore 와 같은 방식: --clean --if-exists)
#    (PowerShell 5.1은 외부 프로그램 인자 안의 큰따옴표를 망가뜨리므로 sh -c 문자열 안에 큰따옴표를 쓰지 않는다)
docker compose exec -T zulip sh -c 'export PGPASSWORD=$(crudini --get /etc/zulip/zulip-secrets.conf secrets postgres_password); pg_restore -h database -U zulip -d zulip --clean --if-exists /tmp/restore/zulip-backup/database'

# 4) 업로드 파일 복원
docker compose exec -T zulip sh -c "cp -a /tmp/restore/zulip-backup/uploads/. /data/uploads/ && chown -R zulip:zulip /data/uploads"

# 5) 캐시 비우고 서버 시작
docker compose exec -T -u zulip zulip /home/zulip/deployments/current/scripts/setup/flush-memcached
docker compose exec -T -u zulip zulip /home/zulip/deployments/current/scripts/start-server

# 6) 임시 파일 정리
docker compose exec -T zulip rm -rf /tmp/restore

# 7) 쪽지 인덱스 되돌리기: 상상톡 웹 서버(npm start)를 먼저 끈 뒤, 같은 폴더의 notes.json을 web/data/로 복사하고 다시 켠다
Copy-Item "C:\SangsangTalk-backup\$stamp\notes.json" C:\SangsangTalk\web\data\notes.json -Force
```

확인: `https://localhost.localdomain:9991` 로그인, 최근 메시지·첨부 파일 열기, 상상톡 웹(`http://127.0.0.1:43123`)에서 대화 목록 확인.

### 주의사항

- `zulip-backup/settings`(= `/etc/zulip`)는 **복원하지 않는다.** docker-zulip에서는 `/etc/zulip`이 `compose.yaml` 환경변수와 `.env` 비밀값으로 매번 다시 만들어지고, `zulip-secrets.conf`는 `zulip` 볼륨(`/data/etc-zulip/`)에 따로 유지된다. 같은 PC에서 볼륨이 살아 있으면 그대로 쓰면 된다.
- 백업과 복원 대상의 Zulip 버전(`zulip-backup/zulip-version`)과 PostgreSQL 메이저 버전(14)이 같아야 한다. 이미지 버전을 올린 뒤라면 먼저 같은 버전으로 맞춘다.
- `pg_restore --clean`은 기존 객체를 지우고 다시 만든다. 경고 몇 줄은 나올 수 있지만 `ERROR`가 많으면 중단하고 원인을 확인한다. 깨끗하게 하려면 `dropdb`/`createdb`(`-d postgres`로 접속) 후 `--clean` 없이 복원하는 방법도 있다.
- 업로드 복원(4단계)은 백업 이후에 새로 올린 파일을 지우지 않는다(덮어쓰기·추가만 한다). DB에는 기록이 없는 파일이 남을 수 있으나 동작에는 지장이 없다.
- 쪽지 인덱스(`notes.json`)는 반드시 같은 회차 폴더의 사본으로 되돌린다(7단계). 다른 회차의 것을 쓰면 메시지 ID가 맞지 않는다. 사본이 없는 회차(`backup.log`에 `[WARN] 쪽지 인덱스 파일이 없어 건너뜁니다`)라면 7단계를 건너뛴다.
- **새 PC / 볼륨을 잃은 경우(미검증):** `.env`를 원래 값으로 복구한 뒤 `docker compose up -d`로 빈 스택을 띄우고, 백업의 `zulip-backup/settings/zulip-secrets.conf`를 `zulip` 볼륨의 `/data/etc-zulip/zulip-secrets.conf`로 넣은 다음 위 1~6단계를 진행한다. `avatar_salt` 등 볼륨에만 있던 비밀값이 바뀌면 아바타·세션이 깨질 수 있다. 실제로 해본 적 없는 절차이므로 시험 환경에서 먼저 확인한다.
- Zulip 이미지에는 자체 자동 백업(`AUTO_BACKUP_ENABLED`, 기본 매일 03:30 UTC, `pg_dump`만 `/data/backups`에 저장)도 있다. 이것은 같은 `zulip` 볼륨 안에 남으므로 볼륨이 사라지면 함께 사라진다. 호스트에 따로 두는 `ops/backup.ps1`과는 별개다. (운영 compose `compose.was-db.yaml`·`compose.app.yaml`은 이 자동 백업을 끄고 `ops/backup.sh`로 일원화한다 — 아래 리눅스 절.)

## 작업 스케줄러로 매일 새벽 실행 (예시, 자동 등록하지 않음)

필요할 때 **관리자가 아닌 일반** PowerShell에서 직접 실행한다. Docker Desktop이 같은 사용자로 로그인된 상태에서 돌아야 하므로 "로그온한 경우에만 실행"(기본값)으로 등록한다.

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\SangsangTalk\ops\backup.ps1"' `
  -WorkingDirectory 'C:\SangsangTalk'
$trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'SangsangTalk Zulip Backup' -Action $action -Trigger $trigger -Settings $settings `
  -Description '상상톡 Zulip 매일 백업 (ops/backup.ps1)'
```

`schtasks`로 한 줄 등록:

```powershell
schtasks /Create /TN "SangsangTalk Zulip Backup" /SC DAILY /ST 03:30 /TR "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\SangsangTalk\ops\backup.ps1"
```

확인·실행·삭제:

```powershell
Get-ScheduledTaskInfo -TaskName 'SangsangTalk Zulip Backup'   # LastTaskResult 0 = 성공
Start-ScheduledTask   -TaskName 'SangsangTalk Zulip Backup'   # 바로 한 번 실행
Unregister-ScheduledTask -TaskName 'SangsangTalk Zulip Backup' -Confirm:$false
```

- `-StartWhenAvailable`: 새벽에 PC가 꺼져 있었으면 다음에 켜졌을 때 실행한다.
- PC가 잠자기 상태면 실행되지 않는다. 깨워서 실행하려면 `New-ScheduledTaskSettingsSet -WakeToRun`을 더한다.
- Docker Desktop이 아직 시작되지 않았으면 스크립트가 실패(종료 코드 1)하고 `backup.log`에 남긴다.

---

# 리눅스(폐쇄망 운영) 백업·복원

기본 운영은 **2대 구성**이다: ② WAS·DB 서버(`ops/compose/compose.was-db.yaml`, Zulip과 PostgreSQL이 한 compose)와 ① 웹 서버.
아래에서 **[앱]은 ② 서버**, **[웹]은 ① 서버**로 읽고, compose 파일은 `ops/compose/compose.was-db.yaml`을 쓴다.
3계층 구성(`compose.app.yaml` = [앱], `compose.db.yaml` = [DB])이면 [앱] 명령의 compose 파일만 `ops/compose/compose.app.yaml`로 바꾼다.
저장소는 각 서버의 `/opt/sangsangtalk`, compose 환경파일은 `/etc/sangsangtalk/zulip.env`(권한 0600 root)로 가정한다.
DB 접속은 44703·TLS(`verify-full`)이며, Zulip 컨테이너의 `PGSSLMODE`·`PGSSLROOTCERT` 환경변수와 libpq 기본 위치에 마운트한 CA
(`/home/zulip/.postgresql/root.crt`, `/root/.postgresql/root.crt`) 덕분에 `manage.py backup`의 `pg_dump`와 아래 `pg_restore`도 같은 기준으로 접속한다(`ops/README.md` M10).

**이 절의 명령은 모두 root 셸(`sudo -i`)에서 실행한다.** docker 명령과 0600 root 환경파일을 쓰기 때문이다.
[웹] 서버의 쪽지 백업만 root 셸에서 `sudo -u sangsangtalk`으로 서비스 계정 권한으로 돌린다.

백업 폴더 만들기(처음 한 번):

```bash
# [앱] 서버
install -d -o root -g root -m 0700 /var/backups/sangsangtalk
# [웹] 서버 (쪽지 백업은 sangsangtalk 계정이 쓴다)
install -d -o sangsangtalk -g sangsangtalk -m 0700 /var/backups/sangsangtalk-web
```

## 백업: `ops/backup.sh`

`ops/backup.ps1`과 같은 동작(`manage.py backup` → `docker compose cp` → tar 목록 검사 → 쪽지 인덱스 사본 → 보관 일수 지난 폴더 삭제 → 로그, 실패 시 종료 코드 1)을 bash로 한다.
여기에 더해 2·3단계 상상톡 데이터를 같은 회차 폴더의 `web-data/`에 복사한다(`backup.ps1`에는 없음).

| `web/data` 파일 | 내용 | 백업 |
|---|---|---|
| `notes.json` | 쪽지 인덱스(Zulip 메시지 ID) | `<회차>/notes.json` |
| `notices.json` | 대화방 공지(메시지 ID, 등록자, 시각) | `<회차>/web-data/notices.json` |
| `prefs.json` | 사용자 설정(즐겨찾기, 알림 끄기, 방해 금지) | `<회차>/web-data/prefs.json` |
| `admin-meta.json` | CMS 관리 정보(퇴직 처리 시각, 다음 로그인 때 비밀번호 바꾸기) | `<회차>/web-data/admin-meta.json` |
| `audit/YYYY-MM.jsonl` | 감사 로그(보존 `AUDIT_KEEP_MONTHS`개월) | `<회차>/web-data/audit/` |
| `activity.json` | 3단계 알림 센터의 답장·반응 기록과 확인 시각(메시지 ID·사용자 ID만, 본문 없음. 최근 30일) | `<회차>/web-data/activity.json` |
| `policy.json` | 3단계 관리자 정책(알림 미리 보기 숨김 강제, 추가 차단 확장자) | `<회차>/web-data/policy.json` |
| `<위 JSON>.bak` | 저장 도중(또는 저장이 끊긴 뒤)에만 있는 직전 사본. 서버는 본 파일이 없거나 깨지면 이것을 읽는다 | 있을 때만 `<회차>/web-data/<이름>.bak` |
| `sessions.json` | 암호화된 로그인 세션(Zulip API 키 포함) | **하지 않음.** 복원 뒤에는 직원이 다시 로그인한다 |

- 아직 만들어지지 않은 파일(`prefs.json`은 처음 설정을 바꿀 때, `activity.json`은 첫 답장·반응 때, `policy.json`은 관리자가 정책을 처음 저장할 때 생기는 등)은 `[INFO] … 건너뜀`만 남긴다. 있는데 복사하지 못하면 `[WARN]`(전체 백업) 또는 `[ERROR] 백업 실패`(`--notes-only`)다.
- 폴더 위치는 기본으로 `--notes-file`이 있는 폴더이고, `--web-data-dir`로 바꿀 수 있다.
- 감사 로그 보존 기간(`AUDIT_KEEP_MONTHS`)이 지나 서버가 지운 달의 파일도 백업 회차에는 남는다. 백업 보관 일수(`--retention-days`)를 기관 보존 기준과 함께 정한다.

- 위치: `/var/backups/sangsangtalk/<yyyyMMdd-HHmmss>/zulip-backup-<yyyyMMdd-HHmmss>.tar.gz` (`--backup-root`)
- 로그: `/var/backups/sangsangtalk/backup.log`
- 보관: 30일(`--retention-days`), 이름이 `yyyyMMdd-HHmmss` 형식인 폴더만 지운다.
- 파일 권한: 스크립트가 `umask 077`로 만든다(백업에 `zulip-secrets.conf` 포함).
- `--dry-run`: 컨테이너 실행 여부만 확인하고 할 일을 출력한다(백업·삭제·로그 기록 없음).

[앱] 서버(Zulip 백업. `manage.py backup`이 `REMOTE_POSTGRES_HOST`로 `pg_dump` 한다):

```bash
/opt/sangsangtalk/ops/backup.sh \
  --compose-file /opt/sangsangtalk/ops/compose/compose.was-db.yaml \
  --env-file /etc/sangsangtalk/zulip.env
```

쪽지 인덱스와 상상톡 데이터(`web/data`)는 [웹] 서버에 있으므로 [앱] 서버 실행에서는 `[WARN] 쪽지 인덱스 파일이 없어 건너뜁니다`와 `상상톡 데이터 폴더가 없어 건너뜁니다`가 정상이다.
[웹] 서버에서는 같은 스크립트를 `--notes-only`로 돌린다(같은 이름 규칙의 폴더에 `notes.json`과 `web-data/`가 생긴다):

```bash
sudo -u sangsangtalk /opt/sangsangtalk/ops/backup.sh --notes-only \
  --backup-root /var/backups/sangsangtalk-web --notes-file /opt/sangsangtalk/web/data/notes.json
```

> 쪽지 인덱스는 Zulip 메시지 ID를 가리킨다. 복원할 때는 Zulip 백업과 **가장 가까운 시각**의 쪽지 사본을 쓴다. 두 cron을 같은 시각에 맞춘다.

### cron 예시 (문서로만. 자동 등록하지 않음)

`/etc/cron.d/sangsangtalk-backup` ([앱] 서버):

```
# 매일 03:30 (서버 현지 시각)
30 3 * * * root /opt/sangsangtalk/ops/backup.sh --compose-file /opt/sangsangtalk/ops/compose/compose.was-db.yaml --env-file /etc/sangsangtalk/zulip.env >/dev/null 2>&1
```

`/etc/cron.d/sangsangtalk-notes-backup` ([웹] 서버):

```
30 3 * * * sangsangtalk /opt/sangsangtalk/ops/backup.sh --notes-only --backup-root /var/backups/sangsangtalk-web --notes-file /opt/sangsangtalk/web/data/notes.json >/dev/null 2>&1
```

- 결과는 `backup.log`의 마지막 줄(`백업 완료` 또는 `[ERROR] 백업 실패`)로 확인한다. 감시 도구가 있으면 종료 코드나 로그를 본다.
- `--notes-only`의 백업 폴더(`/var/backups/sangsangtalk-web`)는 `sangsangtalk` 계정이 쓸 수 있어야 한다(위 `install -d`).
  systemd 유닛의 `ReadWritePaths`는 서비스에만 적용되므로 cron에는 영향이 없다.
- `--notes-only`는 쪽지 인덱스를 복사하지 못하면 `[ERROR] 백업 실패`, 종료 코드 1이다. 전체 백업에서는 경고만 남기고
  마지막 줄이 `[WARN] 백업 완료 (…) — 경고: 쪽지 인덱스 사본 없음`이 된다(3계층 [앱] 서버에서는 정상).
- 백업 폴더는 별도 저장소로 옮겨 보관한다(`ops/firewall.md` 6·7번).
- docker-zulip 자체 자동 백업(`AUTO_BACKUP_ENABLED`, 기본 켜짐)은 `zulip` 볼륨 안 `/data/backups`에 지우지 않고 쌓이므로
  운영 compose(`compose.was-db.yaml`, `compose.app.yaml`)에서 `AUTO_BACKUP_ENABLED: "False"`로 껐다. 운영 백업은 이 스크립트 하나로 한다(개발용 `compose.yaml`은 그대로 켜져 있음).

## 복원 ([앱] 서버, 실행 중인 스택에 덮어쓰기)

위 Windows 절차와 같은 단계를 리눅스 **root 셸**로 한다. **현재 데이터가 백업 시점으로 덮어써진다.** 먼저 지금 상태를 백업한다.
PostgreSQL(`database` 서비스, 3계층이면 [DB] 서버)은 켜 둔다(복원은 zulip 컨테이너에서 DB로 `pg_restore` 한다).

```bash
cd /opt/sangsangtalk
CF=ops/compose/compose.was-db.yaml                      # 3계층 [앱] 서버면 ops/compose/compose.app.yaml
C=(docker compose --env-file /etc/sangsangtalk/zulip.env -f "$CF")
stamp=20261116-110146                                   # 복원할 백업 폴더 이름
file=/var/backups/sangsangtalk/$stamp/zulip-backup-$stamp.tar.gz

# 0) 지금 상태 백업
ops/backup.sh --compose-file "$CF" --env-file /etc/sangsangtalk/zulip.env

# 1) 백업 파일을 컨테이너로 복사하고 풀기
"${C[@]}" exec -T zulip sh -c 'rm -rf /tmp/restore && mkdir -p /tmp/restore'
"${C[@]}" cp "$file" zulip:/tmp/restore/backup.tar.gz
"${C[@]}" exec -T zulip tar -xzf /tmp/restore/backup.tar.gz -C /tmp/restore

# 2) Zulip 앱 서버 중지(컨테이너는 그대로)
"${C[@]}" exec -T -u zulip zulip /home/zulip/deployments/current/scripts/stop-server

# 3) 데이터베이스 복원(컨테이너 환경변수 SETTING_REMOTE_POSTGRES_HOST/PORT, PGSSLMODE/PGSSLROOTCERT·/root/.postgresql/root.crt 로 TLS 검증 접속)
"${C[@]}" exec -T zulip sh -c 'export PGPASSWORD="$(crudini --get /etc/zulip/zulip-secrets.conf secrets postgres_password)"; pg_restore -h "$SETTING_REMOTE_POSTGRES_HOST" -p "${SETTING_REMOTE_POSTGRES_PORT:-44703}" -U zulip -d zulip --clean --if-exists /tmp/restore/zulip-backup/database'

# 4) 업로드 파일 복원
"${C[@]}" exec -T zulip sh -c 'cp -a /tmp/restore/zulip-backup/uploads/. /data/uploads/ && chown -R zulip:zulip /data/uploads'

# 5) 캐시 비우고 서버 시작
"${C[@]}" exec -T -u zulip zulip /home/zulip/deployments/current/scripts/setup/flush-memcached
"${C[@]}" exec -T -u zulip zulip /home/zulip/deployments/current/scripts/start-server

# 6) 임시 파일 정리
"${C[@]}" exec -T zulip rm -rf /tmp/restore
```

7) 쪽지 인덱스·상상톡 데이터 되돌리기 ([웹] 서버, root 셸):

```bash
systemctl stop sangsangtalk-web
src=/var/backups/sangsangtalk-web/<가장 가까운 회차>
dst=/opt/sangsangtalk/web/data
install -o sangsangtalk -g sangsangtalk -m 0600 "$src/notes.json" "$dst/notes.json"
# 2·3단계 데이터: 그 회차에 있는 것만 되돌린다(없는 파일은 그 회차 때 아직 없던 것).
# 지금 폴더의 .bak 은 지우고, 그 회차에 .bak 이 있었으면 그것을 함께 되돌린다(서버가 옛 .bak 을 읽지 않게).
for f in notices.json prefs.json admin-meta.json activity.json policy.json; do
  if [ -f "$src/web-data/$f" ] || [ -f "$src/web-data/$f.bak" ]; then
    rm -f "$dst/$f.bak"
    [ -f "$src/web-data/$f" ] && install -o sangsangtalk -g sangsangtalk -m 0600 "$src/web-data/$f" "$dst/$f"
    [ -f "$src/web-data/$f.bak" ] && install -o sangsangtalk -g sangsangtalk -m 0600 "$src/web-data/$f.bak" "$dst/$f.bak"
  fi
done
# 감사 로그는 덮어쓰지 않고 합친다: 백업에만 있는 달 파일만 되살리고 지금 있는 파일은 그대로 둔다
if [ -d "$src/web-data/audit" ]; then
  install -d -o sangsangtalk -g sangsangtalk -m 0700 "$dst/audit"
  for f in "$src"/web-data/audit/*.jsonl; do
    [ -e "$f" ] && cp -n -p "$f" "$dst/audit/"
  done
  chown -R sangsangtalk:sangsangtalk "$dst/audit"
fi
systemctl start sangsangtalk-web
```

- `notices.json`도 메시지 ID를 가리키므로 쪽지 인덱스처럼 Zulip 백업과 가장 가까운 회차를 쓴다.
- `activity.json`도 메시지 ID를 가리키므로 같은 회차를 쓴다. 되돌리면 백업 이후의 답장·반응 알림이 빠지고, 확인 기록도 백업 시점으로 돌아가 그 뒤에 확인한 항목(멘션·키워드·공지 포함)이 다시 안 본 것으로 보인다. 멘션·키워드·공지 항목 자체는 Zulip과 `notices.json`에서 다시 읽는다.
- `policy.json`을 되돌리면 관리자 정책(미리 보기 숨김 강제, 추가 차단 확장자)이 백업 시점 값이 된다. 복원 뒤 관리자 화면(`/admin`) "정책" 탭에서 확인한다.
- `admin-meta.json`을 되돌리면 백업 이후에 켠 "다음 로그인 때 비밀번호 바꾸기"와 퇴직 처리 시각이 백업 시점으로 돌아간다. 복원 뒤 CMS에서 다시 확인한다.
- 서버는 시작할 때 `AUDIT_KEEP_MONTHS`보다 오래된 감사 로그 파일을 지우므로, 되살린 옛 달 파일도 보존 기간 밖이면 바로 지워진다. 그런 기록은 백업 폴더에서 직접 본다.

확인: 관리 PC에서 `https://<ZULIP_EXTERNAL_HOST>` 로그인, 직원 PC 상상톡 앱에서 대화 목록·최근 메시지·첨부 열기.
주의사항(설정 폴더는 복원하지 않음, 버전 일치, `--clean` 경고 등)은 위 Windows 절과 같다. 리눅스 복원 절차는 **아직 실제로 해 보지 않았다(미검증)** — 시험 환경에서 먼저 확인한다.

## 관리자 정책 파일(`policy.json`)이 깨졌을 때 ([웹] 서버)

웹 서버는 `web/data/policy.json`을 시작할 때와 정책을 바꿀 때 읽는다. 본 파일이 없거나 깨지면 `policy.json.bak`을 읽는다.
**둘 다 읽지 못하면**(내용이 깨짐, 형식이 맞지 않음, 권한 문제로 읽을 수 없음) 서버는 그대로 돌지만 다음처럼 막힌다(`web/server.mjs`):

- 파일 올리기: 503 "파일 정책을 읽지 못해 파일 올리기를 막았습니다. 서버 관리자에게 알려 주세요." 어떤 확장자를 막아야 하는지 모르므로 모두 막는다.
- 관리자 화면 "정책" 탭(`GET/PATCH /api/admin/policy`): 503 "관리자 정책 파일(policy.json)을 읽지 못했습니다. …" 깨진 동안에는 서버가 이 파일을 쓰지 않는다.
- journal에 `[sangsang] 관리자 정책 파일을 읽지 못했습니다 (<원인>). 파일 올리기를 막습니다.`가 한 번 남는다.
- 알림 미리 보기 강제(`forcePreviewHidden`)는 마지막으로 읽은 값을 쓰고, 서버를 시작한 뒤 한 번도 읽지 못했으면 기본값(꺼짐)을 쓴다.

서버는 깨진 동안 파일 올리기 요청과 정책 화면 요청이 올 때마다 파일을 다시 읽는다. 그래서 아래 두 방법 중 하나로 파일을 고치면 **재시작하지 않아도** 풀린다.
서비스를 멈추지 않아도 된다. 명령은 root 셸에서 실행한다.

```bash
cd /opt/sangsangtalk/web/data
ls -l policy.json policy.json.bak
journalctl -u sangsangtalk-web | grep '관리자 정책 파일' | tail -3      # 원인 확인
```

1. **백업에서 되돌리기(권장):** 가장 최근 회차의 사본을 쓴다(정책은 메시지 ID와 관계없으므로 아무 회차나 된다).

   ```bash
   src=/var/backups/sangsangtalk-web/<회차>
   rm -f policy.json.bak
   install -o sangsangtalk -g sangsangtalk -m 0600 "$src/web-data/policy.json" policy.json
   ```

2. **기본값으로 되돌리기:** `policy.json`과 `policy.json.bak`이 **둘 다 없으면** 서버는 기본값으로 읽는다(`web/lib/json-store.mjs`의 빈 저장소 → `web/lib/settings.mjs`의 `emptyPolicy()`).
   기본값은 미리 보기 강제 꺼짐, 관리자가 추가한 차단 확장자 없음이다. 서버에 박힌 차단 목록(`BLOCKED_EXTENSIONS`)과 `MAX_UPLOAD_MB`는 파일과 관계없이 그대로 적용된다.
   깨진 파일은 지우지 말고 다른 이름으로 옮겨 둔다(`.bak`으로 끝나는 이름은 쓰지 않는다).

   ```bash
   d=$(date +%Y%m%d-%H%M%S)
   mv policy.json "policy.json.broken-$d" 2>/dev/null
   mv policy.json.bak "policy.json.bak.broken-$d" 2>/dev/null
   ```

   기본값이 되면 관리자가 정했던 정책이 사라진다. 관리자 화면 "정책" 탭에서 미리 보기 강제와 추가 차단 확장자를 다시 넣는다(저장하면 파일이 새로 생긴다).

확인: 관리자 화면 "정책" 탭이 열리는지, 직원 PC에서 작은 파일 하나를 올려 본다.
`activity.json`과 `.bak`이 둘 다 깨지면 알림 센터(`/api/activity`)가 503을 돌려주고 답장·반응 기록이 남지 않는다(답장·반응 자체는 된다. journal에 `활동 기록을 남기지 못했습니다`).
같은 방식으로 백업에서 되돌리거나(Zulip 백업과 가장 가까운 회차), 두 파일을 옮기면 빈 기록에서 다시 시작한다(지난 답장·반응 알림이 사라지고, 확인 기록도 없어져 최근 30일의 멘션·키워드·공지 항목이 모두 안 본 것으로 다시 보인다).
