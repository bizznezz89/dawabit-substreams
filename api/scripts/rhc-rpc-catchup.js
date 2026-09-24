import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";

import { config } from "../src/config.js";
import { db } from "../src/db.js";

const FACTORY =
  "0x0E54a12dB2d6B8f309269ef98F8b9c2764aa3A92";

const GRADUATION_ROUTER =
  "0x5eCC1aB2CA5e11629fcE19495669dFbE0E78C3d4";

const SOURCE =
  "rhc_rpc";

const CONFIRMATIONS =
  BigInt(
    process.env.RHC_RPC_CONFIRMATIONS ??
      "64",
  );

const CHUNK_SIZE =
  BigInt(
    process.env.RHC_RPC_CHUNK_SIZE ??
      "1000",
  );

const ADDRESS_BATCH_SIZE = 50;

const curveCreatedEvent =
  parseAbiItem(
    "event CurveCreated(address indexed curve, address indexed token, address indexed quoteToken, address creator, uint256 curveAllocation, uint256 liquidityReserve, uint256 startingPrice, uint256 slope, uint256 graduationThreshold, uint8 tokenDecimals)",
  );

const liquiditySeededEvent =
  parseAbiItem(
    "event LiquiditySeeded(address indexed curve, address indexed pair, address indexed token, address quoteToken, uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity)",
  );

const curveEventsAbi =
  parseAbi([
    "event Activated(address indexed funder, uint256 allocation)",
    "event CurveBuy(address indexed trader, uint256 tokenAmount, uint256 curveQuote, uint256 protocolFee, uint256 totalQuoteIn, uint256 tokensSoldAfter, uint256 quoteReserveAfter)",
    "event CurveExactInputBuy(address indexed trader, uint256 grossQuoteLimit, uint256 actualQuoteIn, uint256 refundQuote, uint256 tokenAmount)",
    "event CurveSell(address indexed trader, uint256 tokenAmount, uint256 curveQuote, uint256 protocolFee, uint256 netQuoteOut, uint256 tokensSoldAfter, uint256 quoteReserveAfter)",
    "event CurveStateChanged(uint8 indexed previousState, uint8 indexed newState)",
    "event Graduated(address indexed graduationRouter, uint256 tokenAmount, uint256 quoteAmount)",
  ]);

const pairEventsAbi =
  parseAbi([
    "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
    "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    "event Sync(uint112 reserve0, uint112 reserve1)",
  ]);

const client =
  createPublicClient({
    transport:
      http(
        config.rhcRpcUrl,
        {
          retryCount: 3,
          timeout: 20_000,
        },
      ),
  });

function lower(
  value,
) {
  return String(
    value,
  ).toLowerCase();
}

function strip0x(
  value,
) {
  const text =
    lower(
      value,
    );

  return text.startsWith(
    "0x",
  )
    ? text.slice(
        2,
      )
    : text;
}

function requireNumber(
  value,
  name,
) {
  if (
    value === null ||
    value === undefined
  ) {
    throw new Error(
      `Missing ${name}`,
    );
  }

  return Number(
    value,
  );
}

function eventId(
  transactionHash,
  logIndex,
) {
  return `${strip0x(
    transactionHash,
  )}:${logIndex}`;
}

function pgTimestamp(
  seconds,
) {
  return new Date(
    Number(
      seconds,
    ) * 1000,
  )
    .toISOString()
    .slice(
      0,
      19,
    )
    .replace(
      "T",
      " ",
    );
}

function batches(
  values,
  size,
) {
  const result = [];

  for (
    let i = 0;
    i < values.length;
    i += size
  ) {
    result.push(
      values.slice(
        i,
        i + size,
      ),
    );
  }

  return result;
}

async function getLogsForAddresses(
  addresses,
  fromBlock,
  toBlock,
) {
  if (
    addresses.length === 0
  ) {
    return [];
  }

  const logs = [];

  for (
    const group of batches(
      addresses,
      ADDRESS_BATCH_SIZE,
    )
  ) {
    const result =
      await client.getLogs({
        address:
          group.length === 1
            ? group[0]
            : group,

        fromBlock,
        toBlock,
      });

    logs.push(
      ...result,
    );
  }

  return logs;
}

