#!/usr/bin/env bash
# Build and install neo-recovery as a standalone binary and switch systemd user service
# from direct neo-agent.service to neo-recovery.service (which launches and supervises Neo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DEST="${HOME}/.local/bin/neo-recovery"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_DEST="${UNIT_DIR}/neo-recovery.service"

echo "[1/4] Building standalone zero-dependency binary..."
(cd "${ROOT}" && bun run build)

echo "[2/4] Installing binary to ${BIN_DEST}..."
mkdir -p "$(dirname "${BIN_DEST}")" "${UNIT_DIR}"
install -m 0755 "${ROOT}/dist/neo-recovery" "${BIN_DEST}"

echo "[3/4] Running doctor check..."
"${BIN_DEST}" doctor --repo-dir /nvme/workspace/neo --target-bin /nvme/workspace/neo/backend/dist/neo-agent

echo "[4/4] Installing systemd user unit to ${UNIT_DEST}..."
install -m 0644 "${ROOT}/systemd/neo-recovery-user.service" "${UNIT_DEST}"
systemctl --user daemon-reload

echo ""
echo "Installed ${UNIT_DEST}."
echo "To switch over from direct neo-agent.service to neo-recovery.service, run:"
echo "  systemctl --user disable --now neo-agent.service"
echo "  systemctl --user enable --now neo-recovery.service"
echo "  systemctl --user status neo-recovery.service"
