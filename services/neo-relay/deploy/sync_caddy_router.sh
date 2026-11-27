#!/usr/bin/env bash
# Idempotently configure neo.1inch.cn:18443 SNI routing in Caddy on root@192.168.6.1.
# Shares WAN-open TCP port 18443 alongside magpie.1inch.cn:18443 and voice.1inch.cn:18443.
set -euo pipefail

ROUTER="${ROUTER:-root@192.168.6.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET_FILE="${1:-$SCRIPT_DIR/../caddy/neo.1inch.cn.caddy}"

if [[ ! -s "$SNIPPET_FILE" ]]; then
  echo "Error: Caddy snippet not found: $SNIPPET_FILE" >&2
  exit 1
fi

SNIPPET_B64="$(base64 -w 0 "$SNIPPET_FILE")"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$ROUTER" "SNIPPET_B64='$SNIPPET_B64' sh -s" <<'REMOTE'
set -eu

CADDYFILE="/etc/caddy/Caddyfile"
DNS_ENV="/etc/caddy/dns.env"
TS="$(date +%s)"
BACKUP="${CADDYFILE}.bak.${TS}"
TMP_SNIPPET="/tmp/neo.1inch.cn.caddy.$$"
TMP_NEW="/tmp/Caddyfile.new.$$"

cleanup() {
  rm -f "$TMP_SNIPPET" "$TMP_NEW"
}
trap cleanup EXIT

if [ ! -f "$CADDYFILE" ]; then
  echo "Error: $CADDYFILE not found on router" >&2
  exit 1
fi
if [ ! -s "$DNS_ENV" ]; then
  echo "Error: $DNS_ENV missing on router" >&2
  exit 1
fi

printf '%s' "$SNIPPET_B64" | base64 -d > "$TMP_SNIPPET"
cp -a "$CADDYFILE" "$BACKUP"

awk '
  /^# BEGIN neo\.1inch\.cn$/ { skip=1; next }
  /^# END neo\.1inch\.cn$/   { skip=0; next }
  !skip { print }
' "$CADDYFILE" > "$TMP_NEW"

printf '\n' >> "$TMP_NEW"
cat "$TMP_SNIPPET" >> "$TMP_NEW"

if ! /usr/bin/caddy validate --config "$TMP_NEW" --adapter caddyfile --envfile "$DNS_ENV"; then
  echo "Validation failed; original Caddyfile untouched (backup: $BACKUP)" >&2
  exit 1
fi

mv "$TMP_NEW" "$CADDYFILE"
chmod 644 "$CADDYFILE"

if /usr/bin/caddy reload --config "$CADDYFILE" --adapter caddyfile --address 127.0.0.1:2019; then
  echo "Caddy reloaded gracefully (backup: $BACKUP)"
else
  echo "Graceful reload failed, falling back to /etc/init.d/magpie-https restart"
  /etc/init.d/magpie-https restart
fi
REMOTE