function compareLogs(
  a,
  b,
) {
  const blockA =
    a.blockNumber ??
    0n;

  const blockB =
    b.blockNumber ??
    0n;

  if (
    blockA < blockB
  ) {
    return -1;
  }

  if (
    blockA > blockB
  ) {
    return 1;
  }

  return (
    requireNumber(
      a.logIndex,
      "logIndex",
    ) -
    requireNumber(
      b.logIndex,
      "logIndex",
    )
  );
}

function decodeLog(
  abi,
  log,
) {
  try {
    return decodeEventLog({
      abi,
      data:
        log.data,
      topics:
        log.topics,
      strict:
        true,
    });
  } catch {
    return null;
  }
}

const blockCache =
  new Map();

async function getBlockMeta(
  blockNumber,
) {
  const key =
    blockNumber.toString();

  const cached =
    blockCache.get(
      key,
    );

  if (cached) {
    return cached;
  }

  const block =
    await client.getBlock({
      blockNumber,
    });

  if (!block.hash) {
    throw new Error(
      `Block ${blockNumber} has no hash`,
    );
  }

  const meta = {
    number:
      blockNumber,

    hash:
      strip0x(
        block.hash,
      ),

    timestamp:
      pgTimestamp(
        block.timestamp,
      ),
  };

  blockCache.set(
    key,
    meta,
  );

  return meta;
}

async function loadCurves() {
  const result =
    await db.query(`
      SELECT
        curve,
        token,
        quote_token,
        creator,
        curve_allocation,
        liquidity_reserve,
        starting_price,
        slope,
        graduation_threshold,
        token_decimals
      FROM market_config
    `);

  const curves =
    new Map();

  for (
    const row of
    result.rows
  ) {
    curves.set(
      lower(
        row.curve,
      ),
      {
        curve:
          lower(
            row.curve,
          ),

        token:
          lower(
            row.token,
          ),

        quoteToken:
          lower(
            row.quote_token,
          ),

        creator:
          lower(
            row.creator,
          ),

        curveAllocation:
          row.curve_allocation.toString(),

        liquidityReserve:
          row.liquidity_reserve.toString(),

        startingPrice:
          row.starting_price.toString(),

        slope:
          row.slope.toString(),

        graduationThreshold:
          row.graduation_threshold.toString(),

        tokenDecimals:
          Number(
            row.token_decimals,
          ),
      },
    );
  }

  return curves;
}

async function loadPools() {
  const result =
    await db.query(`
      SELECT
        pair,
        curve,
        token,
        quote_token,
        token0,
        token1,
        token_is_token0,
        token_amount,
        quote_amount,
        liquidity
      FROM amm_pool_config
    `);

  const pools =
    new Map();

  for (
    const row of
    result.rows
  ) {
    pools.set(
      lower(
        row.pair,
      ),
      {
        pair:
          lower(
            row.pair,
          ),

        curve:
          lower(
            row.curve,
          ),

        token:
          lower(
            row.token,
          ),

        quoteToken:
          lower(
            row.quote_token,
          ),

        token0:
          lower(
            row.token0,
          ),

        token1:
          lower(
            row.token1,
          ),

        tokenIsToken0:
          row.token_is_token0,

        tokenAmount:
          row.token_amount.toString(),

        quoteAmount:
          row.quote_amount.toString(),

        liquidity:
          row.liquidity.toString(),
      },
    );
  }

  return pools;
}

