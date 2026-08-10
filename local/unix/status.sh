#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
command -v curl >/dev/null 2>&1 || { echo "curl nao encontrado." >&2; exit 1; }
PORT_VALUE=$(test -f "$REPOSITORY_ROOT/.env" && sed -n 's/^PORT=//p' "$REPOSITORY_ROOT/.env" | head -n 1 || true)
case "$PORT_VALUE" in (*[!0-9]*|'') PORT_VALUE=8080;; esac

if curl -fsS "http://127.0.0.1:$PORT_VALUE/readyz" >/dev/null 2>&1; then
  echo "Cortex esta pronto. Painel: http://127.0.0.1:$PORT_VALUE/dashboard/"
else
  echo "Cortex esta parado ou ainda nao ficou pronto." >&2
  exit 1
fi
