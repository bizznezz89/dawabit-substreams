import { db } from "./db.js";
import { hydrateTransactionActors } from "./transactions.js";
import { loadMarketPriceMomentum } from "./trending-price.js";

const WINDOWS = {
  "5m": 300,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
};

const NEW_MARKET_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const TRENDING_MIN_SCORE = 50;
const TRENDING_MIN_TRADES = 3;
const TRENDING_MIN_UNIQUE_TRADERS = 2;

const DISCOVERY_KEYWORDS =
  new Set([
    "new",
    "trending",
  ]);

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function roundScore(value) {
  return Number(
    value.toFixed(2),
  );
}

function safeTimestamp(value) {
  if (!value) {
    return 0;
  }

  const timestamp =
    new Date(value).getTime();

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

function formatUnits(
  raw,
  decimals,
) {
  if (
    raw === null ||
    raw === undefined ||
    raw === "" ||
    decimals === null ||
    decimals === undefined
  ) {
    return null;
  }

  const value =
    BigInt(raw);

  const places =
    Number(decimals);

  if (places === 0) {
    return value.toString();
  }

  const base =
    10n ** BigInt(places);

  const whole =
    value / base;

  const fraction =
    value % base;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionString =
    fraction
      .toString()
      .padStart(
        places,
        "0",
      )
      .replace(
        /0+$/,
        "",
      );

  return `${whole}.${fractionString}`;
}

function percentRaw(
  numerator,
  denominator,
) {
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

  const a =
    BigInt(numerator);

  const b =
    BigInt(denominator);

  if (b === 0n) {
    return null;
  }

  const scaled =
    (
      a *
      1_000_000n
    ) /
    b;

  return Math.min(
    100,
    Number(scaled) /
      10_000,
  );
}

function calculateTrendScoreV3({
  trades,
  uniqueTraders,
  activityVelocity,
  volumeVelocity,
  traderVelocity,
  priceChangePct,
  buyPressure,
  lastTradeAt,
  windowSeconds,
  coldStart,
}) {
  /*
   * DaWabit Momentum v3
   *
   * 20  trade activity
   * 15  unique trader participation
   * 15  trade acceleration
   * 10  volume acceleration
   * 10  trader acceleration
   * 15  spot-price movement
   *  5  buy pressure
   *  5  recency
   *  5  cold-start signal
   * ---
   * 100
   */

  const tradeActivity =
    Math.min(
      20,
      Math.log1p(
        Math.max(
          0,
          trades,
        ),
      ) * 8,
    );

  const traderParticipation =
    Math.min(
      15,
      Math.log1p(
        Math.max(
          0,
          uniqueTraders,
        ),
      ) * 9,
    );

  const activityAcceleration =
    activityVelocity === null
      ? 0
      : Math.min(
          15,
          Math.max(
            0,
            activityVelocity - 1,
          ) * 5,
        );

  const volumeAcceleration =
    volumeVelocity === null
      ? 0
      : Math.min(
          10,
          Math.max(
            0,
            volumeVelocity - 1,
          ) * (10 / 3),
        );

  const traderAcceleration =
    traderVelocity === null
      ? 0
      : Math.min(
          10,
          Math.max(
            0,
            traderVelocity - 1,
          ) * (10 / 3),
        );

  const priceMovement =
    priceChangePct === null
      ? 0
      : Math.min(
          15,
          Math.abs(
            priceChangePct,
          ) * 1.5,
        );

  const pressure =
    Math.max(
      -1,
      Math.min(
        1,
        buyPressure ?? 0,
      ),
    );

  const buyPressureScore =
    (
      (pressure + 1) /
      2
    ) * 5;

  const lastTradeMs =
    safeTimestamp(
      lastTradeAt,
    );

  const ageSeconds =
    lastTradeMs > 0
      ? Math.max(
          0,
          (
            Date.now() -
            lastTradeMs
          ) / 1000,
        )
      : windowSeconds;

  const recency =
    Math.max(
      0,
      5 -
        (
          ageSeconds /
          windowSeconds
        ) * 5,
    );

  const coldStartScore =
    coldStart
      ? 5
      : 0;

  const components = {
    trade_activity:
      roundScore(
        tradeActivity,
      ),

    trader_participation:
      roundScore(
        traderParticipation,
      ),

    activity_acceleration:
      roundScore(
        activityAcceleration,
      ),

    volume_acceleration:
      roundScore(
        volumeAcceleration,
      ),

    trader_acceleration:
      roundScore(
        traderAcceleration,
      ),

    price_movement:
      roundScore(
        priceMovement,
      ),

    buy_pressure:
      roundScore(
        buyPressureScore,
      ),

    recency:
      roundScore(
        recency,
      ),

    cold_start:
      roundScore(
        coldStartScore,
      ),
  };

  const total =
    Object.values(
      components,
    ).reduce(
      (
        sum,
        value,
      ) =>
        sum + value,
      0,
    );

  return {
    total:
      Math.min(
        100,
        roundScore(
          total,
        ),
      ),

    components,
  };
}

async function loadTrendingMarketContext(
  markets,
) {
  const output =
    new Map();

  if (!markets.length) {
    return output;
  }

  const addresses = [
    ...new Set(
      markets.flatMap(
        (market) => [
          market.token
            .toLowerCase(),

          market.quote_token
            .toLowerCase(),
        ],
      ),
    ),
  ];

  const metadataResult =
    await db.query(
      `
        SELECT
          LOWER(address)
            AS address,

          symbol,
          name,
          decimals

        FROM token_metadata

        WHERE
          LOWER(address) =
          ANY($1::text[])
      `,
      [
        addresses,
      ],
    );

  const tokenMetadata =
    new Map(
      metadataResult.rows.map(
        (row) => [
          row.address,

          {
            symbol:
              row.symbol ??
              null,

            name:
              row.name ??
              null,

            decimals:
              row.decimals !==
                null &&
              row.decimals !==
                undefined
                ? Number(
                    row.decimals,
                  )
                : null,
          },
        ],
      ),
    );

  const targetTokens =
    markets.map(
      (market) =>
        market.token
          .toLowerCase(),
    );

  const targetQuotes =
    markets.map(
      (market) =>
        market.quote_token
          .toLowerCase(),
    );

  const curveResult =
    await db.query(
      `
        WITH targets AS (
          SELECT DISTINCT
            LOWER(token)
              AS token,

            LOWER(quote_token)
              AS quote_token

          FROM UNNEST(
            $1::text[],
            $2::text[]
          )
          AS t(
            token,
            quote_token
          )
        )

        SELECT
          LOWER(mc.token)
            AS token,

          LOWER(mc.quote_token)
            AS quote_token,

          LOWER(mc.curve)
            AS curve,

          mc.creator,

          mc.curve_allocation::text
            AS curve_allocation,

          mc.liquidity_reserve::text
            AS liquidity_reserve,

          mc.starting_price::text
            AS starting_price,

          mc.slope::text
            AS slope,

          mc.graduation_threshold::text
            AS graduation_threshold,

          mc.token_decimals,
          mc.creation_block,

          latest.tokens_sold_after,
          latest.quote_reserve_after

        FROM market_config mc

        JOIN targets t
          ON
            t.token =
              LOWER(mc.token)

            AND
            t.quote_token =
              LOWER(
                mc.quote_token
              )

        LEFT JOIN LATERAL (
          SELECT
            c.tokens_sold_after,
            c.quote_reserve_after

          FROM curveactivity c

          WHERE
            LOWER(c.curve) =
              LOWER(mc.curve)

            AND
              c.event_type IN (
                'CURVE_BUY',
                'CURVE_SELL'
              )

            AND
              c.tokens_sold_after
                IS NOT NULL

            AND
              c.tokens_sold_after
                <> ''

          ORDER BY
            c.block_number DESC,
            c.ordinal DESC

          LIMIT 1
        ) latest
          ON TRUE
      `,
      [
        targetTokens,
        targetQuotes,
      ],
    );

  const curveContext =
    new Map();

  for (
    const row of
    curveResult.rows
  ) {
    const key =
      `${row.token}:${row.quote_token}`;

    const tokensSoldRaw =
      row.tokens_sold_after ??
      "0";

    const quoteReserveRaw =
      row.quote_reserve_after ??
      "0";

    const curveProgressPct =
      percentRaw(
        tokensSoldRaw,
        row.curve_allocation,
      );

    const capitalProgressPct =
      percentRaw(
        quoteReserveRaw,
        row.graduation_threshold,
      );

    const graduationProgressPct =
      curveProgressPct !==
        null &&
      capitalProgressPct !==
        null
        ? Math.min(
            curveProgressPct,
            capitalProgressPct,
          )
        : null;

    const soldOut =
      BigInt(
        tokensSoldRaw,
      ) >=
      BigInt(
        row.curve_allocation,
      );

    const thresholdReached =
      BigInt(
        quoteReserveRaw,
      ) >=
      BigInt(
        row.graduation_threshold,
      );

    curveContext.set(
      key,
      {
        curve:
          row.curve,

        creator:
          row.creator ??
          null,

        curve_allocation_raw:
          row.curve_allocation,

        liquidity_reserve_raw:
          row.liquidity_reserve,

        graduation_threshold_raw:
          row.graduation_threshold,

        tokens_sold_raw:
          tokensSoldRaw,

        quote_reserve_raw:
          quoteReserveRaw,

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
          soldOut &&
          thresholdReached,

        creation_block:
          row.creation_block ??
          null,
      },
    );
  }

  for (
    const market of
    markets
  ) {
    const token =
      market.token
        .toLowerCase();

    const quoteToken =
      market.quote_token
        .toLowerCase();

    const key =
      `${token}:${quoteToken}`;

    output.set(
      market.market
        .toLowerCase(),

      {
        token_info:
          tokenMetadata.get(
            token,
          ) ??
          null,

        quote_info:
          tokenMetadata.get(
            quoteToken,
          ) ??
          null,

        curve:
          curveContext.get(
            key,
          ) ??
          null,
      },
    );
  }

  return output;
}

export function registerTrendingRoute(
  app,
) {
  app.get(
    "/v1/trending",

    async (
      request,
      reply,
    ) => {
      const windowName =
        request.query.window ??
        "24h";

      const windowSeconds =
        WINDOWS[
          windowName
        ];

      if (
        !windowSeconds
      ) {
        return reply
          .code(400)
          .send({
            error:
              "invalid_window",

            allowed:
              Object.keys(
                WINDOWS,
              ),
          });
      }

      /*
       * Optional machine-readable
       * discovery filter:
       *
       * ?keyword=new
       * ?keyword=trending
       */
      const keywordRaw =
        request.query.keyword ??
        null;

      const keyword =
        typeof keywordRaw ===
        "string"
          ? keywordRaw
              .toLowerCase()
          : null;

      if (
        keyword !== null &&
        !DISCOVERY_KEYWORDS.has(
          keyword,
        )
      ) {
        return reply
          .code(400)
          .send({
            error:
              "invalid_keyword",

            allowed: [
              ...DISCOVERY_KEYWORDS,
            ],
          });
      }

      const limit =
        Math.min(
          Math.max(
            Number.parseInt(
              request.query
                .limit ??
                "25",

              10,
            ) || 25,

            1,
          ),

          100,
        );

      const transactions =
        await db.query(
          `
            SELECT DISTINCT
              transaction_hash

            FROM marketactivity

            WHERE
              canonical_trade
                IS TRUE

              AND
                transaction_hash
                IS NOT NULL

              AND
                transaction_hash
                <> '0x'

              AND
                _block_timestamp_ >=
                NOW() -
                (
                  $1::integer *
                  2 *
                  INTERVAL '1 second'
                )
          `,
          [
            windowSeconds,
          ],
        );

      try {
        await hydrateTransactionActors(
          transactions.rows.map(
            (row) =>
              row.transaction_hash,
          ),
        );
      } catch (
        error
      ) {
        request.log.warn(
          {
            err:
              error,
          },

          "transaction actor hydration incomplete",
        );
      }

      const sql = `
        WITH normalized AS (
          SELECT
            m.event_id,
            m.token,
            m.quote_token,
            m.market,
            m.market_stage,
            m.event_type,
            m.transaction_hash,
            m.block_number,
            m.ordinal,

            m._block_timestamp_
              AS block_timestamp,

            ta.trader,

            CASE
              WHEN
                m.market_stage =
                'CURVE'

                THEN NULLIF(
                  c.actor,
                  '0x'
                )

              WHEN
                m.market_stage =
                'AMM'

                THEN NULLIF(
                  a.sender,
                  '0x'
                )

              ELSE NULL
            END
              AS executor,

            CASE
              WHEN
                m.event_type =
                'CURVE_BUY'

                THEN 'BUY'

              WHEN
                m.event_type =
                'CURVE_SELL'

                THEN 'SELL'

              WHEN
                m.market_stage =
                  'AMM'

                AND
                  COALESCE(
                    NULLIF(
                      a.quote_amount_in,
                      ''
                    )::numeric,

                    0
                  ) > 0

                THEN 'BUY'

              WHEN
                m.market_stage =
                  'AMM'

                AND
                  COALESCE(
                    NULLIF(
                      a.quote_amount_out,
                      ''
                    )::numeric,

                    0
                  ) > 0

                THEN 'SELL'

              ELSE 'OTHER'
            END
              AS side,

            CASE
              WHEN
                m.event_type =
                'CURVE_BUY'

                THEN COALESCE(
                  NULLIF(
                    c.actual_quote_in,
                    ''
                  )::numeric,

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

              WHEN
                m.event_type =
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

              WHEN
                m.market_stage =
                  'AMM'

                THEN
                  COALESCE(
                    NULLIF(
                      a.quote_amount_in,
                      ''
                    )::numeric,

                    0
                  )

                  +

                  COALESCE(
                    NULLIF(
                      a.quote_amount_out,
                      ''
                    )::numeric,

                    0
                  )

              ELSE 0
            END
              AS quote_amount

          FROM marketactivity m

          LEFT JOIN
            curveactivity c

            ON
              c.event_id =
              m.event_id

          LEFT JOIN
            ammactivity a

            ON
              a.event_id =
              m.event_id

          LEFT JOIN
            transaction_actor ta

            ON
              ta.transaction_hash =
              m.transaction_hash

          WHERE
            m.canonical_trade
              IS TRUE

            AND
              m._block_timestamp_ >=
              NOW() -
              (
                $1::integer *
                2 *
                INTERVAL '1 second'
              )
        ),

        stats AS (
          SELECT
            token,
            quote_token,

            COUNT(*) FILTER (
              WHERE
                block_timestamp >=
                NOW() -
                (
                  $1::integer *
                  INTERVAL '1 second'
                )
            )::integer
              AS trades,

            COUNT(
              DISTINCT trader
            ) FILTER (
              WHERE
                block_timestamp >=
                NOW() -
                (
                  $1::integer *
                  INTERVAL '1 second'
                )
            )::integer
              AS unique_traders,

            COUNT(*) FILTER (
              WHERE
                block_timestamp >=
                  NOW() -
                  (
                    $1::integer *
                    INTERVAL '1 second'
                  )

                AND
                  trader IS NULL
            )::integer
              AS unresolved_trades,

            COUNT(*) FILTER (
              WHERE
                block_timestamp >=
                  NOW() -
                  (
                    $1::integer *
                    INTERVAL '1 second'
                  )

                AND
                  side = 'BUY'
            )::integer
              AS buys,

            COUNT(*) FILTER (
              WHERE
                block_timestamp >=
                  NOW() -
                  (
                    $1::integer *
                    INTERVAL '1 second'
                  )

                AND
                  side = 'SELL'
            )::integer
              AS sells,

            COALESCE(
              SUM(
                quote_amount
              ) FILTER (
                WHERE
                  block_timestamp >=
                  NOW() -
                  (
                    $1::integer *
                    INTERVAL '1 second'
                  )
              ),

              0
            )
              AS quote_volume_raw,

            COUNT(*) FILTER (
              WHERE
                block_timestamp <
                NOW() -
                (
                  $1::integer *
                  INTERVAL '1 second'
                )
            )::integer
              AS previous_trades,

            COUNT(
              DISTINCT trader
            ) FILTER (
              WHERE
                block_timestamp <
                NOW() -
                (
                  $1::integer *
                  INTERVAL '1 second'
                )
            )::integer
              AS previous_unique_traders,

            COALESCE(
              SUM(
                quote_amount
              ) FILTER (
                WHERE
                  block_timestamp <
                  NOW() -
                  (
                    $1::integer *
                    INTERVAL '1 second'
                  )
              ),

              0
            )
              AS previous_quote_volume_raw,

            MAX(
              block_timestamp
            ) FILTER (
              WHERE
                block_timestamp >=
                NOW() -
                (
                  $1::integer *
                  INTERVAL '1 second'
                )
            )
              AS last_trade_at

          FROM normalized

          GROUP BY
            token,
            quote_token
        ),

        latest AS (
          SELECT DISTINCT ON (
            token,
            quote_token
          )
            token,
            quote_token,
            market,
            market_stage

          FROM normalized

          ORDER BY
            token,
            quote_token,
            block_timestamp DESC,
            ordinal DESC
        ),

        scored AS (
          SELECT
            s.*,
            l.market,
            l.market_stage,

            CASE
              WHEN
                s.previous_trades =
                0

                THEN NULL

              ELSE LEAST(
                4.0,

                s.trades::double precision /
                s.previous_trades::double precision
              )
            END
              AS activity_velocity,

            CASE
              WHEN
                s.previous_quote_volume_raw =
                0

                THEN NULL

              ELSE LEAST(
                4.0,

                (
                  s.quote_volume_raw /
                  s.previous_quote_volume_raw
                )::double precision
              )
            END
              AS volume_velocity,

            CASE
              WHEN
                s.previous_unique_traders =
                0

                THEN NULL

              ELSE LEAST(
                4.0,

                s.unique_traders::double precision /
                s.previous_unique_traders::double precision
              )
            END
              AS trader_velocity,

            CASE
              WHEN
                s.trades =
                0

                THEN 0.0

              ELSE
                (
                  (
                    s.buys -
                    s.sells
                  )::double precision /

                  s.trades::double precision
                )
            END
              AS buy_pressure

          FROM stats s

          JOIN latest l
            USING (
              token,
              quote_token
            )

          WHERE
            s.trades >
            0
        )

        SELECT
          token,
          quote_token,
          market,
          market_stage,

          trades,
          unique_traders,
          unresolved_trades,

          buys,
          sells,

          quote_volume_raw::text
            AS quote_volume_raw,

          previous_trades,

          previous_unique_traders,

          previous_quote_volume_raw::text
            AS previous_quote_volume_raw,

          ROUND(
            activity_velocity::numeric,
            3
          )::double precision
            AS activity_velocity,

          ROUND(
            volume_velocity::numeric,
            3
          )::double precision
            AS volume_velocity,

          ROUND(
            trader_velocity::numeric,
            3
          )::double precision
            AS trader_velocity,

          ROUND(
            buy_pressure::numeric,
            3
          )::double precision
            AS buy_pressure,

          last_trade_at

        FROM scored;
      `;

      const result =
        await db.query(
          sql,
          [
            windowSeconds,
          ],
        );

      const [
        priceMomentum,
        marketContext,
      ] =
        await Promise.all([
          loadMarketPriceMomentum(
            result.rows,
            windowSeconds,
          ),

          loadTrendingMarketContext(
            result.rows,
          ),
        ]);

      const markets =
        result.rows.map(
          (market) => {
            const trades =
              Number(
                market.trades,
              );

            const buys =
              Number(
                market.buys,
              );

            const uniqueTraders =
              Number(
                market.unique_traders,
              );

            const unresolvedTrades =
              Number(
                market.unresolved_trades,
              );

            const activityVelocity =
              numberOrNull(
                market.activity_velocity,
              );

            const volumeVelocity =
              numberOrNull(
                market.volume_velocity,
              );

            const traderVelocity =
              numberOrNull(
                market.trader_velocity,
              );

            const buyPressure =
              numberOrNull(
                market.buy_pressure,
              );

            const marketKey =
              market.market
                .toLowerCase();

            const price =
              priceMomentum.get(
                marketKey,
              ) ??
              null;

            const context =
              marketContext.get(
                marketKey,
              ) ??
              null;

            const tokenInfo =
              context
                ?.token_info ??
              null;

            const quoteInfo =
              context
                ?.quote_info ??
              null;

            const curveContext =
              context
                ?.curve ??
              null;

            const tokenDecimals =
              tokenInfo
                ?.decimals ??
              null;

            const quoteDecimals =
              quoteInfo
                ?.decimals ??
              null;

            const priceChangePct =
              numberOrNull(
                price
                  ?.price_change_pct,
              );

            const priceSource =
              price
                ?.source ??
              null;

            const windowStartPriceSource =
              price
                ?.start_source ??
              null;

            const coldStart =
              Number(
                market.previous_trades,
              ) === 0;

            const score =
              calculateTrendScoreV3({
                trades,
                uniqueTraders,
                activityVelocity,
                volumeVelocity,
                traderVelocity,
                priceChangePct,
                buyPressure,

                lastTradeAt:
                  market
                    .last_trade_at,

                windowSeconds,
                coldStart,
              });

            /*
             * ------------------------------
             * Discovery: NEW
             * ------------------------------
             *
             * Fixed lifecycle classification.
             * It does not change according to
             * the requested trending window.
             */
            const activatedAt =
              price
                ?.activated_at ??
              null;

            const activatedAtMs =
              safeTimestamp(
                activatedAt,
              );

            const marketAgeSeconds =
              activatedAtMs > 0
                ? Math.max(
                    0,

                    (
                      Date.now() -
                      activatedAtMs
                    ) /
                    1000,
                  )
                : null;

            const isNewMarket =
              marketAgeSeconds !==
                null &&
              marketAgeSeconds <=
                NEW_MARKET_MAX_AGE_SECONDS;

            /*
             * ------------------------------
             * Discovery: TRENDING
             * ------------------------------
             *
             * Window-relative classification.
             *
             * Score alone is insufficient.
             * Require measurable trade and
             * trader participation as well.
             */
            const isTrending =
              score.total >=
                TRENDING_MIN_SCORE &&

              trades >=
                TRENDING_MIN_TRADES &&

              uniqueTraders >=
                TRENDING_MIN_UNIQUE_TRADERS;

            const keywords = [];

            if (
              isNewMarket
            ) {
              keywords.push(
                "new",
              );
            }

            if (
              isTrending
            ) {
              keywords.push(
                "trending",
              );
            }

            const quoteVolume =
              quoteDecimals !==
                null

                ? formatUnits(
                    market
                      .quote_volume_raw,

                    quoteDecimals,
                  )

                : null;

            const previousQuoteVolume =
              quoteDecimals !==
                null

                ? formatUnits(
                    market
                      .previous_quote_volume_raw,

                    quoteDecimals,
                  )

                : null;

            const currentPrice =
              price
                ?.current_price_raw !==
                null &&
              price
                ?.current_price_raw !==
                undefined &&
              quoteDecimals !==
                null

                ? formatUnits(
                    price
                      .current_price_raw,

                    quoteDecimals,
                  )

                : null;

            const windowStartPrice =
              price
                ?.start_price_raw !==
                null &&
              price
                ?.start_price_raw !==
                undefined &&
              quoteDecimals !==
                null

                ? formatUnits(
                    price
                      .start_price_raw,

                    quoteDecimals,
                  )

                : null;

            const curveAllocation =
              curveContext &&
              tokenDecimals !==
                null

                ? formatUnits(
                    curveContext
                      .curve_allocation_raw,

                    tokenDecimals,
                  )

                : null;

            const liquidityReserve =
              curveContext &&
              tokenDecimals !==
                null

                ? formatUnits(
                    curveContext
                      .liquidity_reserve_raw,

                    tokenDecimals,
                  )

                : null;

            const tokensSold =
              curveContext &&
              tokenDecimals !==
                null

                ? formatUnits(
                    curveContext
                      .tokens_sold_raw,

                    tokenDecimals,
                  )

                : null;

            const quoteReserve =
              curveContext &&
              quoteDecimals !==
                null

                ? formatUnits(
                    curveContext
                      .quote_reserve_raw,

                    quoteDecimals,
                  )

                : null;

            const graduationThreshold =
              curveContext &&
              quoteDecimals !==
                null

                ? formatUnits(
                    curveContext
                      .graduation_threshold_raw,

                    quoteDecimals,
                  )

                : null;

            return {
              ...market,

              token_symbol:
                tokenInfo
                  ?.symbol ??
                null,

              token_name:
                tokenInfo
                  ?.name ??
                null,

              token_decimals:
                tokenDecimals,

              quote_symbol:
                quoteInfo
                  ?.symbol ??
                null,

              quote_name:
                quoteInfo
                  ?.name ??
                null,

              quote_decimals:
                quoteDecimals,

              quote_volume:
                quoteVolume,

              previous_quote_volume:
                previousQuoteVolume,

              quote_volume_unit:
                quoteInfo
                  ?.symbol ??
                null,

              activity_velocity:
                activityVelocity,

              volume_velocity:
                volumeVelocity,

              trader_velocity:
                traderVelocity,

              price_change_pct:
                priceChangePct,

              price_change_basis:
                price
                  ?.basis ??
                null,

              price_source:
                priceSource,

              current_price_raw:
                price
                  ?.current_price_raw ??
                null,

              current_price:
                currentPrice,

              window_start_price_source:
                windowStartPriceSource,

              window_start_price_raw:
                price
                  ?.start_price_raw ??
                null,

              window_start_price:
                windowStartPrice,

              price_unit:
                quoteInfo
                  ?.symbol &&
                tokenInfo
                  ?.symbol

                  ? `${quoteInfo.symbol}/${tokenInfo.symbol}`

                  : null,

              price_data_complete:
                price
                  ?.available ===
                true,

              curve:
                curveContext
                  ?.curve ??
                (
                  market
                    .market_stage ===
                    "CURVE"

                    ? market.market

                    : null
                ),

              creator:
                curveContext
                  ?.creator ??
                null,

              curve_allocation_raw:
                curveContext
                  ?.curve_allocation_raw ??
                null,

              curve_allocation:
                curveAllocation,

              liquidity_reserve_raw:
                curveContext
                  ?.liquidity_reserve_raw ??
                null,

              liquidity_reserve:
                liquidityReserve,

              tokens_sold_raw:
                curveContext
                  ?.tokens_sold_raw ??
                null,

              tokens_sold:
                tokensSold,

              quote_reserve_raw:
                curveContext
                  ?.quote_reserve_raw ??
                null,

              quote_reserve:
                quoteReserve,

              graduation_threshold_raw:
                curveContext
                  ?.graduation_threshold_raw ??
                null,

              graduation_threshold:
                graduationThreshold,

              curve_progress_pct:
                curveContext
                  ?.curve_progress_pct ??
                null,

              capital_progress_pct:
                curveContext
                  ?.capital_progress_pct ??
                null,

              graduation_progress_pct:
                curveContext
                  ?.graduation_progress_pct ??
                null,

              sold_out:
                curveContext
                  ?.sold_out ??
                null,

              threshold_reached:
                curveContext
                  ?.threshold_reached ??
                null,

              economic_graduation_ready:
                curveContext
                  ?.economic_graduation_ready ??
                null,

              trend_score:
                score.total,

              score_components:
                score.components,

              buy_ratio:
                trades > 0
                  ? Number(
                      (
                        buys /
                        trades
                      ).toFixed(
                        4,
                      ),
                    )
                  : 0,

              /*
               * Explicit discovery fields.
               */
              new_market:
                isNewMarket,

              trending:
                isTrending,

              keywords,

              discovery: {
                new:
                  isNewMarket,

                trending:
                  isTrending,

                keywords,

                activated_at:
                  activatedAt,

                market_age_seconds:
                  marketAgeSeconds !==
                    null

                    ? Math.floor(
                        marketAgeSeconds,
                      )

                    : null,

                trending_window:
                  windowName,
              },

              /*
               * Scoring concept, distinct
               * from discovery keyword "new".
               */
              cold_start:
                coldStart,

              trader_data_complete:
                unresolvedTrades ===
                0,

              signals: {
                activity_velocity:
                  activityVelocity,

                volume_velocity:
                  volumeVelocity,

                trader_velocity:
                  traderVelocity,

                cold_start:
                  coldStart,

                buy_pressure:
                  buyPressure,

                unique_traders:
                  uniqueTraders,

                unresolved_trades:
                  unresolvedTrades,

                price_change_pct:
                  priceChangePct,

                price_source:
                  priceSource,

                window_start_price_source:
                  windowStartPriceSource,

                curve_progress_pct:
                  curveContext
                    ?.curve_progress_pct ??
                  null,

                graduation_progress_pct:
                  curveContext
                    ?.graduation_progress_pct ??
                  null,

                recency:
                  market
                    .last_trade_at,
              },
            };
          },
        );

      /*
       * Optional discovery keyword filter.
       */
      const filteredMarkets =
        keyword === null
          ? markets
          : markets.filter(
              (market) =>
                market
                  .keywords
                  .includes(
                    keyword,
                  ),
            );

      const rankedMarkets =
        filteredMarkets
          .sort(
            (
              a,
              b,
            ) =>
              b.trend_score -
                a.trend_score ||

              Number(
                b.trades,
              ) -
                Number(
                  a.trades,
                ) ||

              Number(
                b.unique_traders,
              ) -
                Number(
                  a.unique_traders,
                ) ||

              safeTimestamp(
                b.last_trade_at,
              ) -
                safeTimestamp(
                  a.last_trade_at,
                ),
          )

          .slice(
            0,
            limit,
          )

          .map(
            (
              market,
              index,
            ) => ({
              ...market,

              rank:
                index + 1,
            }),
          );

      return {
        window:
          windowName,

        keyword_filter:
          keyword,

        generated_at:
          new Date()
            .toISOString(),

        methodology:
          "dawabit_momentum_v3",

        velocity_model:
          "measured_ratio_or_null",

        score_model:
          "transparent_components_v1",

        price_signal_model:
          "lifecycle_spot_v1",

        market_context_model:
          "token_metadata_and_curve_state_v1",

        discovery_model:
          "new_and_trending_v1",

        discovery_rules: {
          new: {
            max_age_seconds:
              NEW_MARKET_MAX_AGE_SECONDS,

            max_age:
              "7d",
          },

          trending: {
            window:
              windowName,

            min_score:
              TRENDING_MIN_SCORE,

            min_trades:
              TRENDING_MIN_TRADES,

            min_unique_traders:
              TRENDING_MIN_UNIQUE_TRADERS,
          },
        },

        trader_identity:
          "transaction_origin",

        count:
          rankedMarkets.length,

        markets:
          rankedMarkets,
      };
    },
  );
}
