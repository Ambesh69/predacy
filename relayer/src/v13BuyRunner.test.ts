import { describe, expect, it, vi } from "vitest";
import { concatHex, keccak256, zeroHash, type Hex } from "viem";
import type { V13BatchAction, V13BatchJournal, V13Intent } from "./v13BatchJournal.js";
import { runV13BuyBatch, type V13BuyDriver, type V13BuyRequest } from "./v13BuyRunner.js";
import { buildV13RouteInputs, buildV13SettlementInputs, v13MerkleRoot, v13OrderCommitment } from "./v13Proofs.js";

const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hashPair = (a: Hex, b: Hex) => keccak256(concatHex([a, b]));
function request(): V13BuyRequest {
  const base = [
    { positionAsset: word("2"), deposit: 600_000n, limitPrice: 600_000n,
      refundPublicKey: word("3"), positionPublicKey: word("5"), orderSecret: word("7") },
    { positionAsset: word("2"), deposit: 400_000n, limitPrice: 600_000n,
      refundPublicKey: word("4"), positionPublicKey: word("6"), orderSecret: word("8") },
  ] as const;
  const leaves = base.map(v13OrderCommitment);
  const paths: Hex[][] = [[], []];
  paths[0].push(leaves[1]); paths[1].push(leaves[0]);
  let zero: Hex = hashPair(zeroHash, zeroHash);
  for (let level = 1; level < 20; level++) { paths[0].push(zero); paths[1].push(zero); zero = hashPair(zero, zero); }
  const root = v13MerkleRoot(leaves[0], { path: paths[0], index: 0 });
  return { marketId: word("9"), positionTokenId: 99n, priceTick: 10_000n,
    depositWallet: "0x0000000000000000000000000000000000000011", witness: {
      collateralAsset: word("1"), positionAsset: word("2"), orders: [
        { ...base[0], merkle: { root, path: paths[0], index: 0 } },
        { ...base[1], merkle: { root, path: paths[1], index: 1 } },
      ],
    } };
}
class Journal implements V13BatchJournal {
  intents = new Map<V13BatchAction, V13Intent>();
  async prepare(id: string, action: V13BatchAction, payload: Record<string, string>) {
    const prior = this.intents.get(action);
    if (prior) return prior;
    const value: V13Intent = { batchId: id, action, state: action === "plan" ? "confirmed" : "prepared",
      payload, txHash: action === "plan" ? null : null, error: null };
    this.intents.set(action, value); return value;
  }
  async claim(_id: string, action: V13BatchAction) { const value = this.intents.get(action)!; value.state = "submitting"; return value; }
  async recordBroadcast(_id: string, action: V13BatchAction, hash: string) { const value = this.intents.get(action)!; value.state = "broadcast"; value.txHash = hash; }
  async recordConfirmed(_id: string, action: V13BatchAction) { this.intents.get(action)!.state = "confirmed"; }
  async recordUncertain(_id: string, action: V13BatchAction, error: string) { const value = this.intents.get(action)!; value.state = "uncertain"; value.error = error; }
  async get(_id: string, action: V13BatchAction) { return this.intents.get(action) ?? null; }
  async listUnresolved() { return [...this.intents.values()].filter((value) => value.state === "uncertain"); }
}
const tx = () => ({ send: vi.fn(async () => word("a")), confirm: vi.fn(async () => undefined) });

describe("v13 resumable private buy", () => {
  it("routes, executes, returns assets and settles exactly once", async () => {
    const input = request(); const journal = new Journal();
    const route = buildV13RouteInputs(input.witness);
    const driver: V13BuyDriver = {
      assertBatch: vi.fn(async () => "READY" as const), route: vi.fn(() => tx()), assertFunding: vi.fn(async () => undefined),
      executeAggregateOrder: vi.fn(async () => ({ returnPusd: 450_000n, returnShares: 1_000_000n, confirmedTradeCount: 1 })),
      withdrawPusd: vi.fn(() => tx()), unwrapPusd: vi.fn(() => tx()), returnShares: vi.fn(() => tx()),
      assertPoolReturns: vi.fn(async () => undefined), settle: vi.fn(() => tx()),
    };
    const result = await runV13BuyBatch(input, journal, driver,
      async () => ({ proof: "0x12", nullifiers: route.nullifiers, fullRefunds: route.fullRefunds,
        binding: route.binding, root: route.root, totalDeposit: route.totalDeposit }),
      async (batch, fills) => { const built = buildV13SettlementInputs(batch, fills); return {
        proof: "0x34", binding: built.binding, refundCommitments: built.refundCommitments,
        positionCommitments: built.positionCommitments, totalSpent: built.totalSpent, totalShares: built.totalShares }; });
    expect(result.batchId).toBe(route.binding);
    expect(result.fills.reduce((sum, fill) => sum + fill.spent, 0n)).toBe(550_000n);
    expect(driver.settle).toHaveBeenCalledOnce();
    expect(journal.intents.get("settle")?.state).toBe("confirmed");
  });

  it("quarantines an uncertain route instead of replaying it", async () => {
    const input = request(); const journal = new Journal(); const route = buildV13RouteInputs(input.witness);
    const broken = { send: vi.fn(async () => { throw new Error("rpc lost"); }), confirm: vi.fn() };
    const driver = { assertBatch: async () => "READY" as const, route: () => broken } as unknown as V13BuyDriver;
    const prover = async () => ({ proof: "0x12" as Hex, nullifiers: route.nullifiers,
      fullRefunds: route.fullRefunds, binding: route.binding, root: route.root, totalDeposit: route.totalDeposit });
    await expect(runV13BuyBatch(input, journal, driver, prover, vi.fn())).rejects.toThrow(/uncertain/i);
    await expect(runV13BuyBatch(input, journal, driver, prover, vi.fn())).rejects.toThrow(/reconcile/i);
    expect(broken.send).toHaveBeenCalledOnce();
  });
});
