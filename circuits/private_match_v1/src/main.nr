// Prototype private two-party prediction-token match. No funds are moved by
// this circuit; a shielded asset contract and note delivery are still needed.
use keccak256::keccak256;

global DEPTH: u32 = 9;
global PRICE_SCALE: u128 = 1_000_000;

fn u64_bytes(value: u64) -> [u8; 32] {
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

fn halves(value: [u8; 32]) -> (u128, u128) {
    let mut hi: u128 = 0;
    let mut lo: u128 = 0;
    for i in 0..16 {
        hi = (hi << 8) | (value[i] as u128);
        lo = (lo << 8) | (value[16 + i] as u128);
    }
    (hi, lo)
}

fn order_commitment(
    side: u8, market: [u8; 32], token: [u8; 32],
    escrow: u64, limit: u64, recipient: [u8; 32], secret: [u8; 32],
) -> [u8; 32] {
    let mut encoded: [u8; 224] = [0; 224];
    encoded[31] = side;
    let escrow_bytes = u64_bytes(escrow);
    let limit_bytes = u64_bytes(limit);
    for i in 0..32 {
        encoded[32 + i] = market[i];
        encoded[64 + i] = token[i];
        encoded[96 + i] = escrow_bytes[i];
        encoded[128 + i] = limit_bytes[i];
        encoded[160 + i] = recipient[i];
        encoded[192 + i] = secret[i];
    }
    keccak256(encoded, 224)
}

fn hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 64] = [0; 64];
    for i in 0..32 {
        encoded[i] = left[i];
        encoded[32 + i] = right[i];
    }
    keccak256(encoded, 64)
}

fn merkle_root(leaf: [u8; 32], path: [[u8; 32]; 9], index: u32) -> [u8; 32] {
    assert(index < 512, "invalid order index");
    let mut current = leaf;
    for depth in 0..DEPTH {
        current = if ((index >> depth) & 1) == 0 {
            hash_pair(current, path[depth])
        } else {
            hash_pair(path[depth], current)
        };
    }
    current
}

fn nullifier(order: [u8; 32], secret: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 96] = [0; 96];
    encoded[31] = 7;
    for i in 0..32 {
        encoded[32 + i] = order[i];
        encoded[64 + i] = secret[i];
    }
    keccak256(encoded, 96)
}

fn note(
    asset: u8, market: [u8; 32], token: [u8; 32],
    amount: u64, recipient: [u8; 32], salt: [u8; 32],
) -> [u8; 32] {
    let mut encoded: [u8; 192] = [0; 192];
    encoded[31] = asset;
    let amount_bytes = u64_bytes(amount);
    for i in 0..32 {
        encoded[32 + i] = market[i];
        encoded[64 + i] = token[i];
        encoded[96 + i] = amount_bytes[i];
        encoded[128 + i] = recipient[i];
        encoded[160 + i] = salt[i];
    }
    keccak256(encoded, 192)
}

fn settlement_root(
    market: [u8; 32], token: [u8; 32],
    buyer_refund: u64, bought: u64, seller_refund: u64, seller_cash: u64,
    buyer_recipient: [u8; 32], seller_recipient: [u8; 32],
    buyer_note_salt: [u8; 32], seller_note_salt: [u8; 32],
) -> [u8; 32] {
    let buyer_cash = note(1, market, token, buyer_refund, buyer_recipient, buyer_note_salt);
    let buyer_position = note(2, market, token, bought, buyer_recipient, buyer_note_salt);
    let seller_position = note(2, market, token, seller_refund, seller_recipient, seller_note_salt);
    let seller_payout = note(1, market, token, seller_cash, seller_recipient, seller_note_salt);
    hash_pair(hash_pair(buyer_cash, buyer_position), hash_pair(seller_position, seller_payout))
}

