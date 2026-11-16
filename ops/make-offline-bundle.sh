#!/usr/bin/env bash
# 상상톡 폐쇄망 반입 패키지 만들기 (인터넷이 되는 PC/서버에서 실행).
#
# 만드는 것: <출력폴더>/sangsangtalk-offline-<커밋 12자리>/
#   source-<커밋>.tar.gz   지정한 커밋의 소스(git archive. 미커밋 변경은 들어가지 않고, .gitattributes 의
#                          export-ignore 항목(.claude/ 등)은 빠진다 — 그 설정이 커밋된 이후의 커밋으로 만들 것)
#   images/*.tar           컨테이너 이미지 5개(docker save, 태그 유지)
#   images.txt             (참고용) 이미지별 태그, 레지스트리 digest, 이미지 ID, 플랫폼, 저장소 방식
#   MANIFEST.txt           커밋, 만든 시각, 도구 버전
#   SHA256SUMS             위 모든 파일의 SHA-256 ← 반입 검증의 기준
#
# 사용법:
#   ops/make-offline-bundle.sh <커밋> [--out DIR] [--platform linux/amd64] [--dry-run]
#     <커밋>        커밋 해시(또는 태그·브랜치 — 전체 해시로 바꿔 기록한다)
#     --out DIR     출력 위치 (기본 ~/sangsangtalk-offline, 저장소 밖을 권장)
#     --platform P  이미지 플랫폼 (기본 linux/amd64, 운영 서버 아키텍처에 맞춘다)
#     --dry-run     커밋·내용 검사·도구만 확인하고 할 일을 출력한다(pull·save·파일 생성 없음)
#
# 반입 후(폐쇄망 서버):
#   cd sangsangtalk-offline-<커밋>
#   sha256sum -c SHA256SUMS                       # 검증 기준. 하나라도 FAILED면 쓰지 않는다
#   for f in images/*.tar; do docker load -i "$f"; done
#   tar -xzf source-<커밋>.tar.gz -C /opt/sangsangtalk --strip-components=1   # 맨 위 sangsangtalk-<커밋>/ 폴더를 벗긴다
#   images.txt 의 이미지 ID·digest는 참고용이다. Docker 이미지 저장소 방식에 따라 load 뒤 값이 달라진다:
#     - containerd 저장소(Docker Desktop·Docker 29 이후 새 설치 기본): 이미지 ID = 레지스트리 digest(인덱스/매니페스트),
#       load 뒤에도 RepoDigests가 남는다.
#     - 기존 overlay2(graphdriver) 저장소: 이미지 ID = 설정(config) digest, load 뒤 RepoDigests가 비어 있다.
#     만든 쪽과 반입 쪽의 방식이 다르면 ID가 달라 보이는 것이 정상이다. `docker info -f '{{.DriverStatus}}'`로 방식을 본다.
set -euo pipefail

IMAGES=(
    "ghcr.io/zulip/zulip-server:12.3-0"
    "zulip/zulip-postgresql:14"
    "memcached:alpine"
    "rabbitmq:4.2"
    "redis:alpine"
)

