// Proves one v11 allocation obeys the committed order's hidden limit.
// The vault must additionally bind this commitment to its escrow, verify all
// allocations exactly once, and enforce whole-batch asset conservation.
use keccak256::keccak256;

global PRICE_SCALE: u128 = 1_000_000;

fn u64_to_bytes32(value: u64) -> [u8; 32] {
    let mut out: [u8; 32] = [0; 32];
    out[24] = ((value >> 56) & 0xff) as u8;
    out[25] = ((value >> 48) & 0xff) as u8;
    out[26] = ((value >> 40) & 0xff) as u8;
    out[27] = ((value >> 32) & 0xff) as u8;
    out[28] = ((value >> 24) & 0xff) as u8;
    out[29] = ((value >> 16) & 0xff) as u8;
    out[30] = ((value >> 8) & 0xff) as u8;
    out[31] = (value & 0xff) as u8;
    out
}

fn split_bytes32(value: [u8; 32]) -> (u128, u128) {
    let mut hi: u128 = 0;
    let mut lo: u128 = 0;
    for i in 0..16 {
        hi = (hi << 8) | (value[i] as u128);
        lo = (lo << 8) | (value[16 + i] as u128);
    }
    (hi, lo)
}

fn commitment(market_id: [u8; 32], side: u8, deposit: u64, limit_price: u64, salt: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 160] = [0; 160];
    for i in 0..32 {
        encoded[i] = market_id[i];
        encoded[128 + i] = salt[i];
    }
    encoded[63] = side;
    let amount_bytes = u64_to_bytes32(deposit);
    let limit_bytes = u64_to_bytes32(limit_price);
    for i in 0..32 {
        encoded[64 + i] = amount_bytes[i];
        encoded[96 + i] = limit_bytes[i];
    }
    keccak256(encoded, 160)
}

fn main(
    market_id: [u8; 32],
    limit_price: u64,
    salt: [u8; 32],
    market_hi: pub u128,
    market_lo: pub u128,
    commitment_hi: pub u128,
    commitment_lo: pub u128,
    side: pub u8,
    deposit: pub u64,
    filled_shares: pub u64,
    usdc_settled: pub u64,
    refund: pub u64,
) {
    assert(side < 4, "invalid side");
    assert(deposit > 0, "empty deposit");
    assert((limit_price > 0) & (limit_price < 1_000_000), "invalid limit");

    let (expected_market_hi, expected_market_lo) = split_bytes32(market_id);
    assert((market_hi == expected_market_hi) & (market_lo == expected_market_lo), "wrong market");
    let (expected_commitment_hi, expected_commitment_lo) =
        split_bytes32(commitment(market_id, side, deposit, limit_price, salt));
    assert((commitment_hi == expected_commitment_hi) & (commitment_lo == expected_commitment_lo), "wrong commitment");

    assert((filled_shares == 0) == (usdc_settled == 0), "zero fill mismatch");
    let buyer: bool = (side == 0) | (side == 2);
    if buyer {
        assert((usdc_settled as u128) + (refund as u128) == deposit as u128, "buy refund mismatch");
        assert((usdc_settled as u128) * PRICE_SCALE <=
            (filled_shares as u128) * (limit_price as u128), "buy limit exceeded");
    } else {
        assert((filled_shares as u128) + (refund as u128) == deposit as u128, "sell refund mismatch");
        assert((usdc_settled as u128) * PRICE_SCALE >=
            (filled_shares as u128) * (limit_price as u128), "sell limit violated");
    }
}

#[test]
fn test_partial_buy_with_fee_and_refund() {
    let market: [u8; 32] = [1; 32];
    let salt: [u8; 32] = [2; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 2, 410_000, 420_000, salt));
    main(market, 420_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        2, 410_000, 1_000_000, 405_000, 5_000);
}

#[test]
fn test_partial_sell_at_net_price() {
    let market: [u8; 32] = [3; 32];
    let salt: [u8; 32] = [4; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 1, 2_000_000, 550_000, salt));
    main(market, 550_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        1, 2_000_000, 1_000_000, 575_000, 1_000_000);
}

#[test]
fn test_full_refund() {
    let market: [u8; 32] = [5; 32];
    let salt: [u8; 32] = [6; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 0, 600_000, 650_000, salt));
    main(market, 650_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        0, 600_000, 0, 0, 600_000);
}

#[test(should_fail)]
fn test_rejects_buy_above_hidden_limit() {
    let market: [u8; 32] = [7; 32];
    let salt: [u8; 32] = [8; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 0, 500_000, 400_000, salt));
    main(market, 400_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        0, 500_000, 1_000_000, 450_000, 50_000);
}

#[test(should_fail)]
fn test_rejects_sell_below_hidden_limit() {
    let market: [u8; 32] = [9; 32];
    let salt: [u8; 32] = [10; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 3, 1_000_000, 600_000, salt));
    main(market, 600_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        3, 1_000_000, 1_000_000, 550_000, 0);
}

#[test(should_fail)]
fn test_rejects_forged_commitment() {
    let market: [u8; 32] = [11; 32];
    let salt: [u8; 32] = [12; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 0, 500_000, 700_000, salt));
    main(market, 650_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        0, 500_000, 1_000_000, 500_000, 0);
}

#[test(should_fail)]
fn test_rejects_unallocated_buyer_deposit() {
    let market: [u8; 32] = [13; 32];
    let salt: [u8; 32] = [14; 32];
    let (market_hi, market_lo) = split_bytes32(market);
    let (commitment_hi, commitment_lo) = split_bytes32(commitment(market, 2, 410_000, 420_000, salt));
    main(market, 420_000, salt, market_hi, market_lo, commitment_hi, commitment_lo,
        2, 410_000, 1_000_000, 405_000, 0);
}
