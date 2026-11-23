#!/bin/sh
# Build the Linux server package: the pure-TypeScript backend (compiled with Bun) and the web app, as one tarball that runs from wherever it is unpacked.
# The Antigravity CLI is not in it: the backend finds it on the machine, and the app installs it with its official
# installer.
#
# Usage: packaging/linux/build-server.sh [--arch x64|arm64]
# Needs: bun, flutter (for the web app).  Output: dist/neo-agent-<version>-linux-<arch>.tar.gz
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
arch=x64
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$arch" in
  x64 | x86_64) arch=x64; target=bun-linux-x64 ;;
  arm64 | aarch64) arch=arm64; target=bun-linux-arm64 ;;
  *) echo "unsupported architecture $arch" >&2; exit 2 ;;
esac
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/backend/package.json" | head -1)
name=neo-agent-$version-linux-$arch
stage=$root/dist/$name
rm -rf "$stage" && mkdir -p "$stage"

(cd "$root/backend" && bun install --frozen-lockfile && bun build --compile --minify --bytecode --target="$target" src/main.ts --outfile dist/neo-agent)
(cd "$root/app" && flutter build web --release --no-web-resources-cdn --csp --no-source-maps)

cp "$root/backend/dist/neo-agent" "$stage/neo-agent"
cp -R "$root/app/build/web" "$stage/web"
cp "$root/LICENSE" "$root/packaging/linux/neo-agent.service" "$root/packaging/linux/neo-agent-user.service" "$stage/"

tar -C "$root/dist" -czf "$root/dist/$name.tar.gz" "$name"
echo "$root/dist/$name.tar.gz"
