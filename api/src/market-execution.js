import {
  createPublicClient,
  http,
} from "viem";

import { db } from "./db.js";

import {
  config,
} from "./config.js";

const RHC_RPC_URL =
  config.rhcRpcUrl;

const TRADE_ROUTER =
  config.relaunchTradeRouter;

const client =
  createPublicClient({
    transport:
      http(RHC_RPC_URL),
  });

const TRADE_ROUTER_ABI = [
  {
    type:
      "function",

    name:
      "quoteExactInput",

    stateMutability:
      "view",

    inputs: [
      {
        name:
          "tokenIn",
        type:
          "address",
      },
      {
        name:
          "tokenOut",
        type:
          "address",
      },
      {
        name:
          "amountIn",
        type:
          "uint256",
      },
    ],

    outputs: [
      {
        name:
          "venue",
        type:
          "uint8",
      },
      {
        name:
          "amountInUsed",
        type:
          "uint256",
      },
      {
        name:
          "amountOut",
        type:
          "uint256",
      },
      {
        name:
          "refundAmount",
        type:
          "uint256",
      },
    ],
  },
  {
    type:
      "function",

    name:
      "quoteExactOutput",

    stateMutability:
      "view",

    inputs: [
      {
        name:
          "tokenIn",
        type:
          "address",
      },
      {
        name:
          "tokenOut",
        type:
          "address",
      },
      {
        name:
          "amountOut",
        type:
          "uint256",
      },
    ],

    outputs: [
      {
        name:
          "venue",
        type:
          "uint8",
      },
      {
        name:
          "amountIn",
        type:
          "uint256",
      },
      {
        name:
          "outputSurplus",
        type:
          "uint256",
      },
    ],
  },
];

const CURVE_ABI = [
  {
    type:
      "function",

    name:
      "PROTOCOL_FEE_BPS",

    stateMutability:
      "view",

    inputs: [],

    outputs: [
      {
        name:
          "",
        type:
          "uint256",
      },
    ],
  },
];

const VENUE = {
  0:
    "UNAVAILABLE",

  1:
    "CURVE",

  2:
    "AMM",
};

const BPS_DENOMINATOR =
  10_000n;

const SLOPE_PRECISION =
  10n ** 18n;

/*
 * The deployed post-graduation pair is canonical
 * Uniswap V2:
 *
 * balanceAdjusted =
 *     balance * 1000
 *     - amountIn * 3
 *
 * => 0.30% swap fee.
 */
const AMM_FEE_NUMERATOR =
  997n;

const AMM_FEE_DENOMINATOR =
  1000n;

const AMM_FEE_BPS =
  30;

const DEPTH_TARGETS_BPS = [
  100,
  500,
  1000,
];

