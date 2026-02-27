/// <reference types="vitest/importMeta" />
import type { Order, ClearingResult } from "./types.js";

const PRICE_DECIMALS = 1_000_000n; // 6 decimal places

/**
 * Compute the batch clearing price using a sealed-bid batch auction.
 *
 * Order types:
 *   isBuy=true  → buy YES: amount in USDC
 *   isBuy=false → sell YES: amount in YES tokens
 *
 * Algorithm (uniform price, max-volume):
 *  1. Collect all buy and sell orders
 *  2. For each candidate clearing price P (from all submitted limit prices):
 *     - buyVol(P)      = Σ buy.amount where buy.limitPrice >= P            (USDC)
 *     - sellVolUSDC(P) = Σ sell.amount * P / 1e6 where sell.limitPrice <= P (YES→USDC equiv)
 *     - filledVol(P)   = min(buyVol(P), sellVolUSDC(P))
 *  3. Choose P that maximizes filledVol(P)
 *     - Tie-break: highest price (favors sellers, common in batch auctions)
 *  4. All orders at or better than P are filled at exactly P
 *
 * If no crossing exists, returns clearingPrice = 0 and routes all buys to Polymarket.
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

    // Sell orders have amount in YES tokens; convert to USDC-equivalent at this price
    const sellVolUSDC = sells
      .filter((o) => o.limitPrice <= price)
      .reduce((sum, o) => sum + o.amount * price / PRICE_DECIMALS, 0n);

    const filled = buyVol < sellVolUSDC ? buyVol : sellVolUSDC;

    if (filled > bestFilledVolume || (filled === bestFilledVolume && price > bestPrice)) {
      bestFilledVolume = filled;
      bestPrice = price;
    }
  }

  if (bestPrice === 0n || bestFilledVolume === 0n) {
    // No crossing — route everything to Polymarket at market price
    const totalBuyAmount = buys.reduce((sum, o) => sum + o.amount, 0n);
    return {
      clearingPrice: 0n,
      filledBuyVolume: 0n,
      filledSellVolume: 0n,
      filledSellYes: 0n,
      netBuyAmount: totalBuyAmount,
      netSellYes: 0n,
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

  // filledSellYes: raw YES token count from filled sell orders
  const filledSellYes = filledOrders
    .filter((o) => !o.isBuy)
    .reduce((sum, o) => sum + o.amount, 0n);

  // filledSellVolume: same as filledSellYes (YES tokens) — passed as totalSellVol to contract
  const filledSellVolume = filledSellYes;

  // Net USDC to route to Polymarket: buy vol minus USDC-equivalent of sell vol
  const filledSellUSDC = filledSellYes * bestPrice / PRICE_DECIMALS;
  const netBuyAmount = filledBuyVolume > filledSellUSDC
    ? filledBuyVolume - filledSellUSDC
    : 0n;

  return {
    clearingPrice: bestPrice,
    filledBuyVolume,
    filledSellVolume,
    filledSellYes,
    netBuyAmount,
    netSellYes: 0n, // internal crossing is always net-buy; net-sell only arises from Polymarket-anchored price
    filledOrders,
    unfilledOrders,
  };
}

/**
 * Given an externally-supplied clearing price (e.g. from Polymarket mid-price),
 * compute fill volumes and net positions for settlement.
 *
 * Used when effectiveClearingPrice differs from the internal crossing price
 * (e.g. sell-only or all-buy batches where price comes from Polymarket).
 */
