#!/bin/sh
set -eu

RELAY_URL="{{PUBLIC_URL}}"
GITHUB_REPO="xbhuang1994/neo"
ENROLL_CODE=""
VER=""
MODE="auto"
UPGRADE=0
UNINSTALL=0
CLUSTER=""
PURGE_WORKSPACE=0
GITHUB_ONLY=0

die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

usage() {
	cat <<'EOF'
Usage: install.sh [options]
  --enroll <code|->               Enrollment code (or '-' to read from stdin)
  --relay-url <url>               Relay base URL
  --version <ver>                 Pin neo-agent-os version (e.g. 0.9.0)
  --mode <auto|system|user|foreground>
  --upgrade                       Upgrade neo-agent-os binary in place and restart service
  --uninstall                     Uninstall neo-agent-os
  --cluster <id>                  Target cluster ID (used with --upgrade / --uninstall)
  --purge-workspace               Purge workspace data (used with --uninstall)
  --github-only                   Skip relay /dl mirror and download from GitHub
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--enroll)         [ $# -ge 2 ] || die "--enroll requires an argument"; ENROLL_CODE="$2"; shift 2 ;;
	--enroll=*)       ENROLL_CODE="${1#*=}"; shift ;;
	--relay-url)      [ $# -ge 2 ] || die "--relay-url requires an argument"; RELAY_URL="$2"; shift 2 ;;
	--relay-url=*)    RELAY_URL="${1#*=}"; shift ;;
	--version)        [ $# -ge 2 ] || die "--version requires an argument"; VER="$2"; shift 2 ;;
	--version=*)      VER="${1#*=}"; shift ;;
	--mode)           [ $# -ge 2 ] || die "--mode requires an argument"; MODE="$2"; shift 2 ;;
	--mode=*)         MODE="${1#*=}"; shift ;;
	--upgrade)        UPGRADE=1; shift ;;
	--uninstall)      UNINSTALL=1; shift ;;
	--cluster)        [ $# -ge 2 ] || die "--cluster requires an argument"; CLUSTER="$2"; shift 2 ;;
	--cluster=*)      CLUSTER="${1#*=}"; shift ;;
	--purge-workspace) PURGE_WORKSPACE=1; shift ;;
	--github-only)    GITHUB_ONLY=1; shift ;;
	-h|--help)        usage; exit 0 ;;
	*)                die "unknown argument: $1" ;;
	esac
done

RELAY_URL="${RELAY_URL%/}"

find_existing_bin() {
	if [ "$(id -u)" -eq 0 ]; then
		for p in /usr/local/bin/neo-agent-os "${HOME:-}/.local/bin/neo-agent-os"; do
			[ -x "$p" ] && { printf '%s\n' "$p"; return 0; }
		done
	else
		for p in "${HOME:-}/.local/bin/neo-agent-os" /usr/local/bin/neo-agent-os; do
			[ -x "$p" ] && { printf '%s\n' "$p"; return 0; }
		done
	fi
	command -v neo-agent-os 2>/dev/null || return 1
}

if [ "$UNINSTALL" -eq 1 ]; then
	BIN="$(find_existing_bin)" || die "neo-agent-os binary not found"
	set -- uninstall
	[ -n "$CLUSTER" ] && set -- "$@" --cluster "$CLUSTER"
	[ "$PURGE_WORKSPACE" -eq 1 ] && set -- "$@" --purge-workspace
	exec "$BIN" "$@"
fi

case "$MODE" in
auto|system|user|foreground) ;;
*) die "invalid --mode: $MODE" ;;
esac

if [ "$UPGRADE" -ne 1 ]; then
	[ "$ENROLL_CODE" = "-" ] && { IFS= read -r ENROLL_CODE || true; }
	[ -n "$ENROLL_CODE" ] || die "missing --enroll <code|-> (or pass --upgrade)"
fi
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

case "$(uname -s)" in
Linux)  OS_TAG="linux" ;;
Darwin) OS_TAG="macos" ;;
*)      die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
x86_64|amd64)  ARCH_TAG="x64" ;;
aarch64|arm64) ARCH_TAG="arm64" ;;
*)             die "unsupported architecture: $(uname -m)" ;;
esac

