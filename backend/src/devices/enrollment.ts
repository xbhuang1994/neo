/**
 * Zero-Trust One-Click Agent Enrollment Manager:
 * - Renders immutable local TOML policy presets (`personal`, `corp`, `readonly`, `desktop`).
 * - Generates `neo_enr_v1.<ticketId>.<ephemeralKey>` tickets and seals `EnrollPayload` with `0xE2` AES-256-GCM.
 * - Publishes opaque ciphertexts to `neo-relayd` (`/v1/enroll/tickets`) or serves Master Direct Mode (`/enroll/claim/:id`)
 *   with per-IP rate limiting (20 req/min/IP) and atomic burn-after-reading consumption.
 * - Persists secret-free enrollment metadata under `device-enroll:<id>` in `Store` KV.
 * - Handles `enroll_register` -> `enroll_ack` E2E exchanges and `manifest.enroll_id` completion.
 */

import type { Store } from "../store/index.ts";
import { generateEnrollTicket, sealEnrollPayload } from "./protocol.ts";
import type {
  DeviceConfig,
  DeviceMessage,
  DeviceTwin,
  DirectClaimResult,
  EnrollPayload,
  EnrollmentAuthMode,
  EnrollmentCommands,
  EnrollmentCreateInput,
  EnrollmentInstallMode,
  EnrollmentPlatform,
  EnrollmentProfile,
  EnrollmentStatus,
  EnrollmentTransportMode,
  EnrollmentView,
  TokenTier,
} from "./types.ts";

export const ENROLL_KEY_PREFIX = "device-enroll:";
const DEFAULT_TTL_SEC = 600;
const MIN_TTL_SEC = 60;
const MAX_TTL_SEC = 86_400;
const DEFAULT_MAX_USES = 1;
const MIN_MAX_USES = 1;
const MAX_MAX_USES = 50;
const DIRECT_CLAIM_RATE_LIMIT = 20;
const DIRECT_CLAIM_WINDOW_MS = 60_000;
const RELAY_SYNC_TIMEOUT_MS = 3_000;
const PERMANENT_TOKEN_TTL_SEC = 365 * 86_400;

const VALID_PLATFORMS: ReadonlySet<string> = new Set(["linux", "macos", "windows", "docker"]);
const VALID_PROFILES: ReadonlySet<string> = new Set(["personal", "corp", "readonly", "desktop"]);
const VALID_INSTALL_MODES: ReadonlySet<string> = new Set(["auto", "system", "user", "foreground"]);
const VALID_TRANSPORT_MODES: ReadonlySet<string> = new Set(["relay", "direct"]);

const DEVICE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MEMORY_MAX_RE = /^[0-9]+[KMGTP]?$/i;
const CPU_QUOTA_RE = /^[0-9]+%?$/;

const BASE_DENIED_COMMANDS: readonly string[] = [
  "rm",
  "sudo",
  "su",
  "doas",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "mount",
  "umount",
  "iptables",
  "ip6tables",
  "nft",
  "systemctl",
  "chmod",
  "chown",
  "chgrp",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "nc",
  "ncat",
];

const PERSONAL_ALLOWED_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "pwd",
  "uname",
  "echo",
  "git",
  "cargo",
  "bun",
  "python3",
  "make",
];

const CORP_ALLOWED_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "pwd",
  "uname",
  "echo",
  "git",
  "cargo",
  "bun",
];

const CORP_EXTRA_DENIED: readonly string[] = ["python3", "perl", "ruby", "bash", "sh"];

const READONLY_ALLOWED_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "pwd",
  "uname",
  "echo",
  "git",
];

const READONLY_EXTRA_DENIED: readonly string[] = [
  ...CORP_EXTRA_DENIED,
  "mv",
  "cp",
  "tee",
  "sed",
  "awk",
  "touch",
  "mkdir",
  "rmdir",
  "ln",
];

const DESKTOP_ALLOWED_COMMANDS: readonly string[] = [
  ...PERSONAL_ALLOWED_COMMANDS,
  "node",
  "npm",
  "npx",
  "flutter",
  "dart",
  "open",
  "xdg-open",
  "osascript",
  "screencapture",
  "scrot",
  "xdotool",
  "powershell",
  "pwsh",
];

interface PolicyPresetSpec {
  comment: string;
  allowedCommands: readonly string[];
  deniedCommands: readonly string[];
  maxChildMemMb: number;
  maxExecTimeoutSec: number;
  maxOutputBytes: number;
}

const POLICY_PRESETS: Readonly<Record<EnrollmentProfile, PolicyPresetSpec>> = {
  personal: {
    comment: "Read-only local execution policy for a personal Neo OS agent instance.",
    allowedCommands: PERSONAL_ALLOWED_COMMANDS,
    deniedCommands: BASE_DENIED_COMMANDS,
    maxChildMemMb: 2048,
    maxExecTimeoutSec: 120,
    maxOutputBytes: 1_048_576,
  },
  corp: {
    comment: "Read-only local execution policy for a corporate Neo OS agent instance.",
    allowedCommands: CORP_ALLOWED_COMMANDS,
    deniedCommands: [...BASE_DENIED_COMMANDS, ...CORP_EXTRA_DENIED],
    maxChildMemMb: 4096,
    maxExecTimeoutSec: 90,
    maxOutputBytes: 1_048_576,
  },
  readonly: {
    comment: "Read-only inspection policy for a Neo OS agent instance.",
    allowedCommands: READONLY_ALLOWED_COMMANDS,
    deniedCommands: [...BASE_DENIED_COMMANDS, ...READONLY_EXTRA_DENIED],
    maxChildMemMb: 1024,
    maxExecTimeoutSec: 60,
    maxOutputBytes: 1_048_576,
  },
  desktop: {
    comment: "Read-only local execution policy for desktop development and UI testing.",
    allowedCommands: DESKTOP_ALLOWED_COMMANDS,
    deniedCommands: BASE_DENIED_COMMANDS,
    maxChildMemMb: 4096,
    maxExecTimeoutSec: 180,
    maxOutputBytes: 1_048_576,
  },
};

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function formatTomlStringArray(items: readonly string[]): string {
  return items.map((item) => `  "${escapeTomlString(item)}",`).join("\n");
}

function validateWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error(`Invalid workspace path: ${JSON.stringify(raw)}`);
  }
  const segments = trimmed.split(/[/\\]+/);
  if (segments.includes("..")) {
    throw new Error(`Workspace path cannot contain '..': ${trimmed}`);
  }
  return trimmed;
}