export function computeFillsAtPrice(orders: Order[], price: bigint): {
  filledBuyVolume: bigint;
  filledSellYes: bigint;
  netBuyAmount: bigint;
  netSellYes: bigint;
} {
  const PRICE_DECIMALS = 1_000_000n;
  let filledBuyVolume = 0n;
  let filledSellYes = 0n;

  for (const o of orders) {
    if (o.isBuy && o.limitPrice >= price) {
      filledBuyVolume += o.amount;
    } else if (!o.isBuy && o.limitPrice <= price) {
      filledSellYes += o.amount;
    }
  }

  const filledSellUSDC = filledSellYes * price / PRICE_DECIMALS;
  const netBuyAmount  = filledBuyVolume > filledSellUSDC ? filledBuyVolume - filledSellUSDC : 0n;
  const netSellUSDC   = filledSellUSDC > filledBuyVolume ? filledSellUSDC - filledBuyVolume : 0n;

  // Convert net-sell USDC back to YES tokens using ceiling division to avoid under-selling.
  // Round-trip truncation (YES→USDC→YES) can understate netSellYes by 1, causing mockSellYes
  // to mint 1 less USDC than claimPosition owes the seller → revert on transfer.
  // Ceiling ensures vault always receives enough USDC to cover every filled sell order.
  // Special case: when there are no buyers at all, netSellYes == filledSellYes exactly.
  const netSellYes = filledBuyVolume === 0n
    ? filledSellYes
    : price > 0n
      ? (netSellUSDC * PRICE_DECIMALS + price - 1n) / price  // ceiling division
      : 0n;

  return { filledBuyVolume, filledSellYes, netBuyAmount, netSellYes };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("computeClearingPrice", () => {
    it("finds crossing price that maximizes volume", () => {
      const orders: Order[] = [
        { trader: "0xA", isBuy: true,  amount: 100_000_000n, limitPrice: 700_000n, salt: "0x01" },
        { trader: "0xB", isBuy: true,  amount:  50_000_000n, limitPrice: 650_000n, salt: "0x02" },
        // Carol sells 80 YES tokens at min 0.60
        { trader: "0xC", isBuy: false, amount:  80_000_000n, limitPrice: 600_000n, salt: "0x03" },
      ];

      const result = computeClearingPrice(orders);

      // At 0.65: buyVol=150, sellVolUSDC=80*0.65=52, filled=52
      // At 0.70: buyVol=100, sellVolUSDC=80*0.70=56, filled=56 — higher, wins
      expect(result.clearingPrice).toBe(700_000n);
      expect(result.filledBuyVolume).toBe(100_000_000n);
      expect(result.filledSellYes).toBe(80_000_000n);
      // netBuy = 100 - 80*0.70 = 100 - 56 = 44
      expect(result.netBuyAmount).toBe(44_000_000n);
    });

    it("returns no-cross result when buys and sells don't cross", () => {
      const orders: Order[] = [
        { trader: "0xA", isBuy: true,  amount: 100_000_000n, limitPrice: 400_000n, salt: "0x01" },
        { trader: "0xB", isBuy: false, amount:  50_000_000n, limitPrice: 700_000n, salt: "0x02" },
      ];

      const result = computeClearingPrice(orders);
      // No crossing: buy wants < 0.40, sell wants > 0.70
      expect(result.clearingPrice).toBe(0n);
      expect(result.netBuyAmount).toBe(100_000_000n); // all buys routed to Polymarket
      expect(result.filledSellYes).toBe(0n);
    });

    it("handles all-buy batch", () => {
      const orders: Order[] = [
        { trader: "0xA", isBuy: true, amount: 100_000_000n, limitPrice: 650_000n, salt: "0x01" },
        { trader: "0xB", isBuy: true, amount: 200_000_000n, limitPrice: 700_000n, salt: "0x02" },
      ];

      const result = computeClearingPrice(orders);
      expect(result.clearingPrice).toBe(0n); // no sells — can't cross internally
      expect(result.netBuyAmount).toBe(300_000_000n); // route all to Polymarket
      expect(result.filledSellYes).toBe(0n);
    });

    it("computes netBuyAmount correctly with partial internal match", () => {
      // Buy 100 USDC, sell 60 YES at 0.65 clearing
      // filledSellUSDC = 60 * 0.65 = 39, netBuy = 100 - 39 = 61
      const orders: Order[] = [
        { trader: "0xA", isBuy: true,  amount: 100_000_000n, limitPrice: 700_000n, salt: "0x01" },
        { trader: "0xB", isBuy: false, amount:  60_000_000n, limitPrice: 600_000n, salt: "0x02" },
      ];
      const result = computeClearingPrice(orders);
      expect(result.clearingPrice).toBeGreaterThan(0n);
      expect(result.filledSellYes).toBe(60_000_000n);
      const expectedNetBuy = result.filledBuyVolume - result.filledSellYes * result.clearingPrice / 1_000_000n;
      expect(result.netBuyAmount).toBe(expectedNetBuy);
    });
  });
}
