#[allow(unused)]
mod abi;
#[allow(unused)]
mod pb;
use hex_literal::hex;
use pb::contract::v1 as contract;
use pb::contract::v1::Events;
use pb::sf::ethereum::r#type::v2::Block;
use substreams_ethereum::pb::eth::v2::Block as EthBlock;

#[allow(unused_imports)]
use num_traits::cast::ToPrimitive;
use substreams::store::{StoreGet, StoreGetProto, StoreNew, StoreSet, StoreSetProto};

substreams_ethereum::init!();

const STATIC_TRACKED_CONTRACTS: &[[u8; 20]] = &[
    hex!("0e54a12db2d6b8f309269ef98f8b9c2764aa3a92"),
    
    hex!("48acf9c62384a6c15cca80f6307cc29a5be2580b"),
    
    hex!("5ecc1ab2ca5e11629fce19495669dfbe0e78c3d4"),
    
    hex!("4c693c74edf24520154d5ac0af35a8ab5530b663"),
    
    hex!("bc3aa39470ae2a71df23af38ff98d26d44317332"),
    ];


#[substreams::handlers::map]
fn map_events_calls(
    events: contract::Events,
    calls: contract::Calls,
) -> Result<contract::EventsCalls, substreams::errors::Error> {
    Ok(contract::EventsCalls {
        events: Some(events),
        calls: Some(calls),
    })
}



#[substreams::handlers::map]
fn map_events(blk: Block) -> Result<Events, substreams::errors::Error> {
    let mut events = contract::Events::default();
    let logs = blk
        .transaction_traces
        .iter()
        .filter_map(|transaction| transaction.receipt.as_ref())
        .flat_map(|view| {
            view.logs
                .iter()
                .filter(|log| is_address_in_contracts(&log.address)).cloned()
        })
        .collect();

    events.logs = logs;

    Ok(events)
}



#[substreams::handlers::map]
fn map_calls(blk: Block) -> Result<contract::Calls, substreams::errors::Error> {
    let mut calls = contract::Calls::default();
    let transaction_calls = blk
        .transaction_traces
        .iter()
        .flat_map(|transaction| {
            transaction.calls
                .iter()
                .filter(|call| is_address_in_contracts(&call.address)).cloned()
        })
        .collect();
    calls.calls = transaction_calls;
    Ok(calls)
}


fn is_address_in_contracts(address: &Vec<u8>) -> bool {
    if address.len() != 20 {
        return false;
    }

    STATIC_TRACKED_CONTRACTS.contains(&address.as_slice().try_into().unwrap())
}


const RELAUNCH_FACTORY_ADDRESS: [u8; 20] =
    hex!("0e54a12db2d6b8f309269ef98f8b9c2764aa3a92");


#[substreams::handlers::map]
fn map_curve_discoveries(
    blk: EthBlock,
) -> Result<contract::DiscoveredCurves, substreams::errors::Error> {
    use abi::relaunch_factory::events::CurveCreated;

    let mut curves = Vec::new();

    for transaction in &blk.transaction_traces {
        let Some(receipt) = transaction.receipt.as_ref() else {
            continue;
        };

        for log in &receipt.logs {
            if log.address.as_slice() != RELAUNCH_FACTORY_ADDRESS.as_slice() {
                continue;
            }

            if !CurveCreated::match_log(log) {
                continue;
            }

            let Ok(event) = CurveCreated::decode(log) else {
                continue;
            };

            curves.push(contract::DiscoveredCurve {
                curve: event.curve,
                token: event.token,
                quote_token: event.quote_token,
                creator: event.creator,
                curve_allocation: event.curve_allocation.to_string(),
                liquidity_reserve: event.liquidity_reserve.to_string(),
                starting_price: event.starting_price.to_string(),
                slope: event.slope.to_string(),
                graduation_threshold: event.graduation_threshold.to_string(),
                token_decimals: event.token_decimals.to_i32() as u32,
                block_number: blk.number,
                transaction_hash: transaction.hash.clone(),
                ordinal: log.ordinal,
            });
        }
    }

    Ok(contract::DiscoveredCurves { curves })
}


