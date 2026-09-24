#!/bin/sh
set -eu

# DaWabit quota safety gate.
# Substreams ingestion must be explicitly enabled.
if [ "${SUBSTREAMS_SINK_ENABLED:-false}" != "true" ]; then
    echo "[substreams-sink] disabled (set SUBSTREAMS_SINK_ENABLED=true to run)"
    exit 0
fi


WORKDIR="${SUBSTREAMS_WORKDIR:-/workspace/dawabit_substreams}"
ENV_FILE="${SUBSTREAMS_ENV_FILE:-$WORKDIR/.substreams.env}"

cd "$WORKDIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "[substreams-sink] missing auth file: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

if [ -z "${SUBSTREAMS_API_TOKEN:-}" ]; then
  echo "[substreams-sink] SUBSTREAMS_API_TOKEN is not set" >&2
  exit 1
fi

echo "[substreams-sink] starting"
echo "[substreams-sink] endpoint: ${SUBSTREAMS_ENDPOINT}"
echo "[substreams-sink] module: ${SUBSTREAMS_MODULE}"
echo "[substreams-sink] start block: ${SUBSTREAMS_START_BLOCK}"

exec substreams sink postgres \
  "${SUBSTREAMS_MANIFEST}" \
  "${SUBSTREAMS_MODULE}" \
  --dsn "${SUBSTREAMS_SINK_DSN}" \
  --bytes-encoding 0xhex \
  --endpoint "${SUBSTREAMS_ENDPOINT}" \
  --start-block "${SUBSTREAMS_START_BLOCK}" \
  --max-retries=-1
