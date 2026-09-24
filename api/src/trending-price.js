import { db } from "./db.js";

function curvePriceRaw(
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
    10n ** BigInt(
      tokenDecimals,
    );

  const slopePrecision =
    10n ** 18n;

  /*
   * Exact ReLaunchBondingCurve.currentPrice()
   * arithmetic:
   *
   * STARTING_PRICE
   * +
   * SLOPE * tokensSold
   * /
   * (TOKEN_UNIT * SLOPE_PRECISION)
   *
   * Result:
   * quote-token raw units per one whole token.
   */
  return (
    startingPrice +
    (
      slope *
      tokensSold /
      (
        tokenUnit *
        slopePrecision
      )
    )
  ).toString();
}

function ammPriceRaw(
  tokenReserveRaw,
  quoteReserveRaw,
  tokenDecimals,
) {
  if (
    tokenReserveRaw === null ||
    tokenReserveRaw === undefined ||
    tokenReserveRaw === "" ||
    quoteReserveRaw === null ||
    quoteReserveRaw === undefined ||
    quoteReserveRaw === "" ||
    tokenDecimals === null ||
    tokenDecimals === undefined
  ) {
    return null;
  }

  const tokenReserve =
    BigInt(
      tokenReserveRaw,
    );

  const quoteReserve =
    BigInt(
      quoteReserveRaw,
    );

  if (
    tokenReserve === 0n
  ) {
    return null;
  }

  const tokenUnit =
    10n ** BigInt(
      tokenDecimals,
    );

  /*
   * Normalized AMM spot price:
   *
   * quoteReserve / tokenReserve
   *
   * converted into the same raw-unit
   * convention used by the bonding curve:
   *
   * quote raw units per one whole token.
   */
  return (
    quoteReserve *
    tokenUnit /
    tokenReserve
  ).toString();
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

  const current =
    BigInt(
      currentRaw,
    );

  const previous =
    BigInt(
      previousRaw,
    );

  if (
    previous === 0n
  ) {
    return null;
  }

  /*
   * Four decimal places of
   * percentage precision.
   */
  const scaled =
    (
      (
        current -
        previous
      ) *
      1_000_000n
    ) /
    previous;

  return (
    Number(scaled) /
    10_000
  );
}

