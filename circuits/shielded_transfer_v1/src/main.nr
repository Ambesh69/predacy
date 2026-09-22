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
    input_amount: u64,
    input_secret: [u8; 32],
    path: [[u8; 32]; 20],
    index: u32,
    first_amount: u64,
    first_public_key: [u8; 32],
    second_amount: u64,
    second_public_key: [u8; 32],
    root_high: pub u128,
    root_low: pub u128,
    nullifier_high: pub u128,
    nullifier_low: pub u128,
    first_commitment_high: pub u128,
    first_commitment_low: pub u128,
    second_commitment_high: pub u128,
    second_commitment_low: pub u128,
) {
    assert(input_amount > 0, "empty input note");
    assert(first_amount > 0, "empty first output");
    assert(
        (first_amount as u128) + (second_amount as u128) == input_amount as u128,
        "value not conserved",
    );

    let input_commitment = note_commitment(asset, input_amount, note_public_key(input_secret));
    let root = merkle_root(input_commitment, path, index);
    let nullifier = note_nullifier(input_commitment, input_secret);
    let first_commitment = note_commitment(asset, first_amount, first_public_key);
    let second_commitment = if second_amount == 0 {
        [0; 32]
    } else {
        note_commitment(asset, second_amount, second_public_key)
    };

    let (actual_root_high, actual_root_low) = halves(root);
    let (actual_nullifier_high, actual_nullifier_low) = halves(nullifier);
    let (actual_first_high, actual_first_low) = halves(first_commitment);
    let (actual_second_high, actual_second_low) = halves(second_commitment);
    assert((root_high == actual_root_high) & (root_low == actual_root_low), "root mismatch");
    assert(
        (nullifier_high == actual_nullifier_high) & (nullifier_low == actual_nullifier_low),
        "nullifier mismatch",
    );
    assert(
        (first_commitment_high == actual_first_high) & (first_commitment_low == actual_first_low),
        "first output mismatch",
    );
    assert(
        (second_commitment_high == actual_second_high)
            & (second_commitment_low == actual_second_low),
        "second output mismatch",
    );
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
fn test_private_note_split() {
    let asset = [11; 32];
    let secret = [22; 32];
    let path = first_leaf_path();
    let input = note_commitment(asset, 1_000_000, note_public_key(secret));
    let root = merkle_root(input, path, 0);
    let nullifier = note_nullifier(input, secret);
    let first = note_commitment(asset, 600_000, [33; 32]);
    let second = note_commitment(asset, 400_000, [44; 32]);
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(nullifier);
    let (first_high, first_low) = halves(first);
    let (second_high, second_low) = halves(second);
    main(
        asset,
        1_000_000,
        secret,
        path,
        0,
        600_000,
        [33; 32],
        400_000,
        [44; 32],
        root_high,
        root_low,
        nullifier_high,
        nullifier_low,
        first_high,
        first_low,
        second_high,
        second_low,
    );
}

#[test(should_fail)]
fn test_rejects_value_creation() {
    let asset = [11; 32];
    let secret = [22; 32];
    let path = first_leaf_path();
    let input = note_commitment(asset, 1_000_000, note_public_key(secret));
    let root = merkle_root(input, path, 0);
    let nullifier = note_nullifier(input, secret);
    let first = note_commitment(asset, 800_000, [33; 32]);
    let second = note_commitment(asset, 800_000, [44; 32]);
    let (root_high, root_low) = halves(root);
    let (nullifier_high, nullifier_low) = halves(nullifier);
    let (first_high, first_low) = halves(first);
    let (second_high, second_low) = halves(second);
    main(
        asset,
        1_000_000,
        secret,
        path,
        0,
        800_000,
        [33; 32],
        800_000,
        [44; 32],
        root_high,
        root_low,
        nullifier_high,
        nullifier_low,
        first_high,
        first_low,
        second_high,
        second_low,
    );
}
