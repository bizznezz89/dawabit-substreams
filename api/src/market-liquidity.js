import { db } from "./db.js";

function formatUnits(raw, decimals) {
  if (
    raw === null ||
    raw === undefined ||
    raw === "" ||
    decimals === null ||
    decimals === undefined
  ) {
    return null;
  }

  const value = BigInt(raw);
  const places = Number(decimals);

  if (places === 0) {
    return value.toString();
  }

  const base = 10n ** BigInt(places);
  const whole = value / base;
  const fraction = value % base;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionString = fraction
    .toString()
    .padStart(places, "0")
    .replace(/0+$/, "");

  return `${whole}.${fractionString}`;
}

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

  const scaled =
    (a * 1_000_000n) / b;

  return Number(scaled) / 10_000;
}

function subtractFloorZero(aRaw, bRaw) {
  const a = BigInt(aRaw ?? "0");
  const b = BigInt(bRaw ?? "0");

  return a > b
    ? (a - b).toString()
    : "0";
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
    BigInt(tokenReserveRaw);

  const quoteReserve =
    BigInt(quoteReserveRaw);

  if (tokenReserve === 0n) {
    return null;
  }

  const tokenUnit =
    10n ** BigInt(tokenDecimals);

  return (
    quoteReserve *
    tokenUnit /
    tokenReserve
  ).toString();
}

