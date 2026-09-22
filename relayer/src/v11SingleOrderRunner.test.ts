import { describe, expect, it, vi } from "vitest";
import { OrderSide, OrderType, type SignedOrder } from "@polymarket/client";
import { encodeAbiParameters, keccak256 } from "viem";
import { runV11SingleOrder, type V11EscrowedOrder, type V11SingleOrderDriver } from "./v11SingleOrderRunner.js";
import type { V11BatchAction, V11BatchIntent, V11BatchJournal } from "./v11BatchJournal.js";
import type { V11OrderIntent, V11OrderJournal } from "./v11OrderJournal.js";
import type { V11WalletBalances } from "./v11SingleOrderAllocation.js";

const maker = "0x00000000000000000000000000000000000000aa" as const;
const market = `0x${"11".repeat(32)}` as const;
const salt = `0x${"44".repeat(32)}` as const;
const commitment = keccak256(encodeAbiParameters(
  [{ type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
  [market, 2, 410_000n, 600_000n, salt],
));
const txHash = `0x${"33".repeat(32)}` as const;
const order: V11EscrowedOrder = {
  batchId: "1", marketId: market, commitment, side: "NO_BUY", deposit: 410_000n,
  limitPrice: 600_000n, salt, tokenId: 123n,
  priceTick: 10_000n, depositWallet: maker,
};
const signed = {
  maker, signer: maker, tokenId: "123", side: OrderSide.BUY, orderType: OrderType.FAK,
  signatureType: 3, makerAmount: "410000", takerAmount: "1000000", signature: "0x1234",
} as unknown as SignedOrder;

class BatchJournal implements V11BatchJournal {
  intents = new Map<V11BatchAction, V11BatchIntent>();
  async prepare(batchId: string, action: V11BatchAction, payload: Record<string, string>) {
    const existing = this.intents.get(action);
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error("different action");
    const intent = existing ?? { batchId, action, state: "prepared" as const, payload, txHash: null, error: null };
    this.intents.set(action, intent);
    return { ...intent };
  }
  async claim(_batchId: string, action: V11BatchAction) {
    const intent = this.intents.get(action);
    if (!intent || intent.state !== "prepared") return null;
    intent.state = "submitting";
    return { ...intent };
  }
  async recordBroadcast(_batchId: string, action: V11BatchAction, hash: string) {
    const intent = this.intents.get(action)!;
    intent.txHash = hash;
    intent.state = "broadcast";
  }
  async recordConfirmed(_batchId: string, action: V11BatchAction) {
    this.intents.get(action)!.state = "confirmed";
  }
  async recordUncertain(_batchId: string, action: V11BatchAction, error: string) {
    const intent = this.intents.get(action)!;
    intent.state = "uncertain";
    intent.error = error;
  }
  async get(_batchId: string, action: V11BatchAction) { return this.intents.get(action) ?? null; }
  async listUnresolved() { return [...this.intents.values()].filter((intent) => intent.state === "uncertain"); }
}

class OrderJournal implements V11OrderJournal {
  intent: V11OrderIntent | null = null;
  async prepare(batchId: string, legId: string, signedOrder: SignedOrder) {
    this.intent ??= { batchId, legId, state: "prepared", signedOrder, orderId: null, response: null, error: null };
    return this.intent;
  }
  async claimForSubmission() {
    if (this.intent?.state !== "prepared") return null;
    this.intent.state = "submitting";
    return this.intent;
  }
  async recordAccepted(_batchId: string, _legId: string, orderId: string, response: unknown) {
    this.intent!.state = "accepted";
    this.intent!.orderId = orderId;
    this.intent!.response = response;
  }
  async recordRejected(_batchId: string, _legId: string, response: unknown) {
    this.intent!.state = "rejected";
    this.intent!.response = response;
  }
  async recordUncertain(_batchId: string, _legId: string, error: string) {
    this.intent!.state = "uncertain";
    this.intent!.error = error;
  }
  async get() { return this.intent; }
  async listUnresolved() { return this.intent ? [this.intent] : []; }
}

function harness(outcome: "partial" | "rejected" | "timeout") {
  const batchJournal = new BatchJournal();
  const orderJournal = new OrderJournal();
  const reservations = new Map<string, bigint>();
  const budget = { reserve: async (batchId: string, amount: bigint) => {
    if (amount > 10_000_000n || (reservations.has(batchId) && reservations.get(batchId) !== amount)) {
      throw new Error("pilot cap exceeded");
    }
    reservations.set(batchId, amount);
  } };
  const wallet: V11WalletBalances = { pusd: 0n, yes: 0n, no: 0n };
  const vault: V11WalletBalances = { pusd: 0n, yes: 0n, no: 0n };
  let status: "CLOSED" | "ROUTED" | "SETTLED" = "CLOSED";
  const sendRoute = vi.fn(async () => { wallet.pusd = 410_000n; status = "ROUTED"; return txHash; });
  const sendPusd = vi.fn(async (amount: bigint) => {
    wallet.pusd -= amount; vault.pusd += amount; return txHash;
  });
  const sendShares = vi.fn(async (amount: bigint) => {
    wallet.no -= amount; vault.no += amount; return txHash;
  });
  const postOrder = vi.fn(async () => {
    if (outcome === "timeout") throw new Error("socket closed");
    if (outcome === "rejected") return { ok: false, code: "REJECTED" };
    wallet.pusd = 5_000n;
    wallet.no = 1_000_000n;
    return { ok: true, orderId: "clob-order" };
  });
  const driver: V11SingleOrderDriver = {
    assertBatchSingleOrder: async () => status,
    readWalletBalances: async () => ({ ...wallet }),
    route: () => ({ send: sendRoute, confirm: async () => {} }),
    assertFunding: async () => {},
    signer: { createMarketOrder: async () => signed },
    poster: { postOrder },
    fetchOrder: async () => ({
      id: "clob-order", conditionId: market, tokenId: "123", makerAddress: maker,
      side: "BUY", orderType: "FAK", status: "CANCELED", sizeMatched: "1", associateTrades: ["trade-1"],
    }),
    tradeReader: { listAccountTrades: () => ({
      firstPage: async () => ({ items: [{ id: "trade-1", takerOrderId: "clob-order", makerOrders: [],
        status: "CONFIRMED", transactionHash: txHash }], nextCursor: null }),
      from: async function* () {},
    }) } as unknown as V11SingleOrderDriver["tradeReader"],
    receiptReader: {
      getBlockNumber: async () => 120n,
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 101n }),
    },
    returnPusd: (amount) => ({ send: () => sendPusd(amount), confirm: async () => {} }),
    returnShares: (_tokenId, amount) => ({ send: () => sendShares(amount), confirm: async () => {} }),
    assertVaultReturns: async (_order, allocation) => {
      expect(vault.pusd).toBe(allocation.returnPusd);
      expect(vault.no).toBe(allocation.returnNo);
    },
    proveAllocation: async () => "0x1234",
    finalize: () => ({ send: async () => { status = "SETTLED"; return txHash; }, confirm: async () => {} }),
  };
  return { batchJournal, orderJournal, driver, budget, wallet, sendRoute, sendPusd, sendShares, postOrder };
}

