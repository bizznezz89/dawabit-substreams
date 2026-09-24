#!/bin/sh
set -eu

INTERVAL_SECONDS="${RHC_RPC_POLL_INTERVAL_SECONDS:-15}"

echo "[rhc-rpc-indexer] starting"
echo "[rhc-rpc-indexer] poll interval: ${INTERVAL_SECONDS}s"

while true; do
    echo "[rhc-rpc-indexer] catch-up pass starting"

    if node /app/scripts/rhc-rpc-catchup.js; then
        echo "[rhc-rpc-indexer] catch-up pass complete"
    else
        status=$?
        echo "[rhc-rpc-indexer] catch-up pass failed with status ${status}" >&2
    fi

    sleep "${INTERVAL_SECONDS}"
done
