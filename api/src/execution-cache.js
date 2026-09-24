import {
  loadMarketExecution,
} from "./market-execution.js";

import {
  config,
} from "./config.js";

/*
 * Executable-depth quotes are deterministic for a
 * given market state, but the chain can move between
 * API requests.
 *
 * A short cache removes bursty duplicate RPC traffic
 * without pretending the quotes are long-lived.
 */
const CACHE_TTL_MS =
  config.executionCacheTtlMs;

const cache =
  new Map();

function cacheKey(
  market,
) {
  return [
    market.market
      .toLowerCase(),

    market.market_stage ??
      "",

    /*
     * The indexed lifecycle fields below cause
     * immediate cache separation when curve state
     * or AMM state changes in the API payload.
     */
    market.tokens_sold_raw ??
      "",

    market.quote_reserve_raw ??
      "",

    market.liquidity
      ?.state_updated_at ??
      "",
  ].join(":");
}

function validEntry(
  entry,
  now,
) {
  return (
    entry &&
    (
      now -
      entry.created_at
    ) <
      CACHE_TTL_MS
  );
}

function pruneExpired(
  now,
) {
  for (
    const [
      key,
      entry,
    ] of cache
  ) {
    if (
      !validEntry(
        entry,
        now,
      )
    ) {
      cache.delete(
        key,
      );
    }
  }
}

export async function loadCachedMarketExecution(
  markets,
) {
  const output =
    new Map();

  if (!markets.length) {
    return output;
  }

  const now =
    Date.now();

  pruneExpired(
    now,
  );

  const misses = [];

  for (
    const market of
    markets
  ) {
    const key =
      cacheKey(
        market,
      );

    const entry =
      cache.get(
        key,
      );

    if (
      validEntry(
        entry,
        now,
      )
    ) {
      output.set(
        market.market
          .toLowerCase(),

        {
          ...entry.value,

          cache: {
            hit:
              true,

            ttl_ms:
              CACHE_TTL_MS,

            age_ms:
              now -
              entry.created_at,
          },
        },
      );

      continue;
    }

    misses.push({
      market,
      key,
    });
  }

  if (misses.length) {
    const live =
      await loadMarketExecution(
        misses.map(
          (item) =>
            item.market,
        ),
      );

    const createdAt =
      Date.now();

    for (
      const {
        market,
        key,
      } of
      misses
    ) {
      const marketAddress =
        market.market
          .toLowerCase();

      const value =
        live.get(
          marketAddress,
        ) ??
        {
          model:
            "trade_router_depth_v1",

          available:
            false,

          venue:
            market.market_stage ??
            null,
        };

      cache.set(
        key,
        {
          created_at:
            createdAt,

          value,
        },
      );

      output.set(
        marketAddress,

        {
          ...value,

          cache: {
            hit:
              false,

            ttl_ms:
              CACHE_TTL_MS,

            age_ms:
              0,
          },
        },
      );
    }
  }

  return output;
}

export function executionCacheStats() {
  const now =
    Date.now();

  pruneExpired(
    now,
  );

  return {
    entries:
      cache.size,

    ttl_ms:
      CACHE_TTL_MS,
  };
}
