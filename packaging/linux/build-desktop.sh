#!/bin/sh
# Build the Linux desktop packages: a relocatable tarball and a Debian/Ubuntu .deb package,
# each bundling the Flutter Linux runner (neo_agent) with the Bun-compiled backend (neo-agent) beside it.
#
# Usage: packaging/linux/build-desktop.sh [--arch x64] [--bundle-dir <prebuilt-flutter-bundle>]
# Needs: bun, flutter + ninja-build + libgtk-3-dev (unless --bundle-dir is given), dpkg-deb.
# Output:
#   dist/Neo-<version>-linux-<arch>.tar.gz
#   dist/Neo-<version>-linux-<arch>.deb
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
arch=x64
bundle_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch=${2:?--arch needs x64 or arm64}; shift ;;
    --bundle-dir) bundle_dir=${2:?--bundle-dir needs a path}; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$arch" in
  x64 | x86_64) arch=x64; deb_arch=amd64; target=bun-linux-x64; flutter_arch=x64; elf_pattern="x86-64" ;;
  arm64 | aarch64) arch=arm64; deb_arch=arm64; target=bun-linux-arm64; flutter_arch=arm64; elf_pattern="ARM aarch64" ;;
  *) echo "unsupported architecture $arch" >&2; exit 2 ;;
esac
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/backend/package.json" | head -1)
[ -n "$version" ] || { echo "could not read version from backend/package.json" >&2; exit 1; }
# Debian treats '-' in Version as the Debian revision separator; map semver prerelease '-' to '~' so 0.7.0~rc.1 < 0.7.0.
deb_version=$(printf '%s' "$version" | sed 's/-/~/')

(cd "$root/backend" && bun install --frozen-lockfile && bun build --compile --minify --bytecode --target="$target" src/main.ts --outfile "dist/neo-agent-$arch")

if [ -z "$bundle_dir" ]; then
  (cd "$root/app" && flutter pub get && flutter build linux --release)
  bundle_dir="$root/app/build/linux/$flutter_arch/release/bundle"
fi
[ -x "$bundle_dir/neo_agent" ] || { echo "Linux desktop binary not found at $bundle_dir/neo_agent" >&2; exit 1; }

name="Neo-$version-linux-$arch"
stage="$root/dist/$name"
rm -rf "$stage" && mkdir -p "$stage"

cp -a "$bundle_dir/." "$stage/"
cp "$root/backend/dist/neo-agent-$arch" "$stage/neo-agent"
find "$stage" -type d -exec chmod 755 {} +
chmod 755 "$stage/neo-agent" "$stage/neo_agent"
cp "$root/LICENSE" "$stage/"
cp "$root/app/web/icons/Icon-512.png" "$stage/neo.png"

cat > "$stage/dev.neoagent.neo_agent.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Neo
Comment=An AI assistant that works in isolated task directories
Exec=/opt/neo/neo_agent %U
Icon=dev.neoagent.neo_agent
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=dev.neoagent.neo_agent
DESKTOP

cat > "$stage/install-desktop.sh" <<'INSTALLER'
#!/bin/sh
# Register this unpacked Neo desktop bundle in the current user's application menu.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
mkdir -p "$apps_dir" "$icons_dir"
cp "$dir/neo.png" "$icons_dir/dev.neoagent.neo_agent.png"
cat > "$apps_dir/dev.neoagent.neo_agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Neo
Comment=An AI assistant that works in isolated task directories
Exec="$dir/neo_agent" %U
Icon=dev.neoagent.neo_agent
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=dev.neoagent.neo_agent
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps_dir" 2>/dev/null || true
echo "Installed Neo desktop entry pointing to $dir/neo_agent"
INSTALLER
chmod 755 "$stage/install-desktop.sh"

if command -v file >/dev/null 2>&1; then
  info=$(file "$stage/neo-agent")
  case "$info" in
    *"$elf_pattern"*) ;;
    *) echo "unexpected ELF architecture for $stage/neo-agent: $info" >&2; exit 1 ;;
  esac
fi

