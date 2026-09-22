import { describe, expect, it, vi } from "vitest";
import { OrderSide, OrderType, WalletType, type SignedOrder } from "@polymarket/client";
import { prepareV11Order } from "./v11OrderPreparation.js";
import { submitFundedV11OrderOnce, submitV11OrderOnce } from "./v11OrderSubmission.js";
import type { DepositWalletClient } from "./depositWalletClient.js";
import type { V11OrderIntent, V11OrderJournal } from "./v11OrderJournal.js";

const maker = "0x00000000000000000000000000000000000000aa" as const;
const signedBuy = {
  maker,
  tokenId: "123",
  side: OrderSide.BUY,
  orderType: OrderType.FAK,
  signatureType: 3,
  makerAmount: "400000",
  takerAmount: "1000000",
  salt: "1",
  builder: "0x",
  expiration: 0,
  metadata: "0x",
  signer: maker,
  timestamp: "0",
  signature: `0x${"11".repeat(65)}`,
} as unknown as SignedOrder;

class MemoryJournal implements V11OrderJournal {
  intent: V11OrderIntent | null = null;
  async prepare(batchId: string, legId: string, signedOrder: SignedOrder): Promise<V11OrderIntent> {
    if (this.intent && JSON.stringify(this.intent.signedOrder) !== JSON.stringify(signedOrder)) {
      throw new Error("A different signed order already exists");
    }
    this.intent ??= { batchId, legId, state: "prepared", signedOrder, orderId: null, response: null, error: null };
    return this.intent;
  }
  async claimForSubmission(): Promise<V11OrderIntent | null> {
    if (this.intent?.state !== "prepared") return null;
    this.intent.state = "submitting";
    return this.intent;
  }
  async recordAccepted(_batchId: string, _legId: string, orderId: string, response: unknown): Promise<void> {
    if (!this.intent || this.intent.state !== "submitting") throw new Error("wrong state");
    this.intent.state = "accepted";
    this.intent.orderId = orderId;
    this.intent.response = response;
  }
  async recordRejected(_batchId: string, _legId: string, response: unknown): Promise<void> {
    if (!this.intent || this.intent.state !== "submitting") throw new Error("wrong state");
    this.intent.state = "rejected";
    this.intent.response = response;
  }
  async recordUncertain(_batchId: string, _legId: string, error: string): Promise<void> {
    if (!this.intent || this.intent.state !== "submitting") throw new Error("wrong state");
    this.intent.state = "uncertain";
    this.intent.error = error;
  }
  async get(): Promise<V11OrderIntent | null> { return this.intent; }
  async listUnresolved(): Promise<V11OrderIntent[]> {
    return this.intent && ["submitting", "accepted", "uncertain"].includes(this.intent.state) ? [this.intent] : [];
  }
}

