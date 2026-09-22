import { describe, expect, it } from "vitest";
import { planV11SingleOrderReturn, type V11WalletBalances } from "./v11SingleOrderAllocation.js";
import type { Side } from "./settlementAccounting.js";

const zero: V11WalletBalances = { pusd: 0n, yes: 0n, no: 0n };

function plan(side: Side, deposit: bigint, after: V11WalletBalances, trades: number) {
  const filledShares = side === "YES_BUY" ? after.yes
    : side === "NO_BUY" ? after.no
    : side === "YES_SELL" ? deposit - after.yes : deposit - after.no;
  return planV11SingleOrderReturn({
    side, deposit, limitPrice: 600_000n, walletBeforeRoute: zero,
    walletAfterTerminalOrder: after, terminalOrderConfirmed: true,
    confirmedTradeCount: trades, matchedShares: filledShares,
  });
}

describe("v11 isolated one-order allocation", () => {
  it("accounts for a partial NO buy and exact USDC refund", () => {
    const result = plan("NO_BUY", 410_000n, { pusd: 5_000n, yes: 0n, no: 1_000_000n }, 1);
    expect(result.allocation).toMatchObject({ filledShares: 1_000_000n, usdcPayout: 405_000n, refund: 5_000n });
    expect(result.returnPusd).toBe(5_000n);
    expect(result.returnNo).toBe(1_000_000n);
  });

  it("accounts for a partial YES sell and unsold-share refund", () => {
    const result = plan("YES_SELL", 1_000_000n, { pusd: 300_000n, yes: 500_000n, no: 0n }, 1);
    expect(result.allocation).toMatchObject({ filledShares: 500_000n, usdcPayout: 300_000n, refund: 500_000n });
    expect(result.returnYes).toBe(500_000n);
  });

  it("refunds a rejected or no-fill buy and sell without inventing a trade", () => {
    expect(plan("YES_BUY", 500_000n, { pusd: 500_000n, yes: 0n, no: 0n }, 0).allocation)
      .toMatchObject({ filledShares: 0n, usdcPayout: 0n, refund: 500_000n });
    expect(plan("NO_SELL", 1_000_000n, { pusd: 0n, yes: 0n, no: 1_000_000n }, 0).allocation)
      .toMatchObject({ filledShares: 0n, usdcPayout: 0n, refund: 1_000_000n });
  });

  it("rejects mixed wallet balances, missing terminality and unproven fills", () => {
    const valid = {
      side: "YES_BUY" as const, deposit: 500_000n, limitPrice: 600_000n,
      walletBeforeRoute: zero, walletAfterTerminalOrder: { pusd: 200_000n, yes: 500_000n, no: 0n },
      terminalOrderConfirmed: true, confirmedTradeCount: 1, matchedShares: 500_000n,
    };
    expect(() => planV11SingleOrderReturn({ ...valid, walletBeforeRoute: { ...zero, pusd: 1n } }))
      .toThrow(/isolated Deposit Wallet/);
    expect(() => planV11SingleOrderReturn({ ...valid, terminalOrderConfirmed: false }))
      .toThrow(/terminal CLOB evidence/);
    expect(() => planV11SingleOrderReturn({ ...valid, confirmedTradeCount: 0 }))
      .toThrow(/disagree/);
    expect(() => planV11SingleOrderReturn({ ...valid, matchedShares: 400_000n }))
      .toThrow(/disagree/);
    expect(() => planV11SingleOrderReturn({ ...valid, walletAfterTerminalOrder: { ...valid.walletAfterTerminalOrder, no: 1n } }))
      .toThrow(/solely/);
  });

  it("refuses an execution that crosses the user's all-in limit", () => {
    expect(() => plan("YES_BUY", 650_000n, { pusd: 0n, yes: 1_000_000n, no: 0n }, 1))
      .toThrow(/limit/);
  });
});
