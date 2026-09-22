import type { V12BuyFill } from "./v12BuyBatchProver.js";

export interface PrivateBuyOrderBounds { deposit: bigint; limitPrice: bigint }

const PRICE_SCALE = 1_000_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/**
 * Deterministically divides one aggregate Deposit Wallet fill across at most two
 * private orders. Spend and shares are proportional to escrow, then shares are
 * shifted only as needed to satisfy each hidden limit exactly.
 */
export function allocateV12BuyFill(
  orders: PrivateBuyOrderBounds[],
  totalSpent: bigint,
  totalShares: bigint,
): V12BuyFill[] {
  if (orders.length < 1 || orders.length > 2 || totalSpent < 0n || totalShares < 0n ||
      (totalSpent === 0n) !== (totalShares === 0n)) {
    throw new Error("Invalid v12 aggregate fill");
  }
  const totalDeposit = orders.reduce((sum, order) => sum + order.deposit, 0n);
  if (orders.some((order) => order.deposit <= 0n || order.limitPrice <= 0n || order.limitPrice >= PRICE_SCALE) ||
      totalSpent > totalDeposit) {
    throw new Error("Invalid v12 private order bounds");
  }
  if (totalSpent === 0n) return orders.map(() => ({ spent: 0n, shares: 0n }));

  const spent = orders.map((order, index) => index === orders.length - 1
    ? 0n : totalSpent * order.deposit / totalDeposit);
  spent[spent.length - 1] = totalSpent - spent.slice(0, -1).reduce((sum, value) => sum + value, 0n);
  if (spent.some((value, index) => value > orders[index].deposit)) {
    throw new Error("V12 proportional spend exceeds an order deposit");
  }

  const shares = spent.map((value, index) => index === spent.length - 1
    ? 0n : totalShares * value / totalSpent);
  shares[shares.length - 1] = totalShares - shares.slice(0, -1).reduce((sum, value) => sum + value, 0n);
  const minimum = spent.map((value, index) => ceilDiv(value * PRICE_SCALE, orders[index].limitPrice));
  if (minimum.reduce((sum, value) => sum + value, 0n) > totalShares) {
    throw new Error("Aggregate fill cannot satisfy every hidden v12 limit after rounding");
  }

  for (let receiver = 0; receiver < shares.length; receiver++) {
    let needed = minimum[receiver] - shares[receiver];
    if (needed <= 0n) continue;
    for (let donor = 0; donor < shares.length && needed > 0n; donor++) {
      if (donor === receiver) continue;
      const available = shares[donor] - minimum[donor];
      const moved = available > needed ? needed : available;
      if (moved > 0n) {
        shares[donor] -= moved;
        shares[receiver] += moved;
        needed -= moved;
      }
    }
    if (needed > 0n) throw new Error("V12 share allocation is infeasible");
  }

  const fills = spent.map((value, index) => ({ spent: value, shares: shares[index] }));
  if (fills.some((fill, index) => (fill.spent === 0n) !== (fill.shares === 0n) ||
      fill.spent * PRICE_SCALE > fill.shares * orders[index].limitPrice)) {
    throw new Error("V12 allocation violates a private order");
  }
  return fills;
}

export function aggregateV12BuyLimit(orders: PrivateBuyOrderBounds[]): bigint {
  if (!orders.length) throw new Error("V12 batch has no orders");
  return orders.reduce((limit, order) => order.limitPrice < limit ? order.limitPrice : limit, orders[0].limitPrice);
}
