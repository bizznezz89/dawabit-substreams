import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
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

const openapiPath =
  fileURLToPath(
    new URL(
      "../openapi.json",
      import.meta.url,
    ),
  );

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

await app.register(
  swagger,
  {
    mode:
      "static",

    specification: {
      path:
        openapiPath,
    },
  },
);

await app.register(
  swaggerUi,
  {
    routePrefix:
      "/docs",

    staticCSP:
      true,

    uiConfig: {
      docExpansion:
        "list",

      deepLinking:
        true,

      displayOperationId:
        true,
    },
  },
);

app.get(
  "/openapi.json",

  {
    config: {
      rateLimit:
        false,
    },
  },

  async () =>
    app.swagger(),
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

      FROM api_marketactivity

      ${
        where.length
          ? `WHERE ${where.join(
              " AND ",
            )}`
          : ""
      }

      ORDER BY
        block_number DESC,
        event_order DESC

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
            _block_number_,
            _block_timestamp_,
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
            event_id

          FROM api_marketactivity

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
              _block_number_,
              _block_timestamp_,
              event_type,
              canonical_trade,
              curve,
              token,
              quote_token,
              token_decimals,
              actor,
              token_amount,
              curve_quote,
              protocol_fee,
              gross_quote_in,
              net_quote_out,
              tokens_sold_after,
              quote_reserve_after,
              gross_quote_limit,
              actual_quote_in,
              refund_quote,
              allocation,
              previous_state,
              new_state,
              graduation_router,
              graduation_quote_amount,
              block_number,
              transaction_hash,
              ordinal,
              event_id

            FROM api_curveactivity

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
              _block_number_,
              _block_timestamp_,
              event_type,
              pair,
              curve,
              token,
              quote_token,
              sender,
              "to",
              amount0,
              amount1,
              amount0_in,
              amount1_in,
              amount0_out,
              amount1_out,
              reserve0,
              reserve1,
              block_number,
              transaction_hash,
              ordinal,
              token0,
              token1,
              token_is_token0,
              token_amount,
              quote_amount,
              token_amount_in,
              quote_amount_in,
              token_amount_out,
              quote_amount_out,
              token_reserve,
              quote_reserve,
              event_id

            FROM api_ammactivity

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