fn main(
    market: [u8; 32], token: [u8; 32],
    buyer_escrow: u64, buyer_limit: u64, buyer_secret: [u8; 32],
    buyer_path: [[u8; 32]; 9], buyer_index: u32,
    seller_escrow: u64, seller_limit: u64, seller_secret: [u8; 32],
    seller_path: [[u8; 32]; 9], seller_index: u32,
    filled_shares: u64, execution_price: u64,
    buyer_recipient: [u8; 32], seller_recipient: [u8; 32],
    buyer_note_salt: [u8; 32], seller_note_salt: [u8; 32],
    order_root_hi: pub u128, order_root_lo: pub u128,
    buyer_nullifier_hi: pub u128, buyer_nullifier_lo: pub u128,
    seller_nullifier_hi: pub u128, seller_nullifier_lo: pub u128,
    settlement_root_hi: pub u128, settlement_root_lo: pub u128,
) {
    assert(buyer_index != seller_index, "same order index");
    assert(buyer_escrow > 0, "empty buyer escrow");
    assert(seller_escrow > 0, "empty seller escrow");
    assert((filled_shares > 0) & (filled_shares <= seller_escrow), "invalid fill");
    assert((buyer_limit > 0) & (buyer_limit < 1_000_000), "invalid buyer limit");
    assert((seller_limit > 0) & (seller_limit < 1_000_000), "invalid seller limit");
    assert((execution_price > 0) & (execution_price < 1_000_000), "invalid price");
    assert((execution_price <= buyer_limit) & (execution_price >= seller_limit), "price outside limits");

    let buyer = order_commitment(0, market, token, buyer_escrow, buyer_limit,
        buyer_recipient, buyer_secret);
    let seller = order_commitment(1, market, token, seller_escrow, seller_limit,
        seller_recipient, seller_secret);
    let buyer_root = merkle_root(buyer, buyer_path, buyer_index);
    let seller_root = merkle_root(seller, seller_path, seller_index);
    let (actual_root_hi, actual_root_lo) = halves(buyer_root);
    assert((buyer_root == seller_root) & (order_root_hi == actual_root_hi) &
        (order_root_lo == actual_root_lo), "order membership invalid");

    let (actual_buyer_nullifier_hi, actual_buyer_nullifier_lo) = halves(nullifier(buyer, buyer_secret));
    let (actual_seller_nullifier_hi, actual_seller_nullifier_lo) = halves(nullifier(seller, seller_secret));
    assert((buyer_nullifier_hi == actual_buyer_nullifier_hi) &
        (buyer_nullifier_lo == actual_buyer_nullifier_lo), "buyer nullifier invalid");
    assert((seller_nullifier_hi == actual_seller_nullifier_hi) &
        (seller_nullifier_lo == actual_seller_nullifier_lo), "seller nullifier invalid");

    let cost = (((filled_shares as u128) * (execution_price as u128)) + PRICE_SCALE - 1) / PRICE_SCALE;
    assert(cost <= buyer_escrow as u128, "buyer escrow insufficient");
    assert(cost * PRICE_SCALE <= (filled_shares as u128) * (buyer_limit as u128), "buyer net limit exceeded");
    assert(cost * PRICE_SCALE >= (filled_shares as u128) * (seller_limit as u128), "seller net limit violated");
    let buyer_refund = buyer_escrow - (cost as u64);
    let seller_refund = seller_escrow - filled_shares;
    let result = settlement_root(market, token, buyer_refund, filled_shares,
        seller_refund, cost as u64, buyer_recipient, seller_recipient,
        buyer_note_salt, seller_note_salt);
    let (actual_settlement_hi, actual_settlement_lo) = halves(result);
    assert((settlement_root_hi == actual_settlement_hi) &
        (settlement_root_lo == actual_settlement_lo), "settlement notes invalid");
}

#[test]
fn test_private_two_party_match() {
    let market = [1; 32];
    let token = [2; 32];
    let buyer_secret = [3; 32];
    let seller_secret = [4; 32];
    let buyer_recipient = [5; 32];
    let seller_recipient = [6; 32];
    let buyer_note_salt = [7; 32];
    let seller_note_salt = [8; 32];
    let buyer = order_commitment(0, market, token, 600_000, 600_000, buyer_recipient, buyer_secret);
    let seller = order_commitment(1, market, token, 1_000_000, 500_000, seller_recipient, seller_secret);
    let mut buyer_path = [[0; 32]; 9];
    let mut seller_path = [[0; 32]; 9];
    buyer_path[0] = seller;
    seller_path[0] = buyer;
    let root = merkle_root(buyer, buyer_path, 0);
    let (root_hi, root_lo) = halves(root);
    let (bn_hi, bn_lo) = halves(nullifier(buyer, buyer_secret));
    let (sn_hi, sn_lo) = halves(nullifier(seller, seller_secret));
    let result = settlement_root(market, token, 50_000, 1_000_000, 0, 550_000,
        buyer_recipient, seller_recipient, buyer_note_salt, seller_note_salt);
    let (result_hi, result_lo) = halves(result);
    main(market, token, 600_000, 600_000, buyer_secret, buyer_path, 0,
        1_000_000, 500_000, seller_secret, seller_path, 1,
        1_000_000, 550_000, buyer_recipient, seller_recipient,
        buyer_note_salt, seller_note_salt, root_hi, root_lo, bn_hi, bn_lo,
        sn_hi, sn_lo, result_hi, result_lo);
}

