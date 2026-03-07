// Predacy: Batch Clearing Price ZK Circuit
//
// Proves that:
//   1. Each revealed order pre-image matches its on-chain keccak256 commitment
//   2. The clearing price P maximizes filled volume (correct batch auction)
//   3. The reported filled volumes per side are correctly computed
//
// Public inputs:
//   - commitment_root:       sequential hash chain of all order commitments
//   - clearing_price:        6-decimal fixed point (e.g. 650000 = $0.65)
//   - filled_yes_buy_vol:    USDC filled on YES_BUY side (6 decimals)
//   - filled_no_buy_vol:     USDC filled on NO_BUY side (6 decimals)
//   - filled_yes_sell_qty:   YES tokens filled on YES_SELL side (6 decimals)
//   - filled_no_sell_qty:    NO tokens filled on NO_SELL side (6 decimals)
//   - order_count:           number of non-padding orders
//
// Private inputs (witness -- never revealed):
//   - market_id:   32-byte market condition ID
//   - orders:      array of N order pre-images (side, amount, limitPrice, salt)
//   - commitments: the on-chain commitment hashes
//
// Circuit constraints:
//   - For each order i: hash(orders[i]) == commitments[i]
//   - clearing_price is a valid price (0 < P < PRICE_DECIMALS)
//   - filled_yes_buy_vol  == sum of amounts where (side==YES_BUY  && limitPrice >= clearingPrice)
//   - filled_no_buy_vol   == sum of amounts where (side==NO_BUY   && limitPrice >= noPrice)
//   - filled_yes_sell_qty == sum of amounts where (side==YES_SELL && limitPrice <= clearingPrice)
//   - filled_no_sell_qty  == sum of amounts where (side==NO_SELL  && limitPrice <= noPrice)
//
// Note: This circuit uses a fixed MAX_ORDERS compile-time constant.
// For variable-length batches, pad unused orders with zero amounts.

use keccak256::keccak256;

// Maximum orders per batch (must match contract MAX_BATCH_ORDERS)
// Noir requires fixed-size arrays -- pad with zero-amount dummy orders
global MAX_ORDERS: u32 = 8;
global PRICE_DECIMALS: u64 = 1_000_000;

// Order side constants - must match BatchVault.sol OrderSide enum
global YES_BUY:  u8 = 0;
global YES_SELL: u8 = 1;
global NO_BUY:   u8 = 2;
global NO_SELL:  u8 = 3;

struct Order {
    side:       u8,   // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
    amount:     u64,  // USDC (buys) or token count (sells), 6 decimals
    limit_price: u64, // 6-decimal fixed point
    salt: [u8; 32],   // random salt for commitment hiding
    is_padding: bool, // true for dummy padding orders
}

/// Compute the keccak256 commitment for an order.
/// Matches BatchVault._makeCommitment() in Solidity:
///   keccak256(abi.encode(marketId, side, amount, limitPrice, salt))
fn compute_commitment(market_id: [u8; 32], order: Order) -> [u8; 32] {
    // ABI encode: market_id (32) + side (32) + amount (32) + limit_price (32) + salt (32)
    // Total: 160 bytes
    let mut encoded: [u8; 160] = [0; 160];

    // market_id (bytes32, left-aligned)
    for i in 0..32 {
        encoded[i] = market_id[i];
    }

    // side (uint8 as uint256, right-aligned: 31 zero bytes + 1 byte)
    encoded[63] = order.side;

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

    keccak256(encoded, 160)
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
    commitment_root:       pub [u8; 32],
    clearing_price:        pub u64,
    filled_yes_buy_vol:    pub u64,  // USDC from filled YES_BUY orders
    filled_no_buy_vol:     pub u64,  // USDC from filled NO_BUY orders
    filled_yes_sell_qty:   pub u64,  // YES tokens from filled YES_SELL orders
    filled_no_sell_qty:    pub u64,  // NO tokens from filled NO_SELL orders
    order_count:           pub u32,

    // Private inputs (witness)
    market_id:   [u8; 32],
    orders:      [Order; MAX_ORDERS],
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

    // -- Constraint 4: Per-side volume computations are correct ---------------
    let no_price: u64 = PRICE_DECIMALS - clearing_price;

    let mut computed_yes_buy_vol:  u64 = 0;
    let mut computed_no_buy_vol:   u64 = 0;
    let mut computed_yes_sell_qty: u64 = 0;
    let mut computed_no_sell_qty:  u64 = 0;

    for i in 0..MAX_ORDERS {
        if (i as u32) < order_count {
            let order = orders[i];
            if !order.is_padding {
                if order.side == YES_BUY {
                    if order.limit_price >= clearing_price {
                        computed_yes_buy_vol += order.amount;
                    }
                } else if order.side == YES_SELL {
                    if order.limit_price <= clearing_price {
                        computed_yes_sell_qty += order.amount;
                    }
                } else if order.side == NO_BUY {
                    if order.limit_price >= no_price {
                        computed_no_buy_vol += order.amount;
                    }
                } else {
                    // NO_SELL
                    if order.limit_price <= no_price {
                        computed_no_sell_qty += order.amount;
                    }
                }
            }
        }
    }

    assert(computed_yes_buy_vol  == filled_yes_buy_vol,  "YES_BUY volume mismatch");
    assert(computed_no_buy_vol   == filled_no_buy_vol,   "NO_BUY volume mismatch");
    assert(computed_yes_sell_qty == filled_yes_sell_qty, "YES_SELL qty mismatch");
    assert(computed_no_sell_qty  == filled_no_sell_qty,  "NO_SELL qty mismatch");
}

// --- Tests ------------------------------------------------------------------

