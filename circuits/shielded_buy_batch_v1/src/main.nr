use keccak256::keccak256;

global MAX_ORDERS: u32 = 2;
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
    input_note: [u8; 32],
    position_asset: [u8; 32],
    deposit: u64,
    limit_price: u64,
    refund_public_key: [u8; 32],
    position_public_key: [u8; 32],
    salt: [u8; 32],
) -> [u8; 32] {
    let mut encoded: [u8; 256] = [0; 256];
    let order_domain = domain(4);
    let deposit_word = word(deposit);
    let limit_word = word(limit_price);
    for i in 0..32 {
        encoded[i] = order_domain[i];
        encoded[32 + i] = input_note[i];
        encoded[64 + i] = position_asset[i];
        encoded[96 + i] = deposit_word[i];
        encoded[128 + i] = limit_word[i];
        encoded[160 + i] = refund_public_key[i];
        encoded[192 + i] = position_public_key[i];
        encoded[224 + i] = salt[i];
    }
    keccak256(encoded, 256)
}

fn main(
    collateral_asset: [u8; 32],
    position_asset: [u8; 32],
    input_notes: [[u8; 32]; 2],
    deposits: [u64; 2],
    limits: [u64; 2],
    salts: [[u8; 32]; 2],
    refund_public_keys: [[u8; 32]; 2],
    position_public_keys: [[u8; 32]; 2],
    spent: [u64; 2],
    shares: [u64; 2],
    order_count: pub u8,
    collateral_high: pub u128,
    collateral_low: pub u128,
    position_high: pub u128,
    position_low: pub u128,
    order_high: pub [u128; 2],
    order_low: pub [u128; 2],
    refund_high: pub [u128; 2],
    refund_low: pub [u128; 2],
    position_note_high: pub [u128; 2],
    position_note_low: pub [u128; 2],
    total_deposit: pub u64,
    total_spent: pub u64,
    total_shares: pub u64,
) {
    assert((order_count > 0) & (order_count <= 2), "invalid order count");
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

    let mut deposit_sum: u128 = 0;
    let mut spent_sum: u128 = 0;
    let mut shares_sum: u128 = 0;
    for i in 0..MAX_ORDERS {
        if i < order_count as u32 {
            assert(deposits[i] > 0, "empty deposit");
            assert((limits[i] > 0) & (limits[i] < 1_000_000), "invalid limit");
            assert(spent[i] <= deposits[i], "overspent order");
            assert((shares[i] == 0) == (spent[i] == 0), "zero fill mismatch");
            assert(
                (spent[i] as u128) * PRICE_SCALE <= (shares[i] as u128) * (limits[i] as u128),
                "hidden limit exceeded",
            );
            let order = order_commitment(
                input_notes[i],
                position_asset,
                deposits[i],
                limits[i],
                refund_public_keys[i],
                position_public_keys[i],
                salts[i],
            );
            let refund = note_commitment(
                collateral_asset,
                deposits[i] - spent[i],
                refund_public_keys[i],
            );
            let position_note = note_commitment(position_asset, shares[i], position_public_keys[i]);
            let (actual_order_high, actual_order_low) = halves(order);
            let (actual_refund_high, actual_refund_low) = halves(refund);
            let (actual_position_note_high, actual_position_note_low) = halves(position_note);
            assert(
                (order_high[i] == actual_order_high) & (order_low[i] == actual_order_low),
                "order mismatch",
            );
            assert(
                (refund_high[i] == actual_refund_high) & (refund_low[i] == actual_refund_low),
                "refund mismatch",
            );
            assert(
                (position_note_high[i] == actual_position_note_high)
                    & (position_note_low[i] == actual_position_note_low),
                "position note mismatch",
            );
            deposit_sum += deposits[i] as u128;
            spent_sum += spent[i] as u128;
            shares_sum += shares[i] as u128;
        } else {
            assert((deposits[i] == 0) & (spent[i] == 0) & (shares[i] == 0), "nonempty padding");
            assert(
                (order_high[i] == 0)
                    & (order_low[i] == 0)
                    & (refund_high[i] == 0)
                    & (refund_low[i] == 0)
                    & (position_note_high[i] == 0)
                    & (position_note_low[i] == 0),
                "public padding not empty",
            );
        }
    }
    assert(deposit_sum == total_deposit as u128, "deposit total mismatch");
    assert(spent_sum == total_spent as u128, "spent total mismatch");
    assert(shares_sum == total_shares as u128, "share total mismatch");
}

#[test]
fn test_two_order_private_buy_batch() {
    let collateral = [1; 32];
    let position = [2; 32];
    let input_notes = [[3; 32], [4; 32]];
    let deposits: [u64; 2] = [600_000, 400_000];
    let limits: [u64; 2] = [600_000, 500_000];
    let salts = [[5; 32], [6; 32]];
    let refund_keys = [[7; 32], [8; 32]];
    let position_keys = [[9; 32], [10; 32]];
    let spent: [u64; 2] = [550_000, 0];
    let shares: [u64; 2] = [1_000_000, 0];
    let mut order_high = [0; 2];
    let mut order_low = [0; 2];
    let mut refund_high = [0; 2];
    let mut refund_low = [0; 2];
    let mut position_note_high = [0; 2];
    let mut position_note_low = [0; 2];
    for i in 0..MAX_ORDERS {
        let (next_order_high, next_order_low) = halves(order_commitment(
            input_notes[i],
            position,
            deposits[i],
            limits[i],
            refund_keys[i],
            position_keys[i],
            salts[i],
        ));
        order_high[i] = next_order_high;
        order_low[i] = next_order_low;
        let (next_refund_high, next_refund_low) = halves(note_commitment(
            collateral,
            deposits[i] - spent[i],
            refund_keys[i],
        ));
        refund_high[i] = next_refund_high;
        refund_low[i] = next_refund_low;
        let (next_position_high, next_position_low) =
            halves(note_commitment(position, shares[i], position_keys[i]));
        position_note_high[i] = next_position_high;
        position_note_low[i] = next_position_low;
    }
    let (collateral_high, collateral_low) = halves(collateral);
    let (position_high, position_low) = halves(position);
    main(
        collateral,
        position,
        input_notes,
        deposits,
        limits,
        salts,
        refund_keys,
        position_keys,
        spent,
        shares,
        2,
        collateral_high,
        collateral_low,
        position_high,
        position_low,
        order_high,
        order_low,
        refund_high,
        refund_low,
        position_note_high,
        position_note_low,
        1_000_000,
        550_000,
        1_000_000,
    );
}