/**
 * Render an immutable TOML policy preset with `{{WORKSPACE_DIR}}` placeholder.
 */
export function renderPolicyPreset(
  profile: EnrollmentProfile,
  workspaces: readonly string[] = [],
): string {
  const spec = POLICY_PRESETS[profile];
  const cleanedWorkspaces = workspaces.map(validateWorkspacePath);
  const wsEntries =
    cleanedWorkspaces.length <= 1
      ? ["{{WORKSPACE_DIR}}"]
      : ["{{WORKSPACE_DIR}}", ...cleanedWorkspaces.slice(1)];

  return [
    `# ${spec.comment}`,
    "# The Master Neo control plane and neo-relay cannot modify this file at runtime.",
    "",
    "allowed_workspaces = [",
    formatTomlStringArray(wsEntries),
    "]",
    "",
    "allowed_commands = [",
    formatTomlStringArray(spec.allowedCommands),
    "]",
    "",
    "# denied_commands always overrides allowed_commands.",
    "denied_commands = [",
    formatTomlStringArray(spec.deniedCommands),
    "]",
    "",
    `max_child_mem_mb = ${spec.maxChildMemMb}`,
    `max_exec_timeout_sec = ${spec.maxExecTimeoutSec}`,
    `max_output_bytes = ${spec.maxOutputBytes}`,
    "",
  ].join("\n");
}

function sanitizeShellLiteral(value: string): string {
  return value.replace(/[^A-Za-z0-9._:/?=&\[\]-]/g, "");
}

/** Render thin POSIX `/install.sh` prefilled for Master Direct Mode. */
export function renderDirectInstallSh(opts: {
  origin: string;
  relayUrl?: string;
  agentVersion: string;
}): string {
  const origin = sanitizeShellLiteral(opts.origin.replace(/\/+$/, "")) || "http://127.0.0.1:3082";
  const relayUrl = sanitizeShellLiteral((opts.relayUrl || origin).replace(/\/+$/, "")) || origin;
  const version = sanitizeShellLiteral(opts.agentVersion) || "0.8.0";

  return `#!/usr/bin/env sh
set -eu

DEFAULT_MASTER_ORIGIN='${origin}'
DEFAULT_RELAY_URL='${relayUrl}'
DEFAULT_VERSION='${version}'

ENROLL_CODE=""
CLAIM_URL=""
RELAY_URL="$DEFAULT_RELAY_URL"
MODE="auto"
VERSION="$DEFAULT_VERSION"
UPGRADE="0"
UNINSTALL="0"
CLUSTER=""
PURGE_WS="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enroll)
      ENROLL_CODE="$2"; shift 2 ;;
    --claim-url)
      CLAIM_URL="$2"; shift 2 ;;
    --relay-url)
      RELAY_URL="$2"; shift 2 ;;
    --mode)
      MODE="$2"; shift 2 ;;
    --version)
      VERSION="$2"; shift 2 ;;
    --upgrade)
      UPGRADE="1"; shift ;;
    --uninstall)
      UNINSTALL="1"; shift ;;
    --cluster)
      CLUSTER="$2"; shift 2 ;;
    --purge-workspace)
      PURGE_WS="1"; shift ;;
    *)
      echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="\${HOME}/.local/bin"
fi
BIN_PATH="\${BIN_DIR}/neo-agent-os"

if [ "$UNINSTALL" = "1" ]; then
  if [ -z "$CLUSTER" ]; then
    echo "--cluster is required with --uninstall" >&2
    exit 2
  fi
  if [ ! -x "$BIN_PATH" ]; then
    BIN_PATH="$(command -v neo-agent-os || true)"
  fi
  if [ -z "$BIN_PATH" ]; then
    echo "neo-agent-os binary not found" >&2
    exit 1
  fi
  if [ "$PURGE_WS" = "1" ]; then
    exec "$BIN_PATH" uninstall --cluster "$CLUSTER" --purge-workspace
  fi
  exec "$BIN_PATH" uninstall --cluster "$CLUSTER"
fi

if [ "$UPGRADE" != "1" ] && [ -z "$ENROLL_CODE" ]; then
  echo "Usage: install.sh --enroll <neo_enr_v1.id.key> [--claim-url <url>] [--relay-url <url>] [--mode auto|system|user|foreground]" >&2
  echo "       install.sh --upgrade [--version <ver>] [--cluster <id>]" >&2
  exit 2
fi

if [ "$UPGRADE" != "1" ] && [ -z "$CLAIM_URL" ]; then
  TICKET_ID="$(printf '%s' "$ENROLL_CODE" | awk -F'.' '{print $2}')"
  if [ -z "$TICKET_ID" ]; then
    echo "Invalid enrollment ticket format" >&2
    exit 2
  fi
  CLAIM_URL="\${DEFAULT_MASTER_ORIGIN}/enroll/claim/\${TICKET_ID}"
fi

UNAME_S="$(uname -s | tr '[:upper:]' '[:lower:]')"
UNAME_M="$(uname -m)"
case "$UNAME_S" in
  linux) OS="linux" ;;
  darwin) OS="macos" ;;
  *) echo "Unsupported OS: $UNAME_S" >&2; exit 1 ;;
esac
case "$UNAME_M" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $UNAME_M" >&2; exit 1 ;;
esac

ASSET="neo-agent-os-\${VERSION}-\${OS}-\${ARCH}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

download_file() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 180 "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    echo "curl or wget is required" >&2
    return 1
  fi
}

fetch_with_fallback() {
  rel_path="$1"
  out="$2"
  if [ "$RELAY_URL" != "$DEFAULT_MASTER_ORIGIN" ]; then
    if download_file "\${RELAY_URL}/dl/v\${VERSION}/\${rel_path}" "$out" 2>/dev/null; then
      return 0
    fi
  fi
  download_file "https://github.com/xbhuang1994/neo/releases/download/v\${VERSION}/\${rel_path}" "$out"
}

echo "[neo-install] Downloading \${ASSET}..."
fetch_with_fallback "$ASSET" "\${TMP_DIR}/\${ASSET}"
fetch_with_fallback "SHA256SUMS.txt" "\${TMP_DIR}/SHA256SUMS.txt"

EXPECTED_SHA="$(awk -v f="$ASSET" '$2 == f || $2 == ("*" f) { print $1; exit }' "\${TMP_DIR}/SHA256SUMS.txt")"
if [ -z "$EXPECTED_SHA" ]; then
  echo "Checksum entry for \${ASSET} not found in SHA256SUMS.txt" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "\${TMP_DIR}/\${ASSET}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA="$(shasum -a 256 "\${TMP_DIR}/\${ASSET}" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required for integrity verification" >&2
  exit 1
fi
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "SHA-256 mismatch for \${ASSET}: expected \${EXPECTED_SHA}, got \${ACTUAL_SHA}" >&2
  exit 1
fi

tar -xzf "\${TMP_DIR}/\${ASSET}" -C "\${TMP_DIR}"
mkdir -p "$BIN_DIR"
BIN_SRC="$(find "$TMP_DIR" -type f -name 'neo-agent-os' | head -n 1)"
if [ -z "$BIN_SRC" ]; then
  echo "neo-agent-os executable missing from archive" >&2
  exit 1
fi
cp "$BIN_SRC" "\${BIN_PATH}.tmp"
chmod 0755 "\${BIN_PATH}.tmp"
mv -f "\${BIN_PATH}.tmp" "$BIN_PATH"

if [ "$UPGRADE" = "1" ]; then
  echo "[neo-install] Upgraded neo-agent-os to v\${VERSION} at \${BIN_PATH}"
  if [ -n "$CLUSTER" ]; then
    if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
      if [ "$(id -u)" -eq 0 ]; then
        systemctl restart "neo-agent-os@\${CLUSTER}.service" 2>/dev/null || true
      else
        systemctl --user restart "neo-agent-os-\${CLUSTER}.service" 2>/dev/null || true
      fi
    elif [ "$OS" = "macos" ] && command -v launchctl >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/cn.1inch.neo.agent.\${CLUSTER}" 2>/dev/null || true
    fi
  fi
  exit 0
fi

echo "[neo-install] Running neo-agent-os enroll via \${CLAIM_URL}..."
printf '%s\\n' "$ENROLL_CODE" | "$BIN_PATH" enroll --relay-url "$RELAY_URL" --claim-url "$CLAIM_URL" --mode "$MODE" --ticket-stdin
`;
}