async function insertMarketConfig(
  sql,
  discovered,
) {
  await sql.query(
    `
      INSERT INTO market_config (
        curve,
        token,
        quote_token,
        creator,

        curve_allocation,
        liquidity_reserve,
        starting_price,
        slope,
        graduation_threshold,

        token_decimals,

        creation_block,
        transaction_hash,
        ordinal,
        log_index,
        source,

        updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10,
        $11, $12, NULL, $13, 'rpc',
        NOW()
      )
      ON CONFLICT (curve)
      DO UPDATE SET
        token =
          EXCLUDED.token,

        quote_token =
          EXCLUDED.quote_token,

        creator =
          EXCLUDED.creator,

        curve_allocation =
          EXCLUDED.curve_allocation,

        liquidity_reserve =
          EXCLUDED.liquidity_reserve,

        starting_price =
          EXCLUDED.starting_price,

        slope =
          EXCLUDED.slope,

        graduation_threshold =
          EXCLUDED.graduation_threshold,

        token_decimals =
          EXCLUDED.token_decimals,

        creation_block =
          EXCLUDED.creation_block,

        transaction_hash =
          EXCLUDED.transaction_hash,

        log_index =
          EXCLUDED.log_index,

        source =
          CASE
            WHEN market_config.source = 'substreams'
              THEN market_config.source
            ELSE EXCLUDED.source
          END,

        updated_at =
          NOW()
    `,
    [
      discovered.curve,
      discovered.token,
      discovered.quoteToken,
      discovered.creator,

      discovered.curveAllocation,
      discovered.liquidityReserve,
      discovered.startingPrice,
      discovered.slope,
      discovered.graduationThreshold,

      discovered.tokenDecimals,

      discovered.blockNumber.toString(),
      discovered.transactionHash,
      discovered.logIndex,
    ],
  );
}

async function insertPoolConfig(
  sql,
  pool,
) {
  await sql.query(
    `
      INSERT INTO amm_pool_config (
        pair,
        curve,
        token,
        quote_token,

        token0,
        token1,
        token_is_token0,

        token_amount,
        quote_amount,
        liquidity,

        discovery_block,
        discovery_block_hash,

        transaction_hash,
        transaction_index,
        log_index,

        source,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        'rpc',
        NOW()
      )
      ON CONFLICT (pair)
      DO UPDATE SET
        curve =
          EXCLUDED.curve,

        token =
          EXCLUDED.token,

        quote_token =
          EXCLUDED.quote_token,

        token0 =
          EXCLUDED.token0,

        token1 =
          EXCLUDED.token1,

        token_is_token0 =
          EXCLUDED.token_is_token0,

        token_amount =
          EXCLUDED.token_amount,

        quote_amount =
          EXCLUDED.quote_amount,

        liquidity =
          EXCLUDED.liquidity,

        discovery_block =
          EXCLUDED.discovery_block,

        discovery_block_hash =
          EXCLUDED.discovery_block_hash,

        transaction_hash =
          EXCLUDED.transaction_hash,

        transaction_index =
          EXCLUDED.transaction_index,

        log_index =
          EXCLUDED.log_index,

        updated_at =
          NOW()
    `,
    [
      pool.pair,
      pool.curve,
      pool.token,
      pool.quoteToken,

      pool.token0,
      pool.token1,
      pool.tokenIsToken0,

      pool.tokenAmount,
      pool.quoteAmount,
      pool.liquidity,

      pool.blockNumber.toString(),
      pool.blockHash,

      pool.transactionHash,
      pool.transactionIndex,
      pool.logIndex,
    ],
  );
}

async function insertMarketActivity(
  sql,
  row,
) {
  await sql.query(
    `
      INSERT INTO rpc_marketactivity (
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
        block_hash,

        transaction_hash,
        transaction_index,
        log_index,

        event_id
      )
      VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        $16
      )
      ON CONFLICT (event_id)
      DO NOTHING
    `,
    [
      row.blockNumber,
      row.blockTimestamp,

      row.marketStage,
      row.eventType,
      row.canonicalTrade,

      row.market,
      row.curve,
      row.pair,
      row.token,
      row.quoteToken,

      row.blockNumber,
      row.blockHash,

      row.transactionHash,
      row.transactionIndex,
      row.logIndex,

      row.eventId,
    ],
  );
}

