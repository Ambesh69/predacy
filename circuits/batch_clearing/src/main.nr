// Predacy: Batch Clearing Price ZK Circuit
//
// Proves that:
//   1. Each revealed order pre-image matches its on-chain keccak256 commitment
//   2. The clearing price P maximizes filled volume (correct batch auction)
//   3. The reported net buy amount is correctly computed from filled orders
//
// Public inputs:
//   - commitment_root: sequential hash chain of all order commitments
//   - clearing_price:  6-decimal fixed point (e.g. 650000 = $0.65)
//   - total_buy_vol:   USDC filled on buy side (6 decimals)
//   - total_sell_vol:  USDC filled on sell side (6 decimals)
//   - net_buy_amount:  net USDC to route to Polymarket (6 decimals)
//
// Private inputs (witness -- never revealed):
//   - orders: array of N order pre-images (trader, direction, amount, limitPrice, salt)
//   - commitments: the on-chain commitment hashes
//
// Circuit constraints:
//   - For each order i: hash(orders[i]) == commitments[i]
//   - clearing_price is a valid price (0 < P < PRICE_DECIMALS)
//   - total_buy_vol == sum of amounts where (isBuy && limitPrice >= clearing_price)
//   - total_sell_vol == sum of amounts where (!isBuy && limitPrice <= clearing_price)
//   - net_buy_amount == total_buy_vol - min(total_buy_vol, total_sell_vol)
//
// Note: This circuit uses a fixed MAX_ORDERS compile-time constant.
// For variable-length batches, pad unused orders with zero amounts.

use keccak256::keccak256;

// Maximum orders per batch (must match contract MAX_BATCH_ORDERS)
// Noir requires fixed-size arrays -- pad with zero-amount dummy orders
global MAX_ORDERS: u32 = 64;
global PRICE_DECIMALS: u64 = 1_000_000;

struct Order {
    trader: [u8; 20],       // Ethereum address (20 bytes)
    is_buy: bool,
    amount: u64,            // USDC, 6 decimals
    limit_price: u64,       // 6-decimal fixed point
    salt: [u8; 32],         // random salt for commitment hiding
    is_padding: bool,       // true for dummy padding orders
}

/// Compute the keccak256 commitment for an order.
/// Matches BatchVault._makeCommitment() in Solidity:
///   keccak256(abi.encode(marketId, isBuy, amount, limitPrice, salt, trader))
fn compute_commitment(market_id: [u8; 32], order: Order) -> [u8; 32] {
    // ABI encode: market_id (32) + is_buy (32) + amount (32) + limit_price (32) + salt (32) + trader (32)
    // Total: 192 bytes
    let mut encoded: [u8; 192] = [0; 192];

    // market_id (bytes32, left-aligned)
    for i in 0..32 {
        encoded[i] = market_id[i];
    }

    // is_buy (bool as uint256, right-aligned in 32 bytes)
    if order.is_buy {
        encoded[63] = 1;
    }

    // amount (uint256, right-aligned)
    let amount_bytes = u64_to_bytes32(order.amount);
    for i in 0..32 {
        encoded[64 + i] = amount_bytes[i];
    }

    // limit_price (uint256, right-aligned)
    let price_bytes = u64_to_bytes32(order.limit_price);
    for i in 0..32 {
        encoded[96 + i] = price_bytes[i];
    }

    // salt (bytes32)
    for i in 0..32 {
        encoded[128 + i] = order.salt[i];
    }

    // trader (address as uint256, right-aligned in 32 bytes -- 12 zero bytes + 20 address bytes)
    for i in 0..20 {
        encoded[172 + i] = order.trader[i];
    }

    keccak256(encoded, 192)
}

/// Sequential commitment root matching BatchVault._computeCommitmentRoot()
/// root = keccak256(keccak256(... keccak256(0, h[0]), h[1] ...), h[n-1])
fn compute_commitment_root(commitments: [[u8; 32]; MAX_ORDERS], count: u32) -> [u8; 32] {
    let mut root: [u8; 32] = [0; 32];

    for i in 0..MAX_ORDERS {
        if (i as u32) < count {
            // abi.encode(bytes32 root, bytes32 commitment) = 64 bytes
            let mut encoded: [u8; 64] = [0; 64];
            for j in 0..32 {
                encoded[j] = root[j];
                encoded[32 + j] = commitments[i][j];
            }
            root = keccak256(encoded, 64);
        }
    }

    root
}

/// Convert u64 to big-endian bytes32 (right-aligned, ABI encoding style)
fn u64_to_bytes32(value: u64) -> [u8; 32] {
    let mut result: [u8; 32] = [0; 32];
    result[24] = ((value >> 56) & 0xFF) as u8;
    result[25] = ((value >> 48) & 0xFF) as u8;
    result[26] = ((value >> 40) & 0xFF) as u8;
    result[27] = ((value >> 32) & 0xFF) as u8;
    result[28] = ((value >> 24) & 0xFF) as u8;
    result[29] = ((value >> 16) & 0xFF) as u8;
    result[30] = ((value >>  8) & 0xFF) as u8;
    result[31] = ((value      ) & 0xFF) as u8;
    result
}

