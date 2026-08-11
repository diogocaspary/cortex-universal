#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"
mkdir -p runtime
command -v curl >/dev/null 2>&1 || { echo "curl nao encontrado." >&2; exit 1; }

CURRENT_TOKEN=$(test -f .env && sed -n 's/^CORTEX_API_TOKEN=//p' .env | head -n 1 || true)
if [ "${#CURRENT_TOKEN}" -lt 32 ]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN=$(openssl rand -base64 48 | tr -d '\n')
  elif command -v node >/dev/null 2>&1; then
    TOKEN=$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64'))")
  else
    echo "Instale Docker ou Node.js 22.16+ antes de continuar." >&2
    exit 1
  fi
  if [ -f .env ]; then
    TMP_ENV=$(mktemp "${TMPDIR:-/tmp}/cortex-env.XXXXXX")
    sed "s|^CORTEX_API_TOKEN=.*|CORTEX_API_TOKEN=$TOKEN|; s|^NODE_ENV=.*|NODE_ENV=development|; s|^HOST=.*|HOST=127.0.0.1|" .env > "$TMP_ENV"
    if ! grep -q '^CORTEX_API_TOKEN=' "$TMP_ENV"; then printf '%s\n' "CORTEX_API_TOKEN=$TOKEN" >> "$TMP_ENV"; fi
    mv "$TMP_ENV" .env
  else
    sed "s|^CORTEX_API_TOKEN=.*|CORTEX_API_TOKEN=$TOKEN|; s|^NODE_ENV=.*|NODE_ENV=development|; s|^HOST=.*|HOST=127.0.0.1|" .env.example > .env
  fi
fi

set_env_value() {
  ENV_NAME=$1
  ENV_VALUE=$2
  ENV_TMP=$(mktemp "${TMPDIR:-/tmp}/cortex-env.XXXXXX")
  if grep -q "^${ENV_NAME}=" .env; then
    sed "s|^${ENV_NAME}=.*|${ENV_NAME}=${ENV_VALUE}|" .env > "$ENV_TMP"
  else
    cp .env "$ENV_TMP"
    printf '%s=%s\n' "$ENV_NAME" "$ENV_VALUE" >> "$ENV_TMP"
  fi
  mv "$ENV_TMP" .env
}

ensure_env_value() {
  ENV_NAME=$1
  ENV_VALUE=$2
  if ! grep -q "^${ENV_NAME}=..*" .env; then set_env_value "$ENV_NAME" "$ENV_VALUE"; fi
}

CURRENT_AUDIT_SECRET=$(sed -n 's/^CORTEX_AUDIT_HMAC_SECRET=//p' .env | head -n 1 || true)
if [ "${#CURRENT_AUDIT_SECRET}" -lt 32 ]; then
  if command -v openssl >/dev/null 2>&1; then
    AUDIT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  else
    AUDIT_SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64'))")
  fi
  set_env_value CORTEX_AUDIT_HMAC_SECRET "$AUDIT_SECRET"
fi

# The one-click profile is loopback-only. Production requires explicit tenant identity settings.
set_env_value NODE_ENV development
set_env_value HOST 127.0.0.1
ensure_env_value PORT 8080
ensure_env_value CORTEX_LOG_LEVEL info
ensure_env_value CORTEX_MAX_BODY_BYTES 1000000
ensure_env_value CORTEX_MAX_RDF_QUADS 10000
ensure_env_value CORTEX_RATE_LIMIT_MAX 120
ensure_env_value CORTEX_DB_PATH runtime/cortex.db
ensure_env_value CORTEX_AGENT_MAX_STEPS 32
ensure_env_value CORTEX_AGENT_MAX_REPEATED_ACTION 3
ensure_env_value CORTEX_ALLOWED_MCP_HOSTS 'localhost,127.0.0.1,[::1]'
chmod 600 .env
PORT_VALUE=$(sed -n 's/^PORT=//p' .env | head -n 1)
case "$PORT_VALUE" in (*[!0-9]*|'') echo "PORT local invalida." >&2; exit 1;; esac
if [ "$PORT_VALUE" -lt 1 ] || [ "$PORT_VALUE" -gt 65535 ]; then
  echo "PORT local fora do intervalo permitido." >&2
  exit 1
fi

EXISTING_MODE=$(test -f runtime/mode && cat runtime/mode || true)
if [ "$EXISTING_MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
    echo "Esta instalacao usa Docker, mas o Docker nao esta disponivel." >&2
    exit 1
  }
  INSTALL_MODE=docker
elif [ "$EXISTING_MODE" = native ]; then
  INSTALL_MODE=native
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  INSTALL_MODE=docker
else
  INSTALL_MODE=native
fi

if [ "$INSTALL_MODE" = docker ]; then
  docker compose up -d --build
  printf '%s\n' docker > runtime/mode
else
  command -v node >/dev/null 2>&1 || { echo "Node.js 22.16+ nao encontrado." >&2; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "npm nao encontrado junto com o Node.js." >&2; exit 1; }
  MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
  [ "$MAJOR" -ge 22 ] || { echo "Node.js 22.16+ e obrigatorio." >&2; exit 1; }
  node -e "require('node:sqlite')" >/dev/null 2>&1 || { echo "Node.js 22.16+ com node:sqlite e obrigatorio." >&2; exit 1; }
  # O motor local exige FTS5, ausente no SQLite embutido do Node 22.13 a 22.15.
  node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')" >/dev/null 2>&1 || { echo "Este Node.js nao traz SQLite com FTS5; use Node.js 22.16+ ou 24+." >&2; exit 1; }
  if [ "$EXISTING_MODE" = native ]; then ./local/unix/stop.sh; fi
  npm ci --ignore-scripts
  npm run check
  npm run build
  printf '%s\n' native > runtime/mode
  ./local/unix/start.sh
fi

i=0
until curl -fsS "http://127.0.0.1:$PORT_VALUE/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 45 ] || { echo "Cortex nao respondeu; consulte runtime/." >&2; exit 1; }
  sleep 1
done
echo "Cortex instalado. Painel: http://127.0.0.1:$PORT_VALUE/dashboard/"
