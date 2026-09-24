#!/bin/sh
set -eu

DAWABIT_DB="${DAWABIT_DB:-dawabit}"
API_SUPPORT_SQL="${API_SUPPORT_SQL:-/bootstrap/api-support.sql}"

echo "[dawabit-init] ensuring database exists: ${DAWABIT_DB}"

database_exists="$(
  psql \
    --username "$POSTGRES_USER" \
    --dbname postgres \
    --tuples-only \
    --no-align \
    --command "SELECT 1 FROM pg_database WHERE datname = '${DAWABIT_DB}'"
)"

if [ "$database_exists" != "1" ]; then
  psql \
    --username "$POSTGRES_USER" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command "CREATE DATABASE \"${DAWABIT_DB}\""
fi

echo "[dawabit-init] applying API support schema"

psql \
  --username "$POSTGRES_USER" \
  --dbname "$DAWABIT_DB" \
  --set ON_ERROR_STOP=1 \
  --file "$API_SUPPORT_SQL"

echo "[dawabit-init] complete"