export async function loadMarketLiquidity(
  markets,
) {
  const output = new Map();

  if (!markets.length) {
    return output;
  }

  const tokens =
    markets.map(
      (market) =>
        market.token.toLowerCase(),
    );

  const quoteTokens =
    markets.map(
      (market) =>
        market.quote_token.toLowerCase(),
    );

  /*
   * ----------------------------------------------------------
   * Static curve configuration + current curve state
   * ----------------------------------------------------------
   */

  const curveResult =
    await db.query(
      `
        WITH targets AS (
          SELECT DISTINCT
            LOWER(token) AS token,
            LOWER(quote_token) AS quote_token

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
          LOWER(mc.curve) AS curve,
          LOWER(mc.token) AS token,
          LOWER(mc.quote_token) AS quote_token,

          mc.curve_allocation::text
            AS curve_allocation,

          mc.liquidity_reserve::text
            AS liquidity_reserve,

          mc.graduation_threshold::text
            AS graduation_threshold,

          mc.token_decimals,

          latest.tokens_sold_after,
          latest.quote_reserve_after,
          latest._block_timestamp_
            AS curve_state_at

        FROM market_config mc

        JOIN targets t
          ON
            t.token =
              LOWER(mc.token)

            AND
            t.quote_token =
              LOWER(mc.quote_token)

        LEFT JOIN LATERAL (
          SELECT
            c.tokens_sold_after,
            c.quote_reserve_after,
            c._block_timestamp_

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
        tokens,
        quoteTokens,
      ],
    );

  const curveByIdentity =
    new Map();

  for (const row of curveResult.rows) {
    curveByIdentity.set(
      `${row.token}:${row.quote_token}`,
      row,
    );
  }

  /*
   * ----------------------------------------------------------
   * Token metadata
   * ----------------------------------------------------------
   */

  const addresses = [
    ...new Set(
      markets.flatMap(
        (market) => [
          market.token.toLowerCase(),
          market.quote_token.toLowerCase(),
        ],
      ),
    ),
  ];

  const metadataResult =
    await db.query(
      `
        SELECT
          LOWER(address) AS address,
          symbol,
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

  const metadata =
    new Map(
      metadataResult.rows.map(
        (row) => [
          row.address,
          {
            symbol:
              row.symbol ?? null,

            decimals:
              row.decimals !== null &&
              row.decimals !== undefined
                ? Number(row.decimals)
                : null,
          },
        ],
      ),
    );

  /*
   * ----------------------------------------------------------
   * Latest AMM reserve state
   * ----------------------------------------------------------
   */

  const pairAddresses =
    markets
      .filter(
        (market) =>
          market.market_stage ===
          "AMM",
      )
      .map(
        (market) =>
          market.market.toLowerCase(),
      );

  const ammByPair =
    new Map();

  if (pairAddresses.length) {
    const ammResult =
      await db.query(
        `
          SELECT DISTINCT ON (
            LOWER(pair)
          )
            LOWER(pair) AS pair,
            LOWER(curve) AS curve,
            LOWER(token) AS token,
            LOWER(quote_token) AS quote_token,

            token_reserve,
            quote_reserve,

            block_number,
            ordinal,

            _block_timestamp_
              AS reserve_state_at

          FROM ammactivity

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
            ordinal DESC
        `,
        [
          pairAddresses,
        ],
      );

    for (const row of ammResult.rows) {
      ammByPair.set(
        row.pair,
        row,
      );
    }
  }

  /*
   * ----------------------------------------------------------
   * Assemble one lifecycle-stable liquidity object per market
   * ----------------------------------------------------------
   */

  for (const market of markets) {
    const marketAddress =
      market.market.toLowerCase();

    const token =
      market.token.toLowerCase();

    const quoteToken =
      market.quote_token.toLowerCase();

    const identityKey =
      `${token}:${quoteToken}`;

    const tokenInfo =
      metadata.get(token) ??
      null;

    const quoteInfo =
      metadata.get(quoteToken) ??
      null;

    const tokenDecimals =
      tokenInfo?.decimals ??
      null;

    const quoteDecimals =
      quoteInfo?.decimals ??
      null;

    const curve =
      curveByIdentity.get(identityKey) ??
      null;

    /*
     * --------------------------------------------------------
     * CURVE quality
     * --------------------------------------------------------
     */

    if (market.market_stage === "CURVE") {
      if (!curve) {
        output.set(
          marketAddress,
          {
            stage: "CURVE",
            available: false,
          },
        );

        continue;
      }

      const tokensSoldRaw =
        curve.tokens_sold_after ??
        "0";

      const quoteReserveRaw =
        curve.quote_reserve_after ??
        "0";

      const remainingCurveInventoryRaw =
        subtractFloorZero(
          curve.curve_allocation,
          tokensSoldRaw,
        );

      const quoteToGraduationRaw =
        subtractFloorZero(
          curve.graduation_threshold,
          quoteReserveRaw,
        );

      output.set(
        marketAddress,
        {
          stage:
            "CURVE",

          available:
            true,

          token_symbol:
            tokenInfo?.symbol ??
            null,

          quote_symbol:
            quoteInfo?.symbol ??
            null,

          curve:
            curve.curve,

          curve_allocation_raw:
            curve.curve_allocation,

          curve_allocation:
            tokenDecimals !== null
              ? formatUnits(
                  curve.curve_allocation,
                  tokenDecimals,
                )
              : null,

          tokens_sold_raw:
            tokensSoldRaw,

          tokens_sold:
            tokenDecimals !== null
              ? formatUnits(
                  tokensSoldRaw,
                  tokenDecimals,
                )
              : null,

          remaining_curve_inventory_raw:
            remainingCurveInventoryRaw,

          remaining_curve_inventory:
            tokenDecimals !== null
              ? formatUnits(
                  remainingCurveInventoryRaw,
                  tokenDecimals,
                )
              : null,

          inventory_utilization_pct:
            percentRaw(
              tokensSoldRaw,
              curve.curve_allocation,
            ),

          liquidity_reserve_raw:
            curve.liquidity_reserve,

          liquidity_reserve:
            tokenDecimals !== null
              ? formatUnits(
                  curve.liquidity_reserve,
                  tokenDecimals,
                )
              : null,

          quote_reserve_raw:
            quoteReserveRaw,

          quote_reserve:
            quoteDecimals !== null
              ? formatUnits(
                  quoteReserveRaw,
                  quoteDecimals,
                )
              : null,

          graduation_threshold_raw:
            curve.graduation_threshold,

          graduation_threshold:
            quoteDecimals !== null
              ? formatUnits(
                  curve.graduation_threshold,
                  quoteDecimals,
                )
              : null,

          quote_to_graduation_raw:
            quoteToGraduationRaw,

          quote_to_graduation:
            quoteDecimals !== null
              ? formatUnits(
                  quoteToGraduationRaw,
                  quoteDecimals,
                )
              : null,

          capital_progress_pct:
            percentRaw(
              quoteReserveRaw,
              curve.graduation_threshold,
            ),

          state_updated_at:
            curve.curve_state_at ??
            null,

          /*
           * We deliberately do not publish
           * synthetic slippage/depth estimates
           * until exact execution fee/math is
           * verified from the contracts.
           */
          executable_depth_complete:
            false,
        },
      );

      continue;
    }

    /*
     * --------------------------------------------------------
     * AMM quality
     * --------------------------------------------------------
     */

    if (market.market_stage === "AMM") {
      const amm =
        ammByPair.get(
          marketAddress,
        ) ??
        null;

      if (!amm) {
        output.set(
          marketAddress,
          {
            stage: "AMM",
            available: false,
          },
        );

        continue;
      }

      const currentPriceRaw =
        ammPriceRaw(
          amm.token_reserve,
          amm.quote_reserve,
          tokenDecimals,
        );

      output.set(
        marketAddress,
        {
          stage:
            "AMM",

          available:
            true,

          token_symbol:
            tokenInfo?.symbol ??
            null,

          quote_symbol:
            quoteInfo?.symbol ??
            null,

          curve:
            amm.curve ??
            curve?.curve ??
            null,

          pair:
            amm.pair,

          token_reserve_raw:
            amm.token_reserve,

          token_reserve:
            tokenDecimals !== null
              ? formatUnits(
                  amm.token_reserve,
                  tokenDecimals,
                )
              : null,

          quote_reserve_raw:
            amm.quote_reserve,

          quote_reserve:
            quoteDecimals !== null
              ? formatUnits(
                  amm.quote_reserve,
                  quoteDecimals,
                )
              : null,

          reserve_spot_price_raw:
            currentPriceRaw,

          reserve_spot_price:
            currentPriceRaw !== null &&
            quoteDecimals !== null
              ? formatUnits(
                  currentPriceRaw,
                  quoteDecimals,
                )
              : null,

          price_unit:
            tokenInfo?.symbol &&
            quoteInfo?.symbol
              ? `${quoteInfo.symbol}/${tokenInfo.symbol}`
              : null,

          state_updated_at:
            amm.reserve_state_at ??
            null,

          executable_depth_complete:
            false,
        },
      );

      continue;
    }

    output.set(
      marketAddress,
      {
        stage:
          market.market_stage ??
          null,

        available:
          false,
      },
    );
  }

  return output;
}
