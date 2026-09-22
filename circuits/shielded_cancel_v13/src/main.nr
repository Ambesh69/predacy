use keccak256::keccak256;

global DEPTH: u32 = 20;

fn word(value: u64) -> [u8; 32] {
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

fn domain(value: u8) -> [u8; 32] {
    let mut out: [u8; 32] = [0; 32];
    out[31] = value;
    out
}

fn halves(value: [u8; 32]) -> (u128, u128) {
    let mut high: u128 = 0;
    let mut low: u128 = 0;
    for i in 0..16 {
        high = (high << 8) | value[i] as u128;
        low = (low << 8) | value[16 + i] as u128;
    }
    (high, low)
}

fn hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 64] = [0; 64];
    for i in 0..32 {
        encoded[i] = left[i];
        encoded[32 + i] = right[i];
    }
    keccak256(encoded, 64)
}

fn note_commitment(asset: [u8; 32], amount: u64, public_key: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 128] = [0; 128];
    let amount_word = word(amount);
    let note_domain = domain(1);
    for i in 0..32 {
        encoded[i] = note_domain[i];
        encoded[32 + i] = asset[i];
        encoded[64 + i] = amount_word[i];
        encoded[96 + i] = public_key[i];
    }
    keccak256(encoded, 128)
}

fn order_commitment(
    position_asset: [u8; 32],
    deposit: u64,
    limit_price: u64,
    refund_public_key: [u8; 32],
    position_public_key: [u8; 32],
    order_public_key: [u8; 32],
) -> [u8; 32] {
    let mut encoded: [u8; 224] = [0; 224];
    let order_domain = domain(5);
    let deposit_word = word(deposit);
    let limit_word = word(limit_price);
    for i in 0..32 {
        encoded[i] = order_domain[i];
        encoded[32 + i] = position_asset[i];
        encoded[64 + i] = deposit_word[i];
        encoded[96 + i] = limit_word[i];
        encoded[128 + i] = refund_public_key[i];
        encoded[160 + i] = position_public_key[i];
        encoded[192 + i] = order_public_key[i];
    }
    keccak256(encoded, 224)
}

fn order_nullifier(commitment: [u8; 32], secret: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 96] = [0; 96];
    let nullifier_domain = domain(6);
    for i in 0..32 {
        encoded[i] = nullifier_domain[i];
        encoded[32 + i] = commitment[i];
        encoded[64 + i] = secret[i];
    }
    keccak256(encoded, 96)
}

fn merkle_root(leaf: [u8; 32], path: [[u8; 32]; 20], index: u32) -> [u8; 32] {
    assert(index < 1_048_576, "invalid leaf index");
    let mut current = leaf;
    for level in 0..DEPTH {
        current = if ((index >> level) & 1) == 0 {
            hash_pair(current, path[level])
        } else {
            hash_pair(path[level], current)
        };
    }
    current
}

fn main(
    position_asset: [u8; 32],
    deposit: u64,
    limit_price: u64,
    refund_public_key: [u8; 32],
    position_public_key: [u8; 32],
    order_secret: [u8; 32],
    path: [[u8; 32]; 20],
    index: u32,
    root_high: pub u128,
    root_low: pub u128,
    order_nullifier_high: pub u128,
    order_nullifier_low: pub u128,
    collateral_high: pub u128,
    collateral_low: pub u128,
    refund_high: pub u128,
    refund_low: pub u128,
    total_deposit: pub u64,
    collateral_asset: [u8; 32],
) {
    assert(deposit > 0, "empty order");
    assert((limit_price > 0) & (limit_price < 1_000_000), "invalid limit");
    assert(deposit == total_deposit, "deposit mismatch");
    let order = order_commitment(
        position_asset,
        deposit,
        limit_price,
        refund_public_key,
        position_public_key,
        keccak256(order_secret, 32),
    );
    let root = merkle_root(order, path, index);
    let nullifier = order_nullifier(order, order_secret);
    let refund = note_commitment(collateral_asset, deposit, refund_public_key);
    let (actual_root_high, actual_root_low) = halves(root);
    let (actual_nullifier_high, actual_nullifier_low) = halves(nullifier);
    let (actual_collateral_high, actual_collateral_low) = halves(collateral_asset);
    let (actual_refund_high, actual_refund_low) = halves(refund);
    assert((root_high == actual_root_high) & (root_low == actual_root_low), "root mismatch");
    assert(
        (order_nullifier_high == actual_nullifier_high)
            & (order_nullifier_low == actual_nullifier_low),
        "nullifier mismatch",
    );
    assert(
        (collateral_high == actual_collateral_high) & (collateral_low == actual_collateral_low),
        "collateral mismatch",
    );
    assert((refund_high == actual_refund_high) & (refund_low == actual_refund_low), "refund mismatch");
}

#[test]
fn test_cancels_without_revealing_position() {
    let collateral = [1; 32];
    let position = [2; 32];
    let refund_key = [3; 32];
    let position_key = [4; 32];
    let secret = [5; 32];
    let order = order_commitment(position, 500_000, 600_000, refund_key, position_key, keccak256(secret, 32));
    let mut path = [[0; 32]; 20];
    let mut root = order;
    let mut zero = [0; 32];
    for level in 0..DEPTH {
        path[level] = zero;
        root = hash_pair(root, zero);
        zero = hash_pair(zero, zero);
    }
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(order_nullifier(order, secret));
    let (collateral_high, collateral_low) = halves(collateral);
    let (refund_high, refund_low) = halves(note_commitment(collateral, 500_000, refund_key));
    main(
        position, 500_000, 600_000, refund_key, position_key, secret, path, 0,
        root_high, root_low, nullifier_high, nullifier_low, collateral_high, collateral_low,
        refund_high, refund_low, 500_000, collateral,
    );
}

#[test(should_fail)]
fn test_rejects_wrong_refund() {
    main(
        [2; 32], 500_000, 600_000, [3; 32], [4; 32], [5; 32], [[0; 32]; 20], 0,
        0, 0, 0, 0, 0, 0, 0, 0, 500_000, [1; 32],
    );
}
