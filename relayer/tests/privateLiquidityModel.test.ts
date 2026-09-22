import { describe, expect, it } from "vitest";
import { admitTrade, aggregateFlow, inventoryBound, publicEpoch, simulateInventoryEpoch,
  type ModelTrade, type PublicHedge } from "../research/privateLiquidityModel.js";

const buy = (token: string, shares: bigint, cash = shares): ModelTrade => ({ token, direction: "buy", shares, cash });

describe("offline privacy-mechanism falsification model (not cryptographic proof)", () => {
  it("reproduces the two-participant subtraction attack", () => {
    const own = buy("A:NO", 7n);
    const other = buy("A:NO", 13n);
    const disclosed = aggregateFlow([own, other])[0].netShares;
    expect(disclosed - own.shares).toBe(other.shares);
  });

  it("shows larger batches do not stop all-but-one collusion", () => {
    const known = Array.from({ length: 31 }, (_, i) => buy("A:YES", BigInt(i + 1)));
    const total = aggregateFlow([...known, buy("A:YES", 73n)])[0].netShares;
    expect(total - known.reduce((sum, order) => sum + order.shares, 0n)).toBe(73n);
  });

  it("shows fixed hedge time still leaks private market and quantity", () => {
    const atFixedTime = (flow: ModelTrade[]) => ({ epoch: 1, hedges: aggregateFlow(flow) });
    expect(atFixedTime([buy("A:NO", 10n)])).not.toEqual(atFixedTime([buy("B:YES", 3n)]));
  });

  it("keeps modeled public metadata equal under a flow-independent plan", () => {
    const plan: PublicHedge[] = [{ epoch: 1, ...buy("A:NO", 5n) }];
    const initial = { cash: 100n, inventory: { "A:NO": 100n, "B:YES": 100n } };
    const left = simulateInventoryEpoch(initial, [buy("A:NO", 10n)], plan, 1, 32);
    const right = simulateInventoryEpoch(initial, [buy("B:YES", 3n)], plan, 1, 32);
    expect(left.private.receipts).toEqual([true]);
    expect(right.private.receipts).toEqual([true]);
    expect(left.private.state).not.toEqual(right.private.state);
    // The model intentionally grants the observer no access to either reserve state.
    expect(left.public).toEqual(right.public);
    expect(simulateInventoryEpoch(initial, [], plan, 1, 32).public).toEqual(left.public);
    expect(simulateInventoryEpoch(initial, [buy("A:NO", 101n)], plan, 1, 32).public).toEqual(left.public);
    expect(initial.inventory["A:NO"]).toBe(100n);
  });

  it("makes finite inventory exhaustion explicit without inventing a reactive hedge", () => {
    const plan: PublicHedge[] = [];
    let state = { cash: 0n, inventory: { "A:NO": 10n } };
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      const result = admitTrade(state, buy("A:NO", 1n));
      state = result.next as typeof state;
      if (result.accepted) accepted++;
    }
    expect(accepted).toBe(10);
    expect(state.cash).toBe(10n);
    expect(state.inventory["A:NO"]).toBe(0n);
    expect(publicEpoch(plan, 1, 32).hedges).toEqual([]);
  });

  it("demonstrates that exposing LP inventory reveals net customer flow", () => {
    const initial = { cash: 0n, inventory: { "A:NO": 100n } };
    const result = admitTrade(initial, buy("A:NO", 13n));
    expect(initial.inventory["A:NO"] - result.next.inventory["A:NO"]).toBe(13n);
  });

  it("demonstrates the capacity-probing side channel even with hidden balances", () => {
    const probe = buy("A:NO", 95n);
    const before = { cash: 0n, inventory: { "A:NO": 100n } };
    const after = admitTrade(before, buy("A:NO", 10n)).next;
    expect(admitTrade(before, probe).accepted).toBe(true);
    expect(admitTrade(after, probe).accepted).toBe(false);
  });

  it("requires actual cash for internal sells rather than user subsidy", () => {
    const sell: ModelTrade = { token: "A:NO", direction: "sell", shares: 5n, cash: 4n };
    expect(admitTrade({ cash: 3n, inventory: {} }, sell).accepted).toBe(false);
    expect(admitTrade({ cash: 4n, inventory: {} }, sell)).toEqual({ accepted: true,
      next: { cash: 0n, inventory: { "A:NO": 5n } } });
  });

  it("accounts separately for inventory quantity and sell cash", () => {
    expect(inventoryBound(20, 100n, 500n)).toEqual({ totalShares: 2_000n, sellCashBuffer: 500n });
    expect(() => inventoryBound(0, 1n, 1n)).toThrow();
    expect(() => publicEpoch([], -1, 32)).toThrow();
    expect(() => admitTrade({ cash: 0n, inventory: {} }, buy("A:NO", -1n))).toThrow();
  });
});
