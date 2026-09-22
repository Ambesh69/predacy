import { describe, expect, it, vi } from "vitest";
import { executeV11BatchAction } from "./v11BatchAction.js";
import type { V11BatchAction, V11BatchIntent, V11BatchJournal } from "./v11BatchJournal.js";

const hash = `0x${"ab".repeat(32)}` as const;

class MemoryBatchJournal implements V11BatchJournal {
  intent: V11BatchIntent | null = null;
  async prepare(batchId: string, action: V11BatchAction, payload: Record<string, string>) {
    if (this.intent && JSON.stringify(this.intent.payload) !== JSON.stringify(payload)) {
      throw new Error("A different v11 batch action is already journaled");
    }
    this.intent ??= { batchId, action, state: "prepared", payload, txHash: null, error: null };
    return { ...this.intent };
  }
  async claim() {
    if (this.intent?.state !== "prepared") return null;
    this.intent.state = "submitting";
    return { ...this.intent };
  }
  async recordBroadcast(_batchId: string, _action: V11BatchAction, txHash: string) {
    if (this.intent?.state !== "submitting") throw new Error("Wrong state");
    this.intent.state = "broadcast";
    this.intent.txHash = txHash;
  }
  async recordConfirmed() {
    if (this.intent?.state !== "broadcast") throw new Error("Wrong state");
    this.intent.state = "confirmed";
  }
  async recordUncertain(_batchId: string, _action: V11BatchAction, error: string) {
    if (!this.intent || !["submitting", "broadcast"].includes(this.intent.state)) throw new Error("Wrong state");
    this.intent.state = "uncertain";
    this.intent.error = error;
  }
  async get() { return this.intent; }
  async listUnresolved() { return this.intent?.state === "uncertain" ? [this.intent] : []; }
}

describe("v11 batch action write-ahead journal", () => {
  it("sends once and treats a confirmed restart as read-only", async () => {
    const journal = new MemoryBatchJournal();
    const transaction = { send: vi.fn(async () => hash), confirm: vi.fn(async () => {}) };
    expect(await executeV11BatchAction(journal, "1", "route", { amount: "100" }, transaction)).toBe(hash);
    expect(await executeV11BatchAction(journal, "1", "route", { amount: "100" }, transaction)).toBe(hash);
    expect(transaction.send).toHaveBeenCalledOnce();
    expect(transaction.confirm).toHaveBeenCalledOnce();
  });

  it("rechecks a broadcast hash after confirmation timeout without sending again", async () => {
    const journal = new MemoryBatchJournal();
    const transaction = {
      send: vi.fn(async () => hash),
      confirm: vi.fn().mockRejectedValueOnce(new Error("RPC timeout")).mockResolvedValue(undefined),
    };
    await expect(executeV11BatchAction(journal, "2", "return_pusd", { amount: "100" }, transaction))
      .rejects.toThrow(/confirmation is pending/);
    expect(journal.intent?.state).toBe("broadcast");
    await executeV11BatchAction(journal, "2", "return_pusd", { amount: "100" }, transaction);
    expect(transaction.send).toHaveBeenCalledOnce();
    expect(transaction.confirm).toHaveBeenCalledTimes(2);
  });

  it("quarantines an ambiguous send across restart", async () => {
    const journal = new MemoryBatchJournal();
    const transaction = { send: vi.fn(async (): Promise<typeof hash> => { throw new Error("timeout"); }), confirm: vi.fn() };
    await expect(executeV11BatchAction(journal, "3", "return_shares", { amount: "1" }, transaction))
      .rejects.toThrow(/submission is uncertain/);
    await expect(executeV11BatchAction(journal, "3", "return_shares", { amount: "1" }, transaction))
      .rejects.toThrow(/reconcile before proceeding/);
    expect(transaction.send).toHaveBeenCalledOnce();
  });

  it("rejects changed amounts on a restart", async () => {
    const journal = new MemoryBatchJournal();
    await executeV11BatchAction(journal, "4", "finalize", { amount: "100" }, {
      send: async () => hash, confirm: async () => {},
    });
    await expect(executeV11BatchAction(journal, "4", "finalize", { amount: "101" }, {
      send: async () => hash, confirm: async () => {},
    })).rejects.toThrow(/different v11 batch action/);
  });
});
