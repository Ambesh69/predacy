import { describe, expect, it, vi } from "vitest";
import { executeV12BatchAction } from "./v12BatchAction.js";
import type { V12BatchAction, V12BatchIntent, V12BatchJournal } from "./v12BatchJournal.js";

const batchId = `0x${"12".repeat(32)}`;
const txHash = `0x${"ab".repeat(32)}` as const;

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

describe("v12 chain action", () => {
  it("does not rebroadcast a confirmed action after restart", async () => {
    const journal = new Journal();
    const send = vi.fn(async () => txHash);
    const transaction = { send, confirm: vi.fn(async () => {}) };
    await executeV12BatchAction(journal, batchId, "route", { amount: "100" }, transaction);
    await executeV12BatchAction(journal, batchId, "route", { amount: "100" }, transaction);
    expect(send).toHaveBeenCalledOnce();
  });

  it("quarantines an ambiguous submission", async () => {
    const journal = new Journal();
    const transaction = { send: vi.fn(async () => { throw new Error("timeout"); }), confirm: vi.fn() };
    await expect(executeV12BatchAction(journal, batchId, "settle", { proof: "digest" }, transaction))
      .rejects.toThrow(/uncertain/);
    await expect(executeV12BatchAction(journal, batchId, "settle", { proof: "digest" }, transaction))
      .rejects.toThrow(/reconcile/);
    expect(transaction.send).toHaveBeenCalledOnce();
  });
});
