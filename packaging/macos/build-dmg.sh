#!/bin/sh
# Build the macOS app with its backend inside, and a disk image of it. Builds for this Mac's architecture unless
# --arch names the other one; the Flutter app is universal either way. The agent runtimes are not inside: the backend
# finds them on the Mac, and the app installs them with their official installers.
#
# Usage: packaging/macos/build-dmg.sh [--arch arm64|x64]
# Needs: Xcode, bun, flutter.  Output: dist/Neo-<version>-macos-<arch>.dmg
#
# Signing: with MACOS_SIGN_IDENTITY set (a "Developer ID Application: …" identity in the keychain) the app is signed
# with it and the hardened runtime; otherwise it is signed ad hoc, which Apple silicon needs to run it at all, and
# Gatekeeper will ask the person to allow it (see docs). Notarization, when wanted, is a separate step.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
arch=$(uname -m)
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch=${2:?--arch needs arm64 or x64}; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
case "$arch" in
  arm64 | aarch64) arch=arm64; macho_arch=arm64; target=bun-darwin-arm64 ;;
  x64 | x86_64) arch=x64; macho_arch=x86_64; target=bun-darwin-x64 ;;
  *) echo "unsupported architecture $arch" >&2; exit 1 ;;
esac
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/backend/package.json" | head -1)
[ -n "$version" ] || { echo "could not read version from backend/package.json" >&2; exit 1; }

(cd "$root/backend" && bun install --frozen-lockfile && bun build --compile --minify --bytecode --target="$target" src/main.ts --outfile "dist/neo-agent-$arch")
(cd "$root/app" && flutter pub get && flutter build macos --release)

app="$root/app/build/macos/Build/Products/Release/Neo.app"
[ -d "$app" ] || { echo "the app was not built at $app" >&2; exit 1; }

# One architecture per image: the backend is built for one.
mkdir -p "$app/Contents/Helpers"
cp "$root/backend/dist/neo-agent-$arch" "$app/Contents/Helpers/neo-agent"
chmod 755 "$app/Contents/Helpers/neo-agent"

# Verify binary architectures match the requested macOS target.
if command -v lipo >/dev/null 2>&1; then
  helper_archs=$(lipo -archs "$app/Contents/Helpers/neo-agent")
  case " $helper_archs " in
    *" $macho_arch "*) ;;
    *) echo "expected neo-agent arch $macho_arch, got: $helper_archs" >&2; exit 1 ;;
  esac
  app_archs=$(lipo -archs "$app/Contents/MacOS/Neo")
  case " $app_archs " in
    *" $macho_arch "*) ;;
    *) echo "expected Neo.app binary to include $macho_arch, got: $app_archs" >&2; exit 1 ;;
  esac
fi

identity=${MACOS_SIGN_IDENTITY:--}
options=""
[ "$identity" != - ] && options="--options runtime --timestamp"
entitlements="$root/packaging/macos/helper.entitlements"

# Inside-out signing WITHOUT --deep on the outer .app so Contents/Helpers/neo-agent preserves
# helper.entitlements (required by Bun/JavaScriptCore under Hardened Runtime).
if [ -d "$app/Contents/Frameworks" ]; then
  find "$app/Contents/Frameworks" -type f \( -name "*.dylib" -o -name "*.so" \) | while IFS= read -r lib; do
    # shellcheck disable=SC2086
    codesign --force --sign "$identity" $options "$lib"
  done
  find "$app/Contents/Frameworks" -maxdepth 2 -type d -name "*.framework" | while IFS= read -r fw; do
    # shellcheck disable=SC2086
    codesign --force --sign "$identity" $options "$fw"
  done
fi
# shellcheck disable=SC2086
codesign --force --sign "$identity" $options --entitlements "$entitlements" "$app/Contents/Helpers/neo-agent"
# shellcheck disable=SC2086
codesign --force --sign "$identity" $options --entitlements "$root/app/macos/Runner/Release.entitlements" "$app"

codesign --verify --deep --strict --verbose=2 "$app"
if ! codesign -d --entitlements :- "$app/Contents/Helpers/neo-agent" 2>&1 | grep -q "com.apple.security.cs.allow-jit"; then
  echo "helper binary lost allow-jit entitlement after signing" >&2
  exit 1
fi

mkdir -p "$root/dist"
dmg="$root/dist/Neo-$version-macos-$arch.dmg"
stage=$(mktemp -d)
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT INT TERM
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"

# Retry hdiutil create to handle transient macOS Spotlight "Resource busy" failures on CI runners.
attempt=1
while :; do
  if hdiutil create -volname "Neo" -srcfolder "$stage" -ov -format UDZO "$dmg"; then
    break
  fi
  if [ "$attempt" -ge 3 ]; then
    echo "hdiutil create failed after $attempt attempts" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 3
done

echo "$dmg"
