#!/usr/bin/env bash
set -euo pipefail

# Provision an isolated Neo Multi-Master cluster across all 4 isolation layers:
#   Layer 1 (Relay):   Independent per-cluster relay secret or HMAC-derived cluster token via neo-relayd
#   Layer 2 (Crypto):  Per-cluster E2E master secret (AES-256-GCM / MCU HMAC-SHA256)
#   Layer 3 (OS/host): Distinct OS user neo-<cluster>, read-only policy-<cluster>.toml, systemd unit/slice drop-ins
#   Layer 4 (Storage): S3/MinIO prefix policy restricting objects to neo-artifacts/<cluster>/*

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLUSTER_ID=""
PROFILE=""
RELAY_URL="https://neo.1inch.cn:18443"
RELAY_BIN="${NEO_RELAYD_BIN:-/nvme/neo-relay/bin/neo-relayd}"
RELAY_SECRET_FILE=""
MASTER_NODE_ID=""
OS_NODE_ID=""
TTL="8760h"
MEMORY_MAX=""
CPU_QUOTA="200%"
CUDA_DEVICES=""
ENABLE_RELAY_BRIDGE=0
MQTT_BIND="127.0.0.1:1883"
OUT_DIR="/etc/neo-agent"
SYSTEMD_DIR="/etc/systemd/system"
WORKSPACE_BASE="/home"
APPLY_SYSTEM=0

usage() {
  cat <<'EOF'
Usage: provision-cluster.sh --cluster <id> [options]

Options:
  --cluster <id>             Cluster identifier ([a-z0-9][a-z0-9_-]{0,31})
  --profile <personal|corp>  Policy template profile (defaults to 'corp' if cluster is 'corp', else 'personal')
  --relay-url <url>          neo-relay base URL (default: https://neo.1inch.cn:18443)
  --relay-bin <path>         Path to neo-relayd binary (default: /nvme/neo-relay/bin/neo-relayd)
  --relay-secret-file <path> Shared relay.env file (optional; if omitted, generates an independent per-cluster secret)
  --master-node-id <id>      Master node ID (default: master-<cluster>)
  --os-node-id <id>          Tier 1 OS agent node ID (default: os-<cluster>-01)
  --ttl <duration>           Token TTL passed to neo-relayd token (default: 8760h)
  --memory-max <size>        cgroup v2 MemoryMax for unit drop-in (default: 2G personal / 4G corp)
  --cpu-quota <percent>      cgroup v2 CPUQuota for unit drop-in (default: 200%)
  --cuda-devices <ids>       Optional CUDA_VISIBLE_DEVICES value (e.g. "0" or "0,1")
  --relay                    Enable Tier 2 MQTT/UART bridge mode (--relay) on neo-agent-os
  --mqtt-bind <addr:port>    MQTT bind address when --relay is set (default: 127.0.0.1:1883)
  --out-dir <dir>            Output directory for policy, env, and S3 JSON (default: /etc/neo-agent)
  --systemd-dir <dir>        Systemd unit/drop-in directory (default: /etc/systemd/system)
  --workspace-base <dir>     Parent directory for neo-<cluster>/work (default: /home)
  --apply                    Create OS user/dirs, install systemd templates, set strict permissions, reload systemd
  -h, --help                 Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_ID="${2:?}"; shift 2 ;;
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --relay-url) RELAY_URL="${2:?}"; shift 2 ;;
    --relay-bin) RELAY_BIN="${2:?}"; shift 2 ;;
    --relay-secret-file) RELAY_SECRET_FILE="${2:?}"; shift 2 ;;
    --master-node-id) MASTER_NODE_ID="${2:?}"; shift 2 ;;
    --os-node-id) OS_NODE_ID="${2:?}"; shift 2 ;;
    --ttl) TTL="${2:?}"; shift 2 ;;
    --memory-max) MEMORY_MAX="${2:?}"; shift 2 ;;
    --cpu-quota) CPU_QUOTA="${2:?}"; shift 2 ;;
    --cuda-devices) CUDA_DEVICES="${2:?}"; shift 2 ;;
    --relay) ENABLE_RELAY_BRIDGE=1; shift ;;
    --mqtt-bind) MQTT_BIND="${2:?}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
    --systemd-dir) SYSTEMD_DIR="${2:?}"; shift 2 ;;
    --workspace-base) WORKSPACE_BASE="${2:?}"; shift 2 ;;
    --apply) APPLY_SYSTEM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$CLUSTER_ID" ]]; then
  echo "Error: --cluster is required" >&2
  usage >&2
  exit 2
fi

