import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { loadPrivateRecoveryEvents } from "../../frontend/lib/privateMerkle";

const pool = "0x0000000000000000000000000000000000000011" as const;
const nullifier = `0x${"ab".repeat(32)}` as const;
const commitment = `0x${"cd".repeat(32)}` as const;

describe("private exit history", () => {
  it("paginates only confirmed blocks without disclosing per-user note filters", async () => {
    const getLogs = vi.fn(async ({ event, fromBlock }) => fromBlock === 1n
      ? event.name === "NoteWithdrawn"
        ? [{ args: { nullifier, assetId: commitment, recipient: pool, amount: 42n } }]
        : [{ args: { orderNullifier: nullifier, refundCommitment: commitment } }]
      : []);
    const client = { getBlockNumber: async () => 50_005n, getLogs } as unknown as PublicClient;
    const history = await loadPrivateRecoveryEvents(client, pool, 1n);
    expect(history.withdrawals.get(nullifier)?.amount).toBe(42n);
    expect(history.cancellations.get(nullifier)).toBe(commitment);
    expect(getLogs.mock.calls.map(([request]) => [request.fromBlock, request.toBlock]))
      .toEqual([[1n, 25_000n], [1n, 25_000n], [25_001n, 50_000n], [25_001n, 50_000n],
        [50_001n, 50_004n], [50_001n, 50_004n]]);
    for (const [request] of getLogs.mock.calls) {
      expect(request).toMatchObject({ address: pool, strict: true });
      expect(request).not.toHaveProperty("args");
    }
  });

  it("does not treat an unconfirmed deployment as recoverable history", async () => {
    const getLogs = vi.fn();
    const client = { getBlockNumber: async () => 10n, getLogs } as unknown as PublicClient;
    const history = await loadPrivateRecoveryEvents(client, pool, 10n);
    expect(history.withdrawals.size).toBe(0);
    expect(getLogs).not.toHaveBeenCalled();
  });
});
