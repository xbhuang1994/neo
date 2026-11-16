#!/bin/sh
# Build the Linux server package: the backend, the web app and the Oh My Pi extension, as one tarball that runs from
# wherever it is unpacked. The agent runtimes are not in it: the backend finds them on the machine, and the app
# installs them with their official installers.
#
# Usage: packaging/linux/build-server.sh [--arch x64|arm64]
# Needs: cargo, flutter (for the web app).  Output: dist/neo-agent-<version>-linux-<arch>.tar.gz
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

tar -C "$root/dist" -czf "$root/dist/$name.tar.gz" "$name"
echo "$root/dist/$name.tar.gz"