if [ -z "$VER" ]; then
	if [ "$GITHUB_ONLY" -eq 0 ] && [ -n "$RELAY_URL" ]; then
		LATEST_JSON="$(curl -fsSL --connect-timeout 10 --max-time 20 "$RELAY_URL/dl/latest.json" 2>/dev/null || true)"
		VER="$(printf '%s\n' "$LATEST_JSON" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	fi
	if [ -z "$VER" ]; then
		GH_JSON="$(curl -fsSL --connect-timeout 10 --max-time 20 "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || true)"
		VER="$(printf '%s\n' "$GH_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	fi
fi
VER="${VER#v}"
[ -n "$VER" ] || die "failed to determine neo-agent-os version (pass --version <ver>)"

ASSET="neo-agent-os-${VER}-${OS_TAG}-${ARCH_TAG}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

download_asset() {
	if [ "$GITHUB_ONLY" -eq 0 ] && [ -n "$RELAY_URL" ]; then
		if curl -fsSL --connect-timeout 15 --max-time 180 "$RELAY_URL/dl/v$VER/$1" -o "$2" 2>/dev/null; then
			return 0
		fi
		printf 'WARN: relay mirror unavailable for %s, falling back to GitHub...\n' "$1" >&2
	fi
	curl -fsSL --connect-timeout 15 --max-time 300 "https://github.com/$GITHUB_REPO/releases/download/v$VER/$1" -o "$2" \
		|| die "failed to download $1"
}

printf 'Downloading %s (v%s)...\n' "$ASSET" "$VER" >&2
download_asset "$ASSET" "$TMP_DIR/$ASSET"
download_asset "SHA256SUMS.txt" "$TMP_DIR/SHA256SUMS.txt"

EXPECTED="$(tr -d '\r' < "$TMP_DIR/SHA256SUMS.txt" | awk -v f="$ASSET" '{ sub(/^(\.\/|\*)/, "", $2); if ($2 == f) { print $1; exit } }' | tr 'A-F' 'a-f')"
[ -n "$EXPECTED" ] || die "checksum entry for $ASSET missing from SHA256SUMS.txt"

if command -v sha256sum >/dev/null 2>&1; then
	ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{ print $1 }' | tr 'A-F' 'a-f')"
elif command -v shasum >/dev/null 2>&1; then
	ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{ print $1 }' | tr 'A-F' 'a-f')"
else
	die "neither sha256sum nor shasum found"
fi
[ "$EXPECTED" = "$ACTUAL" ] || die "SHA-256 mismatch for $ASSET (expected $EXPECTED, got $ACTUAL)"

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
EXTRACTED="$TMP_DIR/neo-agent-os"
[ -f "$EXTRACTED" ] || EXTRACTED="$(find "$TMP_DIR" -maxdepth 3 -type f -name neo-agent-os | head -n 1)"
[ -f "$EXTRACTED" ] || die "neo-agent-os binary not found inside $ASSET"

if [ "$(id -u)" -eq 0 ]; then BIN_DIR="/usr/local/bin"; else BIN_DIR="${HOME}/.local/bin"; fi
mkdir -p "$BIN_DIR"
BIN="$BIN_DIR/neo-agent-os"
BIN_TMP="$BIN_DIR/.neo-agent-os.tmp.$$"
cp "$EXTRACTED" "$BIN_TMP" && chmod 755 "$BIN_TMP" && mv -f "$BIN_TMP" "$BIN"

if [ "$UPGRADE" -eq 1 ]; then
	printf 'Upgraded neo-agent-os to v%s at %s\n' "$VER" "$BIN" >&2
	if [ -n "$CLUSTER" ] && [ "$OS_TAG" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
		[ "$(id -u)" -eq 0 ] && systemctl restart "neo-agent-os@${CLUSTER}.service" 2>/dev/null || systemctl --user restart "neo-agent-os-${CLUSTER}.service" 2>/dev/null || true
	elif [ -n "$CLUSTER" ] && [ "$OS_TAG" = "macos" ] && command -v launchctl >/dev/null 2>&1; then
		launchctl kickstart -k "gui/$(id -u)/cn.1inch.neo.agent.${CLUSTER}" 2>/dev/null || true
	fi
	exit 0
fi

printf '%s\n' "$ENROLL_CODE" | "$BIN" enroll --relay-url "$RELAY_URL" --mode "$MODE" --ticket-stdin