#[substreams::handlers::store]
fn store_curves(
    curves: contract::DiscoveredCurves,
    store: StoreSetProto<contract::DiscoveredCurve>,
) {
    use substreams::Hex;

    for curve in curves.curves {
        let curve_address = Hex(&curve.curve).to_string();

        store.set(
            curve.ordinal,
            format!("curve:{curve_address}"),
            &curve,
        );
    }
}


fn base_curve_activity(
    curve: &contract::DiscoveredCurve,
    curve_address: &[u8],
    block_number: u64,
    transaction_hash: &[u8],
    ordinal: u64,
) -> contract::CurveActivity {
    contract::CurveActivity {
        curve: curve_address.to_vec(),
        token: curve.token.clone(),
        quote_token: curve.quote_token.clone(),
        token_decimals: curve.token_decimals,
        block_number,
        transaction_hash: transaction_hash.to_vec(),
        ordinal,
        ..Default::default()
    }
}


#[substreams::handlers::map]
fn map_curve_activity(
    blk: EthBlock,
    curves_store: StoreGetProto<contract::DiscoveredCurve>,
) -> Result<contract::CurveActivities, substreams::errors::Error> {
    use abi::relaunch_bonding_curve::events::{
        Activated,
        CurveBuy,
        CurveExactInputBuy,
        CurveSell,
        CurveStateChanged,
        Graduated,
    };
    use substreams::Hex;

    let mut activities = Vec::new();

    for transaction in &blk.transaction_traces {
        let Some(receipt) = transaction.receipt.as_ref() else {
            continue;
        };

        for log in &receipt.logs {
            let curve_address = Hex(&log.address).to_string();

            let Some(curve) =
                curves_store.get_last(format!("curve:{curve_address}"))
            else {
                continue;
            };

            if CurveBuy::match_log(log) {
                if let Ok(event) = CurveBuy::decode(log) {
                    let mut activity = base_curve_activity(
                        &curve,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "CURVE_BUY".to_string();
                    activity.canonical_trade = true;
                    activity.actor = event.trader;
                    activity.token_amount = event.token_amount.to_string();
                    activity.curve_quote = event.curve_quote.to_string();
                    activity.protocol_fee = event.protocol_fee.to_string();
                    activity.gross_quote_in = event.total_quote_in.to_string();
                    activity.tokens_sold_after = event.tokens_sold_after.to_string();
                    activity.quote_reserve_after = event.quote_reserve_after.to_string();

                    activities.push(activity);
                }

                continue;
            }

            if CurveSell::match_log(log) {
                if let Ok(event) = CurveSell::decode(log) {
                    let mut activity = base_curve_activity(
                        &curve,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "CURVE_SELL".to_string();
                    activity.canonical_trade = true;
                    activity.actor = event.trader;
                    activity.token_amount = event.token_amount.to_string();
                    activity.curve_quote = event.curve_quote.to_string();
                    activity.protocol_fee = event.protocol_fee.to_string();
                    activity.net_quote_out = event.net_quote_out.to_string();
                    activity.tokens_sold_after = event.tokens_sold_after.to_string();
                    activity.quote_reserve_after = event.quote_reserve_after.to_string();

                    activities.push(activity);
                }

                continue;
            }

            if CurveExactInputBuy::match_log(log) {
                if let Ok(event) = CurveExactInputBuy::decode(log) {
                    let mut activity = base_curve_activity(
                        &curve,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "CURVE_EXACT_INPUT_BUY_META".to_string();
                    activity.canonical_trade = false;
                    activity.actor = event.trader;
                    activity.token_amount = event.token_amount.to_string();
                    activity.gross_quote_limit = event.gross_quote_limit.to_string();
                    activity.actual_quote_in = event.actual_quote_in.to_string();
                    activity.refund_quote = event.refund_quote.to_string();

                    activities.push(activity);
                }

                continue;
            }

            if Activated::match_log(log) {
                if let Ok(event) = Activated::decode(log) {
                    let mut activity = base_curve_activity(
                        &curve,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "ACTIVATED".to_string();
                    activity.actor = event.funder;
                    activity.allocation = event.allocation.to_string();

                    activities.push(activity);
                }

                continue;
            }

            if CurveStateChanged::match_log(log) {
                if let Ok(event) = CurveStateChanged::decode(log) {
                    let mut activity = base_curve_activity(
                        &curve,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "CURVE_STATE_CHANGED".to_string();
                    activity.previous_state = event.previous_state.to_i32() as u32;
                    activity.new_state = event.new_state.to_i32() as u32;

                    activities.push(activity);
                }

                continue;
            }

            if Graduated::match_log(log) {
                if let Ok(event) = Graduated::decode(log) {
                    let mut activity = base_curve_activity(
                        &curve,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "GRADUATED".to_string();
                    activity.graduation_router = event.graduation_router;
                    activity.token_amount = event.token_amount.to_string();
                    activity.graduation_quote_amount = event.quote_amount.to_string();

                    activities.push(activity);
                }
            }
        }
    }

    Ok(contract::CurveActivities { activities })
}

const GRADUATION_ROUTER_ADDRESS: [u8; 20] =
    hex!("5ecc1ab2ca5e11629fce19495669dfbe0e78c3d4");


#[substreams::handlers::map]
fn map_amm_discoveries(
    blk: EthBlock,
) -> Result<contract::DiscoveredAmmPools, substreams::errors::Error> {
    use abi::graduation_router::events::LiquiditySeeded;

    let mut pools = Vec::new();

    for transaction in &blk.transaction_traces {
        let Some(receipt) = transaction.receipt.as_ref() else {
            continue;
        };

        for log in &receipt.logs {
            if log.address.as_slice() != GRADUATION_ROUTER_ADDRESS.as_slice() {
                continue;
            }

            if !LiquiditySeeded::match_log(log) {
                continue;
            }

            let Ok(event) = LiquiditySeeded::decode(log) else {
                continue;
            };

            let token_is_token0 =
                event.token.as_slice() < event.quote_token.as_slice();

            let (token0, token1) = if token_is_token0 {
                (event.token.clone(), event.quote_token.clone())
            } else {
                (event.quote_token.clone(), event.token.clone())
            };

            pools.push(contract::DiscoveredAmmPool {
                pair: event.pair,
                curve: event.curve,
                token: event.token,
                quote_token: event.quote_token,
                token_amount: event.token_amount.to_string(),
                quote_amount: event.quote_amount.to_string(),
                liquidity: event.liquidity.to_string(),
                block_number: blk.number,
                transaction_hash: transaction.hash.clone(),
                ordinal: log.ordinal,
                token0,
                token1,
                token_is_token0,
            });
        }
    }

    Ok(contract::DiscoveredAmmPools { pools })
}


#[substreams::handlers::store]
fn store_amm_pools(
    pools: contract::DiscoveredAmmPools,
    store: StoreSetProto<contract::DiscoveredAmmPool>,
) {
    use substreams::Hex;

    for pool in pools.pools {
        let pair_address = Hex(&pool.pair).to_string();
        let curve_address = Hex(&pool.curve).to_string();

        store.set(
            pool.ordinal,
            format!("pair:{pair_address}"),
            &pool,
        );

        store.set(
            pool.ordinal,
            format!("curve_pool:{curve_address}"),
            &pool,
        );
    }
}



fn base_amm_activity(
    pool: &contract::DiscoveredAmmPool,
    pair_address: &[u8],
    block_number: u64,
    transaction_hash: &[u8],
    ordinal: u64,
) -> contract::AmmActivity {
    contract::AmmActivity {
        pair: pair_address.to_vec(),
        curve: pool.curve.clone(),
        token: pool.token.clone(),
        quote_token: pool.quote_token.clone(),
        token0: pool.token0.clone(),
        token1: pool.token1.clone(),
        token_is_token0: pool.token_is_token0,
        block_number,
        transaction_hash: transaction_hash.to_vec(),
        ordinal,
        ..Default::default()
    }
}


#[substreams::handlers::map]
fn map_amm_activity(
    blk: EthBlock,
    pools_store: StoreGetProto<contract::DiscoveredAmmPool>,
) -> Result<contract::AmmActivities, substreams::errors::Error> {
    use abi::uniswap_v2_pair::events::{Burn, Mint, Swap, Sync};
    use substreams::Hex;

    let mut activities = Vec::new();

    for transaction in &blk.transaction_traces {
        let Some(receipt) = transaction.receipt.as_ref() else {
            continue;
        };

        for log in &receipt.logs {
            let pair_address = Hex(&log.address).to_string();

            let Some(pool) =
                pools_store.get_last(format!("pair:{pair_address}"))
            else {
                continue;
            };

            if Swap::match_log(log) {
                if let Ok(event) = Swap::decode(log) {
                    let mut activity = base_amm_activity(
                        &pool,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "SWAP".to_string();
                    activity.sender = event.sender;
                    activity.to = event.to;
                    let amount0_in = event.amount0_in.to_string();
                    let amount1_in = event.amount1_in.to_string();
                    let amount0_out = event.amount0_out.to_string();
                    let amount1_out = event.amount1_out.to_string();

                    activity.amount0_in = amount0_in.clone();
                    activity.amount1_in = amount1_in.clone();
                    activity.amount0_out = amount0_out.clone();
                    activity.amount1_out = amount1_out.clone();

                    if pool.token_is_token0 {
                        activity.token_amount_in = amount0_in;
                        activity.quote_amount_in = amount1_in;
                        activity.token_amount_out = amount0_out;
                        activity.quote_amount_out = amount1_out;
                    } else {
                        activity.token_amount_in = amount1_in;
                        activity.quote_amount_in = amount0_in;
                        activity.token_amount_out = amount1_out;
                        activity.quote_amount_out = amount0_out;
                    }

                    activities.push(activity);
                }

                continue;
            }

            if Sync::match_log(log) {
                if let Ok(event) = Sync::decode(log) {
                    let mut activity = base_amm_activity(
                        &pool,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "SYNC".to_string();
                    let reserve0 = event.reserve0.to_string();
                    let reserve1 = event.reserve1.to_string();

                    activity.reserve0 = reserve0.clone();
                    activity.reserve1 = reserve1.clone();

                    if pool.token_is_token0 {
                        activity.token_reserve = reserve0;
                        activity.quote_reserve = reserve1;
                    } else {
                        activity.token_reserve = reserve1;
                        activity.quote_reserve = reserve0;
                    }

                    activities.push(activity);
                }

                continue;
            }

            if Mint::match_log(log) {
                if let Ok(event) = Mint::decode(log) {
                    let mut activity = base_amm_activity(
                        &pool,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "MINT".to_string();
                    activity.sender = event.sender;

                    let amount0 = event.amount0.to_string();
                    let amount1 = event.amount1.to_string();

                    activity.amount0 = amount0.clone();
                    activity.amount1 = amount1.clone();

                    if pool.token_is_token0 {
                        activity.token_amount = amount0;
                        activity.quote_amount = amount1;
                    } else {
                        activity.token_amount = amount1;
                        activity.quote_amount = amount0;
                    }

                    activities.push(activity);
                }

                continue;
            }

            if Burn::match_log(log) {
                if let Ok(event) = Burn::decode(log) {
                    let mut activity = base_amm_activity(
                        &pool,
                        &log.address,
                        blk.number,
                        &transaction.hash,
                        log.ordinal,
                    );

                    activity.event_type = "BURN".to_string();
                    activity.sender = event.sender;
                    activity.to = event.to;

                    let amount0 = event.amount0.to_string();
                    let amount1 = event.amount1.to_string();

                    activity.amount0 = amount0.clone();
                    activity.amount1 = amount1.clone();

                    if pool.token_is_token0 {
                        activity.token_amount = amount0;
                        activity.quote_amount = amount1;
                    } else {
                        activity.token_amount = amount1;
                        activity.quote_amount = amount0;
                    }

                    activities.push(activity);
                }
            }
        }
    }

    Ok(contract::AmmActivities { activities })
}
