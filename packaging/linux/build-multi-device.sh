#!/usr/bin/env bash
# Build multi-device release archives:
#   - neo-agent-os-<version>-linux-x64.tar.gz
#   - neo-agent-os-<version>-linux-arm64.tar.gz
#   - neo-relayd-<version>-linux-x64.tar.gz
#   - neo-relayd-<version>-linux-arm64.tar.gz
#   - neo-agent-mcu-<version>-sdk.tar.gz
#
# Usage: packaging/linux/build-multi-device.sh [--version <X.Y.Z>] [--targets <csv|all>]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version=""
targets="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      version="${2:?--version needs a value}"
      shift 2
      ;;
    --targets)
      targets="${2:?--targets needs a value}"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$version" ]]; then
  version="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$root/backend/package.json" | head -n 1)"
fi
if [[ -z "$version" ]]; then
  echo "could not determine version from backend/package.json" >&2
  exit 1
fi

if [[ "$targets" == "all" ]]; then
  targets="agent-os-x64,agent-os-arm64,relay-x64,relay-arm64,mcu-sdk"
fi

has_target() {
  local want="$1"
  [[ ",$targets," == *",$want,"* ]]
}

resolve_go() {
  if [[ -n "${GO_BIN:-}" && -x "${GO_BIN:-}" ]]; then
    echo "$GO_BIN"
    return
  fi
  if command -v go >/dev/null 2>&1; then
    command -v go
    return
  fi
  if [[ -x "/tmp/gotoroot/go/bin/go" ]]; then
    echo "/tmp/gotoroot/go/bin/go"
    return
  fi
  echo "go binary not found (set GO_BIN or add go to PATH)" >&2
  exit 1
}

verify_elf() {
  local bin="$1"
  local pattern="$2"
  if command -v file >/dev/null 2>&1; then
    local info
    info="$(file "$bin")"
    if [[ "$info" != *"$pattern"* ]]; then
      echo "unexpected ELF architecture for $bin: $info (expected *$pattern*)" >&2
      exit 1
    fi
  fi
}

mkdir -p "$root/dist"

build_agent_os() {
  local arch="$1"
  local rust_target="$2"
  local elf_pattern="$3"
  local name="neo-agent-os-$version-linux-$arch"
  local stage="$root/dist/$name"
  local bin_path="$root/agents/neo-agent-os/target/release/neo-agent-os"

  rm -rf "$stage"
  mkdir -p "$stage/deploy"

  if [[ -z "$rust_target" ]]; then
    (cd "$root/agents/neo-agent-os" && cargo build --release)
  else
    bin_path="$root/agents/neo-agent-os/target/$rust_target/release/neo-agent-os"
    (
      cd "$root/agents/neo-agent-os" &&
        CC_aarch64_unknown_linux_gnu="${CC_aarch64_unknown_linux_gnu:-aarch64-linux-gnu-gcc}" \
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER:-aarch64-linux-gnu-gcc}" \
        cargo build --release --target "$rust_target"
    )
  fi

  cp "$bin_path" "$stage/neo-agent-os"
  chmod 755 "$stage/neo-agent-os"
  verify_elf "$stage/neo-agent-os" "$elf_pattern"
  cp -R "$root/deploy/multi-master/"* "$stage/deploy/"
  cp "$root/LICENSE" "$stage/"

  local tarball="$root/dist/$name.tar.gz"
  rm -f "$tarball"
  tar -C "$root/dist" -czf "$tarball" "$name"
  rm -rf "$stage"
  echo "$tarball"
}

build_relay() {
  local arch="$1"
  local goarch="$2"
  local elf_pattern="$3"
  local go_bin
  go_bin="$(resolve_go)"
  local name="neo-relayd-$version-linux-$arch"
  local stage="$root/dist/$name"

  rm -rf "$stage"
  mkdir -p "$stage/deploy"

  (
    cd "$root/services/neo-relay" &&
      CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" "$go_bin" build -trimpath -ldflags="-s -w" -o "$stage/neo-relayd" ./cmd/neo-relayd
  )
  chmod 755 "$stage/neo-relayd"
  verify_elf "$stage/neo-relayd" "$elf_pattern"
  cp -R "$root/services/neo-relay/deploy/"* "$stage/deploy/"
  cp "$root/LICENSE" "$stage/"

  local tarball="$root/dist/$name.tar.gz"
  rm -f "$tarball"
  tar -C "$root/dist" -czf "$tarball" "$name"
  rm -rf "$stage"
  echo "$tarball"
}

build_mcu_sdk() {
  local name="neo-agent-mcu-$version-sdk"
  local stage="$root/dist/$name"

  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "$root/agents/neo-agent-mcu/include" "$stage/"
  cp -R "$root/agents/neo-agent-mcu/src" "$stage/"
  cp -R "$root/agents/neo-agent-mcu/examples" "$stage/"
  cp -R "$root/agents/neo-agent-mcu/tests" "$stage/"
  cp "$root/agents/neo-agent-mcu/Makefile" "$stage/"
  cp "$root/LICENSE" "$stage/"

  local tarball="$root/dist/$name.tar.gz"
  rm -f "$tarball"
  tar -C "$root/dist" -czf "$tarball" "$name"
  rm -rf "$stage"
  echo "$tarball"
}

if has_target "agent-os-x64"; then
  build_agent_os "x64" "" "x86-64"
fi
if has_target "agent-os-arm64"; then
  build_agent_os "arm64" "aarch64-unknown-linux-gnu" "ARM aarch64"
fi
if has_target "relay-x64"; then
  build_relay "x64" "amd64" "x86-64"
fi
if has_target "relay-arm64"; then
  build_relay "arm64" "arm64" "ARM aarch64"
fi
if has_target "mcu-sdk"; then
  build_mcu_sdk
fi
