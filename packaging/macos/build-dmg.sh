#!/bin/sh
# Build the macOS app with its backend and runtimes inside, and a disk image of it. Builds for this Mac's
# architecture unless --arch names the other one; the Flutter app is universal either way.
#
# Usage: packaging/macos/build-dmg.sh [--arch arm64|x64] [--without-runtimes]
# Needs: Xcode, cargo, flutter, python3.  Output: dist/Neo-Agent-<version>-macos-<arch>.dmg
#
# Signing: with MACOS_SIGN_IDENTITY set (a "Developer ID Application: …" identity in the keychain) the app is signed
# with it and the hardened runtime; otherwise it is signed ad hoc, which Apple silicon needs to run it at all, and
# Gatekeeper will ask the person to allow it (see docs). Notarization, when wanted, is a separate step.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
runtimes=yes
arch=$(uname -m)
while [ $# -gt 0 ]; do
  case "$1" in
    --without-runtimes) runtimes=no ;;
    --arch) arch=${2:?--arch needs arm64 or x64}; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
case "$arch" in
  arm64 | aarch64) arch=arm64; target=aarch64-apple-darwin ;;
  x64 | x86_64) arch=x64; target=x86_64-apple-darwin ;;
  *) echo "unsupported architecture $arch" >&2; exit 1 ;;
esac
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/backend/Cargo.toml" | head -1)

rustup target add "$target" >/dev/null 2>&1 || true
(cd "$root/backend" && cargo build --release -p neo-agent --target "$target")
(cd "$root/app" && flutter build macos --release)

app="$root/app/build/macos/Build/Products/Release/Neo Agent.app"
[ -d "$app" ] || { echo "the app was not built at $app" >&2; exit 1; }
# One architecture per image: the bundled runtimes are for one.
mkdir -p "$app/Contents/Helpers" "$app/Contents/Resources/shim"
cp "$root/backend/target/$target/release/neo-agent" "$app/Contents/Helpers/neo-agent"
cp "$root/shim/neo-omp-shim.ts" "$app/Contents/Resources/shim/"
[ "$runtimes" = yes ] && python3 "$root/packaging/fetch-runtimes.py" "macos-$arch" "$app/Contents/Resources/runtimes"

identity=${MACOS_SIGN_IDENTITY:--}
options=""
[ "$identity" != - ] && options="--options runtime --timestamp"
entitlements="$root/packaging/macos/helper.entitlements"
# Inside out: the programs the app starts, then the app around them.
for program in "$app/Contents/Resources/runtimes/claude" "$app/Contents/Resources/runtimes/omp" "$app/Contents/Helpers/neo-agent"; do
  # shellcheck disable=SC2086
  [ -f "$program" ] && codesign --force --sign "$identity" $options --entitlements "$entitlements" "$program"
done
# shellcheck disable=SC2086
codesign --force --deep --sign "$identity" $options --entitlements "$root/app/macos/Runner/Release.entitlements" "$app"
codesign --verify --deep --strict "$app"

mkdir -p "$root/dist"
dmg="$root/dist/Neo-Agent-$version-macos-$arch.dmg"
stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname "Neo Agent" -srcfolder "$stage" -ov -format UDZO "$dmg"
rm -rf "$stage"
echo "$dmg"
