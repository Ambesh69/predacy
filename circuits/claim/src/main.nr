// Predacy: ZK Claim Proof Circuit
//
// Proves that a prover knows a valid order preimage whose commitment
// is included in the batch's Merkle tree, WITHOUT revealing which
// commitment is theirs or what their address is.
//
// Privacy guarantee:
//   - Commitment hash = keccak256(marketId, isBuy, amount, limitPrice, salt)
//     - NO trader address in the hash.  The 256-bit salt is the secret credential.
//   - The Merkle proof shows membership without revealing the leaf index publicly.
//   - The nullifier = keccak256(commitment ++ batchId ++ salt) prevents double-claim
//     while keeping the salt secret.
//
// Public inputs (verified by BatchVault.claimWithProof):
//   batch_id            - must match the batchId passed to the contract
//   commitment_root_hi  - high 128 bits of batch.claimMerkleRoot
//   commitment_root_lo  - low  128 bits of batch.claimMerkleRoot
//   clearing_price      - must match batch.clearingPrice
//   nullifier_hi        - high 128 bits of nullifier (checked against usedNullifiers[])
//   nullifier_lo        - low  128 bits of nullifier
//   recipient           - address that receives the payout (chosen by prover, as Field)
//   fills               - whether the order filled
//   fill_amount         - USDC or YES tokens received
//   refund_amount       - assets returned if unfilled
//   is_buy_out          - order direction (echoed from private input)
//
// NOTE: bytes32 values (keccak256 hashes) are split into two u128 halves so that
// each public output fits in a single BN254 field element.  The contract reassembles
// them: bytes32 v = bytes32((uint256(hi) << 128) | uint256(lo)).
//
// Private inputs (witness - never revealed on-chain):
//   market_id       - the market condition ID (bytes32)
//   is_buy          - order direction
//   amount          - USDC (6 decimals) for buys; YES token count for sells
//   limit_price     - 6-decimal fixed point limit price
//   salt            - 32-byte random secret chosen at order time
//   merkle_path     - DEPTH sibling hashes from leaf to root
//   leaf_index      - position of this commitment in the batch's Merkle tree

use keccak256::keccak256;

// Merkle tree depth supporting up to 2^9 = 512 orders per batch.
// Must match the depth used by BatchVault._buildMerkleRoot().
global DEPTH: u32 = 9;
global PRICE_DECIMALS: u64 = 1_000_000;

// -- Helper: u64 -> big-endian bytes32 (ABI-encoded right-aligned uint256) ----

fn u64_to_bytes32(value: u64) -> [u8; 32] {
    let mut result: [u8; 32] = [0; 32];
    result[24] = ((value >> 56) & 0xFF) as u8;
    result[25] = ((value >> 48) & 0xFF) as u8;
    result[26] = ((value >> 40) & 0xFF) as u8;
    result[27] = ((value >> 32) & 0xFF) as u8;
    result[28] = ((value >> 24) & 0xFF) as u8;
    result[29] = ((value >> 16) & 0xFF) as u8;
    result[30] = ((value >>  8) & 0xFF) as u8;
    result[31] = (value         & 0xFF) as u8;
    result
}

// -- Helper: concatenate three 32-byte arrays into 96 bytes -------------------

fn concat96(a: [u8; 32], b: [u8; 32], c: [u8; 32]) -> [u8; 96] {
    let mut out: [u8; 96] = [0; 96];
    for i in 0..32 {
        out[i]      = a[i];
        out[32 + i] = b[i];
        out[64 + i] = c[i];
    }
    out
}

// -- Helper: 16 bytes (big-endian) -> u128 ------------------------------------

fn bytes16_to_u128(b: [u8; 16]) -> u128 {
    let mut result: u128 = 0;
    for i in 0..16 {
        result = (result << 8) | (b[i] as u128);
    }
    result
}

// -- Helper: split bytes32 into (hi: u128, lo: u128) --------------------------
//
// hi = big-endian interpretation of bytes[0..16]
// lo = big-endian interpretation of bytes[16..32]
// Reconstruct in Solidity: bytes32((uint256(hi) << 128) | uint256(lo))

fn split_bytes32(b: [u8; 32]) -> (u128, u128) {
    let mut hi_bytes: [u8; 16] = [0; 16];
    let mut lo_bytes: [u8; 16] = [0; 16];
    for i in 0..16 {
        hi_bytes[i] = b[i];
        lo_bytes[i] = b[16 + i];
    }
    (bytes16_to_u128(hi_bytes), bytes16_to_u128(lo_bytes))
}

