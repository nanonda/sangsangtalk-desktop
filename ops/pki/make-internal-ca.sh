#!/usr/bin/env bash
# 상상톡 내부 CA와 서버 인증서 만들기(openssl). 기관 인증서(GPKI 등)를 쓸 수 없을 때의 2순위 방법이다.
# 절차·배포 위치는 ops/pki/README.md.
#
# 사용법:
#   ops/pki/make-internal-ca.sh [--out DIR] [--org 이름] [--web 이름[,이름…]] [--zulip 이름[,…]] [--db 이름[,…]] [--renew]
#     --out DIR      출력 폴더(기본 ~/sangsangtalk-pki). git 저장소 안이면 거부한다.
#     --org 이름     인증서 O(조직) 값(기본 "Eumseong-gun SangsangTalk")
#     --web 이름     웹 서버(nginx) 인증서 SAN. 예 talk.eumseong.local
#     --zulip 이름   Zulip(②) 인증서 SAN. 예 zulip.eumseong.local
#     --db 이름      PostgreSQL 인증서 SAN. 2대 구성은 compose 서비스 이름 database,
#                    3계층은 앱 서버가 접속하는 ZULIP_DB_HOST 값(DNS 이름 또는 IP)
#     --renew        이미 있는 서버 인증서를 새로 발급한다(기존 파일은 <이름>.<시각>.bak 으로 남김)
#   이름은 쉼표로 여러 개. IP 주소는 IP SAN으로, 나머지는 DNS SAN으로 넣는다. 첫 이름이 CN이 된다.
#   --web/--zulip/--db 중 최소 하나. 루트 CA가 없으면 처음에 만들고, 있으면 그대로 쓴다.
#
# 출력(DIR):
#   ca/ca.crt                    루트 인증서(공개) → 직원 PC 배포, 웹 서버 ZULIP_CA_FILE, Zulip의 DB CA
#   ca/ca.key                    루트 키(0600) → 발급 후 서버에서 치워 오프라인 보관
#   web/server.crt, server.key   nginx ssl_certificate / ssl_certificate_key
#   zulip/zulip.combined-chain.crt, zulip.key   zulip 볼륨 /data/certs/manual/ 에 그대로
#   db/server.crt, server.key    ZULIP_DB_TLS_DIR 에 그대로
# 유효기간: 루트 10년(3650일), 서버 825일. 키: RSA 3072. 키 파일은 모두 0600.
set -euo pipefail

usage() { sed -n '/^# 사용법:/,/^# 출력(DIR):/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

OUT="${HOME:-.}/sangsangtalk-pki"
ORG="Eumseong-gun SangsangTalk"
WEB="" ZULIP="" DB=""
RENEW=0
CA_DAYS=3650
LEAF_DAYS=825
KEY_BITS=3072

need_arg() { [[ $# -ge 2 && -n "$2" ]] || { echo "옵션 $1 에 값이 필요합니다." >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) need_arg "$@"; OUT="$2"; shift 2 ;;
        --org) need_arg "$@"; ORG="$2"; shift 2 ;;
        --web) need_arg "$@"; WEB="$2"; shift 2 ;;
        --zulip) need_arg "$@"; ZULIP="$2"; shift 2 ;;
        --db) need_arg "$@"; DB="$2"; shift 2 ;;
        --renew) RENEW=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "알 수 없는 인자: $1 (--help 참고)" >&2; exit 2 ;;
    esac
done
[[ -n "$WEB$ZULIP$DB" ]] || { usage >&2; exit 2; }

die() { echo "오류: $*" >&2; exit 1; }
log() { echo "$*"; }
command -v openssl >/dev/null || die "openssl 이 없습니다."
# 주체(DN)는 -subj 대신 설정 파일로 준다(Git Bash의 경로 변환이 /CN=… 을 망가뜨리지 않게).
umask 077

