import { beforeEach, describe, expect, it, vi } from "vitest";
import { concatHex, keccak256, toHex, type Hex } from "viem";

const memory = vi.hoisted(() => ({ notes: [] as any[], orders: [] as any[],
  failAt: 0, snapshots: [] as any[], intake: true, leaves: [] as Hex[],
  withdrawals: new Map(), cancellations: new Map(), receipt: { state: "pending" } as any,
  relayerDown: false }));
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const wallet = "0x0000000000000000000000000000000000000011" as const;

vi.mock("../../frontend/lib/privateNotes", () => ({
  loadPrivateNotes: async () => structuredClone(memory.notes),
  loadPrivateOrders: async () => structuredClone(memory.orders),
  savePrivateNotes: async (_wallet: string, _key: Hex, notes: any[]) => { memory.notes = structuredClone(notes); },
  savePrivateOrders: async (_wallet: string, _key: Hex, orders: any[]) => { memory.orders = structuredClone(orders); },
}));
vi.mock("../../frontend/lib/privateContracts", async () => {
  const actual = await vi.importActual<any>("../../frontend/lib/privateContracts");
  return { ...actual, getPrivateContracts: () => ({ pool: wallet, deploymentBlock: 1n }),
    isPrivateTradingEnabled: () => memory.intake };
});
vi.mock("../../frontend/lib/contracts", async () => {
  const { parseAbi } = await import("viem");
  return { ERC20_ABI: parseAbi(["function approve(address,uint256) returns (bool)"]) };
});
vi.mock("../../frontend/lib/publicClient", () => ({ publicClient: {
  readContract: async ({ functionName }: any) => functionName === "paused" || functionName === "spentNullifiers"
    ? false : word(functionName === "collateralAssetId" ? 1 : 2),
  waitForTransactionReceipt: async ({ hash }: any) => {
    if (BigInt(hash) === BigInt(memory.failAt)) throw new Error("receipt connection lost");
    return { status: "success" };
  },
} }));
vi.mock("../../frontend/lib/privateMerkle", () => ({
  loadPrivateMerkleWitness: async () => ({ index: 0, root: word(5), path: [] }),
  loadPrivateTree: async () => memory.leaves,
  loadPrivateRecoveryEvents: async () => ({ withdrawals: memory.withdrawals, cancellations: memory.cancellations }),
}));
vi.mock("../../frontend/lib/privateProver", () => ({
  privateNoteCommitment: (asset: Hex, amount: bigint, key: Hex) => keccak256(concatHex([asset, toHex(amount, { size: 32 }), key])),
  privateNoteNullifier: (commitment: Hex, secret: Hex) => keccak256(concatHex([commitment, secret])),
  privateOrderNullifier: () => word(11), privateOrderCommitment: () => word(3),
  provePrivateBuyOrder: async () => ({ proof: "0x", root: word(5), nullifier: word(6), orderCommitment: word(3) }),
  provePrivateWithdrawal: async () => ({ proof: "0x", root: word(5), nullifier: word(6) }),
  provePrivateOrderCancellation: async () => ({ proof: "0x", orderNullifier: word(6),
    orderCommitment: word(3), refundCommitment: word(4) }),
}));
vi.mock("../../frontend/lib/privateRelayer", () => ({
  submitPrivateOrder: async () => ({ state: "queued", orderCommitment: word(3) }),
  getPrivateAllocationReceipt: async () => {
    if (memory.relayerDown) throw new Error("relayer unavailable");
    return memory.receipt;
  },
}));

import { cancelPrivateOrder, executePrivateBuy, refreshPrivateAllocations, withdrawPrivateOrderOutput } from "../../frontend/lib/privateTradeFlow";
import { privateNoteCommitment, privateNoteNullifier } from "../../frontend/lib/privateProver";

function args() {
  let calls = 0;
  return { provider: { request: vi.fn(async () => {
    memory.snapshots.push(structuredClone({ notes: memory.notes, orders: memory.orders }));
    return word(++calls);
  }) }, wallet, vaultSignature: word(7), usdc: wallet, depositWallet: wallet,
  marketId: word(8), positionTokenId: 99n, priceTick: 10_000n, amount: 1_000_000n,
  limitPrice: 600_000n, side: "NO" as const };
}

beforeEach(() => { memory.notes = []; memory.orders = []; memory.snapshots = []; memory.failAt = 0; memory.intake = true;
  memory.leaves = []; memory.withdrawals.clear(); memory.cancellations.clear(); memory.receipt = { state: "pending" };
  memory.relayerDown = false; });