async function insertCurveActivity(
  sql,
  row,
) {
  await sql.query(
    `
      INSERT INTO rpc_curveactivity (
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
        block_hash,

        transaction_hash,
        transaction_index,
        log_index,

        event_id
      )
      VALUES (
        $1, $2,
        $3, $4,
        $5, $6, $7, $8,
        $9,
        $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19,
        $20,
        $21, $22,
        $23, $24,
        $25, $26,
        $27, $28, $29,
        $30
      )
      ON CONFLICT (event_id)
      DO NOTHING
    `,
    [
      row.blockNumber,
      row.blockTimestamp,

      row.eventType,
      row.canonicalTrade,

      row.curve,
      row.token,
      row.quoteToken,
      row.tokenDecimals,

      row.actor,

      row.tokenAmount,
      row.curveQuote,
      row.protocolFee,
      row.grossQuoteIn,
      row.netQuoteOut,
      row.tokensSoldAfter,
      row.quoteReserveAfter,

      row.grossQuoteLimit,
      row.actualQuoteIn,
      row.refundQuote,

      row.allocation,

      row.previousState,
      row.newState,

      row.graduationRouter,
      row.graduationQuoteAmount,

      row.blockNumber,
      row.blockHash,

      row.transactionHash,
      row.transactionIndex,
      row.logIndex,

      row.eventId,
    ],
  );
}

async function insertAmmActivity(
  sql,
  row,
) {
  await sql.query(
    `
      INSERT INTO rpc_ammactivity (
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
        block_hash,

        transaction_hash,
        transaction_index,
        log_index,

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
      )
      VALUES (
        $1, $2,
        $3,
        $4, $5, $6, $7,
        $8, $9,
        $10, $11,
        $12, $13, $14, $15,
        $16, $17,
        $18, $19,
        $20, $21, $22,
        $23, $24, $25,
        $26, $27,
        $28, $29, $30, $31,
        $32, $33,
        $34
      )
      ON CONFLICT (event_id)
      DO NOTHING
    `,
    [
      row.blockNumber,
      row.blockTimestamp,

      row.eventType,

      row.pair,
      row.curve,
      row.token,
      row.quoteToken,

      row.sender,
      row.to,

      row.amount0,
      row.amount1,

      row.amount0In,
      row.amount1In,
      row.amount0Out,
      row.amount1Out,

      row.reserve0,
      row.reserve1,

      row.blockNumber,
      row.blockHash,

      row.transactionHash,
      row.transactionIndex,
      row.logIndex,

      row.token0,
      row.token1,
      row.tokenIsToken0,

      row.tokenAmount,
      row.quoteAmount,

      row.tokenAmountIn,
      row.quoteAmountIn,
      row.tokenAmountOut,
      row.quoteAmountOut,

      row.tokenReserve,
      row.quoteReserve,

      row.eventId,
    ],
  );
}