usage() { sed -n '/^# 사용법:/,/^# 반입 후/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

COMMIT=""
OUT_DIR="${HOME:-.}/sangsangtalk-offline"   # 저장소 밖(실수로 커밋되지 않게)
PLATFORM="linux/amd64"
DRY_RUN=0
need_arg() { [[ $# -ge 2 && -n "$2" ]] || { echo "옵션 $1 에 값이 필요합니다." >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) need_arg "$@"; OUT_DIR="$2"; shift 2 ;;
        --platform) need_arg "$@"; PLATFORM="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) echo "알 수 없는 옵션: $1 (--help 참고)" >&2; exit 2 ;;
        *) [[ -z "$COMMIT" ]] || { echo "커밋은 하나만 지정합니다." >&2; exit 2; }; COMMIT="$1"; shift ;;
    esac
done
[[ -n "$COMMIT" ]] || { usage >&2; exit 2; }

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
die() { echo "오류: $*" >&2; exit 1; }
run() {   # 드라이런이면 명령만 출력
    if (( DRY_RUN )); then printf '[드라이런]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

# 실패하면 이번에 만든 부분 패키지를 지운다(완성되지 않은 패키지가 반입되지 않게).
bundle=""
bundle_created=0
completed=0
cleanup() {
    local rc=$?
    if (( bundle_created && ! completed )) && [[ -n "$bundle" && -d "$bundle" ]]; then
        echo "오류로 중단되어 부분 패키지를 지운다: $bundle" >&2
        rm -rf -- "$bundle"
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v git >/dev/null || die "git 이 없습니다."
command -v docker >/dev/null || die "docker 가 없습니다."
repo_dir="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || die "git 저장소 안에서 실행하세요."
if command -v sha256sum >/dev/null; then SHA=(sha256sum)
elif command -v shasum >/dev/null; then SHA=(shasum -a 256)
else die "sha256sum 또는 shasum 이 없습니다."; fi

full=$(git -C "$repo_dir" rev-parse --verify --quiet "${COMMIT}^{commit}") || die "커밋을 찾을 수 없습니다: $COMMIT"
short=${full:0:12}
bundle="$OUT_DIR/sangsangtalk-offline-$short"
log "커밋: $full ($(git -C "$repo_dir" log -1 --format='%cs %s' "$full"))"
log "출력: $bundle  플랫폼: $PLATFORM"
if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
    log "참고: 작업 폴더에 커밋되지 않은 변경이 있다. 패키지에는 커밋 $short 의 내용만 들어간다."
fi

# 비밀값·로컬 데이터가 커밋에 들어 있으면 중단(커밋 전체 트리, 모든 경로)
#   .env / .env.* (.env.example 제외), *.pem, *.key, *.pfx, *.p12, .credentials/ 아래, web/data/ 아래
forbidden=$(git -C "$repo_dir" ls-tree -r --name-only "$full" | grep -E \
    -e '(^|/)\.env(\.[^/]*)?$' \
    -e '\.(pem|key|pfx|p12)$' \
    -e '(^|/)\.credentials/' \
    -e '^web/data/' \
    | grep -Ev '(^|/)\.env\.example$' || true)
if [[ -n "$forbidden" ]]; then
    echo "커밋 $short 에 반출하면 안 되는 파일이 있다:" >&2
    sed 's/^/  /' <<<"$forbidden" >&2
    die "비밀값·로컬 데이터가 반출될 수 있으므로 중단한다."
fi
log "내용 검사: 비밀값·로컬 데이터 파일 없음"
if ! git -C "$repo_dir" cat-file -e "$full:.gitattributes" 2>/dev/null \
    || ! git -C "$repo_dir" show "$full:.gitattributes" | grep -q 'export-ignore'; then
    log "참고: 커밋 $short 의 .gitattributes 에 export-ignore 가 없다. .claude/ 등이 소스 압축에 들어간다."
fi

# docker save --platform: containerd 이미지 저장소에서만 의미가 있고, 지원하는 Docker에서만 쓴다.
save_platform=()
store="overlay2(graphdriver)"
if docker info -f '{{range .DriverStatus}}{{index . 1}};{{end}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
    store="containerd"
    if docker save --help 2>/dev/null | grep -q -- '--platform'; then
        save_platform=(--platform "$PLATFORM")
    fi
fi
log "이미지 저장소: $store${save_platform[*]:+, docker save ${save_platform[*]}}"

if ! (( DRY_RUN )) && [[ -e "$bundle" ]]; then
    die "출력 폴더가 이미 있다: $bundle (지우거나 --out 을 바꾼다)"
fi
run mkdir -p "$bundle/images"
(( DRY_RUN )) || bundle_created=1

# 1) 소스
src="source-$full.tar.gz"
log "소스 압축: $src"
# 저장소 원본(LF) 그대로. Windows의 core.autocrlf/core.eol 때문에 .sh·설정 파일이 CRLF로 바뀌지 않게 한다.
run git -C "$repo_dir" -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz --prefix="sangsangtalk-$short/" -o "$bundle/$src" "$full"

# 2) 이미지: pull → (참고) digest·ID 기록 → save
if ! (( DRY_RUN )); then
    {
        echo "# 참고용. 반입 검증은 SHA256SUMS로 한다. 이미지 ID는 이미지 저장소 방식에 따라 다르다(이 파일을 만든 쪽: $store)."
        printf '# tag\trepo_digest\timage_id\tplatform\tfile\n'
    } >"$bundle/images.txt"
fi
for image in "${IMAGES[@]}"; do
    file="images/$(tr '/:' '__' <<<"$image").tar"
    log "이미지: $image -> $file"
    run docker pull --platform "$PLATFORM" "$image"
    if (( DRY_RUN )); then
        # 로컬에 이미 있으면 현재 digest를 참고로 보여 준다(네트워크 접속 없음)
        local_digest=$(docker image inspect --format '{{join .RepoDigests ","}}' "$image" 2>/dev/null || true)
        log "  (로컬 참고) ${local_digest:-로컬에 없음}"
        run docker save ${save_platform[@]+"${save_platform[@]}"} -o "$bundle/$file" "$image"
        continue
    fi
    repo="${image%:*}"
    digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -m1 "^$repo@" || true)
    [[ -n "$digest" ]] || die "$image 의 레지스트리 digest를 얻지 못했다."
    image_id=$(docker image inspect --format '{{.Id}}' "$image")
    actual_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
    [[ "$actual_platform" == "$PLATFORM" ]] || die "$image 의 플랫폼이 $actual_platform 이다(요청 $PLATFORM)."
    printf '%s\t%s\t%s\t%s\t%s\n' "$image" "$digest" "$image_id" "$actual_platform" "$file" >>"$bundle/images.txt"
    docker save ${save_platform[@]+"${save_platform[@]}"} -o "$bundle/$file" "$image"
    log "  digest $digest"
done

# 3) MANIFEST, SHA256SUMS
if (( DRY_RUN )); then
    log "[드라이런] MANIFEST.txt, SHA256SUMS 생성 예정"
    log "[드라이런] 점검 완료: 실제로 만든 파일 없음"
    exit 0
fi
{
    echo "상상톡 폐쇄망 반입 패키지"
    echo "commit: $full"
    echo "commit_date: $(git -C "$repo_dir" log -1 --format=%cI "$full")"
    echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "platform: $PLATFORM"
    echo "image_store: $store"
    echo "git: $(git --version)"
    echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
    echo "source: $src (풀 때 --strip-components=1)"
    echo "images: images.txt (참고용)"
    echo "verify: sha256sum -c SHA256SUMS"
} >"$bundle/MANIFEST.txt"
(
    cd "$bundle"
    find . -type f ! -name SHA256SUMS -print | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r f; do
        "${SHA[@]}" -- "$f"
    done >SHA256SUMS
)
completed=1
log "완료: $bundle"
log "크기: $(du -sh "$bundle" | cut -f1)"
log "검증: (cd '$bundle' && sha256sum -c SHA256SUMS)"
