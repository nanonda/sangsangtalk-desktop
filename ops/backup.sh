#!/usr/bin/env bash
# 상상톡 Zulip 스택을 Zulip 공식 백업 도구(manage.py backup)로 백업한다. (ops/backup.ps1 의 리눅스판)
#
# 1. 컨테이너 안에서 manage.py backup 으로 tar.gz를 만든다(DB + 업로드 + /etc/zulip 설정).
# 2. docker compose cp 로 꺼내 <BACKUP_ROOT>/<yyyyMMdd-HHmmss>/ 에 저장한다.
# 3. tar 목록으로 압축·DB 덤프 포함 여부를 검사하고, 쪽지 인덱스(web/data/notes.json) 사본을 둔다.
# 4. 컨테이너 안 임시 파일을 지운다.
# 5. RETENTION_DAYS 일보다 오래된 백업 폴더(이름이 yyyyMMdd-HHmmss 형식인 것만)를 지운다.
# 로그는 <BACKUP_ROOT>/backup.log 에 덧붙인다. 실패하면 종료 코드 1.
# 이 스크립트는 .env 나 secrets 를 읽거나 출력하지 않는다.
# (단, 백업 tar.gz 자체에는 /etc/zulip/zulip-secrets.conf 가 들어 있으므로 백업 폴더 권한에 주의한다. umask 077로 만든다.)
#
# 사용법:
#   ops/backup.sh [옵션]
#     --backup-root DIR      백업 위치 (기본 /var/backups/sangsangtalk)
#     --retention-days N     보관 일수 1~3650 (기본 30)
#     --compose-file FILE    compose 파일 (기본 <저장소>/compose.yaml. 운영 ② WAS·DB 서버는 ops/compose/compose.was-db.yaml,
#                            3계층 [앱] 서버는 ops/compose/compose.app.yaml)
#     --env-file FILE        docker compose --env-file 로 넘길 파일(선택. 내용은 읽지 않는다)
#     --service NAME         Zulip 서비스 이름 (기본 zulip)
#     --notes-file FILE      쪽지 인덱스 경로 (기본 <저장소>/web/data/notes.json)
#     --notes-only           Zulip 백업 없이 쪽지 인덱스 사본만 만든다(① 웹 서버용)
#     --dry-run              사전 점검만 하고 할 일을 출력한다(백업·삭제하지 않음, 로그 파일도 쓰지 않음)
#     -h, --help
# 예:
#   ② WAS·DB 서버, root로:  /opt/sangsangtalk/ops/backup.sh \
#     --compose-file /opt/sangsangtalk/ops/compose/compose.was-db.yaml --env-file /etc/sangsangtalk/zulip.env
#   ① 웹 서버, sangsangtalk 계정으로:  sudo -u sangsangtalk /opt/sangsangtalk/ops/backup.sh --notes-only \
#     --backup-root /var/backups/sangsangtalk-web --notes-file /opt/sangsangtalk/web/data/notes.json
#   (전체 백업은 docker 와 /etc/sangsangtalk/zulip.env(0600 root)를 쓰므로 root로 실행한다. ops/restore.md 참고)
set -euo pipefail
umask 077
export MSYS_NO_PATHCONV=1   # Git Bash에서 시험할 때 컨테이너 경로가 바뀌지 않게(리눅스에서는 영향 없음)

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname "$script_dir")"

BACKUP_ROOT="/var/backups/sangsangtalk"
RETENTION_DAYS=30
COMPOSE_FILE="$repo_dir/compose.yaml"
ENV_FILE=""
SERVICE="zulip"
NOTES_FILE="$repo_dir/web/data/notes.json"
NOTES_ONLY=0
DRY_RUN=0

usage() { sed -n '/^# 사용법:/,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

need_arg() { [[ $# -ge 2 && -n "$2" ]] || { echo "옵션 $1 에 값이 필요합니다." >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backup-root) need_arg "$@"; BACKUP_ROOT="$2"; shift 2 ;;
        --retention-days) need_arg "$@"; RETENTION_DAYS="$2"; shift 2 ;;
        --compose-file) need_arg "$@"; COMPOSE_FILE="$2"; shift 2 ;;
        --env-file) need_arg "$@"; ENV_FILE="$2"; shift 2 ;;
        --service) need_arg "$@"; SERVICE="$2"; shift 2 ;;
        --notes-file) need_arg "$@"; NOTES_FILE="$2"; shift 2 ;;
        --notes-only) NOTES_ONLY=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "알 수 없는 옵션: $1 (--help 참고)" >&2; exit 2 ;;
    esac
