# 011 Multi-device control

This document describes how Neo extends from one host to personal and corporate device fleets across networks, while keeping separate Master Neo clusters isolated. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md).

## Topology and device tiers

A deployment pairs one or more independent **Master Neo** control planes (`backend/src/devices`) with edge devices in two execution tiers:

| Tier | Runtime | Transport | Responsibilities |
| --- | --- | --- | --- |
| Master control plane | TypeScript / Bun (`neo-agent`) | HTTPS `/v1/bootstrap`, WSS `/v1/signal`, WSS `/v1/relay` | Device twin persistence, risk gating, desired-state shadow queue, route selection |
| Tier 1 OS agent | Rust binary (`neo-agent-os`) | P2P UDP punch (RFC 5389 STUN) with WSS relay fallback | Sandboxed `exec`, `fs`, `transfer`, capability probing, optional `--relay` bridge |
| Tier 2 MCU | C99 static library (`libneo_mcu.a`) | LAN MQTT 3.1.1 or COBS-framed UART/RS485 via Tier 1 `--relay` | Static action table, physical bounds checks, Deep Sleep shadow sync, A/B OTA |

When a Tier 1 OS agent runs with `--relay`, it embeds a local MQTT broker and UART/RS485 COBS codec to bridge Tier 2 MCUs to Master Neo. The Tier 1 bridge forwards opaque `RelayEnvelope` payloads without holding the Tier 2 MCU E2E key, and marks child MCUs `unreachable_via_relay` if the bridge disconnects so Master Neo suppresses redundant child alerts and can fail over to a backup relay.

## Four-layer multi-master isolation

A single relay server (`neo-relayd`) and shared host hardware can serve independent masters (for example `personal` and `corp`) without cross-cluster visibility or privilege leakage:

| Layer | Mechanism | Artifact |
| --- | --- | --- |
| 1. Relay control plane | Per-cluster HMAC-SHA256 `neo1` tokens and cluster-scoped `/v1/peers` + `/v1/relay` routing (`0x81 ErrOffline` across clusters) | [provision-cluster.sh](../deploy/multi-master/provision-cluster.sh) |
| 2. End-to-end cryptography | Per-cluster AES-256-GCM (`0xE1`, AAD `cluster_id\|src\|dst`) for Tier 1 and HMAC-SHA256 (`neo-mcu-e2e-v1`) for Tier 2 | [provision-cluster.sh](../deploy/multi-master/provision-cluster.sh) |
| 3. Host OS & cgroup v2 | Distinct OS user `neo-%i`, local sandbox policy (`/etc/neo-agent/policy-%i.toml`, with opt-in `lock_sandbox = true`), systemd slice/unit limits, `NoNewPrivileges=true` | [neo-agent-os@.service](../deploy/multi-master/neo-agent-os@.service), [neo-agent-slice@.slice](../deploy/multi-master/neo-agent-slice@.slice) |
| 4. Artifact storage | S3/MinIO IAM policy confining each master to `neo-artifacts/${CLUSTER_ID}/*` and denying cross-cluster listing or reads | [s3-cluster-policy.json.tmpl](../deploy/multi-master/s3-cluster-policy.json.tmpl) |

## Per-device sandbox levels and runtime switching

Each Tier 1 OS agent enforces one of 5 sandbox permission levels (`sandbox_level` in its local TOML policy, from most restricted to completely unrestricted):

| Level | `read_only` / `unrestricted` | Command & workspace limits | Default limits (`mem` / `timeout` / `output`) |
| --- | --- | --- | --- |
| `readonly` | `read_only = true` | Inspection-only allowlist (`ls`, `cat`, `rg`, `git`, …); mutating commands and shells denied; workspace-confined | `1024` MB / `60` s / `1` MiB |
| `corp` | `false` / `false` | Narrow corporate dev allowlist; ad-hoc shells and script interpreters denied; workspace-confined | `4096` MB / `90` s / `1` MiB |
| `personal` | `false` / `false` | Standard personal dev tools (`git`, `cargo`, `bun`, `python3`, `make`, …); destructive/privilege commands denied; workspace-confined | `2048` MB / `120` s / `1` MiB |
| `desktop` | `false` / `false` | Personal tools plus desktop/UI tooling (`node`, `npm`, `flutter`, `dart`, `open`/`xdg-open`, …); workspace-confined | `4096` MB / `180` s / `1` MiB |
| `unrestricted` | `unrestricted = true` | Completely unrestricted execution for trusted hosts (no workspace or command allowlist/denylist limits) | `0` (no cap) / `0` (no timeout cap) / `8` MiB |

Workspace-confined profiles (`readonly`, `corp`, `personal`, `desktop`) canonicalize `allowed_workspaces` at load time and reject `..` traversal or symlink escapes. Example static presets remain in [agent-policy.personal.toml](../deploy/multi-master/agent-policy.personal.toml) and [agent-policy.corp.toml](../deploy/multi-master/agent-policy.corp.toml), and all 5 presets are available during one-click enrollment (`profile`).

Runtime switching via Master Neo:

- Operators switch a Tier 1 OS device's level at runtime via `PUT /api/devices/:id/sandbox` (`{ "level": "<level>", "workspaces"?: [...], "timeoutMs"?: number }`). Master Neo persists `desiredSandboxLevel` on the Device Twin and sends an E2E-encrypted `set_sandbox` RPC to `neo-agent-os`.
- If the device is offline or unreachable, Master Neo records `sandboxSyncState = "pending"` and automatically pushes `set_sandbox` when the agent reconnects and publishes its `manifest`.
- Autonomous LLM tool invocations (`device_invoke` with action `set_sandbox` or `sandbox.set`) are gated as `confirm_required` and require explicit operator approval.
- Hosts requiring strict local immutability can opt in by setting `lock_sandbox = true` in the agent's local TOML policy; locked agents reject remote `set_sandbox` RPCs and `PUT /api/devices/:id/sandbox` responds with HTTP `403`.

