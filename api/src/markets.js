import { db } from "./db.js";

function percentRaw(numerator, denominator) {
  if (
    numerator === null ||
    numerator === undefined ||
    numerator === "" ||
    denominator === null ||
    denominator === undefined ||
    denominator === ""
  ) {
    return null;
  }

  const a = BigInt(numerator);
  const b = BigInt(denominator);

  if (b === 0n) {
    return null;
  }

  // Percentage with four decimal places of precision.
  const scaled = (a * 1_000_000n) / b;

  return Math.min(
    100,
    Number(scaled) / 10_000,
  );
}

function formatUnits(raw, decimals) {
  if (
    raw === null ||
    raw === undefined ||
    raw === ""
  ) {
    return null;
  }

  const value = BigInt(raw);

  if (decimals === 0) {
    return value.toString();
  }

  const base = 10n ** BigInt(decimals);

  const whole = value / base;
  const fraction = value % base;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionString = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return `${whole}.${fractionString}`;
}

function percentChange(
  currentRaw,
  previousRaw,
) {
  if (
    currentRaw === null ||
    currentRaw === undefined ||
    previousRaw === null ||
    previousRaw === undefined
  ) {
    return null;
  }

  const current = BigInt(currentRaw);
  const previous = BigInt(previousRaw);

  if (previous === 0n) {
    return null;
  }

  const scale = 1_000_000n;

  const scaled =
    (
      (current - previous) *
      scale
    ) / previous;

  return Number(scaled) / 10_000;
}


function currentCurvePriceRaw(
  startingPriceRaw,
  slopeRaw,
  tokensSoldRaw,
  tokenDecimals,
) {
  if (
    startingPriceRaw === null ||
    startingPriceRaw === undefined ||
    slopeRaw === null ||
    slopeRaw === undefined ||
    tokensSoldRaw === null ||
    tokensSoldRaw === undefined ||
    tokenDecimals === null ||
    tokenDecimals === undefined
  ) {
    return null;
  }

  const startingPrice =
    BigInt(startingPriceRaw);

  const slope =
    BigInt(slopeRaw);

  const tokensSold =
    BigInt(tokensSoldRaw);

  const tokenUnit =
    10n ** BigInt(tokenDecimals);

  const slopePrecision =
    10n ** 18n;

  /*
   * Mirrors ReLaunchBondingCurve.currentPrice():
   *
   * STARTING_PRICE
   * + SLOPE * tokensSold
   *   / (TOKEN_UNIT * SLOPE_PRECISION)
   */
  return (
    startingPrice +
    (
      slope * tokensSold /
      (tokenUnit * slopePrecision)
    )
  ).toString();
}


async function getCurvePriceWindows({
  curveAddress,
  startingPriceRaw,
  slopeRaw,
  tokenDecimals,
  quoteDecimals,
  currentPriceRaw,
  activationAt,
}) {
  if (
    !curveAddress ||
    startingPriceRaw === null ||
    startingPriceRaw === undefined ||
    slopeRaw === null ||
    slopeRaw === undefined ||
    tokenDecimals === null ||
    tokenDecimals === undefined ||
    currentPriceRaw === null ||
    currentPriceRaw === undefined
  ) {
    return null;
  }

  const result = await db.query(
    `
      WITH windows (
        window_name,
        cutoff
      ) AS (
        VALUES
          (
            '5m',
            NOW() - INTERVAL '5 minutes'
          ),
          (
            '1h',
            NOW() - INTERVAL '1 hour'
          ),
          (
            '6h',
            NOW() - INTERVAL '6 hours'
          ),
          (
            '24h',
            NOW() - INTERVAL '24 hours'
          ),
          (
            '7d',
            NOW() - INTERVAL '7 days'
          )
      )

      SELECT
        w.window_name,
        w.cutoff,

        (
          SELECT
            c.tokens_sold_after

          FROM api_curveactivity c

          WHERE
            LOWER(c.curve) =
              LOWER($1)

            AND c.event_type IN (
              'CURVE_BUY',
              'CURVE_SELL'
            )

            AND c._block_timestamp_ <=
              w.cutoff

          ORDER BY
            c.block_number DESC,
            c.event_order DESC

          LIMIT 1
        ) AS tokens_sold_at_start

      FROM windows w;
    `,
    [curveAddress],
  );

  const output = {};

  const activationTime =
    activationAt
      ? new Date(activationAt)
      : null;

  for (const row of result.rows) {
    /*
     * If no trade existed before the cutoff, the curve was
     * still at its initial tokensSold = 0 state.
     */
    const tokensSoldAtStart =
      row.tokens_sold_at_start ?? "0";

    const startPriceRaw =
      currentCurvePriceRaw(
        startingPriceRaw,
        slopeRaw,
        tokensSoldAtStart,
        tokenDecimals,
      );

    const cutoff =
      new Date(row.cutoff);

    const marketOpenedInsideWindow =
      activationTime !== null &&
      activationTime > cutoff;

    output[row.window_name] = {
      pct:
        percentChange(
          currentPriceRaw,
          startPriceRaw,
        ),

      start_price_raw:
        startPriceRaw,

      start_price:
        startPriceRaw !== null &&
        quoteDecimals !== null
          ? formatUnits(
              startPriceRaw,
              Number(quoteDecimals),
            )
          : null,

      basis:
        marketOpenedInsideWindow
          ? "since_activation"
          : "window_start",
    };
  }

  return output;
}


