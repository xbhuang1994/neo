#!/bin/sh
# Build the Linux server package: the backend, the web app, the Oh My Pi extension and, unless --without-runtimes,
# the pinned agent runtimes, as one tarball that runs from wherever it is unpacked.
#
# Usage: packaging/linux/build-server.sh [--without-runtimes] [--arch x64|arm64]
# Needs: cargo, flutter (for the web app), python3.  Output: dist/neo-agent-<version>-linux-<arch>.tar.gz
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
runtimes=yes
arch=x64
while [ $# -gt 0 ]; do
  case "$1" in
    --without-runtimes) runtimes=no ;;
    --arch) arch=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/backend/Cargo.toml" | head -1)
name=neo-agent-$version-linux-$arch
stage=$root/dist/$name
rm -rf "$stage" && mkdir -p "$stage"

(cd "$root/backend" && cargo build --release -p neo-agent)
(cd "$root/app" && flutter build web --release --no-web-resources-cdn --csp --no-source-maps)

cp "$root/backend/target/release/neo-agent" "$stage/neo-agent"
cp -R "$root/app/build/web" "$stage/web"
mkdir -p "$stage/shim" && cp "$root/shim/neo-omp-shim.ts" "$stage/shim/"
cp "$root/LICENSE" "$root/packaging/linux/neo-agent.service" "$root/packaging/linux/neo-agent-user.service" "$stage/"
[ "$runtimes" = yes ] && python3 "$root/packaging/fetch-runtimes.py" "linux-$arch" "$stage/runtimes"

tar -C "$root/dist" -czf "$root/dist/$name.tar.gz" "$name"
echo "$root/dist/$name.tar.gz"