## Provisioning and running an isolated cluster

Use [provision-cluster.sh](../deploy/multi-master/provision-cluster.sh) to generate per-cluster secrets, mint `master` and `os` tier tokens via `neo-relayd token`, render the S3 prefix policy, and write systemd drop-ins:

```sh
# Stage configuration into a directory without touching system paths
./deploy/multi-master/provision-cluster.sh \
  --cluster personal \
  --profile personal \
  --relay-url https://neo.1inch.cn:18443 \
  --out-dir /tmp/neo-personal \
  --systemd-dir /tmp/neo-personal/systemd

# Production install on Linux (creates user neo-corp, sets 0444/0600 permissions, reloads systemd)
sudo ./deploy/multi-master/provision-cluster.sh \
  --cluster corp \
  --profile corp \
  --relay-url https://neo.1inch.cn:18443 \
  --cuda-devices 0 \
  --relay \
  --apply

sudo systemctl enable --now neo-agent-os@corp.service
```

Generated `.env` files are written with `0600` permissions and policy TOML files with `0444` permissions. Never commit generated cluster `.env` files, relay secret files, or minted `neo1` tokens to source control. Secrets (`NEO_TOKEN` / `NEO_RELAY_TOKEN` and `NEO_E2E_KEY`) are loaded via `EnvironmentFile` (systemd) or `--env-file` (macOS `launchd` / Windows Scheduled Tasks) and are never passed on `argv`.

## One-click enrollment & cross-platform Tier 1 agents

`neo-agent-os` runs natively on Linux (`x64`, `arm64`), macOS (`arm64`, `x64`), and Windows (`x64`), and includes built-in zero-trust `enroll` and `uninstall` commands:

```sh
# Enroll via stdin ticket (never exposes ticket on argv)
printf '%s\n' "$NEO_ENROLL_TICKET" | neo-agent-os enroll \
  --relay-url https://neo.1inch.cn:18443 \
  --ticket-stdin \
  --mode auto

# Container / Docker foreground mode (writes policy + .env and runs immediately)
neo-agent-os enroll --relay-url https://neo.1inch.cn:18443 --ticket-stdin --mode foreground

# Clean teardown (preserves workspace unless --purge-workspace is specified)
neo-agent-os uninstall --cluster personal
```

Enrollment flow:

1. Parses `neo_enr_v1.<ticket_id>.<ephemeral_key>` and POSTs `/v1/enroll/claim/<ticket_id>` to fetch the one-time opaque ciphertext blob.
2. Decrypts the `[0xE2][12B nonce][AES-256-GCM ciphertext || 16B tag]` envelope locally with key `SHA-256("neo-enroll-v1:<ticket_id>:<ephemeral_key>")` and AAD `"neo-enroll-v1|<ticket_id>"` so the relay never sees plaintext secrets.
3. For `auth_mode = "bootstrap_exchange"`, connects briefly to `/v1/relay` and exchanges an E2E-encrypted `enroll_register` / `enroll_ack` handshake with Master Neo to obtain the permanent `device_id` and `relay_token`.
4. Renders `{{WORKSPACE_DIR}}` into `policy-<cluster>.toml` (`0444`) and writes `cluster-<cluster>.env` (`0600`), sends an initial `manifest` containing `enroll_id`, and installs the native OS service (`systemd` system or user unit on Linux, `launchd` LaunchAgent on macOS, or Scheduled Task with restricted `.env` ACL on Windows).

## Direct binary file transfer channel (`0xE3`) & `fs.stat`

Master Neo and Tier 1 `neo-agent-os` nodes transfer files directly disk-to-disk without routing file bytes through LLM context or requiring external object storage:

- **`fs.stat` / `fs_stat` RPC**: inspects path metadata (`exists`, `kind`, `size`, `mode`, `mtime_ms`, `ctime_ms`, optional streaming `sha256`) strictly within `allowed_workspaces` (rejecting traversal or out-of-workspace symlink escapes without leaking existence).
- **Control plane (`0xE1` RPC)**: `file.pull.open`, `file.push.open`, and `file.transfer.abort` enforce local sandbox policy, negotiate `chunk_size` (default `128 KiB`, clamped `4 KiB..512 KiB`) and sliding `window_bytes` (default `512 KiB`), and support resumable `.neo-part-<transfer_id>` staging files.
- **Data plane (`0xE3` binary AEAD envelope)**: raw file chunks, cumulative `ACK`, `FINISH` (32-byte SHA-256), `DONE`, and `ABORT` frames are encrypted with the cluster E2E key (`AES-256-GCM`, AAD `file-v1|<cluster_id>|<src_id>|<dst_id>`) and forwarded opaquely inside `FLAG_DATA` relay frames with zero base64 overhead, sliding-window flow control, `FLAG_ERR_RATE` (`0x83`) adaptive backoff, end-to-end SHA-256 verification, and atomic rename commit.
- **Interfaces**: exposed via the `device_file_transfer` tool (main and worker sessions), `DeviceManager.statFile` / `pullFile` / `pushFile` / `listTransfers` / `cancelTransfer`, and HTTP API endpoints (`/api/devices/:id/files/{stat,pull,push}`, `/api/devices/transfers`), with automatic `rpc_fallback` (`fs_read` / `transfer_chunk`) for legacy Tier 1 agents.
