import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { buildV12BuyBatchInputs, type V12BuyBatchWitness } from "./v12BuyBatchProver.js";
import { runV12BuyBatch, type V12BuyBatchRequest, type V12BuyDriver } from "./v12BuyRunner.js";
import type { V12BatchAction, V12BatchIntent, V12BatchJournal } from "./v12BatchJournal.js";

const hex = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const txHash = hex("a");
const request: V12BuyBatchRequest = {
  marketId: hex("b"),
  positionTokenId: 123n,
  priceTick: 10_000n,
  depositWallet: "0x00000000000000000000000000000000000000aa",
  witness: {
    collateralAsset: hex("1"),
    positionAsset: hex("2"),
    orders: [
      { inputNote: hex("3"), deposit: 600_000n, limitPrice: 600_000n, salt: hex("4"),
        refundPublicKey: hex("5"), positionPublicKey: hex("6") },
      { inputNote: hex("7"), deposit: 400_000n, limitPrice: 550_000n, salt: hex("8"),
        refundPublicKey: hex("9"), positionPublicKey: hex("a") },
    ],
  },
};

class Journal implements V12BatchJournal {
  intents = new Map<V12BatchAction, V12BatchIntent>();
  async prepare(id: string, action: V12BatchAction, payload: Record<string, string>) {
    const existing = this.intents.get(action);
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error("different action");
    const intent = existing ?? { batchId: id, action, state: "prepared" as const, payload, txHash: null, error: null };
    this.intents.set(action, intent);
    return { ...intent };
  }
  async claim(_id: string, action: V12BatchAction) {
    const intent = this.intents.get(action);
    if (!intent || intent.state !== "prepared") return null;
    intent.state = "submitting";
    return { ...intent };
  }
  async recordBroadcast(_id: string, action: V12BatchAction, hash: string) {
    Object.assign(this.intents.get(action)!, { state: "broadcast", txHash: hash });
  }
  async recordConfirmed(_id: string, action: V12BatchAction) { this.intents.get(action)!.state = "confirmed"; }
  async recordUncertain(_id: string, action: V12BatchAction, error: string) {
    Object.assign(this.intents.get(action)!, { state: "uncertain", error });
  }
  async get(_id: string, action: V12BatchAction) { return this.intents.get(action) ?? null; }
  async listUnresolved() { return [...this.intents.values()].filter((value) => value.state === "uncertain"); }
}

function harness(terminal = { returnPusd: 450_000n, returnShares: 1_000_000n, confirmedTradeCount: 1 }) {
  const journal = new Journal();
  let status: "LOCKED" | "ROUTED" | "SETTLED" = "LOCKED";
  let adapterPusd = 0n;
  let poolUsdce = 0n;
  let poolShares = 0n;
  const action = (send: () => void = () => {}) => ({
    send: vi.fn(async () => { send(); return txHash; }), confirm: vi.fn(async () => {}),
  });
  const route = action(() => { status = "ROUTED"; });
  const withdraw = action(() => { adapterPusd += terminal.returnPusd; });
  const unwrap = action(() => { adapterPusd -= terminal.returnPusd; poolUsdce += terminal.returnPusd; });
  const shares = action(() => { poolShares += terminal.returnShares; });
  const settle = action(() => { status = "SETTLED"; });
  const execute = vi.fn(async () => terminal);
  const driver: V12BuyDriver = {
    assertBatch: async () => status,
    route: () => route,
    assertFunding: async (_request, amount) => { expect(amount).toBe(1_000_000n); },
    executeAggregateOrder: execute,
    withdrawPusd: () => withdraw,
    unwrapPusd: () => unwrap,
    returnShares: () => shares,
    assertPoolReturns: async (_token, pusd, outcome) => {
      expect(adapterPusd).toBe(0n);
      expect(poolUsdce).toBe(pusd);
      expect(poolShares).toBe(outcome);
    },
    settle: () => settle,
  };
  const prover = vi.fn(async (witness: V12BuyBatchWitness) => {
    const built = buildV12BuyBatchInputs(witness);
    return { proof: "0x1234" as Hex, orderCommitments: built.orderCommitments,
      refundCommitments: built.refundCommitments, positionCommitments: built.positionCommitments };
  });
  return { journal, driver, prover, execute, route, withdraw, unwrap, shares, settle };
}

describe("v12 private buy runner", () => {
  it("routes, reconciles, returns assets, proves private allocations, and settles once", async () => {
    const h = harness();
    const result = await runV12BuyBatch(request, h.journal, h.driver, h.prover);
    expect(result.fills).toEqual([
      { spent: 330_000n, shares: 600_000n },
      { spent: 220_000n, shares: 400_000n },
    ]);
    await runV12BuyBatch(request, h.journal, h.driver, h.prover);
    expect(h.route.send).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.withdraw.send).toHaveBeenCalledOnce();
    expect(h.unwrap.send).toHaveBeenCalledOnce();
    expect(h.shares.send).toHaveBeenCalledOnce();
    expect(h.settle.send).toHaveBeenCalledOnce();
  });

  it("settles an explicit rejection into full private refund notes", async () => {
    const h = harness({ returnPusd: 1_000_000n, returnShares: 0n, confirmedTradeCount: 0 });
    const result = await runV12BuyBatch(request, h.journal, h.driver, h.prover);
    expect(result.fills).toEqual([{ spent: 0n, shares: 0n }, { spent: 0n, shares: 0n }]);
    expect(h.withdraw.send).toHaveBeenCalledOnce();
    expect(h.unwrap.send).toHaveBeenCalledOnce();
    expect(h.shares.send).not.toHaveBeenCalled();
    expect(h.settle.send).toHaveBeenCalledOnce();
  });

  it("quarantines an ambiguous route and refuses to send it twice", async () => {
    const h = harness();
    h.route.send.mockRejectedValueOnce(new Error("rpc timeout"));
    await expect(runV12BuyBatch(request, h.journal, h.driver, h.prover)).rejects.toThrow(/uncertain/);
    await expect(runV12BuyBatch(request, h.journal, h.driver, h.prover)).rejects.toThrow(/reconcile/);
    expect(h.route.send).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });
});
