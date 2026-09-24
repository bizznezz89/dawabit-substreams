BEGIN;

DROP VIEW IF EXISTS api_marketactivity;
DROP VIEW IF EXISTS api_curveactivity;
DROP VIEW IF EXISTS api_ammactivity;

-- ===========================================================================
-- Unified market activity
--
-- Ownership boundary:
--
--   Substreams <= 71,634,044
--   RPC        >= 71,634,045
--
-- ordinal:
--   Real Firehose/Substreams ordinal only.
--
-- log_index:
--   Real JSON-RPC/EVM log index only.
--
-- event_order:
--   Source-specific same-block ordering key used by the API.
--   It MUST NOT be interpreted as a Firehose ordinal.
-- ===========================================================================

CREATE VIEW api_marketactivity AS

SELECT
    m._block_number_::BIGINT
        AS _block_number_,

    m._block_timestamp_,

    m.market_stage,
    m.event_type,
    m.canonical_trade,

    m.market,
    m.curve,
    m.pair,
    m.token,
    m.quote_token,

    m.block_number,
    m.transaction_hash,

    m.ordinal,
    m.event_id,

    'substreams'::TEXT
        AS source,

    NULL::TEXT
        AS block_hash,

    NULL::BIGINT
        AS transaction_index,

    NULL::BIGINT
        AS log_index,

    m.ordinal
        AS event_order

FROM marketactivity m

WHERE
    m.block_number <= 71634044

UNION ALL

SELECT
    r._block_number_,
    r._block_timestamp_,

    r.market_stage,
    r.event_type,
    r.canonical_trade,

    r.market,
    r.curve,
    r.pair,
    r.token,
    r.quote_token,

    r.block_number,
    CASE
        WHEN LOWER(r.transaction_hash) LIKE '0x%'
            THEN LOWER(r.transaction_hash)
        ELSE
            '0x' || LOWER(r.transaction_hash)
    END
        AS transaction_hash,

    NULL::NUMERIC
        AS ordinal,

    r.event_id,

    'rpc'::TEXT
        AS source,

    r.block_hash,
    r.transaction_index,
    r.log_index,

    r.log_index::NUMERIC
        AS event_order

FROM rpc_marketactivity r

WHERE
    r.block_number >= 71634045;


-- ===========================================================================
-- Unified curve activity
-- ===========================================================================

CREATE VIEW api_curveactivity AS

SELECT
    c._block_number_::BIGINT
        AS _block_number_,

    c._block_timestamp_,

    c.event_type,
    c.canonical_trade,

    c.curve,
    c.token,
    c.quote_token,

    c.token_decimals,
    c.actor,

    c.token_amount,
    c.curve_quote,
    c.protocol_fee,
    c.gross_quote_in,
    c.net_quote_out,
    c.tokens_sold_after,
    c.quote_reserve_after,

    c.gross_quote_limit,
    c.actual_quote_in,
    c.refund_quote,

    c.allocation,

    c.previous_state,
    c.new_state,

    c.graduation_router,
    c.graduation_quote_amount,

    c.block_number,
    c.transaction_hash,

    c.ordinal,
    c.event_id,

    'substreams'::TEXT
        AS source,

    NULL::TEXT
        AS block_hash,

    NULL::BIGINT
        AS transaction_index,

    NULL::BIGINT
        AS log_index,

    c.ordinal
        AS event_order

FROM curveactivity c

WHERE
    c.block_number <= 71634044

UNION ALL

SELECT
    r._block_number_,
    r._block_timestamp_,

    r.event_type,
    r.canonical_trade,

    r.curve,
    r.token,
    r.quote_token,

    r.token_decimals,
    r.actor,

    r.token_amount,
    r.curve_quote,
    r.protocol_fee,
    r.gross_quote_in,
    r.net_quote_out,
    r.tokens_sold_after,
    r.quote_reserve_after,

    r.gross_quote_limit,
    r.actual_quote_in,
    r.refund_quote,

    r.allocation,

    r.previous_state,
    r.new_state,

    r.graduation_router,
    r.graduation_quote_amount,

    r.block_number,
    CASE
        WHEN LOWER(r.transaction_hash) LIKE '0x%'
            THEN LOWER(r.transaction_hash)
        ELSE
            '0x' || LOWER(r.transaction_hash)
    END
        AS transaction_hash,

    NULL::NUMERIC
        AS ordinal,

    r.event_id,

    'rpc'::TEXT
        AS source,

    r.block_hash,
    r.transaction_index,
    r.log_index,

    r.log_index::NUMERIC
        AS event_order

FROM rpc_curveactivity r

WHERE
    r.block_number >= 71634045;


-- ===========================================================================
-- Unified AMM activity
-- ===========================================================================

CREATE VIEW api_ammactivity AS

SELECT
    a._block_number_::BIGINT
        AS _block_number_,

    a._block_timestamp_,

    a.event_type,

    a.pair,
    a.curve,
    a.token,
    a.quote_token,

    a.sender,
    a."to",

    a.amount0,
    a.amount1,

    a.amount0_in,
    a.amount1_in,
    a.amount0_out,
    a.amount1_out,

    a.reserve0,
    a.reserve1,

    a.block_number,
    a.transaction_hash,

    a.ordinal,

    a.token0,
    a.token1,
    a.token_is_token0,

    a.token_amount,
    a.quote_amount,

    a.token_amount_in,
    a.quote_amount_in,
    a.token_amount_out,
    a.quote_amount_out,

    a.token_reserve,
    a.quote_reserve,

    a.event_id,

    'substreams'::TEXT
        AS source,

    NULL::TEXT
        AS block_hash,

    NULL::BIGINT
        AS transaction_index,

    NULL::BIGINT
        AS log_index,

    a.ordinal
        AS event_order

FROM ammactivity a

WHERE
    a.block_number <= 71634044

UNION ALL

SELECT
    r._block_number_,
    r._block_timestamp_,

    r.event_type,

    r.pair,
    r.curve,
    r.token,
    r.quote_token,

    r.sender,
    r."to",

    r.amount0,
    r.amount1,

    r.amount0_in,
    r.amount1_in,
    r.amount0_out,
    r.amount1_out,

    r.reserve0,
    r.reserve1,

    r.block_number,
    CASE
        WHEN LOWER(r.transaction_hash) LIKE '0x%'
            THEN LOWER(r.transaction_hash)
        ELSE
            '0x' || LOWER(r.transaction_hash)
    END
        AS transaction_hash,

    NULL::NUMERIC
        AS ordinal,

    r.token0,
    r.token1,
    r.token_is_token0,

    r.token_amount,
    r.quote_amount,

    r.token_amount_in,
    r.quote_amount_in,
    r.token_amount_out,
    r.quote_amount_out,

    r.token_reserve,
    r.quote_reserve,

    r.event_id,

    'rpc'::TEXT
        AS source,

    r.block_hash,
    r.transaction_index,
    r.log_index,

    r.log_index::NUMERIC
        AS event_order

FROM rpc_ammactivity r

WHERE
    r.block_number >= 71634045;

COMMIT;
