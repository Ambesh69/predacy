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

fn nullifier(commitment: [u8; 32], secret: [u8; 32], domain_value: u8) -> [u8; 32] {
    let mut encoded: [u8; 96] = [0; 96];
    let nullifier_domain = domain(domain_value);
    for i in 0..32 {
        encoded[i] = nullifier_domain[i];
        encoded[32 + i] = commitment[i];
        encoded[64 + i] = secret[i];
    }
    keccak256(encoded, 96)
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
    collateral_asset: [u8; 32],
    position_asset: [u8; 32],
    deposit: u64,
    limit_price: u64,
    note_secret: [u8; 32],
    path: [[u8; 32]; 20],
    index: u32,
    refund_public_key: [u8; 32],
    position_public_key: [u8; 32],
    order_secret: [u8; 32],
    root_high: pub u128,
    root_low: pub u128,
    note_nullifier_high: pub u128,
    note_nullifier_low: pub u128,
    collateral_high: pub u128,
    collateral_low: pub u128,
    order_high: pub u128,
    order_low: pub u128,
) {
    assert(deposit > 0, "empty order");
    assert((limit_price > 0) & (limit_price < 1_000_000), "invalid limit");
    let input_note = note_commitment(collateral_asset, deposit, keccak256(note_secret, 32));
    let root = merkle_root(input_note, path, index);
    let note_nullifier = nullifier(input_note, note_secret, 2);
    let order = order_commitment(
        position_asset,
        deposit,
        limit_price,
        refund_public_key,
        position_public_key,
        keccak256(order_secret, 32),
    );
    let (actual_root_high, actual_root_low) = halves(root);
    let (actual_nullifier_high, actual_nullifier_low) = halves(note_nullifier);
    let (actual_collateral_high, actual_collateral_low) = halves(collateral_asset);
    let (actual_order_high, actual_order_low) = halves(order);
    assert((root_high == actual_root_high) & (root_low == actual_root_low), "root mismatch");
    assert(
        (note_nullifier_high == actual_nullifier_high)
            & (note_nullifier_low == actual_nullifier_low),
        "nullifier mismatch",
    );
    assert(
        (collateral_high == actual_collateral_high) & (collateral_low == actual_collateral_low),
        "collateral mismatch",
    );
    assert((order_high == actual_order_high) & (order_low == actual_order_low), "order mismatch");
}

fn first_leaf_path() -> [[u8; 32]; 20] {
    let mut path = [[0; 32]; 20];
    let mut zero = [0; 32];
    for level in 0..DEPTH {
        path[level] = zero;
        zero = hash_pair(zero, zero);
    }
    path
}

#[test]
fn test_order_commitment_hides_position_asset_from_public_inputs() {
    let collateral = [11; 32];
    let position = [12; 32];
    let note_secret = [13; 32];
    let order_secret = [14; 32];
    let path = first_leaf_path();
    let input = note_commitment(collateral, 750_000, keccak256(note_secret, 32));
    let root = merkle_root(input, path, 0);
    let spent = nullifier(input, note_secret, 2);
    let order = order_commitment(position, 750_000, 600_000, [15; 32], [16; 32], keccak256(order_secret, 32));
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(spent);
    let (collateral_high, collateral_low) = halves(collateral);
    let (order_high, order_low) = halves(order);
    main(
        collateral, position, 750_000, 600_000, note_secret, path, 0, [15; 32], [16; 32], order_secret,
        root_high, root_low, nullifier_high, nullifier_low, collateral_high, collateral_low,
        order_high, order_low,
    );
}

#[test(should_fail)]
fn test_rejects_forged_hidden_position() {
    let collateral = [21; 32];
    let position = [22; 32];
    let note_secret = [23; 32];
    let order_secret = [24; 32];
    let path = first_leaf_path();
    let input = note_commitment(collateral, 500_000, keccak256(note_secret, 32));
    let root = merkle_root(input, path, 0);
    let spent = nullifier(input, note_secret, 2);
    let forged = order_commitment([99; 32], 500_000, 700_000, [25; 32], [26; 32], keccak256(order_secret, 32));
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(spent);
    let (collateral_high, collateral_low) = halves(collateral);
    let (order_high, order_low) = halves(forged);
    main(
        collateral, position, 500_000, 700_000, note_secret, path, 0, [25; 32], [26; 32], order_secret,
        root_high, root_low, nullifier_high, nullifier_low, collateral_high, collateral_low,
        order_high, order_low,
    );
}
