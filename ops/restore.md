# 상상톡 Zulip 백업·복원

## 백업 파일

- 만드는 스크립트: `ops/backup.ps1` (Windows PowerShell 5.1)
- 위치: `C:\SangsangTalk-backup\<yyyyMMdd-HHmmss>\zulip-backup-<yyyyMMdd-HHmmss>.tar.gz`
- 쪽지 인덱스 사본: 같은 폴더의 `notes.json`(`C:\SangsangTalk\web\data\notes.json` 복사본, 원본이 없으면 경고 로그만 남기고 생략)
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
- Zulip 이미지에는 자체 자동 백업(`AUTO_BACKUP_ENABLED`, 기본 매일 03:30 UTC, `pg_dump`만 `/data/backups`에 저장)도 있다. 이것은 같은 `zulip` 볼륨 안에 남으므로 볼륨이 사라지면 함께 사라진다. 호스트에 따로 두는 `ops/backup.ps1`과는 별개다. (운영 3계층 `compose.app.yaml`은 이 자동 백업을 끄고 `ops/backup.sh`로 일원화한다 — 아래 리눅스 절.)

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

3계층 구성(`ops/compose/compose.app.yaml` = [앱], `ops/compose/compose.db.yaml` = [DB], 웹 서버 = [웹])을 기준으로 한다.
저장소는 각 서버의 `/opt/sangsangtalk`, compose 환경파일은 `/etc/sangsangtalk/zulip.env`(권한 0600 root)로 가정한다.

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

- 위치: `/var/backups/sangsangtalk/<yyyyMMdd-HHmmss>/zulip-backup-<yyyyMMdd-HHmmss>.tar.gz` (`--backup-root`)
- 로그: `/var/backups/sangsangtalk/backup.log`
- 보관: 30일(`--retention-days`), 이름이 `yyyyMMdd-HHmmss` 형식인 폴더만 지운다.
- 파일 권한: 스크립트가 `umask 077`로 만든다(백업에 `zulip-secrets.conf` 포함).
- `--dry-run`: 컨테이너 실행 여부만 확인하고 할 일을 출력한다(백업·삭제·로그 기록 없음).

[앱] 서버(Zulip 백업. DB는 원격이지만 `manage.py backup`이 `REMOTE_POSTGRES_HOST`로 `pg_dump` 한다):

```bash
/opt/sangsangtalk/ops/backup.sh \
  --compose-file /opt/sangsangtalk/ops/compose/compose.app.yaml \
  --env-file /etc/sangsangtalk/zulip.env
```

3계층에서는 쪽지 인덱스(`web/data/notes.json`)가 [웹] 서버에 있으므로 [앱] 서버 실행에서는 `[WARN] 쪽지 인덱스 파일이 없어 건너뜁니다`가 정상이다.
[웹] 서버에서는 같은 스크립트를 쪽지만 백업하도록 돌린다(같은 이름 규칙의 폴더에 `notes.json`만 생긴다):

```bash
sudo -u sangsangtalk /opt/sangsangtalk/ops/backup.sh --notes-only \
  --backup-root /var/backups/sangsangtalk-web --notes-file /opt/sangsangtalk/web/data/notes.json
```

> 쪽지 인덱스는 Zulip 메시지 ID를 가리킨다. 복원할 때는 Zulip 백업과 **가장 가까운 시각**의 쪽지 사본을 쓴다. 두 cron을 같은 시각에 맞춘다.

### cron 예시 (문서로만. 자동 등록하지 않음)

`/etc/cron.d/sangsangtalk-backup` ([앱] 서버):

```
# 매일 03:30 (서버 현지 시각)
30 3 * * * root /opt/sangsangtalk/ops/backup.sh --compose-file /opt/sangsangtalk/ops/compose/compose.app.yaml --env-file /etc/sangsangtalk/zulip.env >/dev/null 2>&1
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
  `compose.app.yaml`에서 `AUTO_BACKUP_ENABLED: "False"`로 껐다. 운영 백업은 이 스크립트 하나로 한다(개발용 `compose.yaml`은 그대로 켜져 있음).

## 복원 ([앱] 서버, 실행 중인 스택에 덮어쓰기)

위 Windows 절차와 같은 단계를 리눅스 **root 셸**로 한다. **현재 데이터가 백업 시점으로 덮어써진다.** 먼저 지금 상태를 백업한다.
[DB] 서버의 PostgreSQL은 켜 둔다(복원은 앱 컨테이너에서 원격 DB로 `pg_restore` 한다).

```bash
cd /opt/sangsangtalk
C=(docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/compose.app.yaml)
stamp=20261116-110146                                   # 복원할 백업 폴더 이름
file=/var/backups/sangsangtalk/$stamp/zulip-backup-$stamp.tar.gz

# 0) 지금 상태 백업
ops/backup.sh --compose-file ops/compose/compose.app.yaml --env-file /etc/sangsangtalk/zulip.env

# 1) 백업 파일을 컨테이너로 복사하고 풀기
"${C[@]}" exec -T zulip sh -c 'rm -rf /tmp/restore && mkdir -p /tmp/restore'
"${C[@]}" cp "$file" zulip:/tmp/restore/backup.tar.gz
"${C[@]}" exec -T zulip tar -xzf /tmp/restore/backup.tar.gz -C /tmp/restore

# 2) Zulip 앱 서버 중지(컨테이너는 그대로)
"${C[@]}" exec -T -u zulip zulip /home/zulip/deployments/current/scripts/stop-server

# 3) 데이터베이스 복원(원격 DB. 컨테이너 환경변수 SETTING_REMOTE_POSTGRES_HOST/PORT 로 접속)
"${C[@]}" exec -T zulip sh -c 'export PGPASSWORD="$(crudini --get /etc/zulip/zulip-secrets.conf secrets postgres_password)"; pg_restore -h "$SETTING_REMOTE_POSTGRES_HOST" -p "${SETTING_REMOTE_POSTGRES_PORT:-5432}" -U zulip -d zulip --clean --if-exists /tmp/restore/zulip-backup/database'

# 4) 업로드 파일 복원
"${C[@]}" exec -T zulip sh -c 'cp -a /tmp/restore/zulip-backup/uploads/. /data/uploads/ && chown -R zulip:zulip /data/uploads'

# 5) 캐시 비우고 서버 시작
"${C[@]}" exec -T -u zulip zulip /home/zulip/deployments/current/scripts/setup/flush-memcached
"${C[@]}" exec -T -u zulip zulip /home/zulip/deployments/current/scripts/start-server

# 6) 임시 파일 정리
"${C[@]}" exec -T zulip rm -rf /tmp/restore
```

7) 쪽지 인덱스 되돌리기 ([웹] 서버, root 셸):

```bash
systemctl stop sangsangtalk-web
install -o sangsangtalk -g sangsangtalk -m 0600 /var/backups/sangsangtalk-web/<가장 가까운 회차>/notes.json /opt/sangsangtalk/web/data/notes.json
systemctl start sangsangtalk-web
```

확인: 관리 PC에서 `https://<ZULIP_EXTERNAL_HOST>` 로그인, 직원 PC 상상톡 앱에서 대화 목록·최근 메시지·첨부 열기.
주의사항(설정 폴더는 복원하지 않음, 버전 일치, `--clean` 경고 등)은 위 Windows 절과 같다. 리눅스 복원 절차는 **아직 실제로 해 보지 않았다(미검증)** — 시험 환경에서 먼저 확인한다.
