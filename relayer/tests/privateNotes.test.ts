import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { encryptPrivateNotes, exportPrivateVaultBackup, importPrivateVaultBackup, loadPrivateNotes,
  loadPrivateOrders, savePrivateNotes, savePrivateOrders, type PrivateNoteRecord,
  type PrivateOrderRecord } from "../../frontend/lib/privateNotes";

const a = "0x0000000000000000000000000000000000000011";
const b = "0x0000000000000000000000000000000000000022";
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const signature = word(99);
const values = new Map<string, string>();
function note(n: number): PrivateNoteRecord {
  return { commitment: word(n), assetId: word(20), amount: "1000000", publicKey: word(n + 20),
    secret: word(n + 40), state: "spendable", createdAt: n };
}
function order(n: number): PrivateOrderRecord {
  return { orderCommitment: word(n), receiptToken: word(12), inputNote: word(13), deposit: "1000000",
    limitPrice: "600000", marketId: word(14), positionTokenId: "15", collateralAsset: word(16),
    positionAsset: word(17), orderSecret: word(18), orderLeafIndex: "0", refundSecret: word(19),
    refundPublicKey: word(20), positionSecret: word(21), positionPublicKey: word(22), state: "funding", createdAt: n };
}

beforeEach(() => {
  values.clear();
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("navigator", { locks: { request: (name: string, action: () => Promise<unknown>) => {
    const next = (locks.get(name) ?? Promise.resolve()).then(action);
    locks.set(name, next.catch(() => {}));
    return next;
  } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("private recovery vault storage", () => {
  it("isolates wallets while preserving a readable legacy backup", async () => {
    const legacy = await encryptPrivateNotes(a, signature, [note(1)]);
    values.set("predacy_private_notes_v13", legacy);
    await savePrivateNotes(b, signature, [note(2)]);
    expect((await loadPrivateNotes(a, signature)).map((n) => n.commitment)).toEqual([word(1)]);
    expect((await loadPrivateNotes(b, signature)).map((n) => n.commitment)).toEqual([word(2)]);
    await savePrivateNotes(a, signature, [note(3)]);
    expect(await loadPrivateNotes(a, signature)).toHaveLength(2);
    expect(values.get("predacy_private_notes_v13")).toBe(legacy);
    expect(exportPrivateVaultBackup(a)).not.toBe(exportPrivateVaultBackup(b));
  });

  it("serializes concurrent writes without losing either note", async () => {
    await Promise.all([savePrivateNotes(a, signature, [note(1)]), savePrivateNotes(a, signature, [note(2)])]);
    expect((await loadPrivateNotes(a, signature)).map((n) => n.commitment).sort()).toEqual([word(1), word(2)]);
  });

  it("merges old backups without erasing newer secrets or resurrecting spent outputs", async () => {
    await savePrivateNotes(a, signature, [note(1)]);
    await savePrivateOrders(a, signature, [order(1)]);
    const old = exportPrivateVaultBackup(a)!;
    await savePrivateNotes(a, signature, [{ ...note(1), state: "spent" }, note(2)]);
    await savePrivateOrders(a, signature, [{ ...order(1), state: "settled", refundWithdrawn: true }, order(2)]);
    await importPrivateVaultBackup(a, signature, old);
    const notes = await loadPrivateNotes(a, signature); const orders = await loadPrivateOrders(a, signature);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.commitment === word(1))?.state).toBe("spent");
    expect(orders).toHaveLength(2);
    expect(orders.find((n) => n.orderCommitment === word(1))).toMatchObject({ state: "settled", refundWithdrawn: true });
  });

  it("does not clear current data when importing an empty backup", async () => {
    await savePrivateNotes(a, signature, [note(1)]);
    await importPrivateVaultBackup(a, signature, JSON.stringify({ version: 2, notes: null, orders: null }));
    expect(await loadPrivateNotes(a, signature)).toHaveLength(1);
  });

  it("rejects conflicting secrets before modifying either storage record", async () => {
    await savePrivateNotes(a, signature, [note(1)]);
    const before = exportPrivateVaultBackup(a)!;
    const conflicting = await encryptPrivateNotes(a, signature, [{ ...note(1), secret: word(999) }]);
    await expect(importPrivateVaultBackup(a, signature,
      JSON.stringify({ version: 2, notes: conflicting, orders: null }))).rejects.toThrow("Conflicting");
    expect(JSON.parse(exportPrivateVaultBackup(a)!).notes).toBe(JSON.parse(before).notes);
  });

  it("rejects another wallet's backup and cannot overwrite with a wrong signature", async () => {
    await savePrivateNotes(a, signature, [note(1)]);
    await expect(importPrivateVaultBackup(b, signature, exportPrivateVaultBackup(a)!)).rejects.toThrow("different wallet");
    await expect(savePrivateNotes(a, word(100), [note(2)])).rejects.toThrow();
    expect(await loadPrivateNotes(a, signature)).toHaveLength(1);
    expect(await loadPrivateNotes(b, signature)).toHaveLength(0);
  });

  it("fails before storing recovery data when cross-tab locking is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(savePrivateNotes(a, signature, [note(1)])).rejects.toThrow("Web Locks");
    expect(values.size).toBe(0);
  });
});
