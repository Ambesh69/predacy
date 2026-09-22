use keccak256::keccak256;

global DEPTH: u32 = 20;
global ORDER_COUNT: u32 = 2;

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

fn batch_binding(
    position_asset: [u8; 32],
    nullifiers: [[u8; 32]; 2],
    refunds: [[u8; 32]; 2],
    total_deposit: u64,
) -> [u8; 32] {
    let mut encoded: [u8; 224] = [0; 224];
    let batch_domain = domain(7);
    let total_word = word(total_deposit);
    for i in 0..32 {
        encoded[i] = batch_domain[i];
        encoded[32 + i] = position_asset[i];
        encoded[64 + i] = nullifiers[0][i];
        encoded[96 + i] = nullifiers[1][i];
        encoded[128 + i] = refunds[0][i];
        encoded[160 + i] = refunds[1][i];
        encoded[192 + i] = total_word[i];
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
    deposits: [u64; 2],
    limits: [u64; 2],
    refund_public_keys: [[u8; 32]; 2],
    position_public_keys: [[u8; 32]; 2],
    order_secrets: [[u8; 32]; 2],
    paths: [[[u8; 32]; 20]; 2],
    indices: [u32; 2],
    root_high: pub u128,
    root_low: pub u128,
    collateral_high: pub u128,
    collateral_low: pub u128,
    position_high: pub u128,
    position_low: pub u128,
    nullifier_high: pub [u128; 2],
    nullifier_low: pub [u128; 2],
    refund_high: pub [u128; 2],
    refund_low: pub [u128; 2],
    total_deposit: pub u64,
    binding_high: pub u128,
    binding_low: pub u128,
) {
    let mut actual_nullifiers = [[0; 32]; 2];
    let mut actual_refunds = [[0; 32]; 2];
    let mut deposit_sum: u128 = 0;
    for i in 0..ORDER_COUNT {
        assert(deposits[i] > 0, "empty order");
        assert((limits[i] > 0) & (limits[i] < 1_000_000), "invalid limit");
        let order = order_commitment(
            position_asset,
            deposits[i],
            limits[i],
            refund_public_keys[i],
            position_public_keys[i],
            keccak256(order_secrets[i], 32),
        );
        let root = merkle_root(order, paths[i], indices[i]);
        let (actual_root_high, actual_root_low) = halves(root);
        assert((root_high == actual_root_high) & (root_low == actual_root_low), "root mismatch");
        actual_nullifiers[i] = order_nullifier(order, order_secrets[i]);
        actual_refunds[i] = note_commitment(collateral_asset, deposits[i], refund_public_keys[i]);
        let (actual_nullifier_high, actual_nullifier_low) = halves(actual_nullifiers[i]);
        let (actual_refund_high, actual_refund_low) = halves(actual_refunds[i]);
        assert(
            (nullifier_high[i] == actual_nullifier_high)
                & (nullifier_low[i] == actual_nullifier_low),
            "nullifier mismatch",
        );
        assert(
            (refund_high[i] == actual_refund_high) & (refund_low[i] == actual_refund_low),
            "refund mismatch",
        );
        deposit_sum += deposits[i] as u128;
    }
    assert(actual_nullifiers[0] != actual_nullifiers[1], "duplicate order");
    assert(deposit_sum == total_deposit as u128, "deposit total mismatch");
    let (actual_collateral_high, actual_collateral_low) = halves(collateral_asset);
    let (actual_position_high, actual_position_low) = halves(position_asset);
    assert(
        (collateral_high == actual_collateral_high) & (collateral_low == actual_collateral_low),
        "collateral mismatch",
    );
    assert(
        (position_high == actual_position_high) & (position_low == actual_position_low),
        "position mismatch",
    );
    let binding = batch_binding(position_asset, actual_nullifiers, actual_refunds, total_deposit);
    let (actual_binding_high, actual_binding_low) = halves(binding);
    assert((binding_high == actual_binding_high) & (binding_low == actual_binding_low), "binding mismatch");
}

fn two_leaf_paths(first: [u8; 32], second: [u8; 32]) -> ([[u8; 32]; 20], [[u8; 32]; 20], [u8; 32]) {
    let mut first_path = [[0; 32]; 20];
    let mut second_path = [[0; 32]; 20];
    first_path[0] = second;
    second_path[0] = first;
    let mut root = hash_pair(first, second);
    let mut zero = hash_pair([0; 32], [0; 32]);
    for level in 1..DEPTH {
        first_path[level] = zero;
        second_path[level] = zero;
        root = hash_pair(root, zero);
        zero = hash_pair(zero, zero);
    }
    (first_path, second_path, root)
}

#[test]
fn test_routes_two_unlinkable_order_notes() {
    let collateral = [1; 32];
    let position = [2; 32];
    let deposits: [u64; 2] = [600_000, 400_000];
    let limits: [u64; 2] = [600_000, 500_000];
    let refund_keys = [[3; 32], [4; 32]];
    let position_keys = [[5; 32], [6; 32]];
    let secrets = [[7; 32], [8; 32]];
    let first = order_commitment(position, deposits[0], limits[0], refund_keys[0], position_keys[0], keccak256(secrets[0], 32));
    let second = order_commitment(position, deposits[1], limits[1], refund_keys[1], position_keys[1], keccak256(secrets[1], 32));
    let (first_path, second_path, root) = two_leaf_paths(first, second);
    let paths = [first_path, second_path];
    let nullifiers = [order_nullifier(first, secrets[0]), order_nullifier(second, secrets[1])];
    let refunds = [note_commitment(collateral, deposits[0], refund_keys[0]), note_commitment(collateral, deposits[1], refund_keys[1])];
    let binding = batch_binding(position, nullifiers, refunds, 1_000_000);
    let (root_high, root_low) = halves(root);
    let (collateral_high, collateral_low) = halves(collateral);
    let (position_high, position_low) = halves(position);
    let (n0h, n0l) = halves(nullifiers[0]);
    let (n1h, n1l) = halves(nullifiers[1]);
    let (r0h, r0l) = halves(refunds[0]);
    let (r1h, r1l) = halves(refunds[1]);
    let (binding_high, binding_low) = halves(binding);
    main(
        collateral, position, deposits, limits, refund_keys, position_keys, secrets, paths, [0, 1],
        root_high, root_low, collateral_high, collateral_low, position_high, position_low,
        [n0h, n1h], [n0l, n1l], [r0h, r1h], [r0l, r1l], 1_000_000,
        binding_high, binding_low,
    );
}

#[test(should_fail)]
fn test_rejects_order_note_from_another_position() {
    let collateral = [11; 32];
    let position = [12; 32];
    let deposits: [u64; 2] = [500_000, 500_000];
    let limits: [u64; 2] = [700_000, 700_000];
    let refund_keys = [[13; 32], [14; 32]];
    let position_keys = [[15; 32], [16; 32]];
    let secrets = [[17; 32], [18; 32]];
    let first = order_commitment(position, deposits[0], limits[0], refund_keys[0], position_keys[0], keccak256(secrets[0], 32));
    let second = order_commitment([99; 32], deposits[1], limits[1], refund_keys[1], position_keys[1], keccak256(secrets[1], 32));
    let (first_path, second_path, root) = two_leaf_paths(first, second);
    let paths = [first_path, second_path];
    let nullifiers = [order_nullifier(first, secrets[0]), order_nullifier(second, secrets[1])];
    let refunds = [note_commitment(collateral, deposits[0], refund_keys[0]), note_commitment(collateral, deposits[1], refund_keys[1])];
    let binding = batch_binding(position, nullifiers, refunds, 1_000_000);
    let (root_high, root_low) = halves(root);
    let (collateral_high, collateral_low) = halves(collateral);
    let (position_high, position_low) = halves(position);
    let (n0h, n0l) = halves(nullifiers[0]);
    let (n1h, n1l) = halves(nullifiers[1]);
    let (r0h, r0l) = halves(refunds[0]);
    let (r1h, r1l) = halves(refunds[1]);
    let (binding_high, binding_low) = halves(binding);
    main(
        collateral, position, deposits, limits, refund_keys, position_keys, secrets, paths, [0, 1],
        root_high, root_low, collateral_high, collateral_low, position_high, position_low,
        [n0h, n1h], [n0l, n1l], [r0h, r1h], [r0l, r1l], 1_000_000,
        binding_high, binding_low,
    );
}