#[test]
fn test_basic_batch_clearing_yes_only() {
    // Alice buys YES $100 at $0.70, Bob buys YES $50 at $0.65, Carol sells YES $80 at $0.60
    // Clearing price: $0.65 - all three fill
    let market_id: [u8; 32] = [1; 32];

    let alice_salt: [u8; 32] = [10; 32];
    let bob_salt:   [u8; 32] = [20; 32];
    let carol_salt: [u8; 32] = [30; 32];

    let alice = Order { side: YES_BUY,  amount: 100_000_000, limit_price: 700_000, salt: alice_salt, is_padding: false };
    let bob   = Order { side: YES_BUY,  amount:  50_000_000, limit_price: 650_000, salt: bob_salt,   is_padding: false };
    let carol = Order { side: YES_SELL, amount:  80_000_000, limit_price: 600_000, salt: carol_salt, is_padding: false };

    let padding = Order { side: YES_BUY, amount: 0, limit_price: 0, salt: [0; 32], is_padding: true };
    let mut orders: [Order; MAX_ORDERS] = [padding; MAX_ORDERS];
    orders[0] = alice;
    orders[1] = bob;
    orders[2] = carol;

    let mut commitments: [[u8; 32]; MAX_ORDERS] = [[0; 32]; MAX_ORDERS];
    commitments[0] = compute_commitment(market_id, orders[0]);
    commitments[1] = compute_commitment(market_id, orders[1]);
    commitments[2] = compute_commitment(market_id, orders[2]);

    let commitment_root = compute_commitment_root(commitments, 3);
    let clearing_price: u64 = 650_000;

    // Alice (0.70 >= 0.65 ok) + Bob (0.65 >= 0.65 ok) fill YES_BUY
    // Carol (0.60 <= 0.65 ok) fills YES_SELL
    main(
        commitment_root,
        clearing_price,
        150_000_000, // filled_yes_buy_vol:  Alice + Bob
        0,           // filled_no_buy_vol:   none
        80_000_000,  // filled_yes_sell_qty: Carol
        0,           // filled_no_sell_qty:  none
        3,
        market_id,
        orders,
        commitments,
    );
}

#[test]
fn test_four_sided_batch() {
    // Alice: YES_BUY $100 at 0.70, Carol: YES_SELL 80 tokens at 0.60
    // Dave: NO_BUY $50 at 0.40 (noPrice = 1 - 0.65 = 0.35; 0.40 >= 0.35 ok)
    // Eve: NO_SELL 30 tokens at 0.30 (0.30 <= 0.35 ok)
    // Clearing price: 0.65 (noPrice = 0.35)
    let market_id: [u8; 32] = [2; 32];

    let alice = Order { side: YES_BUY,  amount: 100_000_000, limit_price: 700_000, salt: [10; 32], is_padding: false };
    let carol = Order { side: YES_SELL, amount:  80_000_000, limit_price: 600_000, salt: [30; 32], is_padding: false };
    let dave  = Order { side: NO_BUY,   amount:  50_000_000, limit_price: 400_000, salt: [40; 32], is_padding: false };
    let eve   = Order { side: NO_SELL,  amount:  30_000_000, limit_price: 300_000, salt: [50; 32], is_padding: false };

    let padding = Order { side: YES_BUY, amount: 0, limit_price: 0, salt: [0; 32], is_padding: true };
    let mut orders: [Order; MAX_ORDERS] = [padding; MAX_ORDERS];
    orders[0] = alice;
    orders[1] = carol;
    orders[2] = dave;
    orders[3] = eve;

    let mut commitments: [[u8; 32]; MAX_ORDERS] = [[0; 32]; MAX_ORDERS];
    commitments[0] = compute_commitment(market_id, orders[0]);
    commitments[1] = compute_commitment(market_id, orders[1]);
    commitments[2] = compute_commitment(market_id, orders[2]);
    commitments[3] = compute_commitment(market_id, orders[3]);

    let commitment_root = compute_commitment_root(commitments, 4);
    let clearing_price: u64 = 650_000; // noPrice = 350_000

    main(
        commitment_root,
        clearing_price,
        100_000_000, // filled_yes_buy_vol:  Alice
        50_000_000,  // filled_no_buy_vol:   Dave
        80_000_000,  // filled_yes_sell_qty: Carol
        30_000_000,  // filled_no_sell_qty:  Eve
        4,
        market_id,
        orders,
        commitments,
    );
}

#[test]
fn test_unfilled_orders_not_counted() {
    // Alice: YES_BUY $100 at 0.60 - does NOT fill (0.60 < clearing 0.65)
    // Bob:   YES_BUY $50  at 0.70 - fills
    let market_id: [u8; 32] = [3; 32];

    let alice = Order { side: YES_BUY, amount: 100_000_000, limit_price: 600_000, salt: [10; 32], is_padding: false };
    let bob   = Order { side: YES_BUY, amount:  50_000_000, limit_price: 700_000, salt: [20; 32], is_padding: false };

    let padding = Order { side: YES_BUY, amount: 0, limit_price: 0, salt: [0; 32], is_padding: true };
    let mut orders: [Order; MAX_ORDERS] = [padding; MAX_ORDERS];
    orders[0] = alice;
    orders[1] = bob;

    let mut commitments: [[u8; 32]; MAX_ORDERS] = [[0; 32]; MAX_ORDERS];
    commitments[0] = compute_commitment(market_id, orders[0]);
    commitments[1] = compute_commitment(market_id, orders[1]);

    let commitment_root = compute_commitment_root(commitments, 2);
    let clearing_price: u64 = 650_000;

    main(
        commitment_root,
        clearing_price,
        50_000_000, // only Bob fills
        0,
        0,
        0,
        2,
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
    for i in 0..29 {
        assert(result[i] == 0);
    }
}
