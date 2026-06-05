#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--user" ]]; then
  shift
fi

cmd="${1:-}"
unit="${2:-}"
state_dir="${XDG_RUNTIME_DIR:-/tmp}/tinyagent-systemctl"
pid_dir="${state_dir}/pids"
log_dir="${state_dir}/logs"
mkdir -p "${pid_dir}" "${log_dir}"

unit_name() {
  local value="${1:?unit required}"
  [[ "${value}" == *.service ]] && printf '%s\n' "${value}" || printf '%s.service\n' "${value}"
}

unit_file() {
  printf '%s/.config/systemd/user/%s\n' "${HOME}" "$(unit_name "$1")"
}

pid_file() {
  printf '%s/%s.pid\n' "${pid_dir}" "$(unit_name "$1")"
}

log_file() {
  printf '%s/%s.log\n' "${log_dir}" "$(unit_name "$1")"
}

pid_is_live() {
  local pid="${1:?pid required}"
  kill -0 "${pid}" 2>/dev/null || return 1
  local stat
  stat="$(ps -o stat= -p "${pid}" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "${stat}" && "${stat}" != Z* ]]
}

openclaw_gateway_pid() {
  for pid in $(pgrep -f "openclaw/dist/index.js gateway --port" 2>/dev/null || true); do
    if pid_is_live "${pid}"; then
      printf '%s\n' "${pid}"
      return 0
    fi
  done
  return 1
}

is_running() {
  if [[ "$(unit_name "$1")" == "openclaw-gateway.service" ]] &&
    openclaw_gateway_pid >/dev/null 2>&1; then
    return 0
  fi
  local pid_path
  pid_path="$(pid_file "$1")"
  [[ -f "${pid_path}" ]] || return 1
  local pid
  pid="$(cat "${pid_path}")"
  [[ -n "${pid}" ]] || return 1
  pid_is_live "${pid}"
}

load_unit_env() {
  local file="${1:?unit file required}"
  while IFS= read -r line; do
    [[ "${line}" == Environment=* ]] || continue
    line="${line#Environment=}"
    line="${line%\"}"
    line="${line#\"}"
    [[ "${line}" == *=* ]] || continue
    export "${line}"
  done < "${file}"
}

exec_start() {
  local file="${1:?unit file required}"
  awk -F= '$1 == "ExecStart" { sub(/^ExecStart=/, ""); print; exit }' "${file}"
}

case "${cmd}" in
  daemon-reload|enable)
    exit 0
    ;;
  start)
    file="$(unit_file "${unit}")"
    [[ -f "${file}" ]] || { echo "unit not found: ${file}" >&2; exit 4; }
    if is_running "${unit}"; then
      exit 0
    fi
    load_unit_env "${file}"
    start_cmd="$(exec_start "${file}")"
    [[ -n "${start_cmd}" ]] || { echo "unit has no ExecStart: ${file}" >&2; exit 5; }
    if [[ "$(unit_name "${unit}")" == "openclaw-gateway.service" ]] &&
      [[ -f "${HOME}/.openclaw/openclaw.json" ]]; then
      python3 - "${HOME}/.openclaw/openclaw.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path) as f:
    config = json.load(f)
config.setdefault("gateway", {})["bind"] = "lan"
with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PY
    fi
    nohup bash -lc "exec ${start_cmd}" >>"$(log_file "${unit}")" 2>&1 &
    echo "$!" > "$(pid_file "${unit}")"
    for _ in $(seq 1 20); do
      if is_running "${unit}"; then
        exit 0
      fi
      sleep 0.5
    done
    echo "$(unit_name "${unit}") did not become active" >&2
    tail -n 80 "$(log_file "${unit}")" >&2 2>/dev/null || true
    exit 1
    ;;
  stop)
    if is_running "${unit}"; then
      if [[ -f "$(pid_file "${unit}")" ]]; then
        kill "$(cat "$(pid_file "${unit}")")" 2>/dev/null || true
      fi
      if [[ "$(unit_name "${unit}")" == "openclaw-gateway.service" ]]; then
        pkill -f "openclaw/dist/index.js gateway --port" 2>/dev/null || true
      fi
      rm -f "$(pid_file "${unit}")"
      for _ in $(seq 1 50); do
        is_running "${unit}" || break
        sleep 0.25
      done
    fi
    exit 0
    ;;
  is-active)
    if is_running "${unit}"; then
      echo "active"
      exit 0
    fi
    echo "inactive"
    exit 3
    ;;
  status)
    if is_running "${unit}"; then
      echo "$(unit_name "${unit}") active (tinyagent supervisor)"
      exit 0
    fi
    echo "$(unit_name "${unit}") inactive (tinyagent supervisor)"
    exit 3
    ;;
  *)
    echo "tinyagent systemctl shim only supports --user daemon-reload|enable|start|stop|is-active|status" >&2
    exit 2
    ;;
esac
