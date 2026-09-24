import {
  createPublicClient,
  http,
} from "viem";

import { db } from "../src/db.js";

const rpcUrl =
  process.env.RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({
  transport: http(rpcUrl),
});

const erc20Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
      },
    ],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
      },
    ],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
      },
    ],
  },
];

async function safeRead(
  address,
  functionName,
) {
  try {
    return await client.readContract({
      address,
      abi: erc20Abi,
      functionName,
    });
  } catch {
    return null;
  }
}

const result = await db.query(`
  SELECT token AS address
  FROM market_config

  UNION

  SELECT quote_token AS address
  FROM market_config
`);

for (const row of result.rows) {
  const address =
    row.address.toLowerCase();

  const [
    decimals,
    symbol,
    name,
  ] = await Promise.all([
    safeRead(
      address,
      "decimals",
    ),

    safeRead(
      address,
      "symbol",
    ),

    safeRead(
      address,
      "name",
    ),
  ]);

  await db.query(
    `
      INSERT INTO token_metadata (
        address,
        symbol,
        name,
        decimals,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        NOW()
      )

      ON CONFLICT (address)
      DO UPDATE SET
        symbol = EXCLUDED.symbol,
        name = EXCLUDED.name,
        decimals = EXCLUDED.decimals,
        updated_at = NOW()
    `,
    [
      address,
      symbol,
      name,
      decimals !== null
        ? Number(decimals)
        : null,
    ],
  );

  console.log({
    address,
    symbol,
    name,
    decimals:
      decimals !== null
        ? Number(decimals)
        : null,
  });
}

await db.end();