function curveRowFromLog(
  log,
  decoded,
  curve,
  blockMeta,
) {
  const transactionHash =
    lower(
      log.transactionHash,
    );

  const logIndex =
    requireNumber(
      log.logIndex,
      "logIndex",
    );

  const transactionIndex =
    requireNumber(
      log.transactionIndex,
      "transactionIndex",
    );

  const row = {
    eventType:
      "",

    canonicalTrade:
      false,

    curve:
      curve.curve,

    token:
      curve.token,

    quoteToken:
      curve.quoteToken,

    tokenDecimals:
      curve.tokenDecimals,

    actor:
      "0x",

    tokenAmount:
      "",

    curveQuote:
      "",

    protocolFee:
      "",

    grossQuoteIn:
      "",

    netQuoteOut:
      "",

    tokensSoldAfter:
      "",

    quoteReserveAfter:
      "",

    grossQuoteLimit:
      "",

    actualQuoteIn:
      "",

    refundQuote:
      "",

    allocation:
      "",

    previousState:
      "0",

    newState:
      "0",

    graduationRouter:
      "0x",

    graduationQuoteAmount:
      "",

    blockNumber:
      log.blockNumber.toString(),

    blockHash:
      blockMeta.hash,

    blockTimestamp:
      blockMeta.timestamp,

    transactionHash,

    transactionIndex,

    logIndex,

    eventId:
      eventId(
        transactionHash,
        logIndex,
      ),
  };

  const args =
    decoded.args;

  switch (
    decoded.eventName
  ) {
    case "CurveBuy":
      row.eventType =
        "CURVE_BUY";

      row.canonicalTrade =
        true;

      row.actor =
        lower(
          args.trader,
        );

      row.tokenAmount =
        args.tokenAmount.toString();

      row.curveQuote =
        args.curveQuote.toString();

      row.protocolFee =
        args.protocolFee.toString();

      row.grossQuoteIn =
        args.totalQuoteIn.toString();

      row.tokensSoldAfter =
        args.tokensSoldAfter.toString();

      row.quoteReserveAfter =
        args.quoteReserveAfter.toString();

      break;

    case "CurveSell":
      row.eventType =
        "CURVE_SELL";

      row.canonicalTrade =
        true;

      row.actor =
        lower(
          args.trader,
        );

      row.tokenAmount =
        args.tokenAmount.toString();

      row.curveQuote =
        args.curveQuote.toString();

      row.protocolFee =
        args.protocolFee.toString();

      row.netQuoteOut =
        args.netQuoteOut.toString();

      row.tokensSoldAfter =
        args.tokensSoldAfter.toString();

      row.quoteReserveAfter =
        args.quoteReserveAfter.toString();

      break;

    case "CurveExactInputBuy":
      row.eventType =
        "CURVE_EXACT_INPUT_BUY_META";

      row.actor =
        lower(
          args.trader,
        );

      row.tokenAmount =
        args.tokenAmount.toString();

      row.grossQuoteLimit =
        args.grossQuoteLimit.toString();

      row.actualQuoteIn =
        args.actualQuoteIn.toString();

      row.refundQuote =
        args.refundQuote.toString();

      break;

    case "Activated":
      row.eventType =
        "ACTIVATED";

      row.actor =
        lower(
          args.funder,
        );

      row.allocation =
        args.allocation.toString();

      break;

    case "CurveStateChanged":
      row.eventType =
        "CURVE_STATE_CHANGED";

      row.previousState =
        args.previousState.toString();

      row.newState =
        args.newState.toString();

      break;

    case "Graduated":
      row.eventType =
        "GRADUATED";

      row.graduationRouter =
        lower(
          args.graduationRouter,
        );

      row.tokenAmount =
        args.tokenAmount.toString();

      row.graduationQuoteAmount =
        args.quoteAmount.toString();

      break;

    default:
      return null;
  }

  return row;
}

function ammRowFromLog(
  log,
  decoded,
  pool,
  blockMeta,
) {
  const transactionHash =
    lower(
      log.transactionHash,
    );

  const logIndex =
    requireNumber(
      log.logIndex,
      "logIndex",
    );

  const transactionIndex =
    requireNumber(
      log.transactionIndex,
      "transactionIndex",
    );

  const row = {
    eventType:
      "",

    pair:
      pool.pair,

    curve:
      pool.curve,

    token:
      pool.token,

    quoteToken:
      pool.quoteToken,

    sender:
      "0x",

    to:
      "0x",

    amount0:
      "",

    amount1:
      "",

    amount0In:
      "",

    amount1In:
      "",

    amount0Out:
      "",

    amount1Out:
      "",

    reserve0:
      "",

    reserve1:
      "",

    blockNumber:
      log.blockNumber.toString(),

    blockHash:
      blockMeta.hash,

    blockTimestamp:
      blockMeta.timestamp,

    transactionHash,

    transactionIndex,

    logIndex,

    token0:
      pool.token0,

    token1:
      pool.token1,

    tokenIsToken0:
      pool.tokenIsToken0,

    tokenAmount:
      "",

    quoteAmount:
      "",

    tokenAmountIn:
      "",

    quoteAmountIn:
      "",

    tokenAmountOut:
      "",

    quoteAmountOut:
      "",

    tokenReserve:
      "",

    quoteReserve:
      "",

    eventId:
      eventId(
        transactionHash,
        logIndex,
      ),
  };

  const args =
    decoded.args;

  switch (
    decoded.eventName
  ) {
    case "Swap": {
      row.eventType =
        "SWAP";

      row.sender =
        lower(
          args.sender,
        );

      row.to =
        lower(
          args.to,
        );

      row.amount0In =
        args.amount0In.toString();

      row.amount1In =
        args.amount1In.toString();

      row.amount0Out =
        args.amount0Out.toString();

      row.amount1Out =
        args.amount1Out.toString();

      if (
        pool.tokenIsToken0
      ) {
        row.tokenAmountIn =
          row.amount0In;

        row.quoteAmountIn =
          row.amount1In;

        row.tokenAmountOut =
          row.amount0Out;

        row.quoteAmountOut =
          row.amount1Out;
      } else {
        row.tokenAmountIn =
          row.amount1In;

        row.quoteAmountIn =
          row.amount0In;

        row.tokenAmountOut =
          row.amount1Out;

        row.quoteAmountOut =
          row.amount0Out;
      }

      break;
    }

    case "Sync": {
      row.eventType =
        "SYNC";

      row.reserve0 =
        args.reserve0.toString();

      row.reserve1 =
        args.reserve1.toString();

      if (
        pool.tokenIsToken0
      ) {
        row.tokenReserve =
          row.reserve0;

        row.quoteReserve =
          row.reserve1;
      } else {
        row.tokenReserve =
          row.reserve1;

        row.quoteReserve =
          row.reserve0;
      }

      break;
    }

    case "Mint": {
      row.eventType =
        "MINT";

      row.sender =
        lower(
          args.sender,
        );

      row.amount0 =
        args.amount0.toString();

      row.amount1 =
        args.amount1.toString();

      if (
        pool.tokenIsToken0
      ) {
        row.tokenAmount =
          row.amount0;

        row.quoteAmount =
          row.amount1;
      } else {
        row.tokenAmount =
          row.amount1;

        row.quoteAmount =
          row.amount0;
      }

      break;
    }

    case "Burn": {
      row.eventType =
        "BURN";

      row.sender =
        lower(
          args.sender,
        );

      row.to =
        lower(
          args.to,
        );

      row.amount0 =
        args.amount0.toString();

      row.amount1 =
        args.amount1.toString();

      if (
        pool.tokenIsToken0
      ) {
        row.tokenAmount =
          row.amount0;

        row.quoteAmount =
          row.amount1;
      } else {
        row.tokenAmount =
          row.amount1;

        row.quoteAmount =
          row.amount0;
      }

      break;
    }

    default:
      return null;
  }

  return row;
}