// -- Commitment hash (NO trader address) --------------------------------------
//
// Matches BatchVault._verifyCommitments():
//   keccak256(abi.encode(marketId, isBuy, amount, limitPrice, salt))
//   = keccak256(bytes32 ++ bytes32_bool ++ bytes32_uint ++ bytes32_uint ++ bytes32)
//   = 5 * 32 bytes = 160 bytes total

fn compute_commitment(
    market_id:   [u8; 32],
    is_buy:      bool,
    amount:      u64,
    limit_price: u64,
    salt:        [u8; 32],
) -> [u8; 32] {
    let mut encoded: [u8; 160] = [0; 160];

    // marketId (bytes32, left-aligned)
    for i in 0..32 {
        encoded[i] = market_id[i];
    }

    // isBuy (bool as uint256, right-aligned: 31 zero bytes + 1 byte)
    if is_buy {
        encoded[63] = 1;
    }

    // amount (uint256, right-aligned)
    let amount_bytes = u64_to_bytes32(amount);
    for i in 0..32 {
        encoded[64 + i] = amount_bytes[i];
    }

    // limitPrice (uint256, right-aligned)
    let price_bytes = u64_to_bytes32(limit_price);
    for i in 0..32 {
        encoded[96 + i] = price_bytes[i];
    }

    // salt (bytes32)
    for i in 0..32 {
        encoded[128 + i] = salt[i];
    }

    keccak256(encoded, 160)
}

// -- Standard binary Merkle verification --------------------------------------
//
// Recomputes the root given a leaf hash, the sibling path, and the leaf index.
// Hashing: keccak256(abi.encode(left, right)) = keccak256(64 bytes).
// Ordering: leaf_index bit i == 0 -> current is left child, sibling is right.

fn merkle_verify(
    leaf:        [u8; 32],
    path:        [[u8; 32]; 9],   // DEPTH = 9 siblings
    leaf_index:  u32,
) -> [u8; 32] {
    let mut current = leaf;

    for depth in 0..9 {
        let sibling = path[depth];
        // leaf_index bit `depth`: 0 = left child, 1 = right child
        let is_right_child = ((leaf_index >> depth) & 1) == 1;

        let mut pair: [u8; 64] = [0; 64];
        if is_right_child {
            // current is right child - sibling is left
            for i in 0..32 {
                pair[i]      = sibling[i];
                pair[32 + i] = current[i];
            }
        } else {
            // current is left child - sibling is right
            for i in 0..32 {
                pair[i]      = current[i];
                pair[32 + i] = sibling[i];
            }
        }
        current = keccak256(pair, 64);
    }

    current
}

// -- Main circuit -------------------------------------------------------------

