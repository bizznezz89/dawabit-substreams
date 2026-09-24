BEGIN;

DROP VIEW IF EXISTS api_marketactivity;
DROP VIEW IF EXISTS api_curveactivity;
DROP VIEW IF EXISTS api_ammactivity;

-- RPC-only bootstrap views.
-- Used when Substreams-owned historical tables do not yet exist.
-- Replaced by activity-views.sql once historical tables are available.

CREATE VIEW api_marketactivity AS

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
    r.transaction_hash,

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

CREATE VIEW api_curveactivity AS

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
    r.transaction_hash,

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

CREATE VIEW api_ammactivity AS

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
    r.transaction_hash,

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