/** Render PowerShell `/install.ps1` prefilled for Master Direct Mode. */
export function renderDirectInstallPs1(opts: {
  origin: string;
  relayUrl?: string;
  agentVersion: string;
}): string {
  const origin = sanitizeShellLiteral(opts.origin.replace(/\/+$/, "")) || "http://127.0.0.1:3082";
  const relayUrl = sanitizeShellLiteral((opts.relayUrl || origin).replace(/\/+$/, "")) || origin;
  const version = sanitizeShellLiteral(opts.agentVersion) || "0.8.0";

  return `$ErrorActionPreference = 'Stop'
$script:NeoDefaultOrigin = '${origin}'
$script:NeoDefaultRelayUrl = '${relayUrl}'
$script:NeoDefaultVersion = '${version}'

function Install-NeoAgent {
  param(
    [string]$Enroll = '',
    [string]$ClaimUrl = '',
    [string]$RelayUrl = $script:NeoDefaultRelayUrl,
    [string]$Version = $script:NeoDefaultVersion,
    [string]$Mode = 'auto',
    [switch]$Upgrade,
    [switch]$Uninstall,
    [string]$Cluster = '',
    [switch]$PurgeWorkspace
  )

  $binDir = Join-Path $env:LOCALAPPDATA 'neo-agent\\bin'
  $binPath = Join-Path $binDir 'neo-agent-os.exe'

  if ($Uninstall) {
    if ([string]::IsNullOrWhiteSpace($Cluster)) {
      throw '-Cluster is required with -Uninstall'
    }
    $argsList = @('uninstall', '--cluster', $Cluster)
    if ($PurgeWorkspace) { $argsList += '--purge-workspace' }
    & $binPath @argsList
    return
  }

  if (-not $Upgrade) {
    if ([string]::IsNullOrWhiteSpace($Enroll)) {
      throw 'Install-NeoAgent requires -Enroll <neo_enr_v1.id.key> or -Upgrade'
    }

    $parts = $Enroll.Trim().Split('.')
    if ($parts.Length -ne 3 -or $parts[0] -ne 'neo_enr_v1') {
      throw 'Invalid enrollment ticket format'
    }
    $ticketId = $parts[1]
    if ([string]::IsNullOrWhiteSpace($ClaimUrl)) {
      $ClaimUrl = "$script:NeoDefaultOrigin/enroll/claim/$ticketId"
    }
  }

  $asset = "neo-agent-os-$Version-windows-x64.zip"
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("neo-install-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

  try {
    $zipPath = Join-Path $tmpDir $asset
    $sumsPath = Join-Path $tmpDir 'SHA256SUMS.txt'
    $mirrors = @()
    if ($RelayUrl -ne $script:NeoDefaultOrigin) {
      $mirrors += "$RelayUrl/dl/v$Version"
    }
    $mirrors += "https://github.com/xbhuang1994/neo/releases/download/v$Version"

    $downloaded = $false
    foreach ($base in $mirrors) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zipPath
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $sumsPath
        $downloaded = $true
        break
      } catch {
        continue
      }
    }
    if (-not $downloaded) {
      throw "Failed to download $asset from all mirrors"
    }

    $expected = $null
    foreach ($line in Get-Content $sumsPath) {
      if ($line -match '^([0-9a-fA-F]{64})\\s+\\*?(.+)$' -and $Matches[2].Trim() -eq $asset) {
        $expected = $Matches[1].ToLowerInvariant()
        break
      }
    }
    if (-not $expected) {
      throw "Checksum entry for $asset not found in SHA256SUMS.txt"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "SHA-256 mismatch for $asset: expected $expected, got $actual"
    }

    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
    $exe = Get-ChildItem -Path $tmpDir -Filter 'neo-agent-os.exe' -Recurse | Select-Object -First 1
    if (-not $exe) {
      throw 'neo-agent-os.exe missing from archive'
    }
    $bgExe = Get-ChildItem -Path $tmpDir -Filter 'neo-agent-os-bg.exe' -Recurse | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    foreach ($pair in @(,@($exe, $binPath)) + $(if ($bgExe) { @(,@($bgExe, (Join-Path $binDir 'neo-agent-os-bg.exe'))) } else { @() })) {
      $srcFile = $pair[0]; $dstPath = $pair[1]
      if (Test-Path -LiteralPath $dstPath) {
        $oldPath = "$dstPath.old"
        Remove-Item -LiteralPath $oldPath -Force -ErrorAction SilentlyContinue
        try { Move-Item -LiteralPath $dstPath -Destination $oldPath -Force -ErrorAction Stop } catch {}
      }
      Copy-Item -Path $srcFile.FullName -Destination $dstPath -Force
    }

    if ($Upgrade) {
      Write-Host "[neo-install] Upgraded neo-agent-os.exe to v$Version at $binPath"
      if (-not [string]::IsNullOrWhiteSpace($Cluster)) {
        $taskName = "NeoAgent-$Cluster"
        try { & schtasks /End /TN $taskName 2>$null | Out-Null } catch {}
        try { & schtasks /Run /TN $taskName 2>$null | Out-Null } catch {}
      }
      return
    }

    Write-Host "[neo-install] Running neo-agent-os enroll via $ClaimUrl..."
    $Enroll | & $binPath enroll --relay-url $RelayUrl --claim-url $ClaimUrl --mode $Mode --ticket-stdin
    if ($LASTEXITCODE -ne 0) {
      throw "neo-agent-os enroll exited with code $LASTEXITCODE"
    }
  } finally {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
`;
}