done
if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 1 || RETENTION_DAYS > 3650 )); then
    echo "--retention-days 는 1~3650 사이 정수여야 합니다: $RETENTION_DAYS" >&2
    exit 2
fi

started_at=$(date +%s)
stamp=$(date -d "@$started_at" +%Y%m%d-%H%M%S)
log_file="$BACKUP_ROOT/backup.log"
container_file="/tmp/sangsangtalk-backup-$stamp.tar.gz"
target_dir="$BACKUP_ROOT/$stamp"
target_file="$target_dir/zulip-backup-$stamp.tar.gz"
container_file_created=0
exit_code=0

log() {
    local level="${2:-INFO}" line
    line="$(date '+%Y-%m-%d %H:%M:%S') [$level] $1"
    if [[ "$level" == "ERROR" ]]; then echo "$line" >&2; else echo "$line"; fi
    if (( ! DRY_RUN )); then echo "$line" >>"$log_file" 2>/dev/null || true; fi
}

compose_cmd=(docker compose -f "$COMPOSE_FILE")
[[ -n "$ENV_FILE" ]] && compose_cmd=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# docker compose 를 실행하고 출력(표준오류 포함)을 로그에 남긴다. 종료 코드를 돌려준다.
run_compose() {
    local out code=0
    out=$("${compose_cmd[@]}" "$@" 2>&1) || code=$?
    if [[ -n "$out" ]]; then
        while IFS= read -r l; do if [[ -n "${l//[[:space:]]/}" ]]; then log "  docker> $l"; fi; done <<<"$out"
    fi
    return "$code"
}

fail() { log "백업 실패: $1" ERROR; exit_code=1; }

cleanup() {
    local rc=$?
    (( rc != 0 && exit_code == 0 )) && { log "예상치 못한 오류로 중단되었습니다(종료 코드 $rc)." ERROR; exit_code=1; }
    if (( exit_code != 0 )) && [[ -d "$target_dir" ]] && (( ! DRY_RUN )); then
        rm -rf -- "$target_dir" || true   # 실패한 이번 회차의 불완전한 폴더
    fi
    if (( container_file_created )); then
        if ! run_compose exec -T -u zulip "$SERVICE" rm -f "$container_file"; then
            log "컨테이너 안 임시 파일을 지우지 못했습니다: $container_file" ERROR
            exit_code=1
        fi
    fi
    exit "$exit_code"
}
trap cleanup EXIT

# 쪽지 인덱스 사본. 성공하면 0, 파일이 없거나 복사에 실패하면 WARN을 남기고 1.
# 전체 백업에서는 경고만 하고 계속하며(마지막 줄에 표시), --notes-only 에서는 백업 실패로 처리한다.
notes_missing=0
copy_notes() {
    if [[ ! -f "$NOTES_FILE" ]]; then
        log "쪽지 인덱스 파일이 없어 건너뜁니다: $NOTES_FILE" WARN
        return 1
    fi
    if (( DRY_RUN )); then
        log "[드라이런] 쪽지 인덱스 복사: $NOTES_FILE -> $target_dir/notes.json"
    elif mkdir -p "$target_dir" && cp -- "$NOTES_FILE" "$target_dir/notes.json"; then
        log "쪽지 인덱스 사본 저장: $target_dir/notes.json ($(stat -c %s "$target_dir/notes.json") 바이트)"
    else
        log "쪽지 인덱스를 복사하지 못했습니다: $NOTES_FILE" WARN
        return 1
    fi
}

# 마지막 줄. 쪽지 사본이 빠졌으면 WARN 수준으로 그 사실을 함께 남긴다.
finish_log() {
    local elapsed=$(( $(date +%s) - started_at )) prefix="${1:-}"
    if (( notes_missing )); then
        log "${prefix}백업 완료 (${elapsed}초) — 경고: 쪽지 인덱스 사본 없음(위 WARN 참고)" WARN
    else
        log "${prefix}백업 완료 (${elapsed}초)"
    fi
}