describe("v11 single-order runner", () => {
  it("runs a partial buy through route, fill, exact returns, and finalize once", async () => {
    const h = harness("partial");
    const result = await runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget);
    expect(result.allocation).toMatchObject({ filledShares: 1_000_000n, usdcPayout: 405_000n, refund: 5_000n });
    await runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget);
    expect(h.sendRoute).toHaveBeenCalledOnce();
    expect(h.postOrder).toHaveBeenCalledOnce();
    expect(h.sendPusd).toHaveBeenCalledOnce();
    expect(h.sendShares).toHaveBeenCalledOnce();
  });

  it("returns the full escrow after an explicit CLOB rejection", async () => {
    const h = harness("rejected");
    const result = await runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget);
    expect(result.allocation.refund).toBe(410_000n);
    expect(result.allocation.filledShares).toBe(0n);
    expect(h.sendPusd).toHaveBeenCalledOnce();
    expect(h.sendShares).not.toHaveBeenCalled();
  });

  it("quarantines a CLOB timeout and never returns or resubmits funds", async () => {
    const h = harness("timeout");
    await expect(runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget))
      .rejects.toThrow(/uncertain/);
    await expect(runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget))
      .rejects.toThrow(/not reconciled/);
    expect(h.postOrder).toHaveBeenCalledOnce();
    expect(h.sendPusd).not.toHaveBeenCalled();
  });

  it("checks the durable pilot cap before routing escrow", async () => {
    const h = harness("partial");
    await expect(runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, {
      reserve: async () => { throw new Error("pilot cap exhausted"); },
    })).rejects.toThrow(/pilot cap exhausted/);
    expect(h.sendRoute).not.toHaveBeenCalled();
    expect(h.postOrder).not.toHaveBeenCalled();
  });

  it("does not reserve pilot exposure for an invalid on-chain escrow", async () => {
    const h = harness("partial");
    const reserve = vi.fn(async () => {});
    h.driver.assertBatchSingleOrder = async () => { throw new Error("escrow mismatch"); };
    await expect(runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, { reserve }))
      .rejects.toThrow(/escrow mismatch/);
    expect(reserve).not.toHaveBeenCalled();
    expect(h.sendRoute).not.toHaveBeenCalled();
  });

  it("never retries a prepared route when the chain already shows routed", async () => {
    const h = harness("partial");
    await h.batchJournal.prepare(order.batchId, "route", {
      commitment: order.commitment, side: order.side, deposit: order.deposit.toString(), wallet: maker,
    });
    h.driver.assertBatchSingleOrder = async () => "ROUTED";
    await expect(runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget))
      .rejects.toThrow(/manual reconciliation required/);
    expect(h.sendRoute).not.toHaveBeenCalled();
    expect(h.postOrder).not.toHaveBeenCalled();
  });

  it("resumes a timed-out return by its hash using the immutable fill snapshot", async () => {
    const h = harness("partial");
    const original = h.driver.returnPusd;
    let confirmations = 0;
    h.driver.returnPusd = (amount) => ({
      ...original(amount),
      confirm: async () => {
        confirmations++;
        if (confirmations === 1) throw new Error("RPC timeout");
      },
    });
    await expect(runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget))
      .rejects.toThrow(/confirmation is pending/);
    expect(h.wallet.pusd).toBe(0n);
    const result = await runV11SingleOrder(order, h.batchJournal, h.orderJournal, h.driver, h.budget);
    expect(result.allocation.refund).toBe(5_000n);
    expect(h.sendPusd).toHaveBeenCalledOnce();
    expect(h.sendShares).toHaveBeenCalledOnce();
  });
});