# 저장소 안에 키·인증서가 생기지 않게 한다.
probe="$OUT"
while [[ ! -d "$probe" ]]; do probe="$(dirname -- "$probe")"; done   # 아직 없는 경로면 있는 상위 폴더로 검사
if command -v git >/dev/null && git -C "$probe" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "출력 폴더가 git 저장소 안에 있다: $OUT (저장소 밖 경로를 --out 으로 지정)"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
chmod 700 "$OUT"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# 이름 검사: DNS 이름(영숫자·하이픈·점) 또는 IPv4/IPv6
is_ip() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$1" =~ ^[0-9A-Fa-f:]+:[0-9A-Fa-f:.]*$ ]]; }
san_line() {   # "a,b,10.0.0.1" → "DNS:a,DNS:b,IP:10.0.0.1"
    local list="$1" out="" n
    IFS=',' read -r -a names <<<"$list"
    for n in "${names[@]}"; do
        n="${n#"${n%%[![:space:]]*}"}"; n="${n%"${n##*[![:space:]]}"}"   # 앞뒤 공백만 제거
        [[ -n "$n" ]] || continue
        if is_ip "$n"; then out+="${out:+,}IP:$n"
        elif [[ "$n" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]]; then out+="${out:+,}DNS:$n"
        else die "잘못된 이름: '$n'"; fi
    done
    [[ -n "$out" ]] || die "이름이 비어 있다: '$list'"
    printf '%s' "$out"
}

# 1) 루트 CA
ca_dir="$OUT/ca"
mkdir -p "$ca_dir"
if [[ -f "$ca_dir/ca.crt" && -f "$ca_dir/ca.key" ]]; then
    log "루트 CA 재사용: $ca_dir/ca.crt"
elif [[ -e "$ca_dir/ca.crt" || -e "$ca_dir/ca.key" ]]; then
    die "$ca_dir 에 ca.crt/ca.key 중 하나만 있다. 확인 후 정리하세요."
else
    cat >"$tmp/ca.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca
[dn]
O = $ORG
CN = $ORG Internal Root CA
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
    openssl genpkey -algorithm RSA -pkeyopt "rsa_keygen_bits:$KEY_BITS" -out "$ca_dir/ca.key" 2>/dev/null
    chmod 600 "$ca_dir/ca.key"
    openssl req -new -x509 -sha256 -days "$CA_DAYS" -config "$tmp/ca.cnf" \
        -key "$ca_dir/ca.key" -out "$ca_dir/ca.crt"
    chmod 644 "$ca_dir/ca.crt"
    log "루트 CA 생성: $ca_dir/ca.crt ($CA_DAYS일)"
fi

# 2) 서버 인증서: issue <폴더> <인증서 파일명> <키 파일명> <이름 목록>
issue() {
    local kind="$1" crt_name="$2" key_name="$3" names="$4"
    local dir="$OUT/$kind" san cn stamp
    san="$(san_line "$names")"
    cn="${san%%,*}"; cn="${cn#*:}"
    mkdir -p "$dir"
    if [[ -e "$dir/$crt_name" || -e "$dir/$key_name" ]]; then
        (( RENEW )) || { log "건너뜀($kind): 이미 있음. 새로 발급하려면 --renew"; return 0; }
        stamp="$(date +%Y%m%d%H%M%S)"
        [[ -e "$dir/$crt_name" ]] && mv -- "$dir/$crt_name" "$dir/$crt_name.$stamp.bak"
        [[ -e "$dir/$key_name" ]] && mv -- "$dir/$key_name" "$dir/$key_name.$stamp.bak"
    fi
    cat >"$tmp/$kind.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
[dn]
O = $ORG
CN = $cn
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $san
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
EOF
    openssl genpkey -algorithm RSA -pkeyopt "rsa_keygen_bits:$KEY_BITS" -out "$dir/$key_name" 2>/dev/null
    chmod 600 "$dir/$key_name"
    openssl req -new -sha256 -config "$tmp/$kind.cnf" -key "$dir/$key_name" -out "$tmp/$kind.csr"
    openssl x509 -req -sha256 -days "$LEAF_DAYS" -in "$tmp/$kind.csr" \
        -CA "$ca_dir/ca.crt" -CAkey "$ca_dir/ca.key" -CAcreateserial -CAserial "$ca_dir/ca.srl" \
        -extfile "$tmp/$kind.cnf" -extensions v3_leaf -out "$dir/$crt_name" 2>/dev/null
    chmod 644 "$dir/$crt_name"
    openssl verify -CAfile "$ca_dir/ca.crt" -purpose sslserver "$dir/$crt_name" >/dev/null \
        || die "$kind 인증서 검증 실패"
    log "발급($kind): $dir/$crt_name  SAN=$san  만료=$(openssl x509 -in "$dir/$crt_name" -noout -enddate | cut -d= -f2)"
}

[[ -z "$WEB" ]]   || issue web   server.crt               server.key "$WEB"
# Zulip은 중간 인증서가 없으므로 서버 인증서 하나가 곧 combined-chain 이다.
[[ -z "$ZULIP" ]] || issue zulip zulip.combined-chain.crt zulip.key  "$ZULIP"
[[ -z "$DB" ]]    || issue db    server.crt               server.key "$DB"

log "완료: $OUT"
log "주의: ca/ca.key 는 발급이 끝나면 서버에서 지우고 오프라인 매체에 보관한다."
