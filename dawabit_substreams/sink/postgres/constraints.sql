-- DaWabit Postgres constraints and query indexes.
-- Apply after `substreams sink postgres setup`.

ALTER TABLE marketactivity ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE curveactivity ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE ammactivity ALTER COLUMN event_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'marketactivity_pkey'
    ) THEN
        ALTER TABLE marketactivity
            ADD CONSTRAINT marketactivity_pkey PRIMARY KEY (event_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'curveactivity_pkey'
    ) THEN
        ALTER TABLE curveactivity
            ADD CONSTRAINT curveactivity_pkey PRIMARY KEY (event_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ammactivity_pkey'
    ) THEN
        ALTER TABLE ammactivity
            ADD CONSTRAINT ammactivity_pkey PRIMARY KEY (event_id);
    END IF;
END
$$;

-- Canonical unified feed.
CREATE INDEX IF NOT EXISTS marketactivity_market_block_idx
    ON marketactivity (market, block_number DESC);

CREATE INDEX IF NOT EXISTS marketactivity_token_block_idx
    ON marketactivity (token, block_number DESC);

CREATE INDEX IF NOT EXISTS marketactivity_tx_hash_idx
    ON marketactivity (transaction_hash);

CREATE INDEX IF NOT EXISTS marketactivity_stage_event_block_idx
    ON marketactivity (market_stage, event_type, block_number DESC);

CREATE INDEX IF NOT EXISTS marketactivity_canonical_trade_idx
    ON marketactivity (market, block_number DESC)
    WHERE canonical_trade IS TRUE;

-- Curve detail feed.
CREATE INDEX IF NOT EXISTS curveactivity_curve_block_idx
    ON curveactivity (curve, block_number DESC);

CREATE INDEX IF NOT EXISTS curveactivity_actor_block_idx
    ON curveactivity (actor, block_number DESC);

CREATE INDEX IF NOT EXISTS curveactivity_tx_hash_idx
    ON curveactivity (transaction_hash);

-- AMM detail feed.
CREATE INDEX IF NOT EXISTS ammactivity_pair_block_idx
    ON ammactivity (pair, block_number DESC);

CREATE INDEX IF NOT EXISTS ammactivity_tx_hash_idx
    ON ammactivity (transaction_hash);
