import { describe, expect, it, vi } from "vitest";
import { awaitDepositWalletFunding } from "./depositWalletFundingGate.js";

const wallet = "0x0000000000000000000000000000000000000001" as const;
const exchange = "0x0000000000000000000000000000000000000002" as const;
const options = { wallet, exchange, startingBalance: 500_000n, incomingAmount: 1_000_000n,
  orderAmount: 1_000_000n, maxAttempts: 3, pollIntervalMs: 0 };

describe("Deposit Wallet funding gate", () => {
  it("waits for on-chain funds before refreshing the CLOB cache", async () => {
    const readOnChainBalance = vi.fn()
      .mockResolvedValueOnce(500_000n)
      .mockResolvedValueOnce(1_500_000n);
    const refreshClobBalance = vi.fn(async () => ({
      balance: 1_500_000n, allowances: { [exchange]: 1_500_000n },
    }));
    await awaitDepositWalletFunding(options, { readOnChainBalance, refreshClobBalance, sleep: async () => {} });
    expect(readOnChainBalance).toHaveBeenCalledTimes(2);
    expect(refreshClobBalance).toHaveBeenCalledOnce();
  });

  it("does not accept an empty refresh response or stale CLOB balance", async () => {
    const refreshClobBalance = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ balance: "500000", allowances: { [exchange]: "1500000" } })
      .mockResolvedValueOnce({ balance: "1500000", allowances: { [exchange]: "1500000" } });
    await awaitDepositWalletFunding(options, {
      readOnChainBalance: async () => 1_500_000n, refreshClobBalance, sleep: async () => {},
    });
    expect(refreshClobBalance).toHaveBeenCalledTimes(3);
  });

  it("requires the actual exchange allowance", async () => {
    await expect(awaitDepositWalletFunding({ ...options, maxAttempts: 1 }, {
      readOnChainBalance: async () => 1_500_000n,
      refreshClobBalance: async () => ({ balance: 1_500_000n, allowances: { [wallet]: 1_500_000n } }),
    })).rejects.toThrow(/do not submit/);
  });

  it("fails closed when the transfer never lands", async () => {
    const refreshClobBalance = vi.fn();
    await expect(awaitDepositWalletFunding(options, {
      readOnChainBalance: async () => 500_000n,
      refreshClobBalance, sleep: async () => {},
    })).rejects.toThrow(/do not submit/);
    expect(refreshClobBalance).not.toHaveBeenCalled();
  });

  it("rejects impossible spend bounds", async () => {
    await expect(awaitDepositWalletFunding({ ...options, orderAmount: 2_000_000n }, {
      readOnChainBalance: async () => 2_000_000n,
      refreshClobBalance: async () => ({ balance: 2_000_000n, allowances: { [exchange]: 2_000_000n } }),
    })).rejects.toThrow(/bounds/);
  });
});
