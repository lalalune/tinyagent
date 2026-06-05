#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  enable-linger)
    exit 0
    ;;
  *)
    echo "tinyagent loginctl shim only supports enable-linger" >&2
    exit 2
    ;;
esac