/** Persisted enrollment metadata stored in `Store` KV under `device-enroll:<id>` (never holds secrets). */
interface EnrollmentRecord {
  id: string;
  ticketId: string;
  clusterId: string;
  status: EnrollmentStatus;
  platform: EnrollmentPlatform;
  profile: EnrollmentProfile;
  installMode: EnrollmentInstallMode;
  transportMode: EnrollmentTransportMode;
  authMode: EnrollmentAuthMode;
  requestedDeviceId?: string;
  relayUrl?: string;
  claimUrl?: string;
  ttlSec: number;
  maxUses: number;
  usedCount: number;
  claimedCount: number;
  createdAt: string;
  expiresAt: string;
  expiresAtSec: number;
  lastClaimedAt?: string;
  lastClaimedIp?: string;
  completedAt?: string;
  revokedAt?: string;
  enrolledDeviceIds: string[];
  enrolledFingerprints?: Record<string, string>;
  policyPreview?: string;
}

interface DirectParcel {
  enrollId: string;
  ticketId: string;
  clusterId: string;
  ciphertextB64: string;
  expiresAtSec: number;
  remainingUses: number;
  maxUses: number;
}

interface ActiveCommandCacheEntry {
  enrollCode: string;
  commands: EnrollmentCommands;
  qrPayload: string;
  expiresAtMs: number;
}

export interface EnrollmentManagerOptions {
  store: Store;
  getConfig: () => DeviceConfig | null;
  getMasterToken: () => string;
  mintToken: (opts: {
    nodeId: string;
    tier: TokenTier;
    clusterId?: string;
    ttlSec?: number;
    nowSec?: number;
  }) => string;
  getDevice: (deviceId: string) => DeviceTwin | null;
  getAgentVersion: () => string;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeHostnameForDeviceId(hostname: string, fallbackSeed: string): string {
  const cleaned = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const seed = cleaned || fallbackSeed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "node";
  return seed.startsWith("os-") ? seed : `os-${seed}`;
}

export class EnrollmentManager {
  private readonly store: Store;
  private readonly getConfig: () => DeviceConfig | null;
  private readonly getMasterToken: () => string;
  private readonly mintToken: EnrollmentManagerOptions["mintToken"];
  private readonly getDevice: (deviceId: string) => DeviceTwin | null;
  private readonly getAgentVersion: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;

  private readonly directParcels = new Map<string, DirectParcel>();
  private readonly activeCommands = new Map<string, ActiveCommandCacheEntry>();
  private readonly claimRateBuckets = new Map<string, number[]>();

