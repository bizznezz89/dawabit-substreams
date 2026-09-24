BEGIN;

-- ---------------------------------------------------------------------------
-- Transaction-origin cache
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transaction_actor (
    transaction_hash TEXT PRIMARY KEY,
    trader TEXT NOT NULL,
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transaction_actor_trader_idx
    ON transaction_actor (trader);

-- ---------------------------------------------------------------------------
-- Static ReLaunch Factory market configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market_config (
    curve TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    quote_token TEXT NOT NULL,
    creator TEXT NOT NULL,

    curve_allocation NUMERIC NOT NULL,
    liquidity_reserve NUMERIC NOT NULL,
    starting_price NUMERIC NOT NULL,
    slope NUMERIC NOT NULL,
    graduation_threshold NUMERIC NOT NULL,

    token_decimals INTEGER NOT NULL,

    creation_block BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL,
    ordinal BIGINT NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_config_token_quote_idx
    ON market_config (
        LOWER(token),
        LOWER(quote_token)
    );

CREATE INDEX IF NOT EXISTS market_config_creator_idx
    ON market_config (
        LOWER(creator)
    );

-- ---------------------------------------------------------------------------
-- ERC-20 metadata cache
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS token_metadata (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    decimals INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS token_metadata_lower_address_idx
    ON token_metadata (
        LOWER(address)
    );

-- ---------------------------------------------------------------------------
-- RPC ingestion checkpoint
--
-- The RHC Substreams -> RPC handoff is an immutable deployment boundary.
-- Fresh installations are seeded below at the verified handoff block.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingestion_state (
    source TEXT PRIMARY KEY,
    initial_block BIGINT NOT NULL,
    last_processed_block BIGINT NOT NULL,
    last_processed_block_hash TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ingestion_state_updated_at_idx
    ON ingestion_state (updated_at);

-- RHC permanent Substreams -> RPC handoff.
--
-- Substreams owns through block 71,634,044.
-- RPC ingestion begins at block 71,634,045.
--
-- Never overwrite an existing deployment state during bootstrap.
INSERT INTO ingestion_state (
    source,
    initial_block,
    last_processed_block,
    last_processed_block_hash
)
VALUES (
    'rhc_rpc',
    71634045,
    71634044,
    '915e4012535b400d42e47ee7ae7e641f2bf09c69cbe4c7ecd632acd81149e6ac'
)
ON CONFLICT (source)
DO NOTHING;

-- ---------------------------------------------------------------------------
-- RPC normalized market feed
--
-- Substreams continues to own marketactivity / curveactivity / ammactivity.
-- These tables contain the live JSON-RPC continuation.
--
-- RPC event identity:
--     transaction_hash:log_index
--
-- `ordinal` is intentionally absent. Firehose/Substreams ordinal and Ethereum
-- logIndex are different concepts.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rpc_marketactivity (
    _block_number_ BIGINT NOT NULL,
    _block_timestamp_ TIMESTAMP WITHOUT TIME ZONE NOT NULL,

    market_stage VARCHAR(255),
    event_type VARCHAR(255),
    canonical_trade BOOLEAN,

    market TEXT,
    curve TEXT,
    pair TEXT,
    token TEXT,
    quote_token TEXT,

    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,

    transaction_hash TEXT NOT NULL,
    transaction_index BIGINT,
    log_index BIGINT NOT NULL,

    event_id TEXT PRIMARY KEY
);

CREATE UNIQUE INDEX IF NOT EXISTS rpc_marketactivity_tx_log_idx
    ON rpc_marketactivity (
        transaction_hash,
        log_index
    );

CREATE INDEX IF NOT EXISTS rpc_marketactivity_block_idx
    ON rpc_marketactivity (block_number);

CREATE INDEX IF NOT EXISTS rpc_marketactivity_market_block_idx
    ON rpc_marketactivity (
        market,
        block_number DESC
    );

CREATE INDEX IF NOT EXISTS rpc_marketactivity_token_block_idx
    ON rpc_marketactivity (
        token,
        block_number DESC
    );

CREATE INDEX IF NOT EXISTS rpc_marketactivity_tx_hash_idx
    ON rpc_marketactivity (transaction_hash);

CREATE INDEX IF NOT EXISTS rpc_marketactivity_stage_event_block_idx
    ON rpc_marketactivity (
        market_stage,
        event_type,
        block_number DESC
    );

CREATE INDEX IF NOT EXISTS rpc_marketactivity_canonical_trade_idx
    ON rpc_marketactivity (
        market,
        block_number DESC
    )
    WHERE canonical_trade IS TRUE;

-- ---------------------------------------------------------------------------
-- RPC bonding-curve detail feed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rpc_curveactivity (
    _block_number_ BIGINT NOT NULL,
    _block_timestamp_ TIMESTAMP WITHOUT TIME ZONE NOT NULL,

    event_type VARCHAR(255),
    canonical_trade BOOLEAN,

    curve TEXT,
    token TEXT,
    quote_token TEXT,

    token_decimals NUMERIC,
    actor TEXT,

    token_amount VARCHAR(255),
    curve_quote VARCHAR(255),
    protocol_fee VARCHAR(255),
    gross_quote_in VARCHAR(255),
    net_quote_out VARCHAR(255),
    tokens_sold_after VARCHAR(255),
    quote_reserve_after VARCHAR(255),

    gross_quote_limit VARCHAR(255),
    actual_quote_in VARCHAR(255),
    refund_quote VARCHAR(255),

    allocation VARCHAR(255),

    previous_state NUMERIC,
    new_state NUMERIC,

    graduation_router TEXT,
    graduation_quote_amount VARCHAR(255),

    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,

    transaction_hash TEXT NOT NULL,
    transaction_index BIGINT,
    log_index BIGINT NOT NULL,

    event_id TEXT PRIMARY KEY
);

CREATE UNIQUE INDEX IF NOT EXISTS rpc_curveactivity_tx_log_idx
    ON rpc_curveactivity (
        transaction_hash,
        log_index
    );

CREATE INDEX IF NOT EXISTS rpc_curveactivity_block_idx
    ON rpc_curveactivity (block_number);

CREATE INDEX IF NOT EXISTS rpc_curveactivity_curve_block_idx
    ON rpc_curveactivity (
        curve,
        block_number DESC
    );

CREATE INDEX IF NOT EXISTS rpc_curveactivity_actor_block_idx
    ON rpc_curveactivity (
        actor,
        block_number DESC
    );

CREATE INDEX IF NOT EXISTS rpc_curveactivity_tx_hash_idx
    ON rpc_curveactivity (transaction_hash);

-- ---------------------------------------------------------------------------
-- RPC AMM detail feed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rpc_ammactivity (
    _block_number_ BIGINT NOT NULL,
    _block_timestamp_ TIMESTAMP WITHOUT TIME ZONE NOT NULL,

    event_type VARCHAR(255),

    pair TEXT,
    curve TEXT,
    token TEXT,
    quote_token TEXT,

    sender TEXT,
    "to" TEXT,

    amount0 VARCHAR(255),
    amount1 VARCHAR(255),

    amount0_in VARCHAR(255),
    amount1_in VARCHAR(255),
    amount0_out VARCHAR(255),
    amount1_out VARCHAR(255),

    reserve0 VARCHAR(255),
    reserve1 VARCHAR(255),

    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,

    transaction_hash TEXT NOT NULL,
    transaction_index BIGINT,
    log_index BIGINT NOT NULL,

    token0 TEXT,
    token1 TEXT,
    token_is_token0 BOOLEAN,

    token_amount VARCHAR(255),
    quote_amount VARCHAR(255),

    token_amount_in VARCHAR(255),
    quote_amount_in VARCHAR(255),

    token_amount_out VARCHAR(255),
    quote_amount_out VARCHAR(255),

    token_reserve VARCHAR(255),
    quote_reserve VARCHAR(255),

    event_id TEXT PRIMARY KEY
);

CREATE UNIQUE INDEX IF NOT EXISTS rpc_ammactivity_tx_log_idx
    ON rpc_ammactivity (
        transaction_hash,
        log_index
    );

CREATE INDEX IF NOT EXISTS rpc_ammactivity_block_idx
    ON rpc_ammactivity (block_number);

CREATE INDEX IF NOT EXISTS rpc_ammactivity_pair_block_idx
    ON rpc_ammactivity (
        pair,
        block_number DESC
    );

CREATE INDEX IF NOT EXISTS rpc_ammactivity_tx_hash_idx
    ON rpc_ammactivity (transaction_hash);

COMMIT;

-- ---------------------------------------------------------------------------
-- RPC discovery compatibility
-- ---------------------------------------------------------------------------

BEGIN;

-- Firehose ordinal has no JSON-RPC equivalent.
ALTER TABLE market_config
    ALTER COLUMN ordinal DROP NOT NULL;

ALTER TABLE market_config
    ADD COLUMN IF NOT EXISTS log_index BIGINT;

ALTER TABLE market_config
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'substreams';

CREATE INDEX IF NOT EXISTS market_config_source_idx
    ON market_config (source);

-- Persistent post-graduation AMM discovery registry.
CREATE TABLE IF NOT EXISTS amm_pool_config (
    pair TEXT PRIMARY KEY,
    curve TEXT NOT NULL UNIQUE,

    token TEXT NOT NULL,
    quote_token TEXT NOT NULL,

    token0 TEXT NOT NULL,
    token1 TEXT NOT NULL,
    token_is_token0 BOOLEAN NOT NULL,

    token_amount NUMERIC NOT NULL,
    quote_amount NUMERIC NOT NULL,
    liquidity NUMERIC NOT NULL,

    discovery_block BIGINT NOT NULL,
    discovery_block_hash TEXT NOT NULL,

    transaction_hash TEXT NOT NULL,
    transaction_index BIGINT,
    log_index BIGINT NOT NULL,

    source TEXT NOT NULL DEFAULT 'rpc',

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS amm_pool_config_curve_idx
    ON amm_pool_config (curve);

CREATE INDEX IF NOT EXISTS amm_pool_config_token_quote_idx
    ON amm_pool_config (
        LOWER(token),
        LOWER(quote_token)
    );

COMMIT;


-- ============================================================================
-- RPC ingestion checkpoint history
--
-- Stores committed chunk boundaries so the RPC indexer can identify a common
-- canonical ancestor after a reorg without storing a hash for every block.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
    source TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (source, block_number)
);

CREATE INDEX IF NOT EXISTS ingestion_checkpoints_source_block_idx
    ON ingestion_checkpoints (
        source,
        block_number DESC
    );

-- Seed the currently committed ingestion position when upgrading an existing DB.
INSERT INTO ingestion_checkpoints (
    source,
    block_number,
    block_hash
)
SELECT
    source,
    last_processed_block,
    last_processed_block_hash
FROM ingestion_state
WHERE
    last_processed_block IS NOT NULL
    AND last_processed_block_hash IS NOT NULL
ON CONFLICT (source, block_number)
DO NOTHING;