export function registerMarketRoutes(app) {
  app.get(
    "/v1/markets/:address",
    async (request, reply) => {
      const address =
        request.params.address.toLowerCase();

      const identityResult = await db.query(
        `
          SELECT
            market,
            market_stage,
            curve,
            pair,
            token,
            quote_token,
            block_number,
            ordinal,
            _block_timestamp_ AS block_timestamp
          FROM api_marketactivity
          WHERE
            LOWER(market) = $1
            OR LOWER(curve) = $1
            OR LOWER(pair) = $1
            OR LOWER(token) = $1
          ORDER BY
            block_number DESC,
            event_order DESC
          LIMIT 1
        `,
        [address],
      );

      if (!identityResult.rowCount) {
        return reply.code(404).send({
          error: "market_not_found",
          address,
        });
      }

      const identity =
        identityResult.rows[0];

      const curveAddress =
        identity.curve;

      const [
        configResult,
        activationResult,
        stateResult,
        latestTradeResult,
        stats24hResult,
      ] = await Promise.all([
        db.query(
          `
            SELECT
              curve,
              token,
              quote_token,
              creator,
              curve_allocation::text
                AS curve_allocation,
              liquidity_reserve::text
                AS liquidity_reserve,
              starting_price::text
                AS starting_price,
              slope::text
                AS slope,
              graduation_threshold::text
                AS graduation_threshold,
              token_decimals,
              creation_block,
              transaction_hash,
              ordinal
            FROM market_config
            WHERE LOWER(curve) = LOWER($1)
            LIMIT 1
          `,
          [curveAddress],
        ),

        db.query(
          `
            SELECT
              allocation,
              token_decimals,
              block_number,
              transaction_hash,
              _block_timestamp_
                AS activated_at
            FROM api_curveactivity
            WHERE
              LOWER(curve) = LOWER($1)
              AND event_type = 'ACTIVATED'
            ORDER BY
              block_number DESC,
              event_order DESC
            LIMIT 1
          `,
          [curveAddress],
        ),

        db.query(
          `
            SELECT
              previous_state,
              new_state,
              block_number,
              transaction_hash,
              _block_timestamp_
                AS changed_at
            FROM api_curveactivity
            WHERE
              LOWER(curve) = LOWER($1)
              AND event_type =
                'CURVE_STATE_CHANGED'
            ORDER BY
              block_number DESC,
              event_order DESC
            LIMIT 1
          `,
          [curveAddress],
        ),

        db.query(
          `
            SELECT
              c.event_id,
              c.event_type,
              c.token_decimals,
              c.token_amount,
              c.curve_quote,
              c.protocol_fee,
              c.gross_quote_in,
              c.net_quote_out,
              c.tokens_sold_after,
              c.quote_reserve_after,
              ta.trader,
              c.actor AS executor,
              c.block_number,
              c.transaction_hash,
              c.ordinal,
              c._block_timestamp_
                AS block_timestamp
            FROM api_curveactivity c

            LEFT JOIN transaction_actor ta
              ON ta.transaction_hash =
                c.transaction_hash

            WHERE
              LOWER(c.curve) = LOWER($1)
              AND c.event_type IN (
                'CURVE_BUY',
                'CURVE_SELL'
              )

            ORDER BY
              c.block_number DESC,
              c.event_order DESC

            LIMIT 1
          `,
          [curveAddress],
        ),

        db.query(
          `
            SELECT
              COUNT(*)::integer
                AS trades,

              COUNT(*) FILTER (
                WHERE c.event_type =
                  'CURVE_BUY'
              )::integer
                AS buys,

              COUNT(*) FILTER (
                WHERE c.event_type =
                  'CURVE_SELL'
              )::integer
                AS sells,

              COUNT(
                DISTINCT ta.trader
              )::integer
                AS unique_traders,

              COUNT(*) FILTER (
                WHERE ta.trader IS NULL
              )::integer
                AS unresolved_trades,

              COALESCE(
                SUM(
                  CASE
                    WHEN c.event_type =
                      'CURVE_BUY'
                    THEN COALESCE(
                      NULLIF(
                        c.gross_quote_in,
                        ''
                      )::numeric,
                      NULLIF(
                        c.curve_quote,
                        ''
                      )::numeric,
                      0
                    )

                    WHEN c.event_type =
                      'CURVE_SELL'
                    THEN COALESCE(
                      NULLIF(
                        c.net_quote_out,
                        ''
                      )::numeric,
                      NULLIF(
                        c.curve_quote,
                        ''
                      )::numeric,
                      0
                    )

                    ELSE 0
                  END
                ),
                0
              )::text
                AS quote_volume_raw,

              MAX(
                c._block_timestamp_
              ) AS last_trade_at

            FROM api_curveactivity c

            LEFT JOIN transaction_actor ta
              ON ta.transaction_hash =
                c.transaction_hash

            WHERE
              LOWER(c.curve) = LOWER($1)

              AND c.event_type IN (
                'CURVE_BUY',
                'CURVE_SELL'
              )

              AND c._block_timestamp_ >=
                NOW() - INTERVAL '24 hours'
          `,
          [curveAddress],
        ),
      ]);

      const config =
        configResult.rows[0] ?? null;

      const activation =
        activationResult.rows[0] ?? null;

      const state =
        stateResult.rows[0] ?? null;

      const latestTrade =
        latestTradeResult.rows[0] ?? null;

      const stats24h =
        stats24hResult.rows[0];

      const metadataResult =
        await db.query(
          `
            SELECT
              (
                SELECT symbol
                FROM token_metadata
                WHERE LOWER(address) =
                  LOWER($1)
                LIMIT 1
              ) AS token_symbol,

              (
                SELECT name
                FROM token_metadata
                WHERE LOWER(address) =
                  LOWER($1)
                LIMIT 1
              ) AS token_name,

              (
                SELECT decimals
                FROM token_metadata
                WHERE LOWER(address) =
                  LOWER($1)
                LIMIT 1
              ) AS token_decimals,

              (
                SELECT symbol
                FROM token_metadata
                WHERE LOWER(address) =
                  LOWER($2)
                LIMIT 1
              ) AS quote_symbol,

              (
                SELECT name
                FROM token_metadata
                WHERE LOWER(address) =
                  LOWER($2)
                LIMIT 1
              ) AS quote_name,

              (
                SELECT decimals
                FROM token_metadata
                WHERE LOWER(address) =
                  LOWER($2)
                LIMIT 1
              ) AS quote_decimals
          `,
          [
            identity.token,
            identity.quote_token,
          ],
        );

      const tokenMetadata =
        metadataResult.rows[0] ?? {};

      const tokenDecimals =
        tokenMetadata.token_decimals ??
        config?.token_decimals ??
        latestTrade?.token_decimals ??
        activation?.token_decimals ??
        null;

      const quoteDecimals =
        tokenMetadata.quote_decimals ??
        null;

      /*
       * Factory CurveCreated configuration is authoritative
       * for the economic split:
       *
       * CURVE_ALLOCATION = sellable curve inventory
       * LIQUIDITY_RESERVE = tokens reserved for graduation
       *
       * The ACTIVATED event's allocation represents the
       * deposited total allocation and must not be used as
       * curve progress denominator.
       */
      const curveAllocationRaw =
        config?.curve_allocation ?? null;

      const liquidityReserveRaw =
        config?.liquidity_reserve ?? null;

      const depositedAllocationRaw =
        activation?.allocation ?? null;

      const graduationThresholdRaw =
        config?.graduation_threshold ?? null;

      const tokensSoldRaw =
        latestTrade?.tokens_sold_after ??
        (config ? "0" : null);

      const quoteReserveRaw =
        latestTrade?.quote_reserve_after ??
        (config ? "0" : null);

      const currentPriceRaw =
        currentCurvePriceRaw(
          config?.starting_price ?? null,
          config?.slope ?? null,
          tokensSoldRaw,
          tokenDecimals,
        );

      const priceChangeFromStartPct =
        percentChange(
          currentPriceRaw,
          config?.starting_price ?? null,
        );

      const priceChangeWindows =
        await getCurvePriceWindows({
          curveAddress,

          startingPriceRaw:
            config?.starting_price ??
            null,

          slopeRaw:
            config?.slope ??
            null,

          tokenDecimals,

          quoteDecimals,

          currentPriceRaw,

          activationAt:
            activation?.activated_at ??
            null,
        });

      const curveProgressPct =
        percentRaw(
          tokensSoldRaw,
          curveAllocationRaw,
        );

      const capitalProgressPct =
        percentRaw(
          quoteReserveRaw,
          graduationThresholdRaw,
        );

      const graduationProgressPct =
        curveProgressPct !== null &&
        capitalProgressPct !== null
          ? Math.min(
              curveProgressPct,
              capitalProgressPct,
            )
          : null;

      const soldOut =
        tokensSoldRaw !== null &&
        curveAllocationRaw !== null &&
        BigInt(tokensSoldRaw) >=
          BigInt(curveAllocationRaw);

      const thresholdReached =
        quoteReserveRaw !== null &&
        graduationThresholdRaw !== null &&
        BigInt(quoteReserveRaw) >=
          BigInt(graduationThresholdRaw);

      /*
       * This represents the two economic graduation gates.
       *
       * Solidity canGraduate() additionally requires:
       * - curveState == Active
       * - graduation pair does not already exist
       */
      const economicGraduationReady =
        soldOut && thresholdReached;

      const trades24h =
        Number(stats24h.trades ?? 0);

      const buys24h =
        Number(stats24h.buys ?? 0);

      const unresolvedTrades24h =
        Number(
          stats24h.unresolved_trades ?? 0,
        );

      return {
        market:
          identity.market,

        stage:
          identity.market_stage,

        curve:
          identity.curve,

        pair:
          identity.pair &&
          identity.pair !== "0x"
            ? identity.pair
            : null,

        token:
          identity.token,

        quote_token:
          identity.quote_token,

        token_info: {
          symbol:
            tokenMetadata.token_symbol ??
            null,

          name:
            tokenMetadata.token_name ??
            null,

          decimals:
            tokenDecimals !== null
              ? Number(tokenDecimals)
              : null,
        },

        quote_info: {
          symbol:
            tokenMetadata.quote_symbol ??
            null,

          name:
            tokenMetadata.quote_name ??
            null,

          decimals:
            quoteDecimals !== null
              ? Number(quoteDecimals)
              : null,
        },

        creator:
          config?.creator ?? null,

        state: {
          previous:
            state?.previous_state ?? null,

          current:
            state?.new_state ?? null,

          changed_at:
            state?.changed_at ?? null,
        },

        curve_config: {
          curve_allocation_raw:
            curveAllocationRaw,

          curve_allocation:
            curveAllocationRaw !== null &&
            tokenDecimals !== null
              ? formatUnits(
                  curveAllocationRaw,
                  Number(tokenDecimals),
                )
              : null,

          liquidity_reserve_raw:
            liquidityReserveRaw,

          liquidity_reserve:
            liquidityReserveRaw !== null &&
            tokenDecimals !== null
              ? formatUnits(
                  liquidityReserveRaw,
                  Number(tokenDecimals),
                )
              : null,

          deposited_total_allocation_raw:
            depositedAllocationRaw,

          deposited_total_allocation:
            depositedAllocationRaw !== null &&
            tokenDecimals !== null
              ? formatUnits(
                  depositedAllocationRaw,
                  Number(tokenDecimals),
                )
              : null,

          starting_price_raw:
            config?.starting_price ?? null,

          starting_price:
            config?.starting_price !== null &&
            config?.starting_price !== undefined &&
            quoteDecimals !== null
              ? formatUnits(
                  config.starting_price,
                  Number(quoteDecimals),
                )
              : null,

          slope_raw:
            config?.slope ?? null,

          graduation_threshold_raw:
            graduationThresholdRaw,

          graduation_threshold:
            graduationThresholdRaw !== null &&
            quoteDecimals !== null
              ? formatUnits(
                  graduationThresholdRaw,
                  Number(quoteDecimals),
                )
              : null,

          token_decimals:
            tokenDecimals !== null
              ? Number(tokenDecimals)
              : null,
        },

        curve_state: {
          tokens_sold_raw:
            tokensSoldRaw,

          tokens_sold:
            tokensSoldRaw !== null &&
            tokenDecimals !== null
              ? formatUnits(
                  tokensSoldRaw,
                  Number(tokenDecimals),
                )
              : null,

          quote_reserve_raw:
            quoteReserveRaw,

          quote_reserve:
            quoteReserveRaw !== null &&
            quoteDecimals !== null
              ? formatUnits(
                  quoteReserveRaw,
                  Number(quoteDecimals),
                )
              : null,

          current_price_raw:
            currentPriceRaw,

          current_price:
            currentPriceRaw !== null &&
            quoteDecimals !== null
              ? formatUnits(
                  currentPriceRaw,
                  Number(quoteDecimals),
                )
              : null,

          price_unit:
            tokenMetadata.quote_symbol &&
            tokenMetadata.token_symbol
              ? `${tokenMetadata.quote_symbol}/${tokenMetadata.token_symbol}`
              : null,

          price_change_from_start_pct:
            priceChangeFromStartPct,

          price_change: {
            "5m":
              priceChangeWindows?.["5m"] ??
              null,

            "1h":
              priceChangeWindows?.["1h"] ??
              null,

            "6h":
              priceChangeWindows?.["6h"] ??
              null,

            "24h":
              priceChangeWindows?.["24h"] ??
              null,

            "7d":
              priceChangeWindows?.["7d"] ??
              null,
          },

          curve_progress_pct:
            curveProgressPct,

          capital_progress_pct:
            capitalProgressPct,

          graduation_progress_pct:
            graduationProgressPct,

          sold_out:
            soldOut,

          threshold_reached:
            thresholdReached,

          economic_graduation_ready:
            economicGraduationReady,
        },

        latest_trade:
          latestTrade
            ? {
                event_id:
                  latestTrade.event_id,

                side:
                  latestTrade.event_type ===
                  "CURVE_BUY"
                    ? "BUY"
                    : "SELL",

                trader:
                  latestTrade.trader,

                executor:
                  latestTrade.executor,

                token_amount_raw:
                  latestTrade.token_amount,

                token_amount:
                  tokenDecimals !== null
                    ? formatUnits(
                        latestTrade.token_amount,
                        Number(tokenDecimals),
                      )
                    : null,

                curve_quote_raw:
                  latestTrade.curve_quote ||
                  null,

                curve_quote:
                  latestTrade.curve_quote &&
                  quoteDecimals !== null
                    ? formatUnits(
                        latestTrade.curve_quote,
                        Number(quoteDecimals),
                      )
                    : null,

                protocol_fee_raw:
                  latestTrade.protocol_fee ||
                  null,

                protocol_fee:
                  latestTrade.protocol_fee &&
                  quoteDecimals !== null
                    ? formatUnits(
                        latestTrade.protocol_fee,
                        Number(quoteDecimals),
                      )
                    : null,

                gross_quote_in_raw:
                  latestTrade.gross_quote_in ||
                  null,

                gross_quote_in:
                  latestTrade.gross_quote_in &&
                  quoteDecimals !== null
                    ? formatUnits(
                        latestTrade.gross_quote_in,
                        Number(quoteDecimals),
                      )
                    : null,

                net_quote_out_raw:
                  latestTrade.net_quote_out ||
                  null,

                net_quote_out:
                  latestTrade.net_quote_out &&
                  quoteDecimals !== null
                    ? formatUnits(
                        latestTrade.net_quote_out,
                        Number(quoteDecimals),
                      )
                    : null,

                transaction_hash:
                  latestTrade.transaction_hash,

                block_number:
                  latestTrade.block_number,

                block_timestamp:
                  latestTrade.block_timestamp,
              }
            : null,

        activity_24h: {
          trades:
            trades24h,

          buys:
            buys24h,

          sells:
            Number(
              stats24h.sells ?? 0,
            ),

          buy_ratio:
            trades24h > 0
              ? Number(
                  (
                    buys24h /
                    trades24h
                  ).toFixed(4),
                )
              : 0,

          unique_traders:
            Number(
              stats24h.unique_traders ?? 0,
            ),

          unresolved_trades:
            unresolvedTrades24h,

          trader_data_complete:
            unresolvedTrades24h === 0,

          quote_volume_raw:
            stats24h.quote_volume_raw ??
            "0",

          quote_volume:
            quoteDecimals !== null
              ? formatUnits(
                  stats24h.quote_volume_raw ??
                    "0",
                  Number(quoteDecimals),
                )
              : null,

          quote_symbol:
            tokenMetadata.quote_symbol ??
            null,

          last_trade_at:
            stats24h.last_trade_at ??
            null,
        },

        metadata: {
          creation_block:
            config?.creation_block ?? null,

          creation_transaction:
            config?.transaction_hash ?? null,

          activation_block:
            activation?.block_number ?? null,

          activation_transaction:
            activation?.transaction_hash ??
            null,

          graduation_data_available:
            config !== null,

          graduation_model:
            "sold_out_and_quote_threshold",
        },
      };
    },
  );
}