  constructor(options: EnrollmentManagerOptions) {
    this.store = options.store;
    this.getConfig = options.getConfig;
    this.getMasterToken = options.getMasterToken;
    this.mintToken = options.mintToken;
    this.getDevice = options.getDevice;
    this.getAgentVersion = options.getAgentVersion;
    this.fetchFn = options.fetchFn ?? fetch;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  private findRecord(idOrTicketId: string): EnrollmentRecord | null {
    const trimmed = idOrTicketId.trim();
    if (!trimmed) return null;
    const direct = this.store.get<EnrollmentRecord>(`${ENROLL_KEY_PREFIX}${trimmed}`);
    if (direct) return direct;
    if (!trimmed.startsWith("enr_")) {
      return this.store.get<EnrollmentRecord>(`${ENROLL_KEY_PREFIX}enr_${trimmed}`) ?? null;
    }
    return null;
  }

  private saveRecord(record: EnrollmentRecord): EnrollmentRecord {
    this.store.set(`${ENROLL_KEY_PREFIX}${record.id}`, record);
    return record;
  }

  private maybeExpireRecord(record: EnrollmentRecord): EnrollmentRecord {
    const nowSec = this.nowSec();
    if (record.status === "pending" && nowSec >= record.expiresAtSec) {
      const expired: EnrollmentRecord = {
        ...record,
        status: "expired",
      };
      this.directParcels.delete(record.ticketId);
      this.activeCommands.delete(record.id);
      return this.saveRecord(expired);
    }
    return record;
  }

  private toView(record: EnrollmentRecord): EnrollmentView {
    const cached =
      record.status === "pending" || record.status === "claimed"
        ? this.activeCommands.get(record.id)
        : undefined;
    const activeCached = cached && cached.expiresAtMs > this.nowMs() ? cached : undefined;
    return {
      id: record.id,
      ticketId: record.ticketId,
      clusterId: record.clusterId,
      status: record.status,
      platform: record.platform,
      profile: record.profile,
      installMode: record.installMode,
      transportMode: record.transportMode,
      authMode: record.authMode,
      ...(record.requestedDeviceId !== undefined ? { requestedDeviceId: record.requestedDeviceId } : {}),
      ...(record.relayUrl !== undefined ? { relayUrl: record.relayUrl } : {}),
      ...(record.claimUrl !== undefined ? { claimUrl: record.claimUrl } : {}),
      ttlSec: record.ttlSec,
      maxUses: record.maxUses,
      usedCount: record.usedCount,
      claimedCount: record.claimedCount,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      expiresAtSec: record.expiresAtSec,
      ...(record.lastClaimedAt !== undefined ? { lastClaimedAt: record.lastClaimedAt } : {}),
      ...(record.lastClaimedIp !== undefined ? { lastClaimedIp: record.lastClaimedIp } : {}),
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
      enrolledDeviceIds: [...record.enrolledDeviceIds],
      ...(activeCached
        ? {
            enrollCode: activeCached.enrollCode,
            commands: activeCached.commands,
            qrPayload: activeCached.qrPayload,
          }
        : {}),
      ...(record.policyPreview !== undefined ? { policyPreview: record.policyPreview } : {}),
    };
  }

  /**
   * Create a new zero-trust enrollment ticket, seal the payload with `0xE2` AES-256-GCM,
   * publish to `neo-relayd` (relay mode) or stage locally (direct mode), and build platform commands.
   */
  async createEnrollment(
    input: EnrollmentCreateInput = {},
    opts: { requestOrigin?: string } = {},
  ): Promise<EnrollmentView> {
    const cfg = this.getConfig();
    if (!cfg || !cfg.enabled) {
      throw new Error("Device control plane is not configured or enabled");
    }
    if (!cfg.relaySecret && !cfg.clusterSecret) {
      throw new Error("Master cannot mint enrollment tokens without relaySecret or clusterSecret");
    }

    const platform: EnrollmentPlatform = input.platform ?? "linux";
    if (!VALID_PLATFORMS.has(platform)) {
      throw new Error(`Invalid enrollment platform: ${String(platform)}`);
    }
    const profile: EnrollmentProfile = input.profile ?? "personal";
    if (!VALID_PROFILES.has(profile)) {
      throw new Error(`Invalid enrollment profile: ${String(profile)}`);
    }
    const installMode: EnrollmentInstallMode = input.installMode ?? "auto";
    if (!VALID_INSTALL_MODES.has(installMode)) {
      throw new Error(`Invalid enrollment installMode: ${String(installMode)}`);
    }
    const transportMode: EnrollmentTransportMode =
      input.transportMode ?? (cfg.relayUrl ? "relay" : "direct");
    if (!VALID_TRANSPORT_MODES.has(transportMode)) {
      throw new Error(`Invalid enrollment transportMode: ${String(transportMode)}`);
    }
    if (transportMode === "relay" && !cfg.relayUrl) {
      throw new Error("Relay URL is not configured; use direct transport mode or configure relayUrl");
    }

    const ttlSec = input.ttlSec ?? DEFAULT_TTL_SEC;
    if (!Number.isInteger(ttlSec) || ttlSec < MIN_TTL_SEC || ttlSec > MAX_TTL_SEC) {
      throw new Error(`ttlSec must be an integer between ${MIN_TTL_SEC} and ${MAX_TTL_SEC}`);
    }
    const maxUses = input.maxUses ?? DEFAULT_MAX_USES;
    if (!Number.isInteger(maxUses) || maxUses < MIN_MAX_USES || maxUses > MAX_MAX_USES) {
      throw new Error(`maxUses must be an integer between ${MIN_MAX_USES} and ${MAX_MAX_USES}`);
    }

    const requestedDeviceId = input.deviceId?.trim() || undefined;
    if (requestedDeviceId !== undefined && !DEVICE_ID_RE.test(requestedDeviceId)) {
      throw new Error(
        `Invalid deviceId '${requestedDeviceId}': must match ${DEVICE_ID_RE.source}`,
      );
    }

    const workspaces = (input.workspaces ?? []).map(validateWorkspacePath);
    const mqttBind = input.mqttBind?.trim() || "127.0.0.1:1883";
    const uartDevice =
      typeof input.uartDevice === "string" && input.uartDevice.trim().length > 0
        ? input.uartDevice.trim()
        : null;
    const cudaDevices = input.cudaDevices?.trim() ?? "";
    const defaultMemoryMax =
      profile === "corp" || profile === "desktop" ? "4G" : profile === "readonly" ? "1G" : "2G";
    const memoryMax = input.memoryMax?.trim() || defaultMemoryMax;
    if (!MEMORY_MAX_RE.test(memoryMax)) {
      throw new Error(`Invalid memoryMax '${memoryMax}'`);
    }
    const cpuQuota = input.cpuQuota?.trim() || "200%";
    if (!CPU_QUOTA_RE.test(cpuQuota)) {
      throw new Error(`Invalid cpuQuota '${cpuQuota}'`);
    }

    const agentVersion = input.agentVersion?.trim() || this.getAgentVersion();
    const { ticketId, ephemeralKey, enrollCode } = generateEnrollTicket();
    const enrollId = `enr_${ticketId}`;
    const nowSec = this.nowSec();
    const expiresAtSec = nowSec + ttlSec;

    const authMode: EnrollmentAuthMode =
      requestedDeviceId !== undefined && maxUses === 1 ? "direct" : "bootstrap_exchange";
    const payloadDeviceId = authMode === "direct" ? requestedDeviceId! : requestedDeviceId ?? "auto";
    const relayToken =
      authMode === "direct"
        ? this.mintToken({
            nodeId: requestedDeviceId!,
            tier: "os",
            clusterId: cfg.clusterId,
            ttlSec: PERMANENT_TOKEN_TTL_SEC,
            nowSec,
          })
        : this.mintToken({
            nodeId: `enr-${ticketId}`,
            tier: "os",
            clusterId: cfg.clusterId,
            ttlSec: Math.max(900, ttlSec + 300),
            nowSec,
          });

    const relayBase = cfg.relayUrl ? cfg.relayUrl.replace(/\/+$/, "") : "";
    const directBase = (
      input.masterPublicUrl?.trim() ||
      opts.requestOrigin?.trim() ||
      "http://127.0.0.1:3082"
    ).replace(/\/+$/, "");

    const downloadMirrors =
      input.downloadMirrors && input.downloadMirrors.length > 0
        ? input.downloadMirrors
        : relayBase
          ? [
              `${relayBase}/dl/v${agentVersion}`,
              `https://github.com/xbhuang1994/neo/releases/download/v${agentVersion}`,
            ]
          : [`https://github.com/xbhuang1994/neo/releases/download/v${agentVersion}`];

    const policyToml = renderPolicyPreset(profile, workspaces);

    const payload: EnrollPayload = {
      v: 1,
      enroll_id: enrollId,
      cluster_id: cfg.clusterId,
      master_id: cfg.masterNodeId,
      relay_url: relayBase || directBase,
      device_id: payloadDeviceId,
      auth_mode: authMode,
      relay_token: relayToken,
      e2e_key: cfg.e2eKey,
      agent_version: agentVersion,
      download_mirrors: downloadMirrors,
      checksums: input.checksums ? { ...input.checksums } : {},
      install_mode: installMode,
      policy_profile: profile,
      policy_toml: policyToml,
      workspace_override: workspaces.length > 0 ? workspaces[0]! : "",
      relay_bridge: {
        enabled: Boolean(input.relayBridge),
        mqtt_bind: mqttBind,
        uart_device: uartDevice,
      },
      limits: {
        memory_max: memoryMax,
        cpu_quota: cpuQuota,
        cuda_devices: cudaDevices,
      },
      expires_at: expiresAtSec,
    };

    const ciphertextB64 = sealEnrollPayload(payload, ticketId, ephemeralKey);

    let claimUrl: string | undefined;
    if (transportMode === "relay") {
      const masterToken = this.getMasterToken();
      const res = await this.fetchFn(`${relayBase}/v1/enroll/tickets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${masterToken}`,
        },
        body: JSON.stringify({
          ticket_id: ticketId,
          ciphertext_b64: ciphertextB64,
          ttl_sec: ttlSec,
          max_uses: maxUses,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Relay rejected enrollment ticket (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
    } else {
      claimUrl = `${directBase}/enroll/claim/${ticketId}`;
      this.directParcels.set(ticketId, {
        enrollId,
        ticketId,
        clusterId: cfg.clusterId,
        ciphertextB64,
        expiresAtSec,
        remainingUses: maxUses,
        maxUses,
      });
    }

    const scriptBase = transportMode === "relay" ? relayBase : directBase;
    const directFlagPosix = claimUrl ? ` --claim-url "${claimUrl}"` : "";
    const directFlagPs = claimUrl ? ` -ClaimUrl "${claimUrl}"` : "";
    const dockerRelayUrl = relayBase || directBase;
    const commands: EnrollmentCommands = {
      linuxRoot: `curl -fsSL ${scriptBase}/install.sh | sudo bash -s -- --enroll "${enrollCode}"${directFlagPosix}`,
      linuxUser: `curl -fsSL ${scriptBase}/install.sh | bash -s -- --enroll "${enrollCode}"${directFlagPosix}`,
      macos: `curl -fsSL ${scriptBase}/install.sh | bash -s -- --enroll "${enrollCode}"${directFlagPosix}`,
      windows: `irm ${scriptBase}/install.ps1 | iex; Install-NeoAgent -Enroll "${enrollCode}"${directFlagPs}`,
      docker: `docker run -d --name neo-agent-${cfg.clusterId} --restart unless-stopped -v "$HOME/neo-work:/work" -v neo-agent-state:/state ghcr.io/xbhuang1994/neo-agent-os:v${agentVersion} enroll --relay-url "${dockerRelayUrl}"${directFlagPosix} --ticket "${enrollCode}" --mode foreground`,
      uninstall: `neo-agent-os uninstall --cluster "${cfg.clusterId}"`,
    };

    const qrPayload =
      platform === "windows"
        ? commands.windows
        : platform === "macos"
          ? commands.macos
          : platform === "docker"
            ? commands.docker
            : installMode === "user"
              ? commands.linuxUser
              : commands.linuxRoot;

    const record: EnrollmentRecord = {
      id: enrollId,
      ticketId,
      clusterId: cfg.clusterId,
      status: "pending",
      platform,
      profile,
      installMode,
      transportMode,
      authMode,
      ...(requestedDeviceId !== undefined ? { requestedDeviceId } : {}),
      ...(relayBase ? { relayUrl: relayBase } : {}),
      ...(claimUrl !== undefined ? { claimUrl } : {}),
      ttlSec,
      maxUses,
      usedCount: 0,
      claimedCount: 0,
      createdAt: this.nowIso(),
      expiresAt: new Date(expiresAtSec * 1000).toISOString(),
      expiresAtSec,
      enrolledDeviceIds: [],
      policyPreview: policyToml,
    };

    this.saveRecord(record);
    this.activeCommands.set(record.id, {
      enrollCode,
      commands,
      qrPayload,
      expiresAtMs: expiresAtSec * 1000,
    });
    return this.toView(record);
  }

  /** Fetch one enrollment record, optionally syncing live claim status from `neo-relayd`. */
  async getEnrollment(
    id: string,
    opts: { syncRelay?: boolean } = {},
  ): Promise<EnrollmentView | null> {
    let record = this.findRecord(id);
    if (!record) return null;

    record = this.maybeExpireRecord(record);

    if (
      opts.syncRelay &&
      (record.status === "pending" || record.status === "claimed") &&
      record.transportMode === "relay" &&
      record.relayUrl
    ) {
      try {
        const masterToken = this.getMasterToken();
        const res = await this.fetchFn(
          `${record.relayUrl}/v1/enroll/tickets/${encodeURIComponent(record.ticketId)}/status`,
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${masterToken}`,
            },
            signal: AbortSignal.timeout(RELAY_SYNC_TIMEOUT_MS),
          },
        );
        if (res.ok) {
          const data: unknown = await res.json();
          if (isRecord(data)) {
            let changed = false;
            const next: EnrollmentRecord = { ...record };

            const relayStatus = typeof data.status === "string" ? data.status : "";
            if (relayStatus === "claimed" && next.status === "pending") {
              next.status = "claimed";
              changed = true;
            } else if (relayStatus === "expired" && next.status === "pending") {
              next.status = "expired";
              this.activeCommands.delete(next.id);
              changed = true;
            } else if (relayStatus === "revoked" && next.status !== "completed" && next.status !== "revoked") {
              next.status = "revoked";
              next.revokedAt = next.revokedAt ?? this.nowIso();
              this.activeCommands.delete(next.id);
              changed = true;
            }

            if (typeof data.claimed_count === "number" && data.claimed_count > next.claimedCount) {
              next.claimedCount = data.claimed_count;
              changed = true;
            }
            if (typeof data.last_claimed_ip === "string" && data.last_claimed_ip.length > 0 && data.last_claimed_ip !== next.lastClaimedIp) {
              next.lastClaimedIp = data.last_claimed_ip;
              changed = true;
            }

            let claimedIso: string | undefined;
            if (typeof data.last_claimed_at_ms === "number" && data.last_claimed_at_ms > 0) {
              claimedIso = new Date(data.last_claimed_at_ms).toISOString();
            } else if (typeof data.last_claimed_at === "string" && data.last_claimed_at.length > 0) {
              claimedIso = data.last_claimed_at;
            } else if (typeof data.last_claimed_at === "number" && data.last_claimed_at > 0) {
              const ms = data.last_claimed_at > 1e12 ? data.last_claimed_at : data.last_claimed_at * 1000;
              claimedIso = new Date(ms).toISOString();
            }
            if (claimedIso && claimedIso !== next.lastClaimedAt) {
              next.lastClaimedAt = claimedIso;
              changed = true;
            }

            if (changed) {
              record = this.saveRecord(next);
            }
          }
        }
      } catch {
        // Best-effort sync; keep local record state if relay is unreachable or timed out.
      }
    }

    return this.toView(record);
  }

  /** List all persisted enrollments, newest first, auto-expiring stale pending records. */
  listEnrollments(): EnrollmentView[] {
    const keys = this.store.keys(ENROLL_KEY_PREFIX);
    const out: EnrollmentView[] = [];
    for (let i = 0; i < keys.length; i++) {
      const rec = this.store.get<EnrollmentRecord>(keys[i]!);
      if (rec) {
        out.push(this.toView(this.maybeExpireRecord(rec)));
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }

  /** Revoke an enrollment ticket (best-effort relay delete or local direct parcel removal). */
  async revokeEnrollment(id: string): Promise<EnrollmentView> {
    const record = this.findRecord(id);
    if (!record) {
      throw new Error(`Enrollment not found: ${id}`);
    }

    if (record.transportMode === "relay" && record.relayUrl && record.status !== "revoked") {
      try {
        const masterToken = this.getMasterToken();
        await this.fetchFn(
          `${record.relayUrl}/v1/enroll/tickets/${encodeURIComponent(record.ticketId)}`,
          {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${masterToken}`,
            },
            signal: AbortSignal.timeout(RELAY_SYNC_TIMEOUT_MS),
          },
        );
      } catch {
        // Best-effort relay deletion; local revocation still applies immediately.
      }
    } else if (record.transportMode === "direct") {
      this.directParcels.delete(record.ticketId);
    }

    this.activeCommands.delete(record.id);
    const updated: EnrollmentRecord = {
      ...record,
      status: "revoked",
      revokedAt: record.revokedAt ?? this.nowIso(),
    };
    return this.toView(this.saveRecord(updated));
  }

  /** Public handler for Master Direct Mode (`POST /enroll/claim/:id`) with 20 req/min/IP rate limiting. */
  claimDirectEnrollment(ticketId: string, clientIp: string): DirectClaimResult {
    const now = this.nowMs();
    const ipKey = clientIp.trim() || "unknown";
    if (!this.allowClaimRate(ipKey, now)) {
      return {
        ok: false,
        status: 429,
        error: "Rate limit exceeded for enrollment claim",
      };
    }

    const nowSec = Math.floor(now / 1000);
    const parcel = this.directParcels.get(ticketId);
    if (!parcel) {
      const existing = this.findRecord(ticketId);
      if (existing) {
        if (existing.status === "revoked") {
          return { ok: false, status: 410, error: "Enrollment ticket has been revoked" };
        }
        if (existing.status === "expired" || nowSec >= existing.expiresAtSec) {
          this.maybeExpireRecord(existing);
          return { ok: false, status: 410, error: "Enrollment ticket has expired" };
        }
        if (
          existing.status === "claimed" ||
          existing.status === "completed" ||
          existing.claimedCount >= existing.maxUses
        ) {
          return { ok: false, status: 410, error: "Enrollment ticket has already been claimed" };
        }
      }
      return { ok: false, status: 404, error: "Enrollment ticket not found" };
    }

    if (nowSec >= parcel.expiresAtSec) {
      this.directParcels.delete(ticketId);
      const existing = this.findRecord(parcel.enrollId);
      if (existing) {
        this.maybeExpireRecord(existing);
      }
      return { ok: false, status: 410, error: "Enrollment ticket has expired" };
    }

    if (parcel.remainingUses <= 0) {
      this.directParcels.delete(ticketId);
      return { ok: false, status: 410, error: "Enrollment ticket has already been claimed" };
    }

    parcel.remainingUses -= 1;
    if (parcel.remainingUses <= 0) {
      this.directParcels.delete(ticketId);
    }

    const existing = this.findRecord(parcel.enrollId);
    if (existing) {
      const next: EnrollmentRecord = {
        ...existing,
        claimedCount: existing.claimedCount + 1,
        lastClaimedAt: new Date(now).toISOString(),
        lastClaimedIp: ipKey,
        status: existing.status === "pending" ? "claimed" : existing.status,
      };
      this.saveRecord(next);
    }

    return {
      ok: true,
      status: 200,
      ticket_id: parcel.ticketId,
      ciphertext_b64: parcel.ciphertextB64,
      expires_at: parcel.expiresAtSec,
      expires_at_ms: parcel.expiresAtSec * 1000,
    };
  }

  private allowClaimRate(ip: string, nowMs: number): boolean {
    const cutoff = nowMs - DIRECT_CLAIM_WINDOW_MS;
    if (this.claimRateBuckets.size > 10_000) {
      for (const [key, times] of this.claimRateBuckets.entries()) {
        const kept = times.filter((t) => t > cutoff);
        if (kept.length === 0) {
          this.claimRateBuckets.delete(key);
        } else {
          this.claimRateBuckets.set(key, kept);
        }
      }
    }
    const existing = this.claimRateBuckets.get(ip) ?? [];
    const recent = existing.filter((t) => t > cutoff);
    if (recent.length >= DIRECT_CLAIM_RATE_LIMIT) {
      this.claimRateBuckets.set(ip, recent);
      return false;
    }
    recent.push(nowMs);
    this.claimRateBuckets.set(ip, recent);
    return true;
  }

  /**
   * Handle an incoming encrypted `DeviceMessage(kind: "enroll_register")` from a bootstrapping Tier 1 agent.
   * Assigns a sanitized unique `device_id`, mints a permanent 365-day `neo1` token, updates enrollment state,
   * and returns the `enroll_ack` body.
   */
  handleEnrollRegister(
    _srcNodeId: string,
    msg: DeviceMessage,
  ):
    | {
        ok: true;
        enroll_id: string;
        device_id: string;
        cluster_id: string;
        relay_token: string;
      }
    | {
        ok: false;
        enroll_id: string;
        error: string;
      } {
    const cfg = this.getConfig();
    const rawEnrollId = typeof msg.body.enroll_id === "string" ? msg.body.enroll_id.trim() : "";
    if (!cfg || !cfg.enabled) {
      return { ok: false, enroll_id: rawEnrollId, error: "Device control plane is not enabled" };
    }
    if (!cfg.relaySecret && !cfg.clusterSecret) {
      return {
        ok: false,
        enroll_id: rawEnrollId,
        error: "Master cannot mint device tokens",
      };
    }
    if (!rawEnrollId) {
      return { ok: false, enroll_id: "", error: "enroll_id is required" };
    }

    let record = this.findRecord(rawEnrollId);
    if (!record) {
      return { ok: false, enroll_id: rawEnrollId, error: `Unknown enrollment: ${rawEnrollId}` };
    }
    if (record.clusterId !== cfg.clusterId) {
      return {
        ok: false,
        enroll_id: record.id,
        error: "Cross-cluster enrollment registration rejected",
      };
    }

    record = this.maybeExpireRecord(record);
    if (record.status === "revoked") {
      return { ok: false, enroll_id: record.id, error: "Enrollment ticket has been revoked" };
    }
    if (record.status === "expired" || this.nowSec() >= record.expiresAtSec) {
      if (record.status !== "expired") {
        this.saveRecord({ ...record, status: "expired" });
      }
      return { ok: false, enroll_id: record.id, error: "Enrollment ticket has expired" };
    }

    const fingerprint = typeof msg.body.fingerprint === "string" ? msg.body.fingerprint.trim() : "";
    const fingerprints = { ...(record.enrolledFingerprints ?? {}) };
    const existingForFp = fingerprint ? fingerprints[fingerprint] : undefined;

    if (!existingForFp && record.usedCount >= record.maxUses) {
      return { ok: false, enroll_id: record.id, error: "Enrollment ticket usage limit reached" };
    }

    const hostname = typeof msg.body.hostname === "string" ? msg.body.hostname.trim() : "";
    const assignedDeviceId =
      existingForFp ??
      this.allocateUniqueDeviceId(
        record.requestedDeviceId && record.maxUses === 1
          ? record.requestedDeviceId
          : sanitizeHostnameForDeviceId(hostname, record.ticketId),
        fingerprint,
      );

    const relayToken = this.mintToken({
      nodeId: assignedDeviceId,
      tier: "os",
      clusterId: cfg.clusterId,
      ttlSec: PERMANENT_TOKEN_TTL_SEC,
    });

    const nextUsedCount = existingForFp ? record.usedCount : record.usedCount + 1;
    const nextEnrolledIds = record.enrolledDeviceIds.includes(assignedDeviceId)
      ? record.enrolledDeviceIds
      : [...record.enrolledDeviceIds, assignedDeviceId];
    if (fingerprint) {
      fingerprints[fingerprint] = assignedDeviceId;
    }

    const completed = nextUsedCount >= record.maxUses;
    const updated: EnrollmentRecord = {
      ...record,
      usedCount: nextUsedCount,
      enrolledDeviceIds: nextEnrolledIds,
      enrolledFingerprints: fingerprints,
      status: completed ? "completed" : record.status === "pending" ? "claimed" : record.status,
      ...(completed && !record.completedAt ? { completedAt: this.nowIso() } : {}),
    };
    this.saveRecord(updated);
    if (completed) {
      this.activeCommands.delete(updated.id);
      this.directParcels.delete(updated.ticketId);
    }

    return {
      ok: true,
      enroll_id: updated.id,
      device_id: assignedDeviceId,
      cluster_id: cfg.clusterId,
      relay_token: relayToken,
    };
  }

  private allocateUniqueDeviceId(baseId: string, fingerprint: string): string {
    const reservedByOther = new Set<string>();
    const keys = this.store.keys(ENROLL_KEY_PREFIX);
    for (let i = 0; i < keys.length; i++) {
      const rec = this.store.get<EnrollmentRecord>(keys[i]!);
      if (!rec) continue;
      const fpMap = rec.enrolledFingerprints ?? {};
      const ownedBySameFp = new Set<string>();
      if (fingerprint && fpMap[fingerprint]) {
        ownedBySameFp.add(fpMap[fingerprint]!);
      }
      for (let j = 0; j < rec.enrolledDeviceIds.length; j++) {
        const devId = rec.enrolledDeviceIds[j]!;
        if (!ownedBySameFp.has(devId)) {
          reservedByOther.add(devId);
        }
      }
    }

    const isTaken = (candidate: string): boolean => {
      if (reservedByOther.has(candidate)) {
        return true;
      }
      const twin = this.getDevice(candidate);
      if (!twin) {
        return false;
      }
      const twinFp =
        typeof twin.reportedState?.fingerprint === "string" ? twin.reportedState.fingerprint : "";
      if (fingerprint && twinFp && twinFp === fingerprint) {
        return false;
      }
      return true;
    };

    if (!isTaken(baseId)) {
      return baseId;
    }
    for (let suffix = 2; suffix < 1000; suffix++) {
      const candidate = `${baseId}-${suffix}`;
      if (!isTaken(candidate)) {
        return candidate;
      }
    }
    return `${baseId}-${this.nowSec()}`;
  }

  /** Mark an enrollment record completed when a device's `manifest` arrives carrying `body.enroll_id`. */
  markEnrollmentCompleted(
    enrollId: string,
    deviceId: string,
    fingerprint?: string,
  ): EnrollmentView | null {
    const cfg = this.getConfig();
    if (!cfg) return null;
    const record = this.findRecord(enrollId);
    if (!record || record.clusterId !== cfg.clusterId) {
      return null;
    }
    if (record.status === "revoked") {
      return this.toView(record);
    }

    const enrolledDeviceIds = record.enrolledDeviceIds.includes(deviceId)
      ? record.enrolledDeviceIds
      : [...record.enrolledDeviceIds, deviceId];
    const fingerprints = { ...(record.enrolledFingerprints ?? {}) };
    if (fingerprint && fingerprint.trim().length > 0) {
      fingerprints[fingerprint.trim()] = deviceId;
    }

    const updated: EnrollmentRecord = {
      ...record,
      status: "completed",
      usedCount: Math.max(record.usedCount, enrolledDeviceIds.length),
      completedAt: record.completedAt ?? this.nowIso(),
      enrolledDeviceIds,
      ...(Object.keys(fingerprints).length > 0 ? { enrolledFingerprints: fingerprints } : {}),
    };
    this.saveRecord(updated);
    if (updated.usedCount >= updated.maxUses) {
      this.activeCommands.delete(updated.id);
      this.directParcels.delete(updated.ticketId);
    }
    return this.toView(updated);
  }
}