export async function loadMarketPriceMomentum(
  markets,
  windowSeconds,
) {
  const output =
    new Map();

  if (
    !markets.length
  ) {
    return output;
  }

  /*
   * Market identity is token + quote token.
   *
   * This allows one logical market to survive
   * the venue transition:
   *
   * CURVE -> AMM
   */
  const targets =
    [
      ...new Map(
        markets.map(
          (market) => {
            const token =
              market.token
                .toLowerCase();

            const quoteToken =
              market.quote_token
                .toLowerCase();

            return [
              `${token}:${quoteToken}`,

              {
                token,
                quote_token:
                  quoteToken,

                market:
                  market.market
                    .toLowerCase(),

                market_stage:
                  market.market_stage,
              },
            ];
          },
        ),
      ).values(),
    ];

  const tokens =
    targets.map(
      (target) =>
        target.token,
    );

  const quoteTokens =
    targets.map(
      (target) =>
        target.quote_token,
    );

  /*
   * ----------------------------------------------------------
   * Static curve configuration
   * ----------------------------------------------------------
   */

  const configResult =
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
          LOWER(mc.curve)
            AS curve,

          LOWER(mc.token)
            AS token,

          LOWER(mc.quote_token)
            AS quote_token,

          mc.starting_price::text
            AS starting_price,

          mc.slope::text
            AS slope,

          mc.token_decimals,

          mc.creation_block

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
      `,
      [
        tokens,
        quoteTokens,
      ],
    );

  const configs =
    new Map();

  for (
    const row of
    configResult.rows
  ) {
    configs.set(
      `${row.token}:${row.quote_token}`,
      row,
    );
  }

  /*
   * ----------------------------------------------------------
   * Token metadata
   * ----------------------------------------------------------
   */

  const metadataAddresses =
    [
      ...new Set(
        targets.flatMap(
          (target) => [
            target.token,
            target.quote_token,
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

          decimals

        FROM token_metadata

        WHERE
          LOWER(address) =
          ANY($1::text[])
      `,
      [
        metadataAddresses,
      ],
    );

  const metadata =
    new Map(
      metadataResult.rows.map(
        (row) => [
          row.address,

          row.decimals !==
            null &&
          row.decimals !==
            undefined
            ? Number(
                row.decimals,
              )
            : null,
        ],
      ),
    );

  /*
   * ----------------------------------------------------------
   * Curve activation time
   * ----------------------------------------------------------
   */

  const curveAddresses =
    configResult.rows.map(
      (row) =>
        row.curve,
    );

  let activationRows =
    [];

  if (
    curveAddresses.length
  ) {
    const activationResult =
      await db.query(
        `
          SELECT DISTINCT ON (
            LOWER(curve)
          )
            LOWER(curve)
              AS curve,

            _block_timestamp_
              AS activated_at

          FROM api_curveactivity

          WHERE
            LOWER(curve) =
            ANY($1::text[])

            AND
              event_type =
              'ACTIVATED'

          ORDER BY
            LOWER(curve),
            block_number ASC,
            event_order ASC
        `,
        [
          curveAddresses,
        ],
      );

    activationRows =
      activationResult.rows;
  }

  const activations =
    new Map(
      activationRows.map(
        (row) => [
          row.curve,
          row.activated_at,
        ],
      ),
    );

  /*
   * ----------------------------------------------------------
   * Latest curve state
   * ----------------------------------------------------------
   */

  let latestCurveRows =
    [];

  if (
    curveAddresses.length
  ) {
    const latestCurveResult =
      await db.query(
        `
          SELECT DISTINCT ON (
            LOWER(curve)
          )
            LOWER(curve)
              AS curve,

            tokens_sold_after

          FROM api_curveactivity

          WHERE
            LOWER(curve) =
            ANY($1::text[])

            AND
              event_type IN (
                'CURVE_BUY',
                'CURVE_SELL'
              )

            AND
              tokens_sold_after
                IS NOT NULL

            AND
              tokens_sold_after
                <> ''

          ORDER BY
            LOWER(curve),
            block_number DESC,
            event_order DESC
        `,
        [
          curveAddresses,
        ],
      );

    latestCurveRows =
      latestCurveResult.rows;
  }

  const latestCurveState =
    new Map(
      latestCurveRows.map(
        (row) => [
          row.curve,
          row.tokens_sold_after,
        ],
      ),
    );

  /*
   * ----------------------------------------------------------
   * Curve state at comparison-window start
   * ----------------------------------------------------------
   */

  let startCurveRows =
    [];

  if (
    curveAddresses.length
  ) {
    const startCurveResult =
      await db.query(
        `
          SELECT DISTINCT ON (
            LOWER(curve)
          )
            LOWER(curve)
              AS curve,

            tokens_sold_after

          FROM api_curveactivity

          WHERE
            LOWER(curve) =
            ANY($1::text[])

            AND
              event_type IN (
                'CURVE_BUY',
                'CURVE_SELL'
              )

            AND
              tokens_sold_after
                IS NOT NULL

            AND
              tokens_sold_after
                <> ''

            AND
              _block_timestamp_ <=
              NOW() -
              (
                $2::integer *
                INTERVAL '1 second'
              )

          ORDER BY
            LOWER(curve),
            block_number DESC,
            event_order DESC
        `,
        [
          curveAddresses,
          windowSeconds,
        ],
      );

    startCurveRows =
      startCurveResult.rows;
  }

  const startCurveState =
    new Map(
      startCurveRows.map(
        (row) => [
          row.curve,
          row.tokens_sold_after,
        ],
      ),
    );

  /*
   * ----------------------------------------------------------
   * Latest AMM reserve state
   * ----------------------------------------------------------
   *
   * token_reserve and quote_reserve are already
   * normalized by the Substreams layer, so this
   * API does not need token0/token1 orientation
   * logic.
   */

  const pairAddresses =
    targets
      .filter(
        (target) =>
          target.market_stage ===
          "AMM",
      )
      .map(
        (target) =>
          target.market,
      );

  let latestAmmRows =
    [];

  let startAmmRows =
    [];

  if (
    pairAddresses.length
  ) {
    const [
      latestAmmResult,
      startAmmResult,
    ] =
      await Promise.all([
        db.query(
          `
            SELECT DISTINCT ON (
              LOWER(pair)
            )
              LOWER(pair)
                AS pair,

              LOWER(curve)
                AS curve,

              LOWER(token)
                AS token,

              LOWER(quote_token)
                AS quote_token,

              token_reserve,

              quote_reserve,

              _block_timestamp_
                AS reserve_at

            FROM api_ammactivity

            WHERE
              LOWER(pair) =
              ANY($1::text[])

              AND
                token_reserve
                IS NOT NULL

              AND
                token_reserve
                <> ''

              AND
                quote_reserve
                IS NOT NULL

              AND
                quote_reserve
                <> ''

            ORDER BY
              LOWER(pair),
              block_number DESC,
              event_order DESC
          `,
          [
            pairAddresses,
          ],
        ),

        db.query(
          `
            SELECT DISTINCT ON (
              LOWER(pair)
            )
              LOWER(pair)
                AS pair,

              LOWER(curve)
                AS curve,

              LOWER(token)
                AS token,

              LOWER(quote_token)
                AS quote_token,

              token_reserve,

              quote_reserve,

              _block_timestamp_
                AS reserve_at

            FROM api_ammactivity

            WHERE
              LOWER(pair) =
              ANY($1::text[])

              AND
                token_reserve
                IS NOT NULL

              AND
                token_reserve
                <> ''

              AND
                quote_reserve
                IS NOT NULL

              AND
                quote_reserve
                <> ''

              AND
                _block_timestamp_ <=
                NOW() -
                (
                  $2::integer *
                  INTERVAL '1 second'
                )

            ORDER BY
              LOWER(pair),
              block_number DESC,
              event_order DESC
          `,
          [
            pairAddresses,
            windowSeconds,
          ],
        ),
      ]);

    latestAmmRows =
      latestAmmResult.rows;

    startAmmRows =
      startAmmResult.rows;
  }

  const latestAmmState =
    new Map(
      latestAmmRows.map(
        (row) => [
          row.pair,
          row,
        ],
      ),
    );

  const startAmmState =
    new Map(
      startAmmRows.map(
        (row) => [
          row.pair,
          row,
        ],
      ),
    );

  /*
   * ----------------------------------------------------------
   * Build lifecycle-aware prices
   * ----------------------------------------------------------
   */

  const cutoff =
    Date.now() -
    (
      windowSeconds *
      1000
    );

  for (
    const target of
    targets
  ) {
    const identityKey =
      `${target.token}:${target.quote_token}`;

    const config =
      configs.get(
        identityKey,
      ) ??
      null;

    if (
      !config
    ) {
      output.set(
        target.market,
        {
          available:
            false,

          source:
            null,

          start_source:
            null,

          current_price_raw:
            null,

          start_price_raw:
            null,

          price_change_pct:
            null,

          basis:
            null,

          activated_at:
            null,
        },
      );

      continue;
    }

    const tokenDecimals =
      metadata.get(
        target.token,
      ) ??
      Number(
        config.token_decimals,
      );

    const activatedAt =
      activations.get(
        config.curve,
      ) ??
      null;

    /*
     * --------------------------------------------------------
     * Current price
     * --------------------------------------------------------
     */

    let currentPriceRaw =
      null;

    let currentSource =
      null;

    if (
      target.market_stage ===
      "AMM"
    ) {
      const ammState =
        latestAmmState.get(
          target.market,
        ) ??
        null;

      if (
        ammState
      ) {
        currentPriceRaw =
          ammPriceRaw(
            ammState
              .token_reserve,

            ammState
              .quote_reserve,

            tokenDecimals,
          );

        currentSource =
          "AMM";
      }
    }

    /*
     * AMM state may not have arrived yet in the
     * same block that venue identity changed.
     *
     * Falling back to the latest curve state keeps
     * the endpoint available during that narrow
     * transition period.
     */
    if (
      currentPriceRaw ===
      null
    ) {
      const tokensSold =
        latestCurveState.get(
          config.curve,
        ) ??
        "0";

      currentPriceRaw =
        curvePriceRaw(
          config.starting_price,
          config.slope,
          tokensSold,
          tokenDecimals,
        );

      currentSource =
        "CURVE";
    }

    /*
     * --------------------------------------------------------
     * Window-start price
     * --------------------------------------------------------
     *
     * If the AMM already existed at the cutoff,
     * use AMM reserves.
     *
     * Otherwise use curve state at the cutoff.
     *
     * This lets one price-change window cross the
     * graduation boundary naturally.
     */

    let startPriceRaw =
      null;

    let startSource =
      null;

    const ammStart =
      startAmmState.get(
        target.market,
      ) ??
      null;

    if (
      target.market_stage ===
        "AMM" &&
      ammStart
    ) {
      startPriceRaw =
        ammPriceRaw(
          ammStart
            .token_reserve,

          ammStart
            .quote_reserve,

          tokenDecimals,
        );

      startSource =
        "AMM";
    }

    if (
      startPriceRaw ===
      null
    ) {
      const tokensSoldAtStart =
        startCurveState.get(
          config.curve,
        ) ??
        "0";

      startPriceRaw =
        curvePriceRaw(
          config.starting_price,
          config.slope,
          tokensSoldAtStart,
          tokenDecimals,
        );

      startSource =
        "CURVE";
    }

    const activationTime =
      activatedAt
        ? new Date(
            activatedAt,
          )
        : null;

    const marketOpenedInsideWindow =
      activationTime !==
        null &&
      activationTime.getTime() >
        cutoff;

    const basis =
      marketOpenedInsideWindow
        ? "since_activation"
        : "window_start";

    output.set(
      target.market,
      {
        available:
          currentPriceRaw !==
            null &&
          startPriceRaw !==
            null,

        /*
         * Current pricing venue.
         */
        source:
          currentSource,

        /*
         * Pricing venue used for the comparison
         * point. This can differ from source when
         * the requested window crosses graduation.
         *
         * Example:
         *
         * start_source = CURVE
         * source       = AMM
         */
        start_source:
          startSource,

        current_price_raw:
          currentPriceRaw,

        start_price_raw:
          startPriceRaw,

        price_change_pct:
          percentChange(
            currentPriceRaw,
            startPriceRaw,
          ),

        basis,

        activated_at:
          activatedAt,
      },
    );
  }

  return output;
}

/*
 * Backward-compatible export.
 *
 * Existing callers can continue importing
 * loadCurvePriceMomentum while we migrate the
 * API terminology to lifecycle-aware pricing.
 */
export const loadCurvePriceMomentum =
  loadMarketPriceMomentum;
