#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"
command -v curl >/dev/null 2>&1 || { echo "curl nao encontrado." >&2; exit 1; }
MODE=$(test -f runtime/mode && cat runtime/mode || true)
PORT_VALUE=$(test -f .env && sed -n 's/^PORT=//p' .env | head -n 1 || true)
case "$PORT_VALUE" in (*[!0-9]*|'') echo "PORT local invalida." >&2; exit 1;; esac
if [ "$PORT_VALUE" -lt 1 ] || [ "$PORT_VALUE" -gt 65535 ]; then
  echo "PORT local fora do intervalo permitido." >&2
  exit 1
fi

if [ "$MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
    echo "Docker nao esta em execucao." >&2
    exit 1
  }
  docker compose up -d
elif [ "$MODE" = native ]; then
  command -v node >/dev/null 2>&1 || { echo "Node.js 22.16+ nao encontrado." >&2; exit 1; }
  MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
  [ "$MAJOR" -ge 22 ] || { echo "Node.js 22.16+ e obrigatorio." >&2; exit 1; }
  node -e "require('node:sqlite')" >/dev/null 2>&1 || { echo "Node.js 22.16+ com node:sqlite e obrigatorio." >&2; exit 1; }
  # O motor local exige FTS5, ausente no SQLite embutido do Node 22.13 a 22.15.
  node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')" >/dev/null 2>&1 || { echo "Este Node.js nao traz SQLite com FTS5; use Node.js 22.16+ ou 24+." >&2; exit 1; }
  [ -f dist/server.js ] || { echo "Build ausente; execute install.sh novamente." >&2; exit 1; }
  if [ -f runtime/cortex.pid ]; then
    PID=$(cat runtime/cortex.pid)
    case "$PID" in (*[!0-9]*|'') echo "PID local invalido; nada foi iniciado." >&2; exit 1;; esac
    PROCESS_ARGS=$(ps -p "$PID" -o args= 2>/dev/null || true)
    if printf '%s' "$PROCESS_ARGS" | grep -F 'dist/server.js' >/dev/null 2>&1; then
      echo "Cortex ja esta em execucao (PID $PID)."
    elif [ -n "$PROCESS_ARGS" ]; then
      echo "O PID pertence a outro programa; nada foi iniciado." >&2
      exit 1
    else
      rm -f runtime/cortex.pid
    fi
  fi
  if [ ! -f runtime/cortex.pid ]; then
    nohup node --env-file=.env dist/server.js > runtime/cortex.log 2> runtime/cortex-error.log &
    printf '%s\n' "$!" > runtime/cortex.pid
  fi
else
  echo "Instalacao nao encontrada; execute install.sh." >&2
  exit 1
fi

i=0
until curl -fsS "http://127.0.0.1:$PORT_VALUE/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 45 ] || { echo "Cortex nao respondeu; consulte runtime/." >&2; exit 1; }
  sleep 1
done
echo "Cortex iniciado. Painel: http://127.0.0.1:$PORT_VALUE/dashboard/"
