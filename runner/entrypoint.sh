#!/usr/bin/env bash
set -euo pipefail

export LOWKEY_HOME="${LOWKEY_HOME:-/opt/lowkey}"
export TINYAGENT_STATE_DIR="${TINYAGENT_STATE_DIR:-/data}"
export GATEWAY_PORT="${GATEWAY_PORT:-3001}"

mkdir -p "${TINYAGENT_STATE_DIR}"

if command -v openclaw >/dev/null 2>&1; then
  exec openclaw gateway \
    --host 0.0.0.0 \
    --port "${GATEWAY_PORT}" \
    --state-dir "${TINYAGENT_STATE_DIR}/openclaw"
fi

echo "tinyagent-runner: openclaw is not installed yet; keeping runner alive for provider exec" >&2
exec sleep infinity