function marketRowFromCurve(
  row,
) {
  return {
    blockNumber:
      row.blockNumber,

    blockTimestamp:
      row.blockTimestamp,

    marketStage:
      "CURVE",

    eventType:
      row.eventType,

    canonicalTrade:
      row.canonicalTrade,

    market:
      row.curve,

    curve:
      row.curve,

    pair:
      "0x",

    token:
      row.token,

    quoteToken:
      row.quoteToken,

    blockHash:
      row.blockHash,

    transactionHash:
      row.transactionHash,

    transactionIndex:
      row.transactionIndex,

    logIndex:
      row.logIndex,

    eventId:
      row.eventId,
  };
}

function marketRowFromAmm(
  row,
) {
  return {
    blockNumber:
      row.blockNumber,

    blockTimestamp:
      row.blockTimestamp,

    marketStage:
      "AMM",

    eventType:
      row.eventType,

    canonicalTrade:
      row.eventType ===
      "SWAP",

    market:
      row.pair,

    curve:
      row.curve,

    pair:
      row.pair,

    token:
      row.token,

    quoteToken:
      row.quoteToken,

    blockHash:
      row.blockHash,

    transactionHash:
      row.transactionHash,

    transactionIndex:
      row.transactionIndex,

    logIndex:
      row.logIndex,

    eventId:
      row.eventId,
  };
}

