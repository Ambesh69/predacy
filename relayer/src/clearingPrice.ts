/// <reference types="vitest/importMeta" />
import { OrderSide } from "./types.js";
import type { Order, ClearingResult } from "./types.js";

const PRICE_DECIMALS = 1_000_000n; // 6 decimal places

/**
 * Compute the batch clearing price using a 4-sided sealed-bid batch auction.
 *
 * Order types:
 *   YES_BUY  — pay USDC for YES tokens:  amount in USDC, limitPrice = max YES price
 *   YES_SELL — sell YES for USDC:         amount in YES tokens, limitPrice = min YES price
 *   NO_BUY   — pay USDC for NO tokens:   amount in USDC, limitPrice = max NO price
 *   NO_SELL  — sell NO for USDC:          amount in NO tokens, limitPrice = min NO price
 *
 * At clearing price P (YES price, 6-decimal):
 *   noPrice = 1_000_000 - P
 *   YES_BUY  fills when order.limitPrice >= P       (willing to pay at most limitPrice per YES)
 *   YES_SELL fills when order.limitPrice <= P       (willing to accept at least limitPrice per YES)
 *   NO_BUY   fills when order.limitPrice >= noPrice (willing to pay at most limitPrice per NO)
 *   NO_SELL  fills when order.limitPrice <= noPrice (willing to accept at least limitPrice per NO)
 *
 * Algorithm (uniform price, max-volume):
 *  1. Candidate prices: all YES limit prices + complements of all NO limit prices
 *  2. For each candidate P:
 *     - totalBuyUSDC  = yesBuyVol(P) + noBuyVol(P)
 *     - totalSellUSDC = yesSellUSDC(P) + noSellUSDC(P)
 *     - filledVol(P)  = min(totalBuyUSDC, totalSellUSDC)
 *  3. Choose P that maximises filledVol(P)
 *     - Tie-break: highest price (slight seller favoritism, common in batch auctions)
 *
 * If no internal crossing exists (filledVol = 0), returns clearingPrice = 0 so
 * batchProcessor anchors to Polymarket mid-price for price discovery.
 *
 * Note: YES and NO buyers can always cross with each other via CTF.splitPosition
 * (the vault's own USDC). This min(buy, sell) objective biases toward batches with
 * internal sell-side liquidity; the gap is covered by the relayer CLOB fill in
 * processBatch (much smaller than v7.3 now that split/merge handle balanced batches).
 */
export function computeClearingPrice(orders: Order[]): ClearingResult {
  const yesBuys  = orders.filter((o) => o.side === OrderSide.YES_BUY);
  const yesSells = orders.filter((o) => o.side === OrderSide.YES_SELL);
  const noBuys   = orders.filter((o) => o.side === OrderSide.NO_BUY);
  const noSells  = orders.filter((o) => o.side === OrderSide.NO_SELL);

  // Candidate prices: all YES/SELL limit prices + complements of all NO limit prices
  const candidatePrices = new Set<bigint>();
  for (const o of orders) {
    if (o.side === OrderSide.YES_BUY || o.side === OrderSide.YES_SELL) {
      candidatePrices.add(o.limitPrice);
    } else {
      // NO_BUY / NO_SELL: limitPrice is a NO price → convert to YES equivalent
      candidatePrices.add(PRICE_DECIMALS - o.limitPrice);
    }
  }

  let bestPrice = 0n;
  let bestFilledVolume = 0n;

  for (const price of candidatePrices) {
    if (price <= 0n || price >= PRICE_DECIMALS) continue;
    const noPrice = PRICE_DECIMALS - price;

    // USDC provided by eligible buyers at this price
    const yesBuyVol = yesBuys
      .filter((o) => o.limitPrice >= price)
      .reduce((sum, o) => sum + o.amount, 0n);
    const noBuyVol  = noBuys
      .filter((o) => o.limitPrice >= noPrice)
      .reduce((sum, o) => sum + o.amount, 0n);

    // USDC-equivalent received by eligible sellers at this price
    const yesSellUSDC = yesSells
      .filter((o) => o.limitPrice <= price)
      .reduce((sum, o) => sum + (o.amount * price) / PRICE_DECIMALS, 0n);
    const noSellUSDC  = noSells
      .filter((o) => o.limitPrice <= noPrice)
      .reduce((sum, o) => sum + (o.amount * noPrice) / PRICE_DECIMALS, 0n);

    const totalBuy  = yesBuyVol + noBuyVol;
    const totalSell = yesSellUSDC + noSellUSDC;
    const filled    = totalBuy < totalSell ? totalBuy : totalSell;

    if (filled > bestFilledVolume || (filled === bestFilledVolume && price > bestPrice)) {
      bestFilledVolume = filled;
      bestPrice = price;
    }
  }

  if (bestPrice === 0n || bestFilledVolume === 0n) {
    // No internal crossing — price will come from Polymarket (batchProcessor anchors to mid)
    return {
      clearingPrice:    0n,
      filledYesBuyVol:  0n,
      filledNoBuyVol:   0n,
      filledYesSellQty: 0n,
      filledNoSellQty:  0n,
      filledOrders:     [...orders], // all orders "pending" — re-evaluated at effectiveClearingPrice
      unfilledOrders:   [],
    };
  }

  // Assign fills at the best crossing price
  const noPrice = PRICE_DECIMALS - bestPrice;
  const filledOrders: Order[]   = [];
  const unfilledOrders: Order[] = [];

  for (const o of orders) {
    let fills: boolean;
    if      (o.side === OrderSide.YES_BUY)  fills = o.limitPrice >= bestPrice;
    else if (o.side === OrderSide.YES_SELL) fills = o.limitPrice <= bestPrice;
    else if (o.side === OrderSide.NO_BUY)   fills = o.limitPrice >= noPrice;
    else                                     fills = o.limitPrice <= noPrice; // NO_SELL

    if (fills) filledOrders.push(o);
    else        unfilledOrders.push(o);
  }

  const filledYesBuyVol  = filledOrders.filter((o) => o.side === OrderSide.YES_BUY) .reduce((s, o) => s + o.amount, 0n);
  const filledNoBuyVol   = filledOrders.filter((o) => o.side === OrderSide.NO_BUY)  .reduce((s, o) => s + o.amount, 0n);
  const filledYesSellQty = filledOrders.filter((o) => o.side === OrderSide.YES_SELL).reduce((s, o) => s + o.amount, 0n);
  const filledNoSellQty  = filledOrders.filter((o) => o.side === OrderSide.NO_SELL) .reduce((s, o) => s + o.amount, 0n);

  return {
    clearingPrice: bestPrice,
    filledYesBuyVol,
    filledNoBuyVol,
    filledYesSellQty,
    filledNoSellQty,
    filledOrders,
    unfilledOrders,
  };
}

