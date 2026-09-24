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

COMMIT;