host_arch=$(uname -m)
case "$host_arch:$arch" in
  x86_64:x64 | aarch64:arm64 | arm64:arm64)
    reported=$("$stage/neo-agent" version)
    case "$reported" in
      *"$version"*) ;;
      *) echo "staged neo-agent reported '$reported', expected '$version'" >&2; exit 1 ;;
    esac
    ;;
esac

tarball="$root/dist/$name.tar.gz"
rm -f "$tarball"
tar -C "$root/dist" -czf "$tarball" "$name"

# Build Debian/Ubuntu .deb package when dpkg-deb is available (standard on Ubuntu runners).
deb_out="$root/dist/$name.deb"
if command -v dpkg-deb >/dev/null 2>&1; then
  deb_stage=$(mktemp -d)
  cleanup_deb() { rm -rf "$deb_stage"; }
  trap cleanup_deb EXIT INT TERM

  mkdir -p \
    "$deb_stage/DEBIAN" \
    "$deb_stage/opt/neo" \
    "$deb_stage/usr/bin" \
    "$deb_stage/usr/share/applications" \
    "$deb_stage/usr/share/icons/hicolor/512x512/apps"

  cp -a "$bundle_dir/." "$deb_stage/opt/neo/"
  cp "$root/backend/dist/neo-agent-$arch" "$deb_stage/opt/neo/neo-agent"
  cp "$root/LICENSE" "$deb_stage/opt/neo/LICENSE"

  cat > "$deb_stage/usr/bin/neo" <<'WRAPPER'
#!/bin/sh
exec /opt/neo/neo_agent "$@"
WRAPPER

  cp "$stage/dev.neoagent.neo_agent.desktop" "$deb_stage/usr/share/applications/dev.neoagent.neo_agent.desktop"
  cp "$root/app/web/icons/Icon-512.png" "$deb_stage/usr/share/icons/hicolor/512x512/apps/dev.neoagent.neo_agent.png"

  # Normalize permissions so installed files and directories are world-readable/traversable for non-root users.
  chmod 755 "$deb_stage" "$deb_stage/DEBIAN"
  find "$deb_stage/opt" "$deb_stage/usr" -type d -exec chmod 755 {} +
  find "$deb_stage/opt" "$deb_stage/usr" -type f -exec chmod go-w,a+r {} +
  chmod 755 "$deb_stage/opt/neo/neo-agent" "$deb_stage/opt/neo/neo_agent" "$deb_stage/usr/bin/neo"
  chmod 644 \
    "$deb_stage/opt/neo/LICENSE" \
    "$deb_stage/usr/share/applications/dev.neoagent.neo_agent.desktop" \
    "$deb_stage/usr/share/icons/hicolor/512x512/apps/dev.neoagent.neo_agent.png"

  installed_kb=$(du -sk "$deb_stage/opt" "$deb_stage/usr" | awk '{s+=$1} END {print s}')
  cat > "$deb_stage/DEBIAN/control" <<CONTROL
Package: neo
Version: $deb_version
Section: devel
Priority: optional
Architecture: $deb_arch
Installed-Size: $installed_kb
Depends: libgtk-3-0 | libgtk-3-0t64, libglib2.0-0 | libglib2.0-0t64, libstdc++6
Maintainer: Neo Contributors <noreply@github.com>
Homepage: https://github.com/xbhuang1994/neo
Description: Neo AI assistant desktop application
 Neo desktop application with bundled pure-TypeScript (Bun-compiled) neo-agent
 backend. Manages isolated task workers, chat, and WeChat integration.
CONTROL
  chmod 644 "$deb_stage/DEBIAN/control"

  rm -f "$deb_out"
  dpkg-deb --build --root-owner-group "$deb_stage" "$deb_out" >/dev/null
  dpkg-deb -I "$deb_out" >/dev/null
  deb_listing=$(dpkg-deb -c "$deb_out")
  printf '%s\n' "$deb_listing" | grep -q "./opt/neo/neo-agent"
  printf '%s\n' "$deb_listing" | grep -q "./opt/neo/neo_agent"
  rm -rf "$deb_stage"
  trap - EXIT INT TERM
fi

echo "$tarball"
[ -f "$deb_out" ] && echo "$deb_out"
