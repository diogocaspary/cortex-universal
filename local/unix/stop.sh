#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"
MODE=$(test -f runtime/mode && cat runtime/mode || true)

if [ "$MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 || { echo "Docker nao encontrado." >&2; exit 1; }
  docker compose down
elif [ "$MODE" = native ] && [ -f runtime/cortex.pid ]; then
  PID=$(cat runtime/cortex.pid)
  case "$PID" in (*[!0-9]*|'') echo "PID local invalido; nada foi encerrado." >&2; exit 1;; esac
  if ps -p "$PID" -o args= 2>/dev/null | grep -F 'dist/server.js' >/dev/null 2>&1; then
    kill "$PID"
  elif kill -0 "$PID" 2>/dev/null; then
    echo "O PID pertence a outro programa; nada foi encerrado." >&2
    exit 1
  fi
  rm -f runtime/cortex.pid
fi
echo "Cortex parado com seguranca."
