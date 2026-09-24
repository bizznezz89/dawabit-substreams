import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { db } from "../src/db.js";

const TARGET_WALLET =
  "0x3Ac79720E4302dD73899a44494A843975E3c0c2F".toLowerCase();

const CURVE =
  "0x66c44133ae27929b4d8e5c4392d516b5558f4f3e";

const START_BLOCK = 66614149n;
const CHUNK = 25000n;

const rpcUrl =
  process.env.RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({
  transport: http(rpcUrl),
});

const rawAbi = JSON.parse(
  readFileSync(
    "/workspace/dawabit_substreams/abi/relaunch_bonding_curve.json",
    "utf8",
  ),
);

const abi = rawAbi.abi ?? rawAbi;

const curveBuy = abi.find(
  (item) =>
    item.type === "event" &&
    item.name === "CurveBuy",
);

const curveSell = abi.find(
  (item) =>
    item.type === "event" &&
    item.name === "CurveSell",
);

if (!curveBuy || !curveSell) {
  throw new Error(
    "CurveBuy/CurveSell not found in bonding curve ABI",
  );
}

const latestBlock = await client.getBlockNumber();

console.log({
  rpcUrl,
  startBlock: START_BLOCK.toString(),
  latestBlock: latestBlock.toString(),
});

const canonicalLogs = [];

for (
  let fromBlock = START_BLOCK;
  fromBlock <= latestBlock;
  fromBlock += CHUNK
) {
  const toBlock =
    fromBlock + CHUNK - 1n > latestBlock
      ? latestBlock
      : fromBlock + CHUNK - 1n;

  const [buys, sells] = await Promise.all([
    client.getLogs({
      address: CURVE,
      event: curveBuy,
      fromBlock,
      toBlock,
    }),

    client.getLogs({
      address: CURVE,
      event: curveSell,
      fromBlock,
      toBlock,
    }),
  ]);

  for (const log of buys) {
    canonicalLogs.push({
      side: "BUY",
      ...log,
    });
  }

  for (const log of sells) {
    canonicalLogs.push({
      side: "SELL",
      ...log,
    });
  }

  console.log(
    `scanned ${fromBlock}-${toBlock} | buys=${buys.length} sells=${sells.length}`,
  );
}

canonicalLogs.sort((a, b) => {
  if (a.blockNumber < b.blockNumber) return -1;
  if (a.blockNumber > b.blockNumber) return 1;

  return Number(a.logIndex) - Number(b.logIndex);
});

const indexedResult = await db.query(`
  SELECT DISTINCT LOWER(transaction_hash) AS transaction_hash
  FROM marketactivity
  WHERE canonical_trade IS TRUE
`);

const indexed = new Set(
  indexedResult.rows.map(
    (row) => row.transaction_hash,
  ),
);

const walletTrades = [];

for (const log of canonicalLogs) {
  const tx = await client.getTransaction({
    hash: log.transactionHash,
  });

  if (tx.from.toLowerCase() !== TARGET_WALLET) {
    continue;
  }

  walletTrades.push({
    side: log.side,
    block: log.blockNumber.toString(),
    hash: log.transactionHash,
    from: tx.from,
    indexed: indexed.has(
      log.transactionHash.toLowerCase(),
    ),
  });
}

console.log("\n=== Wallet canonical DaWabit trades ===");

console.table(walletTrades);

console.log("\n=== Missing from Postgres ===");

console.table(
  walletTrades.filter(
    (trade) => !trade.indexed,
  ),
);

await db.end();