prune_old() {
    local cutoff dir name iso
    cutoff=$(date -d "@$(( started_at - RETENTION_DAYS * 86400 ))" +%Y%m%d-%H%M%S)
    shopt -s nullglob
    for dir in "$BACKUP_ROOT"/*/; do
        dir="${dir%/}"; name="${dir##*/}"
        [[ "$name" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})$ ]] || continue
        iso="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}"
        # 실제 날짜인지 확인(예: 20261399-… 는 건너뜀). 같은 형식이므로 문자열 비교 = 시간 비교.
        [[ "$(date -d "$iso" +%Y%m%d-%H%M%S 2>/dev/null || true)" == "$name" ]] || continue
        [[ "$name" < "$cutoff" ]] || continue
        if (( DRY_RUN )); then
            log "[드라이런] 오래된 백업 삭제 예정: $dir"
        else
            rm -rf -- "$dir"
            log "오래된 백업 삭제: $dir"
        fi
    done
    shopt -u nullglob
}

main() {
    if (( ! DRY_RUN )); then mkdir -p "$BACKUP_ROOT"; fi
    (( DRY_RUN )) && log "[드라이런] 실제 백업·삭제·로그 기록을 하지 않습니다."
    log "백업 시작: compose=$COMPOSE_FILE, 대상=$target_dir, 보관=${RETENTION_DAYS}일$( (( NOTES_ONLY )) && echo ', 쪽지만')"

    if (( NOTES_ONLY )); then
        copy_notes || { fail "--notes-only 인데 쪽지 인덱스를 복사하지 못했습니다: $NOTES_FILE"; return; }
        prune_old
        finish_log "$( (( DRY_RUN )) && echo '[드라이런] ')"
        return
    fi

    command -v docker >/dev/null 2>&1 || { fail "docker 명령을 찾을 수 없습니다. Docker가 설치·실행 중인지 확인하세요."; return; }
    [[ -f "$COMPOSE_FILE" ]] || { fail "compose 파일을 찾을 수 없습니다: $COMPOSE_FILE"; return; }
    [[ -z "$ENV_FILE" || -f "$ENV_FILE" ]] || { fail "env 파일을 찾을 수 없습니다: $ENV_FILE"; return; }

    # 1) 서비스 실행 확인
    local running
    running=$("${compose_cmd[@]}" ps --status running --services 2>/dev/null || true)
    if ! grep -qx -- "$SERVICE" <<<"$running"; then
        fail "Zulip 컨테이너('$SERVICE')가 실행 중이 아닙니다. 'docker compose up -d' 후 다시 시도하세요."
        return
    fi
    log "서비스 실행 확인: $SERVICE"

    if (( DRY_RUN )); then
        log "[드라이런] 실행할 명령: ${compose_cmd[*]} exec -T -u zulip $SERVICE /home/zulip/deployments/current/manage.py backup --output=$container_file"
        log "[드라이런] 복사: ${compose_cmd[*]} cp $SERVICE:$container_file $target_file"
        copy_notes || notes_missing=1
        prune_old
        finish_log "[드라이런] 점검 완료, "
        return
    fi

    # 2) 컨테이너 안에서 공식 백업 생성
    log "manage.py backup 실행 중..."
    container_file_created=1
    run_compose exec -T -u zulip "$SERVICE" \
        /home/zulip/deployments/current/manage.py backup "--output=$container_file" \
        || { fail "Zulip 백업 명령이 실패했습니다(종료 코드 $?)."; return; }

    # 3) 호스트로 복사
    mkdir -p "$target_dir"
    run_compose cp "$SERVICE:$container_file" "$target_file" \
        || { fail "백업 파일을 컨테이너에서 꺼내지 못했습니다(종료 코드 $?)."; return; }
    [[ -f "$target_file" ]] || { fail "복사된 백업 파일이 없습니다: $target_file"; return; }
    local size
    size=$(stat -c %s "$target_file")
    (( size > 0 )) || { fail "백업 파일 크기가 0입니다: $target_file"; return; }

    # 4) 내용 목록만 검사(압축이 깨지지 않았는지, DB 덤프가 들어 있는지). 파일 내용은 읽지 않는다.
    local entries
    entries=$(tar -tzf "$target_file" 2>/dev/null) || { fail "백업 파일이 손상되었습니다(tar 목록 읽기 실패)."; return; }
    grep -q '^zulip-backup/database/' <<<"$entries" \
        || { fail "백업 파일에 데이터베이스 덤프(zulip-backup/database)가 없습니다."; return; }
    log "백업 파일 저장: $target_file ($size 바이트, $(awk -v s="$size" 'BEGIN{printf "%.1f", s/1048576}') MB)"

    # 4-1) 상상톡 쪽지 인덱스 사본. 없거나 실패하면 경고만 남기고 계속한다(마지막 줄에 표시).
    copy_notes || notes_missing=1

    # 5) 오래된 백업 정리
    prune_old
    finish_log
}

main