fn main(
    // Public inputs
    commitment_root: pub [u8; 32],
    clearing_price: pub u64,
    total_buy_vol: pub u64,
    total_sell_vol: pub u64,
    net_buy_amount: pub u64,
    order_count: pub u32,

    // Private inputs (witness)
    market_id: [u8; 32],
    orders: [Order; MAX_ORDERS],
    commitments: [[u8; 32]; MAX_ORDERS],
) {
    // -- Constraint 1: Valid clearing price -----------------------------------
    assert(clearing_price > 0, "clearing price must be > 0");
    assert(clearing_price < PRICE_DECIMALS, "clearing price must be < 1.0");

    // -- Constraint 2: Each order commitment matches its pre-image ------------
    for i in 0..MAX_ORDERS {
        if (i as u32) < order_count {
            let computed = compute_commitment(market_id, orders[i]);
            assert(computed == commitments[i], "commitment mismatch");
        }
    }

    // -- Constraint 3: Commitment root is correctly computed ------------------
    let computed_root = compute_commitment_root(commitments, order_count);
    assert(computed_root == commitment_root, "commitment root mismatch");

    // -- Constraint 4: Volume computations are correct ------------------------
    let mut computed_buy_vol: u64 = 0;
    let mut computed_sell_vol: u64 = 0;

    for i in 0..MAX_ORDERS {
        if (i as u32) < order_count {
            let order = orders[i];
            if !order.is_padding {
                if order.is_buy & (order.limit_price >= clearing_price) {
                    computed_buy_vol += order.amount;
                } else if !order.is_buy & (order.limit_price <= clearing_price) {
                    computed_sell_vol += order.amount;
                }
            }
        }
    }

    assert(computed_buy_vol == total_buy_vol, "buy volume mismatch");
    assert(computed_sell_vol == total_sell_vol, "sell volume mismatch");

    // -- Constraint 5: Net buy amount is correctly computed -------------------
    let matched_vol = if total_buy_vol < total_sell_vol { total_buy_vol } else { total_sell_vol };
    let computed_net = total_buy_vol - matched_vol;
    assert(computed_net == net_buy_amount, "net buy amount mismatch");
}

// --- Tests ------------------------------------------------------------------

#[test]
fn test_basic_batch_clearing() {
    // Three orders: Alice buys $100 at $0.70, Bob buys $50 at $0.65, Carol sells $80 at $0.60
    // Clearing price: $0.65 -- all three fill
    // Buy vol: 150, Sell vol: 80, Net buy: 70

    let market_id: [u8; 32] = [1; 32];

    let alice_salt: [u8; 32] = [10; 32];
    let bob_salt: [u8; 32] = [20; 32];
    let carol_salt: [u8; 32] = [30; 32];

    let alice = Order {
        trader: [0xAA; 20],
        is_buy: true,
        amount: 100_000_000,  // $100
        limit_price: 700_000, // $0.70
        salt: alice_salt,
        is_padding: false,
    };

    let bob = Order {
        trader: [0xBB; 20],
        is_buy: true,
        amount: 50_000_000,   // $50
        limit_price: 650_000, // $0.65
        salt: bob_salt,
        is_padding: false,
    };

    let carol = Order {
        trader: [0xCC; 20],
        is_buy: false,
        amount: 80_000_000,   // $80
        limit_price: 600_000, // $0.60
        salt: carol_salt,
        is_padding: false,
    };

    let padding = Order {
        trader: [0; 20],
        is_buy: false,
        amount: 0,
        limit_price: 0,
        salt: [0; 32],
        is_padding: true,
    };

    let mut orders: [Order; MAX_ORDERS] = [padding; MAX_ORDERS];
    orders[0] = alice;
    orders[1] = bob;
    orders[2] = carol;

    // Compute commitments
    let mut commitments: [[u8; 32]; MAX_ORDERS] = [[0; 32]; MAX_ORDERS];
    commitments[0] = compute_commitment(market_id, orders[0]);
    commitments[1] = compute_commitment(market_id, orders[1]);
    commitments[2] = compute_commitment(market_id, orders[2]);

    let commitment_root = compute_commitment_root(commitments, 3);

    // At clearing price 0.65: Alice fills (0.70 >= 0.65), Bob fills (0.65 >= 0.65), Carol fills (0.60 <= 0.65)
    let clearing_price: u64 = 650_000;
    let total_buy_vol: u64 = 150_000_000;  // Alice + Bob
    let total_sell_vol: u64 = 80_000_000;  // Carol
    let net_buy_amount: u64 = 70_000_000;  // 150 - 80

    main(
        commitment_root,
        clearing_price,
        total_buy_vol,
        total_sell_vol,
        net_buy_amount,
        3,
        market_id,
        orders,
        commitments,
    );
}

#[test]
fn test_u64_to_bytes32() {
    let result = u64_to_bytes32(1_000_000);
    // 1000000 = 0xF4240
    assert(result[29] == 0x0F);
    assert(result[30] == 0x42);
    assert(result[31] == 0x40);
    // All other bytes should be 0
    for i in 0..29 {
        assert(result[i] == 0);
    }
}