describe("v11 signed CLOB order", () => {
  it("caps an all-in buy, validates the Deposit Wallet, and journals the signature", async () => {
    const journal = new MemoryJournal();
    const signer = { createMarketOrder: vi.fn(async () => signedBuy) };
    await prepareV11Order(journal, signer, {
      batchId: "1", legId: "0", tokenId: 123n, side: "BUY",
      escrowAmount: 410_000n, limitPrice: 420_000n, priceTick: 10_000n, expectedMaker: maker,
    });
    expect(signer.createMarketOrder).toHaveBeenCalledWith({
      tokenId: "123", side: OrderSide.BUY, amount: "0.410000",
      maxSpend: "0.410000", maxPrice: "0.400000", orderType: OrderType.FAK,
    });
    expect(journal.intent?.signedOrder).toBe(signedBuy);
  });

  it("rejects a signed order from a different maker", async () => {
    const journal = new MemoryJournal();
    await expect(prepareV11Order(journal, { createMarketOrder: async () => signedBuy }, {
      batchId: "1", legId: "0", tokenId: 123n, side: "BUY",
      escrowAmount: 410_000n, limitPrice: 420_000n, priceTick: 10_000n,
      expectedMaker: "0x00000000000000000000000000000000000000bb",
    })).rejects.toThrow(/Deposit Wallet/);
    expect(journal.intent).toBeNull();
  });

  it("rejects a sell signed below the user's minimum", async () => {
    const journal = new MemoryJournal();
    const signedSell = {
      ...signedBuy, side: OrderSide.SELL, makerAmount: "1000000", takerAmount: "500000",
    } as SignedOrder;
    await expect(prepareV11Order(journal, { createMarketOrder: async () => signedSell }, {
      batchId: "2", legId: "0", tokenId: 123n, side: "SELL",
      escrowAmount: 1_000_000n, limitPrice: 550_000n, priceTick: 10_000n, expectedMaker: maker,
    })).rejects.toThrow(/below limit/);
    expect(journal.intent).toBeNull();
  });

  it("rounds a sell minimum up to the next market tick after the fee buffer", async () => {
    const journal = new MemoryJournal();
    const signedSell = {
      ...signedBuy, side: OrderSide.SELL, makerAmount: "1000000", takerAmount: "580000",
    } as SignedOrder;
    const signer = { createMarketOrder: vi.fn(async () => signedSell) };
    await prepareV11Order(journal, signer, {
      batchId: "2", legId: "0", tokenId: 123n, side: "SELL",
      escrowAmount: 1_000_000n, limitPrice: 555_000n, priceTick: 10_000n, expectedMaker: maker,
    });
    expect(signer.createMarketOrder).toHaveBeenCalledWith({
      tokenId: "123", side: OrderSide.SELL, shares: "1.000000",
      minPrice: "0.580000", orderType: OrderType.FAK,
    });
  });

  it("fails closed when the fee buffer leaves no tradable price", async () => {
    const journal = new MemoryJournal();
    const signer = { createMarketOrder: vi.fn(async () => signedBuy) };
    await expect(prepareV11Order(journal, signer, {
      batchId: "1", legId: "0", tokenId: 123n, side: "BUY",
      escrowAmount: 100_000n, limitPrice: 15_000n, priceTick: 10_000n, expectedMaker: maker,
    })).rejects.toThrow(/fee envelope/);
    expect(signer.createMarketOrder).not.toHaveBeenCalled();
  });

  it("allows only one network post even when two workers race", async () => {
    const journal = new MemoryJournal();
    await journal.prepare("3", "0", signedBuy);
    const postOrder = vi.fn(async () => ({ ok: true, orderId: "order-1", status: "delayed" }));
    const assertFunding = vi.fn(async () => {});
    const results = await Promise.allSettled([
      submitV11OrderOnce(journal, { postOrder }, "3", "0", assertFunding),
      submitV11OrderOnce(journal, { postOrder }, "3", "0", assertFunding),
    ]);
    expect(postOrder).toHaveBeenCalledOnce();
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(journal.intent?.state).toBe("accepted");
    expect(journal.intent?.orderId).toBe("order-1");
    expect(await journal.listUnresolved()).toHaveLength(1);
  });

  it("quarantines a timeout and refuses a retry", async () => {
    const journal = new MemoryJournal();
    await journal.prepare("4", "0", signedBuy);
    const postOrder = vi.fn(async () => { throw new Error("timeout"); });
    await expect(submitV11OrderOnce(journal, { postOrder }, "4", "0", async () => {}))
      .rejects.toThrow(/outcome is uncertain/);
    expect(journal.intent?.state).toBe("uncertain");
    await expect(submitV11OrderOnce(journal, { postOrder }, "4", "0", async () => {}))
      .rejects.toThrow(/duplicate post/);
    expect(postOrder).toHaveBeenCalledOnce();
  });

  it("records an explicit CLOB rejection without posting again", async () => {
    const journal = new MemoryJournal();
    await journal.prepare("5", "0", signedBuy);
    const postOrder = vi.fn(async () => ({ ok: false, code: "INSUFFICIENT_BALANCE" }));
    await expect(submitV11OrderOnce(journal, { postOrder }, "5", "0", async () => {}))
      .rejects.toThrow(/INSUFFICIENT_BALANCE/);
    expect(journal.intent?.state).toBe("rejected");
    expect(postOrder).toHaveBeenCalledOnce();
  });

  it("does not submit or consume the journal when funding is unconfirmed", async () => {
    const journal = new MemoryJournal();
    await journal.prepare("6", "0", signedBuy);
    const postOrder = vi.fn();
    await expect(submitV11OrderOnce(journal, { postOrder }, "6", "0", async () => {
      throw new Error("Deposit Wallet balance is stale");
    })).rejects.toThrow(/balance is stale/);
    expect(journal.intent?.state).toBe("prepared");
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("rejects a mismatched SDK account before any funding or CLOB call", async () => {
    const journal = new MemoryJournal();
    await journal.prepare("7", "0", signedBuy);
    const client = { account: {
      wallet: "0x00000000000000000000000000000000000000bb",
      walletType: WalletType.DEPOSIT_WALLET,
    } } as unknown as DepositWalletClient;
    await expect(submitFundedV11OrderOnce(journal, client, "7", "0", {
      rpcUrl: "https://polygon.invalid", tokenAddress: maker, exchange: maker,
      asset: "COLLATERAL", startingBalance: 0n, incomingAmount: 400_000n,
      orderAmount: 400_000n,
    })).rejects.toThrow(/does not belong/);
    expect(journal.intent?.state).toBe("prepared");
  });
});
