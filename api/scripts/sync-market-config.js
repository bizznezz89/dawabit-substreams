import { readFileSync } from "node:fs";
import {
  createPublicClient,
  http,
} from "viem";

import { db } from "../src/db.js";

const FACTORY =
  "0x0E54a12dB2d6B8f309269ef98F8b9c2764aa3A92";

const START_BLOCK = 66552064n;

const rpcUrl =
  process.env.RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({
  transport: http(rpcUrl),
});

const rawAbi = JSON.parse(
  readFileSync(
    "/workspace/dawabit_substreams/abi/relaunch_factory.json",
    "utf8",
  ),
);

const abi = rawAbi.abi ?? rawAbi;

const curveCreated = abi.find(
  (item) =>
    item.type === "event" &&
    item.name === "CurveCreated",
);

if (!curveCreated) {
  throw new Error("CurveCreated event not found");
}

const latestBlock =
  await client.getBlockNumber();

const CHUNK = 25_000n;

let total = 0;

for (
  let fromBlock = START_BLOCK;
  fromBlock <= latestBlock;
  fromBlock += CHUNK
) {
  const toBlock =
    fromBlock + CHUNK - 1n > latestBlock
      ? latestBlock
      : fromBlock + CHUNK - 1n;

  const logs = await client.getLogs({
    address: FACTORY,
    event: curveCreated,
    fromBlock,
    toBlock,
  });

  for (const log of logs) {
    const args = log.args;

    await db.query(
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
          updated_at
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13,
          NOW()
        )

        ON CONFLICT (curve)
        DO UPDATE SET
          token = EXCLUDED.token,
          quote_token = EXCLUDED.quote_token,
          creator = EXCLUDED.creator,
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
          ordinal =
            EXCLUDED.ordinal,
          updated_at = NOW()
      `,
      [
        args.curve.toLowerCase(),
        args.token.toLowerCase(),
        args.quoteToken.toLowerCase(),
        args.creator.toLowerCase(),
        args.curveAllocation.toString(),
        args.liquidityReserve.toString(),
        args.startingPrice.toString(),
        args.slope.toString(),
        args.graduationThreshold.toString(),
        Number(args.tokenDecimals),
        log.blockNumber.toString(),
        log.transactionHash.toLowerCase(),
        Number(log.logIndex ?? 0),
      ],
    );

    total++;

    console.log({
      curve: args.curve,
      token: args.token,
      graduationThreshold:
        args.graduationThreshold.toString(),
    });
  }
}

console.log(`Synced ${total} market config record(s)`);

await db.end();
