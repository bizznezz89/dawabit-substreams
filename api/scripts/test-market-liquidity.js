import { loadMarketLiquidity } from "../src/market-liquidity.js";

const CURVE =
  "0x66c44133ae27929b4d8e5c4392d516b5558f4f3e";

const TOKEN =
  "0xce39ca04c9c924c949172fdeeff588ab586a7db1";

const WETH =
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const markets = [
  {
    token: TOKEN,
    quote_token: WETH,
    market: CURVE,
    market_stage: "CURVE",
  },
];

const result =
  await loadMarketLiquidity(markets);

console.log(
  JSON.stringify(
    result.get(
      CURVE.toLowerCase(),
    ),
    null,
    2,
  ),
);

process.exit(0);