describe("private wallet recovery", () => {
  it.each([2, 3])("preserves note and order secrets when receipt %s times out", async (failAt) => {
    memory.failAt = failAt;
    await expect(executePrivateBuy(args())).rejects.toThrow("connection lost");
    expect(memory.notes).toHaveLength(1);
    expect(memory.orders).toHaveLength(1);
    for (const saved of memory.snapshots) {
      expect(saved.notes[0].secret).toMatch(/^0x[0-9a-f]{64}$/);
      expect(saved.orders[0].orderSecret).toMatch(/^0x[0-9a-f]{64}$/);
      expect(saved.orders[0].refundSecret).toMatch(/^0x[0-9a-f]{64}$/);
      expect(saved.orders[0].positionSecret).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(memory.orders[0].state).toBe(failAt === 2 ? "funding" : "locking");
  });

  it("keeps confirmed deposit recovery available if proving or locking never completes", async () => {
    memory.failAt = 3;
    const input = args();
    await expect(executePrivateBuy(input)).rejects.toThrow();
    memory.failAt = 0;
    memory.intake = false;
    await withdrawPrivateOrderOutput({ ...args(), order: memory.orders[0], output: "refund" });
    expect(memory.orders[0]).toMatchObject({ state: "cancelled", refundWithdrawn: true });
    expect(memory.notes[0].state).toBe("spent");
  });

  it("permits a cancelled order's refund withdrawal while intake is closed", async () => {
    await executePrivateBuy(args());
    memory.intake = false;
    memory.orders[0].state = "cancelled";
    memory.orders[0].refund = "1000000";
    memory.notes[0].state = "spendable";
    memory.notes[0].commitment = privateNoteCommitment(memory.orders[0].collateralAsset, 1_000_000n, memory.orders[0].refundPublicKey);
    await withdrawPrivateOrderOutput({ ...args(), order: memory.orders[0], output: "refund" });
    expect(memory.orders[0].refundWithdrawn).toBe(true);
  });

  it("blocks new deposits while intake is closed", async () => {
    memory.intake = false;
    const input = args();
    await expect(executePrivateBuy(input)).rejects.toThrow("paused");
    expect(input.provider.request).not.toHaveBeenCalled();
    expect(memory.notes).toHaveLength(0);
  });

  it("recovers a confirmed cancellation after the receipt connection is lost", async () => {
    await executePrivateBuy(args());
    const order = memory.orders[0];
    memory.failAt = 1;
    await expect(cancelPrivateOrder({ ...args(), order })).rejects.toThrow("connection lost");
    const refund = privateNoteCommitment(order.collateralAsset, BigInt(order.deposit), order.refundPublicKey);
    memory.cancellations.set(word(11), refund);
    memory.leaves = [order.inputNote, order.orderCommitment, refund];
    memory.relayerDown = true;
    await refreshPrivateAllocations(args());
    expect(memory.orders[0]).toMatchObject({ state: "cancelled", refund: order.deposit });
    expect(memory.notes.find((note) => note.commitment === refund)).toMatchObject({ state: "spendable", secret: order.refundSecret });
  });

  it("recovers a confirmed deposit withdrawal without submitting another transaction", async () => {
    memory.failAt = 3;
    await expect(executePrivateBuy(args())).rejects.toThrow();
    const note = memory.notes[0];
    memory.failAt = 1;
    await expect(withdrawPrivateOrderOutput({ ...args(), order: memory.orders[0], output: "refund" }))
      .rejects.toThrow("connection lost");
    memory.leaves = [note.commitment];
    memory.withdrawals.set(privateNoteNullifier(note.commitment, note.secret),
      { assetId: note.assetId, amount: BigInt(note.amount), recipient: wallet });
    const refreshArgs = args();
    await refreshPrivateAllocations(refreshArgs);
    expect(memory.orders[0]).toMatchObject({ state: "cancelled", refundWithdrawn: true });
    expect(memory.notes[0].state).toBe("spent");
    expect(refreshArgs.provider.request).not.toHaveBeenCalled();
  });

  it("rebuilds outputs if settlement state persisted before the note write", async () => {
    await executePrivateBuy(args());
    const order = memory.orders[0];
    Object.assign(order, { state: "settled", refund: "450000", spent: "550000", shares: "1000000" });
    const refund = privateNoteCommitment(order.collateralAsset, 450_000n, order.refundPublicKey);
    const position = privateNoteCommitment(order.positionAsset, 1_000_000n, order.positionPublicKey);
    memory.leaves = [order.inputNote, order.orderCommitment, refund, position];
    memory.relayerDown = true;
    await refreshPrivateAllocations(args());
    expect(memory.notes.find((note) => note.commitment === refund)?.secret).toBe(order.refundSecret);
    expect(memory.notes.find((note) => note.commitment === position)?.secret).toBe(order.positionSecret);
  });

  it("does not resurrect a withdrawn output when refreshing an older settlement state", async () => {
    await executePrivateBuy(args());
    const order = memory.orders[0];
    Object.assign(order, { state: "settled", refund: "450000", spent: "550000", shares: "1000000" });
    const refund = privateNoteCommitment(order.collateralAsset, 450_000n, order.refundPublicKey);
    const position = privateNoteCommitment(order.positionAsset, 1_000_000n, order.positionPublicKey);
    memory.leaves = [order.inputNote, order.orderCommitment, refund, position];
    memory.withdrawals.set(privateNoteNullifier(position, order.positionSecret),
      { assetId: order.positionAsset, amount: 1_000_000n, recipient: wallet });
    await refreshPrivateAllocations(args());
    await refreshPrivateAllocations(args());
    expect(memory.orders[0].positionWithdrawn).toBe(true);
    expect(memory.notes.find((note) => note.commitment === position)?.state).toBe("spent");
  });

  it.each([
    { spent: "550000", refund: "999999", shares: "1000000" },
    { spent: "700000", refund: "300000", shares: "1000000" },
    { spent: "0", refund: "1000000", shares: "1000000" },
  ])("rejects an inconsistent allocation receipt %j", async (receipt) => {
    await executePrivateBuy(args());
    memory.receipt = { state: "settled", ...receipt };
    await expect(refreshPrivateAllocations(args())).rejects.toThrow("violates the order");
    expect(memory.orders[0].state).toBe("queued");
  });
});
