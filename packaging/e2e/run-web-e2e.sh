#!/bin/sh
# Run the browser test of the web app: the real backend with the pure-Rust `fixture-agy` stand-in, and Chromium.
#
# Usage: packaging/e2e/run-web-e2e.sh [screenshot-dir]
# With NEO_E2E_PACKAGE=<unpacked package folder>, the packaged program is tested instead, with the web app it bundles.
# Needs: cargo build -p neo-agent -p neo-testkit, flutter build web (see docs),
#        and the `playwright` package where node finds it (NODE_PATH) with its Chromium installed.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
shots=${1:-$root/.artifacts/web-e2e}
shift 2>/dev/null || true
work=$(mktemp -d)
cleanup() {
  [ -n "${agent:-}" ] && kill "$agent" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
mkdir -p "$work/home"

cat > "$work/settings.json" <<JSON
{"kernel": "antigravity", "models": {"antigravity": {"eval": {"provider": "antigravity", "model": "gemini-3.8-flash-low"}, "executor": {"provider": "antigravity", "model": "gemini-3.8-flash-low"}}}}
JSON
if [ -n "${NEO_E2E_PACKAGE:-}" ]; then
  program=$NEO_E2E_PACKAGE/neo-agent
  set --
else
  program=$root/backend/target/debug/neo-agent
  set -- --web-dir "$root/app/build/web"
fi
unset NEO_TOKEN NEO_DATA_DIR
export NEO_AGY_BIN="${NEO_AGY_BIN:-$root/backend/target/debug/fixture-agy}"
HOME="$work/home" NEO_RUNTIME_DIR="$work/run" \
  "$program" serve --port 0 --data-dir "$work/data" --init-settings "$work/settings.json" "$@" \
  > "$work/agent.out" 2> "$work/agent.log" &
agent=$!
for _ in $(seq 100); do [ -s "$work/agent.out" ] && break; sleep 0.1; done
port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$work/agent.out")
[ -n "$port" ] || { cat "$work/agent.log"; exit 1; }

node "$root/packaging/e2e/web-e2e.mjs" "http://127.0.0.1:$port" "$shots" || { mkdir -p "$shots"; cp "$work/agent.log" "$shots/backend.log"; echo "the backend's log is in $shots/backend.log"; exit 1; }
