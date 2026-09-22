use keccak256::keccak256;

global DEPTH: u32 = 20;

fn u64_word(value: u64) -> [u8; 32] {
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

fn u160_word(high: u32, low: u128) -> [u8; 32] {
    let mut out: [u8; 32] = [0; 32];
    out[12] = ((high >> 24) & 0xff) as u8;
    out[13] = ((high >> 16) & 0xff) as u8;
    out[14] = ((high >> 8) & 0xff) as u8;
    out[15] = (high & 0xff) as u8;
    for i in 0..16 {
        out[(16 + i) as u32] = ((low >> (120 - i * 8)) & 0xff) as u8;
    }
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

fn note_public_key(secret: [u8; 32]) -> [u8; 32] {
    keccak256(secret, 32)
}

fn note_commitment(asset: [u8; 32], amount: u64, public_key: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 128] = [0; 128];
    let amount_word = u64_word(amount);
    let note_domain = domain(1);
    for i in 0..32 {
        encoded[i] = note_domain[i];
        encoded[32 + i] = asset[i];
        encoded[64 + i] = amount_word[i];
        encoded[96 + i] = public_key[i];
    }
    keccak256(encoded, 128)
}

fn note_nullifier(commitment: [u8; 32], secret: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 96] = [0; 96];
    let nullifier_domain = domain(2);
    for i in 0..32 {
        encoded[i] = nullifier_domain[i];
        encoded[32 + i] = commitment[i];
        encoded[64 + i] = secret[i];
    }
    keccak256(encoded, 96)
}

fn withdrawal_binding(
    root: [u8; 32],
    nullifier: [u8; 32],
    asset: [u8; 32],
    amount: u64,
    recipient_high: u32,
    recipient_low: u128,
) -> [u8; 32] {
    let mut encoded: [u8; 192] = [0; 192];
    let binding_domain = domain(3);
    let amount_word = u64_word(amount);
    let recipient = u160_word(recipient_high, recipient_low);
    for i in 0..32 {
        encoded[i] = binding_domain[i];
        encoded[32 + i] = root[i];
        encoded[64 + i] = nullifier[i];
        encoded[96 + i] = asset[i];
        encoded[128 + i] = amount_word[i];
        encoded[160 + i] = recipient[i];
    }
    keccak256(encoded, 192)
}

fn hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut encoded: [u8; 64] = [0; 64];
    for i in 0..32 {
        encoded[i] = left[i];
        encoded[32 + i] = right[i];
    }
    keccak256(encoded, 64)
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
    asset: [u8; 32],
    secret: [u8; 32],
    path: [[u8; 32]; 20],
    index: u32,
    recipient_high: u32,
    recipient_low: u128,
    root_high: pub u128,
    root_low: pub u128,
    nullifier_high: pub u128,
    nullifier_low: pub u128,
    asset_high: pub u128,
    asset_low: pub u128,
    amount: pub u64,
    binding_high: pub u128,
    binding_low: pub u128,
) {
    assert(amount > 0, "empty note");
    let commitment = note_commitment(asset, amount, note_public_key(secret));
    let root = merkle_root(commitment, path, index);
    let nullifier = note_nullifier(commitment, secret);
    let binding = withdrawal_binding(
        root,
        nullifier,
        asset,
        amount,
        recipient_high,
        recipient_low,
    );

    let (actual_root_high, actual_root_low) = halves(root);
    let (actual_nullifier_high, actual_nullifier_low) = halves(nullifier);
    let (actual_asset_high, actual_asset_low) = halves(asset);
    let (actual_binding_high, actual_binding_low) = halves(binding);
    assert((root_high == actual_root_high) & (root_low == actual_root_low), "root mismatch");
    assert(
        (nullifier_high == actual_nullifier_high) & (nullifier_low == actual_nullifier_low),
        "nullifier mismatch",
    );
    assert((asset_high == actual_asset_high) & (asset_low == actual_asset_low), "asset mismatch");
    assert(
        (binding_high == actual_binding_high) & (binding_low == actual_binding_low),
        "withdrawal binding mismatch",
    );
}

#[test]
fn test_valid_private_withdrawal() {
    let asset = [11; 32];
    let amount: u64 = 1_350_000;
    let secret = [22; 32];
    let recipient_high: u32 = 0x12345678;
    let recipient_low: u128 = 0x90abcdef1234567890abcdef12345678;
    let commitment = note_commitment(asset, amount, note_public_key(secret));
    let mut path = [[0; 32]; 20];
    let mut zero = [0; 32];
    for level in 0..DEPTH {
        path[level] = zero;
        zero = hash_pair(zero, zero);
    }
    let root = merkle_root(commitment, path, 0);
    let nullifier = note_nullifier(commitment, secret);
    let binding = withdrawal_binding(
        root,
        nullifier,
        asset,
        amount,
        recipient_high,
        recipient_low,
    );
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(nullifier);
    let (asset_high, asset_low) = halves(asset);
    let (binding_high, binding_low) = halves(binding);

    main(
        asset,
        secret,
        path,
        0,
        recipient_high,
        recipient_low,
        root_high,
        root_low,
        nullifier_high,
        nullifier_low,
        asset_high,
        asset_low,
        amount,
        binding_high,
        binding_low,
    );
}

#[test(should_fail)]
fn test_rejects_redirected_withdrawal() {
    let asset = [11; 32];
    let amount: u64 = 500_000;
    let secret = [33; 32];
    let commitment = note_commitment(asset, amount, note_public_key(secret));
    let mut path = [[0; 32]; 20];
    let mut zero = [0; 32];
    for level in 0..DEPTH {
        path[level] = zero;
        zero = hash_pair(zero, zero);
    }
    let root = merkle_root(commitment, path, 0);
    let nullifier = note_nullifier(commitment, secret);
    let binding = withdrawal_binding(root, nullifier, asset, amount, 1, 2);
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(nullifier);
    let (asset_high, asset_low) = halves(asset);
    let (binding_high, binding_low) = halves(binding);

    main(
        asset,
        secret,
        path,
        0,
        9,
        9,
        root_high,
        root_low,
        nullifier_high,
        nullifier_low,
        asset_high,
        asset_low,
        amount,
        binding_high,
        binding_low,
    );
}
