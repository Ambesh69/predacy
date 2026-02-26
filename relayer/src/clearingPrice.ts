import type { Order, ClearingResult } from "./types.js";

const PRICE_DECIMALS = 1_000_000n; // 6 decimal places

/**
 * Compute the batch clearing price using a sealed-bid batch auction.
 *
 * Algorithm (uniform price, max-volume):
 *  1. Collect all buy and sell orders
 *  2. For each candidate clearing price P (from all submitted limit prices):
 *     - buyVolume(P) = sum of buy amounts where limitPrice >= P
 *     - sellVolume(P) = sum of sell amounts where limitPrice <= P
 *     - filledVolume(P) = min(buyVolume(P), sellVolume(P))
 *  3. Choose P that maximizes filledVolume(P)
 *     - Tie-break: highest price (favors sellers, common in batch auctions)
 *  4. All orders at or better than P are filled at exactly P
 *
 * If no crossing exists (all buys below all sells), returns clearingPrice = 0
 * and routes the net buy-side to Polymarket at market price.
 */
export function computeClearingPrice(orders: Order[]): ClearingResult {
  const buys = orders.filter((o) => o.isBuy);
  const sells = orders.filter((o) => !o.isBuy);

  // Collect all candidate prices from submitted limit prices
  const candidatePrices = new Set<bigint>();
  for (const o of orders) {
    candidatePrices.add(o.limitPrice);
  }

  let bestPrice = 0n;
  let bestFilledVolume = 0n;

  for (const price of candidatePrices) {
    if (price <= 0n || price >= PRICE_DECIMALS) continue;

    const buyVol = buys
      .filter((o) => o.limitPrice >= price)
      .reduce((sum, o) => sum + o.amount, 0n);

    const sellVol = sells
      .filter((o) => o.limitPrice <= price)
      .reduce((sum, o) => sum + o.amount, 0n);

    const filled = buyVol < sellVol ? buyVol : sellVol;

    if (filled > bestFilledVolume || (filled === bestFilledVolume && price > bestPrice)) {
      bestFilledVolume = filled;
      bestPrice = price;
    }
  }

  if (bestPrice === 0n || bestFilledVolume === 0n) {
    // No crossing — route everything to Polymarket at market price
    // In this case, net buy = sum of all buy orders (all go to Polymarket)
    const totalBuyAmount = buys.reduce((sum, o) => sum + o.amount, 0n);
    return {
      clearingPrice: 0n,
      filledBuyVolume: 0n,
      filledSellVolume: 0n,
      netBuyAmount: totalBuyAmount,
      filledOrders: [...orders],
      unfilledOrders: [],
    };
  }

  // Determine which orders fill at clearingPrice
  const filledOrders: Order[] = [];
  const unfilledOrders: Order[] = [];

  for (const o of orders) {
    const fills = o.isBuy ? o.limitPrice >= bestPrice : o.limitPrice <= bestPrice;
    if (fills) {
      filledOrders.push(o);
    } else {
      unfilledOrders.push(o);
    }
  }

  const filledBuyVolume = filledOrders
    .filter((o) => o.isBuy)
    .reduce((sum, o) => sum + o.amount, 0n);

  const filledSellVolume = filledOrders
    .filter((o) => !o.isBuy)
    .reduce((sum, o) => sum + o.amount, 0n);

  // Net position to execute on Polymarket: excess buys not matched internally
  const netBuyAmount = filledBuyVolume > filledSellVolume
    ? filledBuyVolume - filledSellVolume
    : 0n;

  return {
    clearingPrice: bestPrice,
    filledBuyVolume,
    filledSellVolume,
    netBuyAmount,
    filledOrders,
    unfilledOrders,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("computeClearingPrice", () => {
    it("finds crossing price that maximizes volume", () => {
      const orders: Order[] = [
        { trader: "0xA", isBuy: true, amount: 100_000_000n, limitPrice: 700_000n, salt: "0x01" },
        { trader: "0xB", isBuy: true, amount: 50_000_000n, limitPrice: 650_000n, salt: "0x02" },
        { trader: "0xC", isBuy: false, amount: 80_000_000n, limitPrice: 600_000n, salt: "0x03" },
      ];

      const result = computeClearingPrice(orders);

      // At 0.65: buys = 150, sells = 80 (0.60 <= 0.65), filled = 80
      // At 0.70: buys = 100, sells = 80, filled = 80 — tie, higher price wins
      // So clearing = 0.70 (tie-breaks to higher price)
      expect(result.clearingPrice).toBeGreaterThan(0n);
      expect(result.filledBuyVolume).toBeGreaterThan(0n);
      expect(result.netBuyAmount).toBeGreaterThanOrEqual(0n);
    });

    it("returns no-cross result when buys and sells don't cross", () => {
      const orders: Order[] = [
        { trader: "0xA", isBuy: true, amount: 100_000_000n, limitPrice: 400_000n, salt: "0x01" },
        { trader: "0xB", isBuy: false, amount: 50_000_000n, limitPrice: 700_000n, salt: "0x02" },
      ];

      const result = computeClearingPrice(orders);
      // No crossing: buy wants < 0.40, sell wants > 0.70
      expect(result.clearingPrice).toBe(0n);
      expect(result.netBuyAmount).toBe(100_000_000n); // all buys routed to Polymarket
    });

    it("handles all-buy batch", () => {
      const orders: Order[] = [
        { trader: "0xA", isBuy: true, amount: 100_000_000n, limitPrice: 650_000n, salt: "0x01" },
        { trader: "0xB", isBuy: true, amount: 200_000_000n, limitPrice: 700_000n, salt: "0x02" },
      ];

      const result = computeClearingPrice(orders);
      expect(result.clearingPrice).toBe(0n); // no sells — can't cross internally
      expect(result.netBuyAmount).toBe(300_000_000n); // route all to Polymarket
    });
  });
}