/**
 * Given an externally-supplied clearing price (e.g. from Polymarket mid-price),
 * compute fill volumes for all 4 order types.
 *
 * Used when there is no internal crossing (all-buy, all-sell, or no-crossing batches)
 * and batchProcessor uses the Polymarket price for settlement.
 */
export function computeFillsAtPrice(orders: Order[], price: bigint): {
  filledYesBuyVol:  bigint;
  filledNoBuyVol:   bigint;
  filledYesSellQty: bigint;
  filledNoSellQty:  bigint;
} {
  const noPrice = PRICE_DECIMALS - price;

  let filledYesBuyVol  = 0n;
  let filledNoBuyVol   = 0n;
  let filledYesSellQty = 0n;
  let filledNoSellQty  = 0n;

  for (const o of orders) {
    if      (o.side === OrderSide.YES_BUY  && o.limitPrice >= price)   filledYesBuyVol  += o.amount;
    else if (o.side === OrderSide.NO_BUY   && o.limitPrice >= noPrice)  filledNoBuyVol   += o.amount;
    else if (o.side === OrderSide.YES_SELL && o.limitPrice <= price)    filledYesSellQty += o.amount;
    else if (o.side === OrderSide.NO_SELL  && o.limitPrice <= noPrice)  filledNoSellQty  += o.amount;
  }

  return { filledYesBuyVol, filledNoBuyVol, filledYesSellQty, filledNoSellQty };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("computeClearingPrice (4-sided)", () => {
    it("finds crossing price that maximises YES_BUY ↔ YES_SELL volume", () => {
      const orders: Order[] = [
        { trader: "0xA" as `0x${string}`, side: OrderSide.YES_BUY,  amount: 100_000_000n, limitPrice: 700_000n, salt: "0x01" as `0x${string}` },
        { trader: "0xB" as `0x${string}`, side: OrderSide.YES_BUY,  amount:  50_000_000n, limitPrice: 650_000n, salt: "0x02" as `0x${string}` },
        // Carol sells 80 YES tokens at min 0.60
        { trader: "0xC" as `0x${string}`, side: OrderSide.YES_SELL, amount:  80_000_000n, limitPrice: 600_000n, salt: "0x03" as `0x${string}` },
      ];

      const result = computeClearingPrice(orders);

      // At 0.65: yesBuyVol=150, yesSellUSDC=80*0.65=52, filled=min(150,52)=52
      // At 0.70: yesBuyVol=100, yesSellUSDC=80*0.70=56, filled=min(100,56)=56 — higher, wins
      expect(result.clearingPrice).toBe(700_000n);
      expect(result.filledYesBuyVol).toBe(100_000_000n);
      expect(result.filledYesSellQty).toBe(80_000_000n);
      expect(result.filledNoBuyVol).toBe(0n);
      expect(result.filledNoSellQty).toBe(0n);
    });

    it("returns no-cross result when buys and sells don't cross", () => {
      const orders: Order[] = [
        { trader: "0xA" as `0x${string}`, side: OrderSide.YES_BUY,  amount: 100_000_000n, limitPrice: 400_000n, salt: "0x01" as `0x${string}` },
        { trader: "0xB" as `0x${string}`, side: OrderSide.YES_SELL, amount:  50_000_000n, limitPrice: 700_000n, salt: "0x02" as `0x${string}` },
      ];

      const result = computeClearingPrice(orders);
      expect(result.clearingPrice).toBe(0n);
      expect(result.filledYesBuyVol).toBe(0n);
      expect(result.filledYesSellQty).toBe(0n);
    });

    it("handles all-buy batch (no sellers → no internal crossing)", () => {
      const orders: Order[] = [
        { trader: "0xA" as `0x${string}`, side: OrderSide.YES_BUY, amount: 100_000_000n, limitPrice: 650_000n, salt: "0x01" as `0x${string}` },
        { trader: "0xB" as `0x${string}`, side: OrderSide.YES_BUY, amount: 200_000_000n, limitPrice: 700_000n, salt: "0x02" as `0x${string}` },
      ];

      const result = computeClearingPrice(orders);
      expect(result.clearingPrice).toBe(0n); // no sells → price from Polymarket
      expect(result.filledYesBuyVol).toBe(0n);
    });

    it("finds crossing with YES_BUY and NO_SELL (complementary sides)", () => {
      // YES buyer at 0.65 and NO seller at min 0.35 — they agree at a price near 0.65
      // At P=0.65: yesBuyVol=100, noSellUSDC=80*(1-0.35)/1e6... wait
      // NO_SELL.limitPrice=350_000n means they want at least 0.35 per NO token
      // At P=0.65: noPrice=0.35, NO_SELL fills when limitPrice <= noPrice: 350_000 <= 350_000 → fills
      // noSellUSDC = 80 * 0.35 = 28
      // At P=0.65: totalBuy=100, totalSell=0+28=28, filled=28
      const orders: Order[] = [
        { trader: "0xA" as `0x${string}`, side: OrderSide.YES_BUY,  amount: 100_000_000n, limitPrice: 650_000n, salt: "0x01" as `0x${string}` },
        { trader: "0xB" as `0x${string}`, side: OrderSide.NO_SELL,  amount:  80_000_000n, limitPrice: 350_000n, salt: "0x02" as `0x${string}` },
      ];

      const result = computeClearingPrice(orders);
      // At P=0.65: totalBuy=100, totalSell=80*0.35=28, filled=28
      expect(result.clearingPrice).toBe(650_000n);
      expect(result.filledYesBuyVol).toBe(100_000_000n);
      expect(result.filledNoSellQty).toBe(80_000_000n);
    });

    it("handles NO_BUY orders at complementary price", () => {
      // NO buyer wants max 0.40 per NO token → YES price must be ≥ 0.60
      // YES seller wants min 0.60 per YES → price must be ≥ 0.60
      // At P=0.60: noPrice=0.40, NO_BUY fills (0.40 >= 0.40), YES_SELL fills (0.60 <= 0.60)
      const orders: Order[] = [
        { trader: "0xA" as `0x${string}`, side: OrderSide.NO_BUY,   amount: 100_000_000n, limitPrice: 400_000n, salt: "0x01" as `0x${string}` },
        { trader: "0xB" as `0x${string}`, side: OrderSide.YES_SELL, amount: 150_000_000n, limitPrice: 600_000n, salt: "0x02" as `0x${string}` },
      ];

      const result = computeClearingPrice(orders);
      // At P=0.60: noPrice=0.40
      //   noBuyVol=100, yesSellUSDC=150*0.60=90, filled=min(100, 90)=90
      // Candidate prices: 400_000 (NO_BUY complement: 1e6-400_000=600_000) and 600_000 (YES_SELL)
      // Both candidates = 600_000
      expect(result.clearingPrice).toBe(600_000n);
      expect(result.filledNoBuyVol).toBe(100_000_000n);
      expect(result.filledYesSellQty).toBe(150_000_000n);
    });

    it("computeFillsAtPrice handles all 4 sides", () => {
      const orders: Order[] = [
        { trader: "0xA" as `0x${string}`, side: OrderSide.YES_BUY,  amount: 100_000_000n, limitPrice: 700_000n, salt: "0x01" as `0x${string}` },
        { trader: "0xB" as `0x${string}`, side: OrderSide.YES_SELL, amount:  80_000_000n, limitPrice: 600_000n, salt: "0x02" as `0x${string}` },
        { trader: "0xC" as `0x${string}`, side: OrderSide.NO_BUY,   amount:  50_000_000n, limitPrice: 450_000n, salt: "0x03" as `0x${string}` },
        { trader: "0xD" as `0x${string}`, side: OrderSide.NO_SELL,  amount:  60_000_000n, limitPrice: 300_000n, salt: "0x04" as `0x${string}` },
      ];

      // At price 0.65: noPrice = 0.35
      const fills = computeFillsAtPrice(orders, 650_000n);

      // YES_BUY: 700_000 >= 650_000 → fills
      expect(fills.filledYesBuyVol).toBe(100_000_000n);
      // YES_SELL: 600_000 <= 650_000 → fills
      expect(fills.filledYesSellQty).toBe(80_000_000n);
      // NO_BUY: 450_000 >= 350_000 → fills
      expect(fills.filledNoBuyVol).toBe(50_000_000n);
      // NO_SELL: 300_000 <= 350_000 → fills
      expect(fills.filledNoSellQty).toBe(60_000_000n);
    });
  });
}