function formatUnits(
  raw,
  decimals,
) {
  if (
    raw === null ||
    raw === undefined ||
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
    10n ** BigInt(
      places,
    );

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

function thresholdKey(
  targetBps,
) {
  return `${targetBps / 100}pct`;
}

function priceUnit(
  quoteSymbol,
  tokenSymbol,
) {
  if (
    !quoteSymbol ||
    !tokenSymbol
  ) {
    return null;
  }

  return `${quoteSymbol}/${tokenSymbol}`;
}

function percentDelta(
  aRaw,
  bRaw,
) {
  if (
    aRaw === null ||
    aRaw === undefined ||
    bRaw === null ||
    bRaw === undefined
  ) {
    return null;
  }

  const a =
    BigInt(aRaw);

  const b =
    BigInt(bRaw);

  if (a === 0n) {
    return null;
  }

  const delta =
    b >= a
      ? b - a
      : a - b;

  /*
   * Four decimal places of percentage
   * precision.
   */
  const scaled =
    (
      delta *
      1_000_000n
    ) /
    a;

  return Number(
    scaled,
  ) / 10_000;
}

function directionalDeviationPct(
  currentRaw,
  executionRaw,
  side,
) {
  if (
    currentRaw === null ||
    executionRaw === null
  ) {
    return null;
  }

  const current =
    BigInt(currentRaw);

  const execution =
    BigInt(executionRaw);

  if (current === 0n) {
    return null;
  }

  let delta;

  if (side === "BUY") {
    delta =
      execution > current
        ? execution - current
        : 0n;
  } else {
    delta =
      execution < current
        ? current - execution
        : 0n;
  }

  const scaled =
    (
      delta *
      1_000_000n
    ) /
    current;

  return Number(
    scaled,
  ) / 10_000;
}

function withinImpact(
  currentPriceRaw,
  postPriceRaw,
  targetBps,
) {
  const current =
    BigInt(
      currentPriceRaw,
    );

  const post =
    BigInt(
      postPriceRaw,
    );

  if (current === 0n) {
    return false;
  }

  const delta =
    post >= current
      ? post - current
      : current - post;

  return (
    delta *
    BPS_DENOMINATOR
  ) <= (
    current *
    BigInt(targetBps)
  );
}

function curvePriceRaw({
  startingPriceRaw,
  slopeRaw,
  tokensSoldRaw,
  tokenDecimals,
}) {
  const startingPrice =
    BigInt(
      startingPriceRaw,
    );

  const slope =
    BigInt(
      slopeRaw,
    );

  const tokensSold =
    BigInt(
      tokensSoldRaw,
    );

  const tokenUnit =
    10n ** BigInt(
      tokenDecimals,
    );

  return (
    startingPrice +
    (
      slope *
      tokensSold /
      (
        tokenUnit *
        SLOPE_PRECISION
      )
    )
  );
}

function quoteCurveBuyRaw(
  state,
  tokenAmountRaw,
) {
  const amount =
    BigInt(
      tokenAmountRaw,
    );

  if (amount === 0n) {
    return 0n;
  }

  const sold =
    BigInt(
      state.tokens_sold_raw,
    );

  const allocation =
    BigInt(
      state.curve_allocation_raw,
    );

  if (
    sold + amount >
    allocation
  ) {
    return null;
  }

  const tokenUnit =
    10n ** BigInt(
      state.token_decimals,
    );

  const start =
    sold;

  const end =
    sold + amount;

  const baseCost =
    BigInt(
      state.starting_price_raw,
    ) *
    amount /
    tokenUnit;

  const slopeCost =
    BigInt(
      state.slope_raw,
    ) *
    (
      end * end -
      start * start
    ) /
    (
      2n *
      tokenUnit *
      tokenUnit *
      SLOPE_PRECISION
    );

  return (
    baseCost +
    slopeCost
  );
}

function quoteCurveSellRaw(
  state,
  tokenAmountRaw,
) {
  const amount =
    BigInt(
      tokenAmountRaw,
    );

  if (amount === 0n) {
    return 0n;
  }

  const sold =
    BigInt(
      state.tokens_sold_raw,
    );

  if (
    amount >
    sold
  ) {
    return null;
  }

  const tokenUnit =
    10n ** BigInt(
      state.token_decimals,
    );

  const end =
    sold;

  const start =
    sold - amount;

  const baseRefund =
    BigInt(
      state.starting_price_raw,
    ) *
    amount /
    tokenUnit;

  const slopeRefund =
    BigInt(
      state.slope_raw,
    ) *
    (
      end * end -
      start * start
    ) /
    (
      2n *
      tokenUnit *
      tokenUnit *
      SLOPE_PRECISION
    );

  return (
    baseRefund +
    slopeRefund
  );
}

function ammAmountOut(
  amountInRaw,
  reserveInRaw,
  reserveOutRaw,
) {
  const amountIn =
    BigInt(
      amountInRaw,
    );

  const reserveIn =
    BigInt(
      reserveInRaw,
    );

  const reserveOut =
    BigInt(
      reserveOutRaw,
    );

  if (
    amountIn === 0n ||
    reserveIn === 0n ||
    reserveOut === 0n
  ) {
    return 0n;
  }

  const amountInWithFee =
    amountIn *
    AMM_FEE_NUMERATOR;

  const numerator =
    amountInWithFee *
    reserveOut;

  const denominator =
    (
      reserveIn *
      AMM_FEE_DENOMINATOR
    ) +
    amountInWithFee;

  return (
    numerator /
    denominator
  );
}

function ammSpotPriceRaw(
  tokenReserveRaw,
  quoteReserveRaw,
  tokenDecimals,
) {
  const tokenReserve =
    BigInt(
      tokenReserveRaw,
    );

  const quoteReserve =
    BigInt(
      quoteReserveRaw,
    );

  if (tokenReserve === 0n) {
    return null;
  }

  const tokenUnit =
    10n ** BigInt(
      tokenDecimals,
    );

  return (
    quoteReserve *
    tokenUnit /
    tokenReserve
  );
}

function findMaximumWithinImpact({
  maxAmount,
  currentPriceRaw,
  targetBps,
  postPriceForAmount,
}) {
  const maximum =
    BigInt(
      maxAmount,
    );

  if (maximum === 0n) {
    return {
      amount:
        0n,

      threshold_reached:
        false,
    };
  }

  const maximumPostPrice =
    postPriceForAmount(
      maximum,
    );

  if (
    withinImpact(
      currentPriceRaw,
      maximumPostPrice,
      targetBps,
    )
  ) {
    return {
      amount:
        maximum,

      threshold_reached:
        false,
    };
  }

  let low =
    0n;

  let high =
    maximum;

  while (
    low < high
  ) {
    const mid =
      (
        low +
        high +
        1n
      ) /
      2n;

    const postPrice =
      postPriceForAmount(
        mid,
      );

    if (
      withinImpact(
        currentPriceRaw,
        postPrice,
        targetBps,
      )
    ) {
      low =
        mid;
    } else {
      high =
        mid - 1n;
    }
  }

  return {
    amount:
      low,

    threshold_reached:
      true,
  };
}

function findAmmInputWithinImpact({
  currentPriceRaw,
  targetBps,
  postPriceForInput,
}) {
  let low =
    0n;

  let high =
    1n;

  /*
   * Find an upper bound that crosses
   * the requested spot-price movement.
   */
  for (
    let i = 0;
    i < 256;
    i += 1
  ) {
    const postPrice =
      postPriceForInput(
        high,
      );

    if (
      !withinImpact(
        currentPriceRaw,
        postPrice,
        targetBps,
      )
    ) {
      break;
    }

    low =
      high;

    high *=
      2n;
  }

  /*
   * Find the largest exact raw-unit input
   * still inside the requested impact.
   */
  while (
    low < high
  ) {
    const mid =
      (
        low +
        high +
        1n
      ) /
      2n;

    const postPrice =
      postPriceForInput(
        mid,
      );

    if (
      withinImpact(
        currentPriceRaw,
        postPrice,
        targetBps,
      )
    ) {
      low =
        mid;
    } else {
      high =
        mid - 1n;
    }
  }

  return {
    amount:
      low,

    threshold_reached:
      true,
  };
}

function maxExecutableCurveSell(
  state,
) {
  const sold =
    BigInt(
      state.tokens_sold_raw,
    );

  const reserve =
    BigInt(
      state.quote_reserve_raw,
    );

  if (
    sold === 0n ||
    reserve === 0n
  ) {
    return 0n;
  }

  const fullQuote =
    quoteCurveSellRaw(
      state,
      sold,
    );

  if (
    fullQuote !== null &&
    fullQuote <= reserve
  ) {
    return sold;
  }

  let low =
    0n;

  let high =
    sold;

  while (
    low < high
  ) {
    const mid =
      (
        low +
        high +
        1n
      ) /
      2n;

    const quote =
      quoteCurveSellRaw(
        state,
        mid,
      );

    if (
      quote !== null &&
      quote <= reserve
    ) {
      low =
        mid;
    } else {
      high =
        mid - 1n;
    }
  }

  return low;
}

export async function quoteExactInput(
  tokenIn,
  tokenOut,
  amountIn,
) {
  const result =
    await client.readContract({
      address:
        TRADE_ROUTER,

      abi:
        TRADE_ROUTER_ABI,

      functionName:
        "quoteExactInput",

      args: [
        tokenIn,
        tokenOut,
        BigInt(
          amountIn,
        ),
      ],
    });

  return {
    venue:
      Number(
        result[0],
      ),

    amount_in_used:
      BigInt(
        result[1],
      ),

    amount_out:
      BigInt(
        result[2],
      ),

    refund:
      BigInt(
        result[3],
      ),
  };
}

export async function quoteExactOutput(
  tokenIn,
  tokenOut,
  amountOut,
) {
  const result =
    await client.readContract({
      address:
        TRADE_ROUTER,

      abi:
        TRADE_ROUTER_ABI,

      functionName:
        "quoteExactOutput",

      args: [
        tokenIn,
        tokenOut,
        BigInt(
          amountOut,
        ),
      ],
    });

  return {
    venue:
      Number(
        result[0],
      ),

    amount_in:
      BigInt(
        result[1],
      ),

    output_surplus:
      BigInt(
        result[2],
      ),
  };
}

async function loadExecutionStates(
  markets,
) {
  const output =
    new Map();

  if (!markets.length) {
    return output;
  }

  const tokens =
    markets.map(
      (market) =>
        market.token
          .toLowerCase(),
    );

  const quoteTokens =
    markets.map(
      (market) =>
        market.quote_token
          .toLowerCase(),
    );

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

  const [
    configResult,
    metadataResult,
  ] =
    await Promise.all([
      db.query(
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

            mc.curve_allocation::text
              AS curve_allocation,

            mc.starting_price::text
              AS starting_price,

            mc.slope::text
              AS slope,

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

            FROM api_curveactivity c

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
              c.event_order DESC

            LIMIT 1
          ) latest
            ON TRUE
        `,
        [
          tokens,
          quoteTokens,
        ],
      ),

      db.query(
        `
          SELECT
            LOWER(address)
              AS address,

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
      ),
    ]);

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

  const metadata =
    new Map();

  for (
    const row of
    metadataResult.rows
  ) {
    metadata.set(
      row.address,
      {
        symbol:
          row.symbol ??
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
    );
  }

  const pairAddresses =
    markets
      .filter(
        (market) =>
          market.market_stage ===
          "AMM",
      )
      .map(
        (market) =>
          market.market
            .toLowerCase(),
      );

  const ammStates =
    new Map();

  if (
    pairAddresses.length
  ) {
    const result =
      await db.query(
        `
          SELECT DISTINCT ON (
            LOWER(pair)
          )
            LOWER(pair)
              AS pair,

            LOWER(curve)
              AS curve,

            token_reserve,
            quote_reserve,

            _block_timestamp_
              AS state_updated_at

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
      );

    for (
      const row of
      result.rows
    ) {
      ammStates.set(
        row.pair,
        row,
      );
    }
  }

  for (
    const market of
    markets
  ) {
    const marketAddress =
      market.market
        .toLowerCase();

    const token =
      market.token
        .toLowerCase();

    const quoteToken =
      market.quote_token
        .toLowerCase();

    const config =
      configs.get(
        `${token}:${quoteToken}`,
      ) ??
      null;

    const tokenInfo =
      metadata.get(
        token,
      ) ??
      null;

    const quoteInfo =
      metadata.get(
        quoteToken,
      ) ??
      null;

    if (
      !config ||
      !tokenInfo ||
      !quoteInfo
    ) {
      output.set(
        marketAddress,
        null,
      );

      continue;
    }

    const common = {
      market:
        marketAddress,

      stage:
        market.market_stage,

      token,

      quote_token:
        quoteToken,

      token_symbol:
        tokenInfo.symbol,

      quote_symbol:
        quoteInfo.symbol,

      token_decimals:
        tokenInfo.decimals,

      quote_decimals:
        quoteInfo.decimals,

      curve:
        config.curve,

      curve_allocation_raw:
        config.curve_allocation,

      starting_price_raw:
        config.starting_price,

      slope_raw:
        config.slope,

      tokens_sold_raw:
        config.tokens_sold_after ??
        "0",

      quote_reserve_raw:
        config.quote_reserve_after ??
        "0",
    };

    if (
      market.market_stage ===
      "CURVE"
    ) {
      output.set(
        marketAddress,
        {
          ...common,

          state_updated_at:
            config.curve_state_at ??
            null,
        },
      );

      continue;
    }

    if (
      market.market_stage ===
      "AMM"
    ) {
      const amm =
        ammStates.get(
          marketAddress,
        ) ??
        null;

      if (!amm) {
        output.set(
          marketAddress,
          null,
        );

        continue;
      }

      output.set(
        marketAddress,
        {
          ...common,

          token_reserve_raw:
            amm.token_reserve,

          amm_quote_reserve_raw:
            amm.quote_reserve,

          state_updated_at:
            amm.state_updated_at ??
            null,
        },
      );

      continue;
    }

    output.set(
      marketAddress,
      null,
    );
  }

  return output;
}

async function buildCurveBuyPoint(
  state,
  targetBps,
  currentPriceRaw,
  protocolFeeBps,
) {
  const sold =
    BigInt(
      state.tokens_sold_raw,
    );

  const allocation =
    BigInt(
      state.curve_allocation_raw,
    );

  const remaining =
    allocation - sold;

  const search =
    findMaximumWithinImpact({
      maxAmount:
        remaining,

      currentPriceRaw,

      targetBps,

      postPriceForAmount:
        (amount) =>
          curvePriceRaw({
            startingPriceRaw:
              state.starting_price_raw,

            slopeRaw:
              state.slope_raw,

            tokensSoldRaw:
              sold + amount,

            tokenDecimals:
              state.token_decimals,
          }),
    });

  if (
    search.amount === 0n
  ) {
    return null;
  }

  /*
   * For curve buys, exact-output gives us
   * the authoritative gross quote required
   * for precisely the token amount selected
   * by the local impact boundary.
   */
  const routerQuote =
    await quoteExactOutput(
      state.quote_token,
      state.token,
      search.amount,
    );

  const curveQuote =
    quoteCurveBuyRaw(
      state,
      search.amount,
    );

  if (
    curveQuote === null
  ) {
    return null;
  }

  const grossQuote =
    routerQuote.amount_in;

  const protocolFee =
    grossQuote >=
      curveQuote
      ? grossQuote -
        curveQuote
      : 0n;

  const postPrice =
    curvePriceRaw({
      startingPriceRaw:
        state.starting_price_raw,

      slopeRaw:
        state.slope_raw,

      tokensSoldRaw:
        sold +
        search.amount,

      tokenDecimals:
        state.token_decimals,
    });

  const tokenUnit =
    10n ** BigInt(
      state.token_decimals,
    );

  const averageExecutionPrice =
    grossQuote *
    tokenUnit /
    search.amount;

  const averageExFeePrice =
    curveQuote *
    tokenUnit /
    search.amount;

  return {
    target_market_impact_pct:
      targetBps /
      100,

    threshold_reached:
      search
        .threshold_reached,

    quote_method:
      "quoteExactOutput",

    venue:
      VENUE[
        routerQuote.venue
      ] ??
      "UNKNOWN",

    input_raw:
      grossQuote
        .toString(),

    input:
      formatUnits(
        grossQuote,
        state.quote_decimals,
      ),

    input_symbol:
      state.quote_symbol,

    output_raw:
      search.amount
        .toString(),

    output:
      formatUnits(
        search.amount,
        state.token_decimals,
      ),

    output_symbol:
      state.token_symbol,

    curve_quote_raw:
      curveQuote
        .toString(),

    curve_quote:
      formatUnits(
        curveQuote,
        state.quote_decimals,
      ),

    protocol_fee_bps:
      Number(
        protocolFeeBps,
      ),

    protocol_fee_raw:
      protocolFee
        .toString(),

    protocol_fee:
      formatUnits(
        protocolFee,
        state.quote_decimals,
      ),

    average_execution_price_raw:
      averageExecutionPrice
        .toString(),

    average_execution_price:
      formatUnits(
        averageExecutionPrice,
        state.quote_decimals,
      ),

    average_execution_price_excluding_fee_raw:
      averageExFeePrice
        .toString(),

    average_execution_price_excluding_fee:
      formatUnits(
        averageExFeePrice,
        state.quote_decimals,
      ),

    post_trade_spot_price_raw:
      postPrice
        .toString(),

    post_trade_spot_price:
      formatUnits(
        postPrice,
        state.quote_decimals,
      ),

    market_impact_pct:
      percentDelta(
        currentPriceRaw,
        postPrice,
      ),

    execution_deviation_excluding_fee_pct:
      directionalDeviationPct(
        currentPriceRaw,
        averageExFeePrice,
        "BUY",
      ),

    effective_deviation_including_fees_pct:
      directionalDeviationPct(
        currentPriceRaw,
        averageExecutionPrice,
        "BUY",
      ),

    output_surplus_raw:
      routerQuote
        .output_surplus
        .toString(),

    quote_verified:
      routerQuote.venue ===
        1 &&
      routerQuote
        .output_surplus ===
        0n,
  };
}

async function buildCurveSellPoint(
  state,
  targetBps,
  currentPriceRaw,
  protocolFeeBps,
  maximumSell,
) {
  const sold =
    BigInt(
      state.tokens_sold_raw,
    );

  const search =
    findMaximumWithinImpact({
      maxAmount:
        maximumSell,

      currentPriceRaw,

      targetBps,

      postPriceForAmount:
        (amount) =>
          curvePriceRaw({
            startingPriceRaw:
              state.starting_price_raw,

            slopeRaw:
              state.slope_raw,

            tokensSoldRaw:
              sold - amount,

            tokenDecimals:
              state.token_decimals,
          }),
    });

  if (
    search.amount === 0n
  ) {
    return null;
  }

  const routerQuote =
    await quoteExactInput(
      state.token,
      state.quote_token,
      search.amount,
    );

  const curveQuote =
    quoteCurveSellRaw(
      state,
      search.amount,
    );

  if (
    curveQuote === null
  ) {
    return null;
  }

  const protocolFee =
    curveQuote >=
      routerQuote.amount_out
      ? curveQuote -
        routerQuote.amount_out
      : 0n;

  const postPrice =
    curvePriceRaw({
      startingPriceRaw:
        state.starting_price_raw,

      slopeRaw:
        state.slope_raw,

      tokensSoldRaw:
        sold -
        search.amount,

      tokenDecimals:
        state.token_decimals,
    });

  const tokenUnit =
    10n ** BigInt(
      state.token_decimals,
    );

  const averageExecutionPrice =
    routerQuote.amount_out *
    tokenUnit /
    routerQuote.amount_in_used;

  const averageExFeePrice =
    curveQuote *
    tokenUnit /
    routerQuote.amount_in_used;

  return {
    target_market_impact_pct:
      targetBps /
      100,

    threshold_reached:
      search
        .threshold_reached,

    quote_method:
      "quoteExactInput",

    venue:
      VENUE[
        routerQuote.venue
      ] ??
      "UNKNOWN",

    input_raw:
      routerQuote
        .amount_in_used
        .toString(),

    input:
      formatUnits(
        routerQuote
          .amount_in_used,
        state.token_decimals,
      ),

    input_symbol:
      state.token_symbol,

    output_raw:
      routerQuote
        .amount_out
        .toString(),

    output:
      formatUnits(
        routerQuote
          .amount_out,
        state.quote_decimals,
      ),

    output_symbol:
      state.quote_symbol,

    curve_quote_raw:
      curveQuote
        .toString(),

    curve_quote:
      formatUnits(
        curveQuote,
        state.quote_decimals,
      ),

    protocol_fee_bps:
      Number(
        protocolFeeBps,
      ),

    protocol_fee_raw:
      protocolFee
        .toString(),

    protocol_fee:
      formatUnits(
        protocolFee,
        state.quote_decimals,
      ),

    average_execution_price_raw:
      averageExecutionPrice
        .toString(),

    average_execution_price:
      formatUnits(
        averageExecutionPrice,
        state.quote_decimals,
      ),

    average_execution_price_excluding_fee_raw:
      averageExFeePrice
        .toString(),

    average_execution_price_excluding_fee:
      formatUnits(
        averageExFeePrice,
        state.quote_decimals,
      ),

    post_trade_spot_price_raw:
      postPrice
        .toString(),

    post_trade_spot_price:
      formatUnits(
        postPrice,
        state.quote_decimals,
      ),

    market_impact_pct:
      percentDelta(
        currentPriceRaw,
        postPrice,
      ),

    execution_deviation_excluding_fee_pct:
      directionalDeviationPct(
        currentPriceRaw,
        averageExFeePrice,
        "SELL",
      ),

    effective_deviation_including_fees_pct:
      directionalDeviationPct(
        currentPriceRaw,
        averageExecutionPrice,
        "SELL",
      ),

    refund_raw:
      routerQuote
        .refund
        .toString(),

    quote_verified:
      routerQuote.venue ===
        1 &&
      routerQuote
        .amount_in_used ===
        search.amount &&
      routerQuote
        .refund ===
        0n,
  };
}

function ammPostPriceBuy(
  state,
  amountIn,
  amountOut,
) {
  const tokenReserve =
    BigInt(
      state.token_reserve_raw,
    );

  const quoteReserve =
    BigInt(
      state.amm_quote_reserve_raw,
    );

  const nextToken =
    tokenReserve -
    amountOut;

  const nextQuote =
    quoteReserve +
    amountIn;

  return ammSpotPriceRaw(
    nextToken,
    nextQuote,
    state.token_decimals,
  );
}

function ammPostPriceSell(
  state,
  amountIn,
  amountOut,
) {
  const tokenReserve =
    BigInt(
      state.token_reserve_raw,
    );

  const quoteReserve =
    BigInt(
      state.amm_quote_reserve_raw,
    );

  const nextToken =
    tokenReserve +
    amountIn;

  const nextQuote =
    quoteReserve -
    amountOut;

  return ammSpotPriceRaw(
    nextToken,
    nextQuote,
    state.token_decimals,
  );
}

async function buildAmmPoint(
  state,
  side,
  targetBps,
  currentPriceRaw,
) {
  const tokenReserve =
    BigInt(
      state.token_reserve_raw,
    );

  const quoteReserve =
    BigInt(
      state.amm_quote_reserve_raw,
    );

  const isBuy =
    side ===
    "BUY";

  const reserveIn =
    isBuy
      ? quoteReserve
      : tokenReserve;

  const reserveOut =
    isBuy
      ? tokenReserve
      : quoteReserve;

  const search =
    findAmmInputWithinImpact({
      currentPriceRaw,

      targetBps,

      postPriceForInput:
        (amountIn) => {
          const amountOut =
            ammAmountOut(
              amountIn,
              reserveIn,
              reserveOut,
            );

          return isBuy
            ? ammPostPriceBuy(
                state,
                amountIn,
                amountOut,
              )
            : ammPostPriceSell(
                state,
                amountIn,
                amountOut,
              );
        },
    });

  if (
    search.amount === 0n
  ) {
    return null;
  }

  const tokenIn =
    isBuy
      ? state.quote_token
      : state.token;

  const tokenOut =
    isBuy
      ? state.token
      : state.quote_token;

  const routerQuote =
    await quoteExactInput(
      tokenIn,
      tokenOut,
      search.amount,
    );

  const localAmountOut =
    ammAmountOut(
      search.amount,
      reserveIn,
      reserveOut,
    );

  const postPrice =
    isBuy
      ? ammPostPriceBuy(
          state,
          routerQuote
            .amount_in_used,
          routerQuote
            .amount_out,
        )
      : ammPostPriceSell(
          state,
          routerQuote
            .amount_in_used,
          routerQuote
            .amount_out,
        );

  const tokenUnit =
    10n ** BigInt(
      state.token_decimals,
    );

  let averageExecutionPrice;
  let averageExFeePrice;

  if (isBuy) {
    averageExecutionPrice =
      routerQuote
        .amount_in_used *
      tokenUnit /
      routerQuote
        .amount_out;

    averageExFeePrice =
      (
        routerQuote
          .amount_in_used *
        AMM_FEE_NUMERATOR *
        tokenUnit
      ) /
      (
        AMM_FEE_DENOMINATOR *
        routerQuote
          .amount_out
      );
  } else {
    averageExecutionPrice =
      routerQuote
        .amount_out *
      tokenUnit /
      routerQuote
        .amount_in_used;

    averageExFeePrice =
      (
        routerQuote
          .amount_out *
        tokenUnit *
        AMM_FEE_DENOMINATOR
      ) /
      (
        routerQuote
          .amount_in_used *
        AMM_FEE_NUMERATOR
      );
  }

  const inputDecimals =
    isBuy
      ? state.quote_decimals
      : state.token_decimals;

  const outputDecimals =
    isBuy
      ? state.token_decimals
      : state.quote_decimals;

  return {
    target_market_impact_pct:
      targetBps /
      100,

    threshold_reached:
      search
        .threshold_reached,

    quote_method:
      "quoteExactInput",

    venue:
      VENUE[
        routerQuote.venue
      ] ??
      "UNKNOWN",

    input_raw:
      routerQuote
        .amount_in_used
        .toString(),

    input:
      formatUnits(
        routerQuote
          .amount_in_used,
        inputDecimals,
      ),

    input_symbol:
      isBuy
        ? state.quote_symbol
        : state.token_symbol,

    output_raw:
      routerQuote
        .amount_out
        .toString(),

    output:
      formatUnits(
        routerQuote
          .amount_out,
        outputDecimals,
      ),

    output_symbol:
      isBuy
        ? state.token_symbol
        : state.quote_symbol,

    amm_swap_fee_bps:
      AMM_FEE_BPS,

    protocol_fee_bps:
      0,

    average_execution_price_raw:
      averageExecutionPrice
        .toString(),

    average_execution_price:
      formatUnits(
        averageExecutionPrice,
        state.quote_decimals,
      ),

    average_execution_price_excluding_fee_raw:
      averageExFeePrice
        .toString(),

    average_execution_price_excluding_fee:
      formatUnits(
        averageExFeePrice,
        state.quote_decimals,
      ),

    post_trade_spot_price_raw:
      postPrice
        .toString(),

    post_trade_spot_price:
      formatUnits(
        postPrice,
        state.quote_decimals,
      ),

    market_impact_pct:
      percentDelta(
        currentPriceRaw,
        postPrice,
      ),

    execution_deviation_excluding_fee_pct:
      directionalDeviationPct(
        currentPriceRaw,
        averageExFeePrice,
        side,
      ),

    effective_deviation_including_fees_pct:
      directionalDeviationPct(
        currentPriceRaw,
        averageExecutionPrice,
        side,
      ),

    refund_raw:
      routerQuote
        .refund
        .toString(),

    quote_verified:
      routerQuote.venue ===
        2 &&
      routerQuote
        .amount_in_used ===
        search.amount &&
      routerQuote
        .amount_out ===
        localAmountOut &&
      routerQuote
        .refund ===
        0n,
  };
}

async function buildCurveExecution(
  state,
) {
  const feeBps =
    BigInt(
      await client.readContract({
        address:
          state.curve,

        abi:
          CURVE_ABI,

        functionName:
          "PROTOCOL_FEE_BPS",
      }),
    );

  const currentPrice =
    curvePriceRaw({
      startingPriceRaw:
        state.starting_price_raw,

      slopeRaw:
        state.slope_raw,

      tokensSoldRaw:
        state.tokens_sold_raw,

      tokenDecimals:
        state.token_decimals,
    });

  const maximumSell =
    maxExecutableCurveSell(
      state,
    );

  const buyEntries =
    await Promise.all(
      DEPTH_TARGETS_BPS.map(
        async (
          targetBps,
        ) => [
          thresholdKey(
            targetBps,
          ),

          await buildCurveBuyPoint(
            state,
            targetBps,
            currentPrice,
            feeBps,
          ),
        ],
      ),
    );

  const sellEntries =
    await Promise.all(
      DEPTH_TARGETS_BPS.map(
        async (
          targetBps,
        ) => [
          thresholdKey(
            targetBps,
          ),

          await buildCurveSellPoint(
            state,
            targetBps,
            currentPrice,
            feeBps,
            maximumSell,
          ),
        ],
      ),
    );

  return {
    model:
      "trade_router_depth_v1",

    available:
      true,

    venue:
      "CURVE",

    trade_router:
      TRADE_ROUTER,

    market_impact_definition:
      "absolute post-trade marginal spot-price movement from the pre-trade spot price",

    fee_model:
      "curve_protocol_fee",

    protocol_fee_bps:
      Number(
        feeBps,
      ),

    amm_swap_fee_bps:
      null,

    current_spot_price_raw:
      currentPrice
        .toString(),

    current_spot_price:
      formatUnits(
        currentPrice,
        state.quote_decimals,
      ),

    price_unit:
      priceUnit(
        state.quote_symbol,
        state.token_symbol,
      ),

    max_executable_sell_raw:
      maximumSell
        .toString(),

    max_executable_sell:
      formatUnits(
        maximumSell,
        state.token_decimals,
      ),

    state_updated_at:
      state.state_updated_at,

    depth: {
      buy:
        Object.fromEntries(
          buyEntries,
        ),

      sell:
        Object.fromEntries(
          sellEntries,
        ),
    },

    quote_source:
      "ReLaunchTradeRouter",
  };
}

async function buildAmmExecution(
  state,
) {
  const currentPrice =
    ammSpotPriceRaw(
      state.token_reserve_raw,
      state.amm_quote_reserve_raw,
      state.token_decimals,
    );

  if (
    currentPrice === null
  ) {
    return {
      model:
        "trade_router_depth_v1",

      available:
        false,

      venue:
        "AMM",
    };
  }

  const buyEntries =
    await Promise.all(
      DEPTH_TARGETS_BPS.map(
        async (
          targetBps,
        ) => [
          thresholdKey(
            targetBps,
          ),

          await buildAmmPoint(
            state,
            "BUY",
            targetBps,
            currentPrice,
          ),
        ],
      ),
    );

  const sellEntries =
    await Promise.all(
      DEPTH_TARGETS_BPS.map(
        async (
          targetBps,
        ) => [
          thresholdKey(
            targetBps,
          ),

          await buildAmmPoint(
            state,
            "SELL",
            targetBps,
            currentPrice,
          ),
        ],
      ),
    );

  return {
    model:
      "trade_router_depth_v1",

    available:
      true,

    venue:
      "AMM",

    trade_router:
      TRADE_ROUTER,

    market_impact_definition:
      "absolute post-trade marginal spot-price movement from the pre-trade spot price",

    fee_model:
      "canonical_uniswap_v2",

    protocol_fee_bps:
      0,

    amm_swap_fee_bps:
      AMM_FEE_BPS,

    current_spot_price_raw:
      currentPrice
        .toString(),

    current_spot_price:
      formatUnits(
        currentPrice,
        state.quote_decimals,
      ),

    price_unit:
      priceUnit(
        state.quote_symbol,
        state.token_symbol,
      ),

    token_reserve_raw:
      state.token_reserve_raw,

    token_reserve:
      formatUnits(
        state.token_reserve_raw,
        state.token_decimals,
      ),

    quote_reserve_raw:
      state.amm_quote_reserve_raw,

    quote_reserve:
      formatUnits(
        state.amm_quote_reserve_raw,
        state.quote_decimals,
      ),

    state_updated_at:
      state.state_updated_at,

    depth: {
      buy:
        Object.fromEntries(
          buyEntries,
        ),

      sell:
        Object.fromEntries(
          sellEntries,
        ),
    },

    quote_source:
      "ReLaunchTradeRouter",
  };
}

export async function loadMarketExecution(
  markets,
) {
  const output =
    new Map();

  if (!markets.length) {
    return output;
  }

  const states =
    await loadExecutionStates(
      markets,
    );

  await Promise.all(
    markets.map(
      async (
        market,
      ) => {
        const key =
          market.market
            .toLowerCase();

        const state =
          states.get(
            key,
          ) ??
          null;

        if (!state) {
          output.set(
            key,
            {
              model:
                "trade_router_depth_v1",

              available:
                false,

              venue:
                market.market_stage ??
                null,
            },
          );

          return;
        }

        try {
          if (
            market.market_stage ===
            "CURVE"
          ) {
            output.set(
              key,
              await buildCurveExecution(
                state,
              ),
            );

            return;
          }

          if (
            market.market_stage ===
            "AMM"
          ) {
            output.set(
              key,
              await buildAmmExecution(
                state,
              ),
            );

            return;
          }

          output.set(
            key,
            {
              model:
                "trade_router_depth_v1",

              available:
                false,

              venue:
                market.market_stage ??
                null,
            },
          );
        } catch (
          error
        ) {
          output.set(
            key,
            {
              model:
                "trade_router_depth_v1",

              available:
                false,

              venue:
                market.market_stage ??
                null,

              error:
                "execution_quote_unavailable",

              detail:
                error instanceof
                  Error
                  ? error.message
                  : String(
                      error,
                    ),
            },
          );
        }
      },
    ),
  );

  return output;
}
