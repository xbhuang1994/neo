#!/bin/sh
# Build the Linux server package: the pure-TypeScript backend (neo-agent), independent recovery daemon
# (neo-recovery), and the web app, as one tarball that runs from wherever it is unpacked.
# The Antigravity CLI is not in it: the backend finds it on the machine, and the app installs it with its official
# installer.
#
# Usage: packaging/linux/build-server.sh [--arch x64|arm64] [--skip-web-build]
# Needs: bun, flutter (unless --skip-web-build with app/build/web already present).
# Output: dist/neo-agent-<version>-linux-<arch>.tar.gz
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
arch=x64
skip_web=no
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch=${2:?--arch needs x64 or arm64}; shift ;;
    --skip-web-build) skip_web=yes ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$arch" in
  x64 | x86_64) arch=x64; target=bun-linux-x64; elf_pattern="x86-64" ;;
  arm64 | aarch64) arch=arm64; target=bun-linux-arm64; elf_pattern="ARM aarch64" ;;
  *) echo "unsupported architecture $arch" >&2; exit 2 ;;
esac
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/backend/package.json" | head -1)
[ -n "$version" ] || { echo "could not read version from backend/package.json" >&2; exit 1; }
name=neo-agent-$version-linux-$arch
stage=$root/dist/$name
rm -rf "$stage" && mkdir -p "$stage"

(cd "$root/backend" && bun install --frozen-lockfile && bun build --compile --minify --bytecode --target="$target" src/main.ts --outfile "dist/neo-agent-$arch")
(cd "$root/recovery" && bun install --frozen-lockfile && bun build --compile --minify --bytecode --target="$target" src/main.ts --outfile "dist/neo-recovery-$arch")
if [ "$skip_web" = no ]; then
  (cd "$root/app" && flutter pub get && flutter build web --wasm --release --no-web-resources-cdn --csp --no-source-maps)
fi
[ -f "$root/app/build/web/index.html" ] || { echo "web app not built at $root/app/build/web/index.html" >&2; exit 1; }

cp "$root/backend/dist/neo-agent-$arch" "$stage/neo-agent"
cp "$root/recovery/dist/neo-recovery-$arch" "$stage/neo-recovery"
chmod 755 "$stage/neo-agent" "$stage/neo-recovery"
cp -R "$root/app/build/web" "$stage/web"
cp \
  "$root/LICENSE" \
  "$root/packaging/linux/neo-agent.service" \
  "$root/packaging/linux/neo-agent-user.service" \
  "$root/packaging/linux/neo-recovery-user.service" \
  "$stage/"

# Verify ELF architecture of compiled binaries when `file` is available.
if command -v file >/dev/null 2>&1; then
  for bin in "$stage/neo-agent" "$stage/neo-recovery"; do
    info=$(file "$bin")
    case "$info" in
      *"$elf_pattern"*) ;;
      *) echo "unexpected ELF architecture for $bin: $info" >&2; exit 1 ;;
    esac
  done
fi

tarball="$root/dist/$name.tar.gz"
rm -f "$tarball"
tar -C "$root/dist" -czf "$tarball" "$name"

# Smoke-test unpacked archive on matching host architecture.
host_arch=$(uname -m)
native_match=no
case "$host_arch:$arch" in
  x86_64:x64 | aarch64:arm64 | arm64:arm64) native_match=yes ;;
esac

if [ "$native_match" = yes ]; then
  smoke=$(mktemp -d)
  cleanup_smoke() {
    [ -n "${smoke_pid:-}" ] && kill "$smoke_pid" 2>/dev/null || true
    wait "${smoke_pid:-}" 2>/dev/null || true
    rm -rf "$smoke"
  }
  trap cleanup_smoke EXIT INT TERM

  tar -xzf "$tarball" -C "$smoke"
  unpacked="$smoke/$name"
  reported=$("$unpacked/neo-agent" version)
  case "$reported" in
    *"$version"*) ;;
    *) echo "unpacked neo-agent reported '$reported', expected '$version'" >&2; exit 1 ;;
  esac
  "$unpacked/neo-recovery" version >/dev/null

  # Verify packaged binary auto-discovers its sibling web/ directory and serves /api/health + /.
  env -u NEO_TOKEN -u NEO_DATA_DIR HOME="$smoke/home" NEO_RUNTIME_DIR="$smoke/run" \
    "$unpacked/neo-agent" serve --port 0 --allow-multiple --data-dir "$smoke/data" \
    >"$smoke/out.json" 2>"$smoke/err.log" &
  smoke_pid=$!
  i=0
  while [ "$i" -lt 50 ]; do
    [ -s "$smoke/out.json" ] && break
    sleep 0.1
    i=$((i + 1))
  done
  smoke_port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$smoke/out.json")
  if [ -z "$smoke_port" ]; then
    cat "$smoke/err.log" >&2
    exit 1
  fi
  bun -e '
    const port = process.argv[1];
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (health.status !== 200) throw new Error(`health status ${health.status}`);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    if (page.status !== 200) throw new Error(`web root status ${page.status}`);
    const html = await page.text();
    if (!html.includes("flutter_bootstrap.js")) throw new Error("web index missing flutter_bootstrap.js");
  ' "$smoke_port"
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  smoke_pid=""
  rm -rf "$smoke"
  trap - EXIT INT TERM
fi

echo "$tarball"
