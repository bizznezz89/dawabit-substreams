# DaWabit Substreams

DaWabit Substreams provides protocol discovery and market activity data for the DaWabit ReLaunchpad on Robinhood Chain Mainnet.

The package follows the complete ReLaunchpad market lifecycle:

```text
ReLaunchFactory
    |
    | CurveCreated
    v
Dynamic Bonding Curve
    |
    | CurveBuy / CurveSell / lifecycle events
    v
GraduationRouter
    |
    | LiquiditySeeded
    v
Dynamic Uniswap V2 Pair
    |
    | Swap / Sync / Mint / Burn
    v
Post-graduation AMM Market
```

## Network

- **Network:** Robinhood Chain Mainnet
- **Substreams network identifier:** `robinhood`
- **Initial protocol deployment block:** `66552064`

## Protocol Contracts

| Contract | Address |
|---|---|
| ReLaunchFactory | `0x0e54a12db2d6b8f309269ef98f8b9c2764aa3a92` |
| ReLaunchTradeRouter | `0x48acf9c62384a6c15cca80f6307cc29a5be2580b` |
| GraduationRouter | `0x5ecc1ab2ca5e11629fce19495669dfbe0e78c3d4` |
| ProtocolLiquidityVault | `0x4c693c74edf24520154d5ac0af35a8ab5530b663` |
| ProtocolFeeVault | `0xbc3aa39470ae2a71df23af38ff98d26d44317332` |

## Core Modules

### `map_curve_discoveries`

Indexes `CurveCreated` events emitted by `ReLaunchFactory`.

Each discovered bonding curve includes:

- Curve address
- Token address
- Quote token address
- Creator
- Curve allocation
- Liquidity reserve
- Starting price
- Slope
- Graduation threshold
- Token decimals
- Creation block
- Creation transaction

### `store_curves`

Persists dynamically created bonding curves.

Primary key format:

```text
curve:<curve_address>
```

This allows downstream modules to recognize ReLaunchpad bonding curves without hardcoding every deployed curve address.

### `map_curve_activity`

Processes activity emitted by dynamically discovered bonding curves.

Canonical trade events:

- `CurveBuy`
- `CurveSell`

Lifecycle and supplemental events:

- `Activated`
- `CurveExactInputBuy`
- `CurveStateChanged`
- `Graduated`

`Bought` and `Sold` are intentionally not treated as canonical trades because the bonding curve emits them alongside `CurveBuy` and `CurveSell`.

This prevents downstream trade and volume double-counting.

## Graduation and AMM Discovery

### `map_amm_discoveries`

Indexes `LiquiditySeeded` events emitted by `GraduationRouter`.

`LiquiditySeeded` establishes the canonical relationship:

```text
bonding curve -> graduated AMM pair
```

Each discovered AMM pool includes:

- Pair address
- Originating bonding curve
- Token address
- Quote token address
- Token amount seeded
- Quote amount seeded
- LP liquidity minted
- V2 `token0`
- V2 `token1`
- Whether the ReLaunchpad token is `token0`
- Block number
- Transaction hash

Uniswap V2 orders pair assets by address, so the ReLaunchpad token cannot be assumed to always be `token0`.

### `store_amm_pools`

Persists graduated AMM pools using two indexes:

```text
pair:<pair_address>
curve_pool:<curve_address>
```

This supports lookup in either direction:

```text
pair -> originating ReLaunchpad market
curve -> graduated AMM pair
```

## AMM Activity

### `map_amm_activity`

Processes activity emitted by dynamically discovered post-graduation Uniswap V2 pairs.

Indexed events:

- `Swap`
- `Sync`
- `Mint`
- `Burn`

The module preserves raw Uniswap V2 values:

```text
amount0
amount1

amount0_in
amount1_in
amount0_out
amount1_out

reserve0
reserve1
```

It also provides normalized ReLaunchpad semantics:

```text
token_amount_in
quote_amount_in

token_amount_out
quote_amount_out

token_reserve
quote_reserve

token_amount
quote_amount
```

This allows downstream bots, indexers, aggregators, and analytics systems to consume the market without independently reproducing Uniswap V2 token ordering.

## Raw Protocol Modules

The package also includes the original static raw protocol modules:

- `map_events`
- `map_calls`
- `map_events_calls`

These expose lower-level events and calls for the statically configured ReLaunchpad contracts.

## Build

```bash
substreams build
```

The v0.1.0 package builds as:

```text
dawabit-substreams-v0.1.0.spkg
```

## Run on Robinhood Chain

### Bonding Curve Activity

```bash
substreams run \
  -e mainnet.robinhood.streamingfast.io:443 \
  substreams.yaml \
  map_curve_activity \
  --start-block 66552064 \
  -o json
```

### AMM Discovery

```bash
substreams run \
  -e mainnet.robinhood.streamingfast.io:443 \
  substreams.yaml \
  map_amm_discoveries \
  --start-block 66552064 \
  -o json
```

### Post-Graduation AMM Activity

```bash
substreams run \
  -e mainnet.robinhood.streamingfast.io:443 \
  substreams.yaml \
  map_amm_activity \
  --start-block 66552064 \
  -o json
```

## Authentication

A Substreams API token can be supplied through a local `.substreams.env` file.

The following local/generated files are excluded from source control:

```text
.substreams.env
target/
*.spkg
```

## Repository

https://github.com/bizznezz89/dawabit-substreams
