import { createPublicClient, http } from "viem";
import { db } from "./db.js";

const rpcUrl =
  process.env.RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({
  transport: http(rpcUrl),
});

export async function resolveTransactionActor(transactionHash) {
  const hash = transactionHash.toLowerCase();

  const cached = await db.query(
    `
      SELECT trader
      FROM transaction_actor
      WHERE transaction_hash = $1
    `,
    [hash],
  );

  if (cached.rowCount) {
    return cached.rows[0].trader;
  }

  const tx = await client.getTransaction({
    hash,
  });

  const trader = tx.from.toLowerCase();

  await db.query(
    `
      INSERT INTO transaction_actor (
        transaction_hash,
        trader
      )
      VALUES ($1, $2)
      ON CONFLICT (transaction_hash)
      DO UPDATE SET
        trader = EXCLUDED.trader,
        resolved_at = NOW()
    `,
    [hash, trader],
  );

  return trader;
}

export async function hydrateTransactionActors(transactionHashes) {
  const hashes = [
    ...new Set(
      transactionHashes
        .filter(Boolean)
        .map((hash) => hash.toLowerCase()),
    ),
  ];

  if (!hashes.length) {
    return;
  }

  const existing = await db.query(
    `
      SELECT transaction_hash
      FROM transaction_actor
      WHERE transaction_hash = ANY($1::text[])
    `,
    [hashes],
  );

  const known = new Set(
    existing.rows.map((row) => row.transaction_hash),
  );

  for (const hash of hashes) {
    if (!known.has(hash)) {
      await resolveTransactionActor(hash);
    }
  }
}