async function main() {
  const stateResult =
    await db.query(
      `
        SELECT
          source,
          initial_block,
          last_processed_block,
          last_processed_block_hash
        FROM ingestion_state
        WHERE source = $1
      `,
      [
        SOURCE,
      ],
    );

  const state =
    stateResult.rows[0];

  if (!state) {
    throw new Error(
      `Missing ingestion_state row for ${SOURCE}`,
    );
  }

  const initialBlock =
    BigInt(
      state.initial_block,
    );

  const lastProcessedBlock =
    BigInt(
      state.last_processed_block,
    );

  const checkpointBlock =
    await client.getBlock({
      blockNumber:
        lastProcessedBlock,
    });

  const checkpointHash =
    strip0x(
      checkpointBlock.hash,
    );

  if (
    checkpointHash !==
    lower(
      state.last_processed_block_hash,
    )
  ) {
    throw new Error(
      [
        "RPC checkpoint hash mismatch.",
        `database=${state.last_processed_block_hash}`,
        `chain=${checkpointHash}`,
        `block=${lastProcessedBlock}`,
      ].join(
        " ",
      ),
    );
  }

  const head =
    await client.getBlockNumber();

  const target =
    head > CONFIRMATIONS
      ? head -
        CONFIRMATIONS
      : 0n;

  let fromBlock =
    lastProcessedBlock +
    1n;

  if (
    fromBlock <
    initialBlock
  ) {
    fromBlock =
      initialBlock;
  }

  console.log({
    source:
      SOURCE,

    checkpoint:
      lastProcessedBlock.toString(),

    initialBlock:
      initialBlock.toString(),

    head:
      head.toString(),

    confirmations:
      CONFIRMATIONS.toString(),

    target:
      target.toString(),

    nextBlock:
      fromBlock.toString(),
  });

  if (
    fromBlock >
    target
  ) {
    console.log(
      "Already caught up to the confirmed RPC target.",
    );

    return;
  }

  const curves =
    await loadCurves();

  const pools =
    await loadPools();

  console.log({
    knownCurves:
      curves.size,

    knownAmmPools:
      pools.size,
  });

  let totals = {
    curveDiscoveries:
      0,

    poolDiscoveries:
      0,

    curveActivities:
      0,

    ammActivities:
      0,
  };

  while (
    fromBlock <=
    target
  ) {
    let toBlock =
      fromBlock +
      CHUNK_SIZE -
      1n;

    if (
      toBlock >
      target
    ) {
      toBlock =
        target;
    }

    console.log(
      `Scanning ${fromBlock} -> ${toBlock}`,
    );

    const factoryLogs =
      await client.getLogs({
        address:
          FACTORY,

        event:
          curveCreatedEvent,

        fromBlock,
        toBlock,
      });

    const discoveredCurves =
      [];

    for (
      const log of
      factoryLogs
    ) {
      const args =
        log.args;

      const discovered = {
        curve:
          lower(
            args.curve,
          ),

        token:
          lower(
            args.token,
          ),

        quoteToken:
          lower(
            args.quoteToken,
          ),

        creator:
          lower(
            args.creator,
          ),

        curveAllocation:
          args.curveAllocation.toString(),

        liquidityReserve:
          args.liquidityReserve.toString(),

        startingPrice:
          args.startingPrice.toString(),

        slope:
          args.slope.toString(),

        graduationThreshold:
          args.graduationThreshold.toString(),

        tokenDecimals:
          Number(
            args.tokenDecimals,
          ),

        blockNumber:
          log.blockNumber,

        transactionHash:
          lower(
            log.transactionHash,
          ),

        transactionIndex:
          requireNumber(
            log.transactionIndex,
            "transactionIndex",
          ),

        logIndex:
          requireNumber(
            log.logIndex,
            "logIndex",
          ),
      };

      curves.set(
        discovered.curve,
        discovered,
      );

      discoveredCurves.push(
        discovered,
      );
    }

    const liquidityLogs =
      await client.getLogs({
        address:
          GRADUATION_ROUTER,

        event:
          liquiditySeededEvent,

        fromBlock,
        toBlock,
      });

    const discoveredPools =
      [];

    for (
      const log of
      liquidityLogs
    ) {
      const args =
        log.args;

      const token =
        lower(
          args.token,
        );

      const quoteToken =
        lower(
          args.quoteToken,
        );

      const tokenIsToken0 =
        token <
        quoteToken;

      const meta =
        await getBlockMeta(
          log.blockNumber,
        );

      const pool = {
        pair:
          lower(
            args.pair,
          ),

        curve:
          lower(
            args.curve,
          ),

        token,

        quoteToken,

        token0:
          tokenIsToken0
            ? token
            : quoteToken,

        token1:
          tokenIsToken0
            ? quoteToken
            : token,

        tokenIsToken0,

        tokenAmount:
          args.tokenAmount.toString(),

        quoteAmount:
          args.quoteAmount.toString(),

        liquidity:
          args.liquidity.toString(),

        blockNumber:
          log.blockNumber,

        blockHash:
          meta.hash,

        transactionHash:
          lower(
            log.transactionHash,
          ),

        transactionIndex:
          requireNumber(
            log.transactionIndex,
            "transactionIndex",
          ),

        logIndex:
          requireNumber(
            log.logIndex,
            "logIndex",
          ),
      };

      pools.set(
        pool.pair,
        pool,
      );

      discoveredPools.push(
        pool,
      );
    }

    const curveLogs =
      (
        await getLogsForAddresses(
          [
            ...curves.keys(),
          ],
          fromBlock,
          toBlock,
        )
      ).sort(
        compareLogs,
      );

    const pairLogs =
      (
        await getLogsForAddresses(
          [
            ...pools.keys(),
          ],
          fromBlock,
          toBlock,
        )
      ).sort(
        compareLogs,
      );

    const curveRows =
      [];

    for (
      const log of
      curveLogs
    ) {
      const decoded =
        decodeLog(
          curveEventsAbi,
          log,
        );

      if (!decoded) {
        continue;
      }

      const curve =
        curves.get(
          lower(
            log.address,
          ),
        );

      if (!curve) {
        continue;
      }

      const blockMeta =
        await getBlockMeta(
          log.blockNumber,
        );

      const row =
        curveRowFromLog(
          log,
          decoded,
          curve,
          blockMeta,
        );

      if (row) {
        curveRows.push(
          row,
        );
      }
    }

    const ammRows =
      [];

    for (
      const log of
      pairLogs
    ) {
      const decoded =
        decodeLog(
          pairEventsAbi,
          log,
        );

      if (!decoded) {
        continue;
      }

      const pool =
        pools.get(
          lower(
            log.address,
          ),
        );

      if (!pool) {
        continue;
      }

      const blockMeta =
        await getBlockMeta(
          log.blockNumber,
        );

      const row =
        ammRowFromLog(
          log,
          decoded,
          pool,
          blockMeta,
        );

      if (row) {
        ammRows.push(
          row,
        );
      }
    }

    const checkpointMeta =
      await getBlockMeta(
        toBlock,
      );

    const sql =
      await db.connect();

    try {
      await sql.query(
        "BEGIN",
      );

      for (
        const discovered of
        discoveredCurves
      ) {
        await insertMarketConfig(
          sql,
          discovered,
        );
      }

      for (
        const pool of
        discoveredPools
      ) {
        await insertPoolConfig(
          sql,
          pool,
        );
      }

      for (
        const row of
        curveRows
      ) {
        await insertCurveActivity(
          sql,
          row,
        );

        await insertMarketActivity(
          sql,
          marketRowFromCurve(
            row,
          ),
        );
      }

      for (
        const row of
        ammRows
      ) {
        await insertAmmActivity(
          sql,
          row,
        );

        await insertMarketActivity(
          sql,
          marketRowFromAmm(
            row,
          ),
        );
      }

      await sql.query(
        `
          UPDATE ingestion_state
          SET
            last_processed_block = $2,
            last_processed_block_hash = $3,
            updated_at = NOW()
          WHERE source = $1
        `,
        [
          SOURCE,
          toBlock.toString(),
          checkpointMeta.hash,
        ],
      );

      await sql.query(
        "COMMIT",
      );
    } catch (
      error
    ) {
      await sql.query(
        "ROLLBACK",
      );

      throw error;
    } finally {
      sql.release();
    }

    totals.curveDiscoveries +=
      discoveredCurves.length;

    totals.poolDiscoveries +=
      discoveredPools.length;

    totals.curveActivities +=
      curveRows.length;

    totals.ammActivities +=
      ammRows.length;

    console.log({
      committedThrough:
        toBlock.toString(),

      curveDiscoveries:
        discoveredCurves.length,

      poolDiscoveries:
        discoveredPools.length,

      curveActivities:
        curveRows.length,

      ammActivities:
        ammRows.length,
    });

    fromBlock =
      toBlock +
      1n;
  }

  console.log({
    complete:
      true,

    ...totals,
  });
}

try {
  await main();
} finally {
  await db.end();
}