fn main(
    // -- Private witness (never revealed on-chain) ----------------------------
    market_id:   [u8; 32],      // market condition ID
    is_buy:      bool,          // order direction
    amount:      u64,           // USDC (buy) or YES tokens (sell), 6 decimals
    limit_price: u64,           // 6-decimal limit price
    salt:        [u8; 32],      // 32-byte random secret
    merkle_path: [[u8; 32]; 9], // sibling hashes from leaf to root (DEPTH = 9)
    leaf_index:  u32,           // position of this commitment in the batch tree

    // -- Public outputs (checked on-chain by BatchVault.claimWithProof) -------
    // bytes32 values are split into two u128 halves (each fits in BN254 field).
    // Contract reconstructs: bytes32((uint256(hi) << 128) | uint256(lo)).
    batch_id:           pub u64,   // batch ID
    commitment_root_hi: pub u128,  // high 128 bits of batch.claimMerkleRoot
    commitment_root_lo: pub u128,  // low  128 bits of batch.claimMerkleRoot
    clearing_price:     pub u64,   // batch.clearingPrice
    nullifier_hi:       pub u128,  // high 128 bits of nullifier
    nullifier_lo:       pub u128,  // low  128 bits of nullifier
    recipient:          pub Field, // payout address as field element (prover chooses)
    fills:              pub bool,  // whether this order filled
    fill_amount:        pub u64,   // payout amount if filled
    refund_amount:      pub u64,   // refund amount if unfilled
    is_buy_out:         pub bool,  // echoes is_buy for the contract to branch on
) {
    // Suppress unused-variable warning on recipient (circuit makes no constraint on it;
    // the contract reads it from public inputs to route the payout).
    let _ = recipient;

    // -- 1. Recompute commitment (no trader address) ---------------------------
    let commitment = compute_commitment(market_id, is_buy, amount, limit_price, salt);

    // -- 2. Verify Merkle membership ------------------------------------------
    let computed_root = merkle_verify(commitment, merkle_path, leaf_index);

    // Split the computed root and assert it matches the hi/lo public outputs.
    let (root_hi, root_lo) = split_bytes32(computed_root);
    assert(root_hi == commitment_root_hi, "Merkle root hi mismatch");
    assert(root_lo == commitment_root_lo, "Merkle root lo mismatch");

    // -- 3. Compute nullifier and assert it matches the public input -----------
    //    nullifier = keccak256(commitment ++ batchId_bytes32 ++ salt)
    let batch_id_bytes = u64_to_bytes32(batch_id);
    let null_input = concat96(commitment, batch_id_bytes, salt);
    let expected_null = keccak256(null_input, 96);

    let (null_hi, null_lo) = split_bytes32(expected_null);
    assert(null_hi == nullifier_hi, "Nullifier hi mismatch");
    assert(null_lo == nullifier_lo, "Nullifier lo mismatch");

    // -- 4. Echo is_buy --------------------------------------------------------
    assert(is_buy_out == is_buy, "is_buy_out must match is_buy");

    // -- 5. Verify fill decision -----------------------------------------------
    //    Buy fills if limit_price >= clearing_price
    //    Sell fills if limit_price <= clearing_price
    let order_fills: bool = if is_buy {
        limit_price >= clearing_price
    } else {
        limit_price <= clearing_price
    };
    assert(order_fills == fills, "Fill decision mismatch");

    // -- 6. Verify fill/refund amounts ----------------------------------------
    if fills {
        if is_buy {
            // Filled buy: all USDC amount was spent, refund = 0
            assert(fill_amount == amount, "fill_amount must equal order amount for filled buy");
            assert(refund_amount == 0, "refund_amount must be 0 for filled buy");
        } else {
            // Filled sell: USDC proceeds = amount * clearingPrice / PRICE_DECIMALS
            let expected_usdc: u64 = (amount * clearing_price) / PRICE_DECIMALS;
            assert(fill_amount == expected_usdc, "fill_amount mismatch for filled sell");
            assert(refund_amount == 0, "refund_amount must be 0 for filled sell");
        }
    } else {
        assert(fill_amount == 0, "fill_amount must be 0 for unfilled order");
        if is_buy {
            // Unfilled buy: EIP-3009 deferred - USDC was never deposited, nothing to refund
            assert(refund_amount == 0, "refund_amount must be 0 for unfilled buy (EIP-3009)");
        } else {
            // Unfilled sell: full YES token refund
            assert(refund_amount == amount, "refund_amount must equal order amount for unfilled sell");
        }
    }
}

// -- Unit tests ---------------------------------------------------------------

#[test]
fn test_compute_commitment_deterministic() {
    let market_id: [u8; 32] = [1; 32];
    let salt: [u8; 32] = [42; 32];

    let c1 = compute_commitment(market_id, true, 100_000_000, 650_000, salt);
    let c2 = compute_commitment(market_id, true, 100_000_000, 650_000, salt);
    assert(c1 == c2, "Commitment must be deterministic");
}

#[test]
fn test_compute_commitment_sensitive_to_inputs() {
    let market_id: [u8; 32] = [1; 32];
    let salt: [u8; 32] = [42; 32];

    let c_buy  = compute_commitment(market_id, true,  100_000_000, 650_000, salt);
    let c_sell = compute_commitment(market_id, false, 100_000_000, 650_000, salt);
    assert(c_buy != c_sell, "Buy/sell commitments must differ");

    let c_price1 = compute_commitment(market_id, true, 100_000_000, 650_000, salt);
    let c_price2 = compute_commitment(market_id, true, 100_000_000, 700_000, salt);
    assert(c_price1 != c_price2, "Different limit prices must give different commitments");
}

#[test]
fn test_u64_to_bytes32_values() {
    let result = u64_to_bytes32(1_000_000);
    // 1_000_000 = 0x000F4240
    assert(result[29] == 0x0F);
    assert(result[30] == 0x42);
    assert(result[31] == 0x40);
    for i in 0..29 {
        assert(result[i] == 0, "High bytes must be zero");
    }
}

#[test]
fn test_split_bytes32_roundtrip() {
    // All-ones high half, all-zeros low half
    let mut b: [u8; 32] = [0; 32];
    for i in 0..16 { b[i] = 0xFF; }
    let (hi, lo) = split_bytes32(b);
    assert(hi == 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF, "hi must be all ones");
    assert(lo == 0, "lo must be zero");

    // All-zeros high half, all-ones low half
    let mut b2: [u8; 32] = [0; 32];
    for i in 16..32 { b2[i] = 0xFF; }
    let (hi2, lo2) = split_bytes32(b2);
    assert(hi2 == 0, "hi must be zero");
    assert(lo2 == 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF, "lo must be all ones");
}