#[test(should_fail)]
fn test_rejects_forged_settlement_root() {
    let market = [1; 32];
    let token = [2; 32];
    let buyer_secret = [3; 32];
    let seller_secret = [4; 32];
    let buyer = order_commitment(0, market, token, 600_000, 600_000, [5; 32], buyer_secret);
    let seller = order_commitment(1, market, token, 1_000_000, 500_000, [6; 32], seller_secret);
    let mut buyer_path = [[0; 32]; 9];
    let mut seller_path = [[0; 32]; 9];
    buyer_path[0] = seller;
    seller_path[0] = buyer;
    let (root_hi, root_lo) = halves(merkle_root(buyer, buyer_path, 0));
    let (bn_hi, bn_lo) = halves(nullifier(buyer, buyer_secret));
    let (sn_hi, sn_lo) = halves(nullifier(seller, seller_secret));
    main(market, token, 600_000, 600_000, buyer_secret, buyer_path, 0,
        1_000_000, 500_000, seller_secret, seller_path, 1,
        1_000_000, 550_000, [5; 32], [6; 32], [7; 32], [8; 32],
        root_hi, root_lo, bn_hi, bn_lo, sn_hi, sn_lo, 0, 0);
}

#[test(should_fail)]
fn test_rejects_redirected_buyer_note() {
    let market = [1; 32];
    let token = [2; 32];
    let buyer_secret = [3; 32];
    let seller_secret = [4; 32];
    let buyer = order_commitment(0, market, token, 600_000, 600_000, [5; 32], buyer_secret);
    let seller = order_commitment(1, market, token, 1_000_000, 500_000, [6; 32], seller_secret);
    let mut buyer_path = [[0; 32]; 9];
    let mut seller_path = [[0; 32]; 9];
    buyer_path[0] = seller;
    seller_path[0] = buyer;
    let (root_hi, root_lo) = halves(merkle_root(buyer, buyer_path, 0));
    let (bn_hi, bn_lo) = halves(nullifier(buyer, buyer_secret));
    let (sn_hi, sn_lo) = halves(nullifier(seller, seller_secret));
    let redirected = settlement_root(market, token, 50_000, 1_000_000, 0, 550_000,
        [9; 32], [6; 32], [7; 32], [8; 32]);
    let (result_hi, result_lo) = halves(redirected);
    main(market, token, 600_000, 600_000, buyer_secret, buyer_path, 0,
        1_000_000, 500_000, seller_secret, seller_path, 1,
        1_000_000, 550_000, [9; 32], [6; 32], [7; 32], [8; 32],
        root_hi, root_lo, bn_hi, bn_lo, sn_hi, sn_lo, result_hi, result_lo);
}

#[test(should_fail)]
fn test_rejects_buy_price_above_limit() {
    let market = [1; 32];
    let token = [2; 32];
    let buyer_secret = [3; 32];
    let seller_secret = [4; 32];
    let buyer = order_commitment(0, market, token, 600_000, 600_000, [5; 32], buyer_secret);
    let seller = order_commitment(1, market, token, 1_000_000, 500_000, [6; 32], seller_secret);
    let mut buyer_path = [[0; 32]; 9];
    let mut seller_path = [[0; 32]; 9];
    buyer_path[0] = seller;
    seller_path[0] = buyer;
    let (root_hi, root_lo) = halves(merkle_root(buyer, buyer_path, 0));
    let (bn_hi, bn_lo) = halves(nullifier(buyer, buyer_secret));
    let (sn_hi, sn_lo) = halves(nullifier(seller, seller_secret));
    main(market, token, 600_000, 600_000, buyer_secret, buyer_path, 0,
        1_000_000, 500_000, seller_secret, seller_path, 1,
        1_000_000, 650_000, [5; 32], [6; 32], [7; 32], [8; 32],
        root_hi, root_lo, bn_hi, bn_lo, sn_hi, sn_lo, 0, 0);
}

#[test(should_fail)]
fn test_rejects_sell_price_below_limit() {
    let market = [1; 32];
    let token = [2; 32];
    let buyer_secret = [3; 32];
    let seller_secret = [4; 32];
    let buyer = order_commitment(0, market, token, 600_000, 600_000, [5; 32], buyer_secret);
    let seller = order_commitment(1, market, token, 1_000_000, 500_000, [6; 32], seller_secret);
    let mut buyer_path = [[0; 32]; 9];
    let mut seller_path = [[0; 32]; 9];
    buyer_path[0] = seller;
    seller_path[0] = buyer;
    let (root_hi, root_lo) = halves(merkle_root(buyer, buyer_path, 0));
    let (bn_hi, bn_lo) = halves(nullifier(buyer, buyer_secret));
    let (sn_hi, sn_lo) = halves(nullifier(seller, seller_secret));
    main(market, token, 600_000, 600_000, buyer_secret, buyer_path, 0,
        1_000_000, 500_000, seller_secret, seller_path, 1,
        1_000_000, 450_000, [5; 32], [6; 32], [7; 32], [8; 32],
        root_hi, root_lo, bn_hi, bn_lo, sn_hi, sn_lo, 0, 0);
}