if [[ ! "$CLUSTER_ID" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "Error: --cluster must match ^[a-z0-9][a-z0-9_-]{0,31}$" >&2
  exit 2
fi

if [[ -z "$PROFILE" ]]; then
  if [[ "$CLUSTER_ID" == "corp" || "$CLUSTER_ID" == corp-* ]]; then
    PROFILE="corp"
  else
    PROFILE="personal"
  fi
fi

if [[ "$PROFILE" != "personal" && "$PROFILE" != "corp" ]]; then
  echo "Error: --profile must be 'personal' or 'corp'" >&2
  exit 2
fi

if [[ -z "$MEMORY_MAX" ]]; then
  if [[ "$PROFILE" == "corp" ]]; then
    MEMORY_MAX="4G"
  else
    MEMORY_MAX="2G"
  fi
fi

MASTER_NODE_ID="${MASTER_NODE_ID:-master-${CLUSTER_ID}}"
OS_NODE_ID="${OS_NODE_ID:-os-${CLUSTER_ID}-01}"
OS_USER="neo-${CLUSTER_ID}"
WORKSPACE_DIR="${WORKSPACE_BASE}/${OS_USER}/work"
OTA_CACHE_DIR="/var/lib/neo-agent/${CLUSTER_ID}/ota"

POLICY_TEMPLATE="${SCRIPT_DIR}/agent-policy.${PROFILE}.toml"
S3_TEMPLATE="${SCRIPT_DIR}/s3-cluster-policy.json.tmpl"
SERVICE_TEMPLATE="${SCRIPT_DIR}/neo-agent-os@.service"
SLICE_TEMPLATE="${SCRIPT_DIR}/neo-agent-slice@.slice"

for required_file in "$POLICY_TEMPLATE" "$S3_TEMPLATE" "$SERVICE_TEMPLATE" "$SLICE_TEMPLATE"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Error: missing template file: $required_file" >&2
    exit 1
  fi
done

if [[ ! -x "$RELAY_BIN" ]]; then
  echo "Error: neo-relayd binary not found or not executable at $RELAY_BIN" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: openssl is required to generate cluster secrets" >&2
  exit 1
fi

if [[ "$APPLY_SYSTEM" -eq 1 && "$(id -u)" -ne 0 ]]; then
  echo "Error: --apply requires root privileges" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
mkdir -p "${SYSTEMD_DIR}/neo-agent-os@${CLUSTER_ID}.service.d"
mkdir -p "${SYSTEMD_DIR}/neo-agent-slice@${CLUSTER_ID}.slice.d"

# Ensure secrets and tokens are created with 0600 permissions from creation time.
(
  umask 077

  E2E_KEY="$(openssl rand -hex 32)"
  CLUSTER_SECRET=""
  TOKEN_ARGS=()

  if [[ -n "$RELAY_SECRET_FILE" ]]; then
    if [[ ! -r "$RELAY_SECRET_FILE" ]]; then
      echo "Error: cannot read relay secret file: $RELAY_SECRET_FILE" >&2
      exit 1
    fi
    TOKEN_ARGS=(-secret-file "$RELAY_SECRET_FILE")
  else
    CLUSTER_SECRET="$(openssl rand -hex 32)"
    CLUSTER_SECRETS_JSON="${OUT_DIR}/cluster-secrets-${CLUSTER_ID}.json"
    printf '{\n  "%s": "%s"\n}\n' "$CLUSTER_ID" "$CLUSTER_SECRET" > "$CLUSTER_SECRETS_JSON"
    chmod 0600 "$CLUSTER_SECRETS_JSON"
    TOKEN_ARGS=(-cluster-secrets-file "$CLUSTER_SECRETS_JSON")
  fi

  MASTER_TOKEN="$("$RELAY_BIN" token "${TOKEN_ARGS[@]}" -cluster "$CLUSTER_ID" -node "$MASTER_NODE_ID" -tier master -ttl "$TTL")"
  OS_TOKEN="$("$RELAY_BIN" token "${TOKEN_ARGS[@]}" -cluster "$CLUSTER_ID" -node "$OS_NODE_ID" -tier os -ttl "$TTL")"

  EXTRA_ARGS=""
  if [[ "$ENABLE_RELAY_BRIDGE" -eq 1 ]]; then
    EXTRA_ARGS="--relay --mqtt-bind ${MQTT_BIND}"
  fi

  AGENT_ENV_FILE="${OUT_DIR}/cluster-${CLUSTER_ID}.env"
  {
    printf '# Auto-generated Tier 1 OS agent environment for cluster %s\n' "$CLUSTER_ID"
    printf 'NEO_CLUSTER_ID=%s\n' "$CLUSTER_ID"
    printf 'NEO_DEVICE_ID=%s\n' "$OS_NODE_ID"
    printf 'NEO_MASTER_ID=%s\n' "$MASTER_NODE_ID"
    printf 'NEO_RELAY_URL=%s\n' "$RELAY_URL"
    printf 'NEO_RELAY_TOKEN=%s\n' "$OS_TOKEN"
    printf 'NEO_E2E_KEY=%s\n' "$E2E_KEY"
    printf 'NEO_EXTRA_ARGS=%s\n' "$EXTRA_ARGS"
    if [[ -n "$CUDA_DEVICES" ]]; then
      printf 'CUDA_VISIBLE_DEVICES=%s\n' "$CUDA_DEVICES"
    fi
  } > "$AGENT_ENV_FILE"
  chmod 0600 "$AGENT_ENV_FILE"

  MASTER_ENV_FILE="${OUT_DIR}/master-${CLUSTER_ID}.env"
  {
    printf '# Auto-generated Master Neo environment for cluster %s\n' "$CLUSTER_ID"
    printf 'NEO_CLUSTER_ID=%s\n' "$CLUSTER_ID"
    printf 'NEO_MASTER_NODE_ID=%s\n' "$MASTER_NODE_ID"
    printf 'NEO_RELAY_URL=%s\n' "$RELAY_URL"
    printf 'NEO_RELAY_TOKEN=%s\n' "$MASTER_TOKEN"
    if [[ -n "$CLUSTER_SECRET" ]]; then
      printf 'NEO_CLUSTER_SECRET=%s\n' "$CLUSTER_SECRET"
    fi
    printf 'NEO_E2E_KEY=%s\n' "$E2E_KEY"
    printf 'NEO_S3_BUCKET=neo-artifacts\n'
    printf 'NEO_S3_PREFIX=%s/\n' "$CLUSTER_ID"
  } > "$MASTER_ENV_FILE"
  chmod 0600 "$MASTER_ENV_FILE"
)

# Render read-only policy file for this cluster
POLICY_OUT="${OUT_DIR}/policy-${CLUSTER_ID}.toml"
DEFAULT_TEMPLATE_WS="/home/neo-${PROFILE}/work"
if [[ "$WORKSPACE_DIR" != "$DEFAULT_TEMPLATE_WS" ]]; then
  sed "s|${DEFAULT_TEMPLATE_WS}|${WORKSPACE_DIR}|g" "$POLICY_TEMPLATE" > "$POLICY_OUT"
else
  cp "$POLICY_TEMPLATE" "$POLICY_OUT"
fi
chmod 0444 "$POLICY_OUT"

# Render Layer 4 S3/MinIO prefix policy
S3_OUT="${OUT_DIR}/s3-policy-${CLUSTER_ID}.json"
sed "s|\${CLUSTER_ID}|${CLUSTER_ID}|g" "$S3_TEMPLATE" > "$S3_OUT"
chmod 0644 "$S3_OUT"

# Render Layer 3 systemd drop-ins for unit and slice
UNIT_DROPIN="${SYSTEMD_DIR}/neo-agent-os@${CLUSTER_ID}.service.d/10-isolation.conf"
{
  printf '[Service]\n'
  printf 'User=%s\n' "$OS_USER"
  printf 'Group=%s\n' "$OS_USER"
  printf 'WorkingDirectory=%s\n' "$WORKSPACE_DIR"
  printf 'EnvironmentFile=%s/cluster-%s.env\n' "$OUT_DIR" "$CLUSTER_ID"
  printf 'MemoryMax=%s\n' "$MEMORY_MAX"
  printf 'CPUQuota=%s\n' "$CPU_QUOTA"
  printf 'OOMScoreAdjust=-500\n'
  printf 'ReadOnlyPaths=%s\n' "$POLICY_OUT"
  printf 'ReadWritePaths=%s %s\n' "$WORKSPACE_DIR" "/var/lib/neo-agent/${CLUSTER_ID}"
  if [[ -n "$CUDA_DEVICES" ]]; then
    printf 'Environment="CUDA_VISIBLE_DEVICES=%s"\n' "$CUDA_DEVICES"
  fi
} > "$UNIT_DROPIN"

SLICE_DROPIN="${SYSTEMD_DIR}/neo-agent-slice@${CLUSTER_ID}.slice.d/10-limits.conf"
{
  printf '[Slice]\n'
  printf 'MemoryMax=%s\n' "$MEMORY_MAX"
  printf 'CPUQuota=%s\n' "$CPU_QUOTA"
} > "$SLICE_DROPIN"

if [[ "$APPLY_SYSTEM" -eq 1 ]]; then
  if ! id "$OS_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "${WORKSPACE_BASE}/${OS_USER}" --shell /usr/sbin/nologin "$OS_USER"
  fi
  install -d -m 0750 -o "$OS_USER" -g "$OS_USER" "$WORKSPACE_DIR"
  install -d -m 0750 -o "$OS_USER" -g "$OS_USER" "$OTA_CACHE_DIR"
  chown root:root "$POLICY_OUT"
  chmod 0444 "$POLICY_OUT"
  chown "$OS_USER:$OS_USER" "${OUT_DIR}/cluster-${CLUSTER_ID}.env"
  chmod 0600 "${OUT_DIR}/cluster-${CLUSTER_ID}.env"

  install -m 0644 "$SERVICE_TEMPLATE" "${SYSTEMD_DIR}/neo-agent-os@.service"
  install -m 0644 "$SLICE_TEMPLATE" "${SYSTEMD_DIR}/neo-agent-slice@.slice"
  systemctl daemon-reload
fi

cat <<EOF
Provisioned cluster '${CLUSTER_ID}' (profile=${PROFILE}):
  Policy (read-only): ${POLICY_OUT}
  Agent env (0600):   ${OUT_DIR}/cluster-${CLUSTER_ID}.env
  Master env (0600):  ${OUT_DIR}/master-${CLUSTER_ID}.env
  S3 IAM policy:      ${S3_OUT}
  Systemd drop-ins:   ${UNIT_DROPIN}
                      ${SLICE_DROPIN}
EOF
