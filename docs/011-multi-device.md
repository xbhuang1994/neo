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
| 3. Host OS & cgroup v2 | Distinct OS user `neo-%i`, read-only local policy (`/etc/neo-agent/policy-%i.toml`), systemd slice/unit limits, `NoNewPrivileges=true` | [neo-agent-os@.service](../deploy/multi-master/neo-agent-os@.service), [neo-agent-slice@.slice](../deploy/multi-master/neo-agent-slice@.slice) |
| 4. Artifact storage | S3/MinIO IAM policy confining each master to `neo-artifacts/${CLUSTER_ID}/*` and denying cross-cluster listing or reads | [s3-cluster-policy.json.tmpl](../deploy/multi-master/s3-cluster-policy.json.tmpl) |

## Local read-only agent policies

Each Tier 1 OS agent reads an immutable local TOML policy file on startup (`--policy /etc/neo-agent/policy-%i.toml`). The Master Neo control plane cannot relax or overwrite this file over the relay:

- [agent-policy.personal.toml](../deploy/multi-master/agent-policy.personal.toml): restricts workspace access to `/home/neo-personal/work`, permits common development tools, denies destructive/privilege commands, and caps child memory at `2048` MB and execution time at `120` s.
- [agent-policy.corp.toml](../deploy/multi-master/agent-policy.corp.toml): restricts workspace access to `/home/neo-corp/work`, narrows the command allowlist (denying ad-hoc shells and script interpreters), and enforces a `90` s execution timeout.

Both files canonicalize `allowed_workspaces` at load time and reject `..` traversal or symlink escapes.

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

Generated `.env` files are written with `0600` permissions and policy TOML files with `0444` permissions. Never commit generated cluster `.env` files, relay secret files, or minted `neo1` tokens to source control.
