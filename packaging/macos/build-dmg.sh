#!/bin/sh
# Build the macOS app with its backend and runtimes inside, and a disk image of it. Run on a Mac of the
# architecture to build for.
#
# Usage: packaging/macos/build-dmg.sh [--without-runtimes]
# Needs: Xcode, cargo, flutter, python3.  Output: dist/Neo-Agent-<version>-macos-<arch>.dmg
#
# Signing: with MACOS_SIGN_IDENTITY set (a "Developer ID Application: …" identity in the keychain) the app is signed
# with it and the hardened runtime; otherwise it is signed ad hoc, which Apple silicon needs to run it at all, and
# Gatekeeper will ask the person to allow it (see docs). Notarization, when wanted, is a separate step.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
runtimes=yes
[ "${1:-}" = --without-runtimes ] && runtimes=no
case "$(uname -m)" in
  arm64) arch=arm64; target=aarch64-apple-darwin ;;
  x86_64) arch=x64; target=x86_64-apple-darwin ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/backend/Cargo.toml" | head -1)

(cd "$root/backend" && cargo build --release -p neo-agent --target "$target")
(cd "$root/app" && flutter build macos --release)

app="$root/app/build/macos/Build/Products/Release/Neo Agent.app"
[ -d "$app" ] || { echo "the app was not built at $app" >&2; exit 1; }
# Only this Mac's architecture: the bundled runtimes are for one.
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
