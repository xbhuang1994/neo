#!/usr/bin/env bash
# Build macOS Tier 1 OS agent (neo-agent-os) release tarball:
#   - dist/neo-agent-os-<version>-macos-arm64.tar.gz
#   - dist/neo-agent-os-<version>-macos-x64.tar.gz
#
# Usage: packaging/macos/build-agent-os.sh --arch arm64|x64 [--version X.Y.Z]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
arch="$(uname -m)"
version=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      arch="${2:?--arch needs arm64 or x64}"
      shift 2
      ;;
    --version)
      version="${2:?--version needs a value}"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

case "$arch" in
  arm64 | aarch64)
    arch="arm64"
    rust_target="aarch64-apple-darwin"
    macho_arch="arm64"
    ;;
  x64 | x86_64)
    arch="x64"
    rust_target="x86_64-apple-darwin"
    macho_arch="x86_64"
    ;;
  *)
    echo "unsupported architecture: $arch (expected arm64 or x64)" >&2
    exit 2
    ;;
esac

if [[ -z "$version" ]]; then
  version="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/backend/package.json" | head -n 1)"
fi
if [[ -z "$version" ]]; then
  echo "could not determine version from backend/package.json" >&2
  exit 1
fi

mkdir -p "$root/dist"
name="neo-agent-os-$version-macos-$arch"
stage="$root/dist/$name"
bin_path="$root/agents/neo-agent-os/target/$rust_target/release/neo-agent-os"

rm -rf "$stage"
mkdir -p "$stage/deploy"

(
  cd "$root/agents/neo-agent-os"
  cargo build --release --target "$rust_target"
)

cp "$bin_path" "$stage/neo-agent-os"
chmod 755 "$stage/neo-agent-os"

if command -v lipo >/dev/null 2>&1; then
  actual_archs="$(lipo -archs "$stage/neo-agent-os")"
  case " $actual_archs " in
    *" $macho_arch "*) ;;
    *)
      echo "unexpected Mach-O architecture for neo-agent-os: $actual_archs (expected $macho_arch)" >&2
      exit 1
      ;;
  esac
fi

cp -R "$root/deploy/multi-master/"* "$stage/deploy/"
cp "$root/LICENSE" "$stage/"

tarball="$root/dist/$name.tar.gz"
rm -f "$tarball"
tar -C "$root/dist" -czf "$tarball" "$name"
rm -rf "$stage"

echo "$tarball"
