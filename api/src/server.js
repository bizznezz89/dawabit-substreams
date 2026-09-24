import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import {
  config,
} from "./config.js";

import {
  db,
  checkDatabase,
} from "./db.js";

import {
  registerTrendingRoute,
} from "./trending.js";

import {
  registerMarketRoutes,
} from "./markets.js";

import {
  registerQuoteRoute,
} from "./quote.js";

const app =
  Fastify({
    logger:
      true,

    /*
     * false by default.
     *
     * X-Forwarded-For is trusted only when
     * TRUST_PROXY_CIDRS explicitly contains
     * known proxy addresses/networks.
     */
    trustProxy:
      config.trustProxy,
  });

await app.register(
  cors,
  {
    origin:
      true,
  },
);

await app.register(
  rateLimit,
  {
    global:
      true,

    max:
      config
        .rateLimit
        .globalMax,

    timeWindow:
      config
        .rateLimit
        .windowMs,

    /*
     * request.ip is derived from the socket unless
     * Fastify explicitly trusts the connecting proxy.
     */
    keyGenerator:
      (request) =>
        request.ip,

    errorResponseBuilder:
      (
        request,
        context,
      ) => ({
        statusCode:
          429,

        error:
          "rate_limit_exceeded",

        message:
          "Too many requests",

        max:
          context.max,

        retry_after_ms:
          context.ttl,

        route:
          request
            .routeOptions
            ?.url ??
          request.url,
      }),
  },
);

registerTrendingRoute(
  app,
);

registerMarketRoutes(
  app,
);

registerQuoteRoute(
  app,
);

app.get(
  "/health",

  {
    config: {
      /*
       * Health checks must remain usable by
       * container/orchestrator probes.
       */
      rateLimit:
        false,
    },
  },

  async () => {
    const database =
      await checkDatabase();

    return {
      ok:
        true,

      service:
        "dawabit-api",

      environment:
        config.nodeEnv,

      database,

      configuration: {
        database_source:
          config.databaseSource,

        rhc_rpc_source:
          config.rhcRpcSource,

        trust_proxy_enabled:
          config.trustProxy !==
          false,

        execution_cache_ttl_ms:
          config
            .executionCacheTtlMs,

        rate_limit: {
          window_ms:
            config
              .rateLimit
              .windowMs,

          global_max:
            config
              .rateLimit
              .globalMax,

          quote_max:
            config
              .rateLimit
              .quoteMax,
        },
      },
    };
  },
);

app.get(
  "/v1/activity",

  async (
    request,
  ) => {
    const {
      market,
      token,
      event_type,
      market_stage,
      canonical_trade,
      limit = "50",
    } =
      request.query;

    const values = [];
    const where = [];

    const add = (
      column,
      value,
    ) => {
      values.push(
        value,
      );

      where.push(
        `${column} = $${values.length}`,
      );
    };

    if (market) {
      add(
        "market",
        market.toLowerCase(),
      );
    }

    if (token) {
      add(
        "token",
        token.toLowerCase(),
      );
    }

    if (event_type) {
      add(
        "event_type",
        event_type,
      );
    }

    if (market_stage) {
      add(
        "market_stage",
        market_stage,
      );
    }

    if (
      canonical_trade !==
      undefined
    ) {
      add(
        "canonical_trade",
        canonical_trade ===
          "true",
      );
    }

    const safeLimit =
      Math.min(
        Math.max(
          Number.parseInt(
            limit,
            10,
          ) || 50,

          1,
        ),

        500,
      );

    values.push(
      safeLimit,
    );

    const sql = `
      SELECT
        event_id,
        market_stage,
        event_type,
        canonical_trade,
        market,
        curve,
        pair,
        token,
        quote_token,
        block_number,
        transaction_hash,
        ordinal,
        _block_timestamp_
          AS block_timestamp

      FROM marketactivity

      ${
        where.length
          ? `WHERE ${where.join(
              " AND ",
            )}`
          : ""
      }

      ORDER BY
        block_number DESC,
        ordinal DESC

      LIMIT $${values.length}
    `;

    const result =
      await db.query(
        sql,
        values,
      );

    return {
      count:
        result.rowCount,

      activity:
        result.rows,
    };
  },
);

app.get(
  "/v1/activity/:eventId",

  async (
    request,
    reply,
  ) => {
    const {
      eventId,
    } =
      request.params;

    const market =
      await db.query(
        `
          SELECT
            *

          FROM marketactivity

          WHERE
            event_id = $1
        `,
        [
          eventId,
        ],
      );

    if (
      !market.rowCount
    ) {
      return reply
        .code(
          404,
        )
        .send({
          error:
            "activity_not_found",
        });
    }

    const row =
      market.rows[0];

    let details =
      null;

    if (
      row.market_stage ===
      "CURVE"
    ) {
      const result =
        await db.query(
          `
            SELECT
              *

            FROM curveactivity

            WHERE
              event_id = $1
          `,
          [
            eventId,
          ],
        );

      details =
        result.rows[0] ??
        null;
    } else if (
      row.market_stage ===
      "AMM"
    ) {
      const result =
        await db.query(
          `
            SELECT
              *

            FROM ammactivity

            WHERE
              event_id = $1
          `,
          [
            eventId,
          ],
        );

      details =
        result.rows[0] ??
        null;
    }

    return {
      activity:
        row,

      details,
    };
  },
);

await app.listen({
  port:
    config.port,

  host:
    config.host,
});
