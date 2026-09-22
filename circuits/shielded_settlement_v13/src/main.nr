use keccak256::keccak256;

global ORDER_COUNT: u32 = 2;
global PRICE_SCALE: u128 = 1_000_000;

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

fn note_commitment(asset: [u8; 32], amount: u64, public_key: [u8; 32]) -> [u8; 32] {
    if amount == 0 {
        [0; 32]
    } else {
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

fn main(
    collateral_asset: [u8; 32],
    position_asset: [u8; 32],
    deposits: [u64; 2],
    limits: [u64; 2],
    refund_public_keys: [[u8; 32]; 2],
    position_public_keys: [[u8; 32]; 2],
    order_secrets: [[u8; 32]; 2],
    spent: [u64; 2],
    shares: [u64; 2],
    binding_high: pub u128,
    binding_low: pub u128,
    collateral_high: pub u128,
    collateral_low: pub u128,
    position_high: pub u128,
    position_low: pub u128,
    refund_high: pub [u128; 2],
    refund_low: pub [u128; 2],
    position_note_high: pub [u128; 2],
    position_note_low: pub [u128; 2],
    total_deposit: pub u64,
    total_spent: pub u64,
    total_shares: pub u64,
) {
    let mut nullifiers = [[0; 32]; 2];
    let mut full_refunds = [[0; 32]; 2];
    let mut deposit_sum: u128 = 0;
    let mut spent_sum: u128 = 0;
    let mut shares_sum: u128 = 0;
    for i in 0..ORDER_COUNT {
        assert(deposits[i] > 0, "empty order");
        assert((limits[i] > 0) & (limits[i] < 1_000_000), "invalid limit");
        assert(spent[i] <= deposits[i], "overspent order");
        assert((shares[i] == 0) == (spent[i] == 0), "zero fill mismatch");
        assert(
            (spent[i] as u128) * PRICE_SCALE <= (shares[i] as u128) * (limits[i] as u128),
            "hidden limit exceeded",
        );
        let order = order_commitment(
            position_asset,
            deposits[i],
            limits[i],
            refund_public_keys[i],
            position_public_keys[i],
            keccak256(order_secrets[i], 32),
        );
        nullifiers[i] = order_nullifier(order, order_secrets[i]);
        full_refunds[i] = note_commitment(collateral_asset, deposits[i], refund_public_keys[i]);
        let refund = note_commitment(
            collateral_asset,
            deposits[i] - spent[i],
            refund_public_keys[i],
        );
        let position_note = note_commitment(position_asset, shares[i], position_public_keys[i]);
        let (actual_refund_high, actual_refund_low) = halves(refund);
        let (actual_position_high, actual_position_low) = halves(position_note);
        assert(
            (refund_high[i] == actual_refund_high) & (refund_low[i] == actual_refund_low),
            "refund mismatch",
        );
        assert(
            (position_note_high[i] == actual_position_high)
                & (position_note_low[i] == actual_position_low),
            "position note mismatch",
        );
        deposit_sum += deposits[i] as u128;
        spent_sum += spent[i] as u128;
        shares_sum += shares[i] as u128;
    }
    assert(deposit_sum == total_deposit as u128, "deposit total mismatch");
    assert(spent_sum == total_spent as u128, "spent total mismatch");
    assert(shares_sum == total_shares as u128, "share total mismatch");
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
    let binding = batch_binding(position_asset, nullifiers, full_refunds, total_deposit);
    let (actual_binding_high, actual_binding_low) = halves(binding);
    assert((binding_high == actual_binding_high) & (binding_low == actual_binding_low), "binding mismatch");
}

#[test]
fn test_settles_two_hidden_orders() {
    let collateral = [1; 32];
    let position = [2; 32];
    let deposits: [u64; 2] = [600_000, 400_000];
    let limits: [u64; 2] = [600_000, 500_000];
    let refund_keys = [[3; 32], [4; 32]];
    let position_keys = [[5; 32], [6; 32]];
    let secrets = [[7; 32], [8; 32]];
    let spent: [u64; 2] = [550_000, 0];
    let shares: [u64; 2] = [1_000_000, 0];
    let mut nullifiers = [[0; 32]; 2];
    let mut full_refunds = [[0; 32]; 2];
    let mut refund_high = [0; 2];
    let mut refund_low = [0; 2];
    let mut position_highs = [0; 2];
    let mut position_lows = [0; 2];
    for i in 0..ORDER_COUNT {
        let order = order_commitment(position, deposits[i], limits[i], refund_keys[i], position_keys[i], keccak256(secrets[i], 32));
        nullifiers[i] = order_nullifier(order, secrets[i]);
        full_refunds[i] = note_commitment(collateral, deposits[i], refund_keys[i]);
        let (rh, rl) = halves(note_commitment(collateral, deposits[i] - spent[i], refund_keys[i]));
        refund_high[i] = rh;
        refund_low[i] = rl;
        let (ph, pl) = halves(note_commitment(position, shares[i], position_keys[i]));
        position_highs[i] = ph;
        position_lows[i] = pl;
    }
    let (binding_high, binding_low) = halves(batch_binding(position, nullifiers, full_refunds, 1_000_000));
    let (collateral_high, collateral_low) = halves(collateral);
    let (position_high, position_low) = halves(position);
    main(
        collateral, position, deposits, limits, refund_keys, position_keys, secrets, spent, shares,
        binding_high, binding_low, collateral_high, collateral_low, position_high, position_low,
        refund_high, refund_low, position_highs, position_lows, 1_000_000, 550_000, 1_000_000,
    );
}

#[test(should_fail)]
fn test_rejects_fill_above_hidden_limit() {
    let collateral = [11; 32];
    let position = [12; 32];
    let deposits: [u64; 2] = [600_000, 400_000];
    let limits: [u64; 2] = [500_000, 500_000];
    let refund_keys = [[13; 32], [14; 32]];
    let position_keys = [[15; 32], [16; 32]];
    let secrets = [[17; 32], [18; 32]];
    let spent: [u64; 2] = [600_000, 0];
    let shares: [u64; 2] = [1_000_000, 0];
    main(
        collateral, position, deposits, limits, refund_keys, position_keys, secrets, spent, shares,
        0, 0, 0, 0, 0, 0, [0; 2], [0; 2], [0; 2], [0; 2], 1_000_000, 600_000, 1_000_000,
    );
}
