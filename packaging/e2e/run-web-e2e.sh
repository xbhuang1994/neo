#!/bin/sh
# Run the browser test of the web app: a fake model, the real backend with the real `claude` runtime, and Chromium.
#
# Usage: packaging/e2e/run-web-e2e.sh [screenshot-dir]
# With NEO_E2E_PACKAGE=<unpacked package folder>, the packaged program is tested instead, with the web app it bundles.
# Needs: cargo build -p neo-agent -p neo-testkit, flutter build web (see docs), `claude` on PATH or NEO_CLAUDE_BIN,
#        and the `playwright` package where node finds it (NODE_PATH) with its Chromium installed.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
shots=${1:-$root/.artifacts/web-e2e}
shift 2>/dev/null || true
work=$(mktemp -d)
cleanup() {
  [ -n "${agent:-}" ] && kill "$agent" 2>/dev/null || true
  [ -n "${model:-}" ] && kill "$model" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
mkdir -p "$work/home" "$work/config"

"$root/backend/target/debug/fixture-model" anthropic > "$work/model.url" &
model=$!
for _ in $(seq 50); do [ -s "$work/model.url" ] && break; sleep 0.1; done
model_url=$(head -1 "$work/model.url")

cat > "$work/settings.json" <<JSON
{"kernel": "claude", "models": {"claude": {"eval": {"provider": "anthropic", "model": "fixture"}, "executor": {"provider": "anthropic", "model": "fixture"}}}}
JSON
if [ -n "${NEO_E2E_PACKAGE:-}" ]; then
  program=$NEO_E2E_PACKAGE/neo-agent
  set --
else
  program=$root/backend/target/debug/neo-agent
  set -- --web-dir "$root/app/build/web"
fi
export NEO_CLAUDE_BIN="${NEO_CLAUDE_BIN:-$(command -v claude)}"
HOME="$work/home" NEO_RUNTIME_DIR="$work/run" NEO_OMP_BIN="$work/none" \
ANTHROPIC_BASE_URL="$model_url" ANTHROPIC_API_KEY=fixture-key \
CLAUDE_CONFIG_DIR="$work/config" DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$program" serve --port 0 --data-dir "$work/data" --init-settings "$work/settings.json" "$@" \
  > "$work/agent.out" 2> "$work/agent.log" &
agent=$!
for _ in $(seq 100); do [ -s "$work/agent.out" ] && break; sleep 0.1; done
port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$work/agent.out")
[ -n "$port" ] || { cat "$work/agent.log"; exit 1; }

node "$root/packaging/e2e/web-e2e.mjs" "http://127.0.0.1:$port" "$shots" || { mkdir -p "$shots"; cp "$work/agent.log" "$shots/backend.log"; echo "the backend's log is in $shots/backend.log"; exit 1; }
