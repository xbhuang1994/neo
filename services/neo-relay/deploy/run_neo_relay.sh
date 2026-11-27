#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${NEO_RELAY_ENV:-/nvme/neo-relay/config/relay.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec /nvme/neo-relay/bin/neo-relayd
