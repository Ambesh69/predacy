import { describe, expect, it, vi } from "vitest";
vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  return { Pool: newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool };
});
import { openV13Witness, sealV13Witness, PostgresV13BatchJournal, PostgresV13WitnessVault } from "./v13BatchJournal.js";
const word = (byte: string) => `0x${byte.repeat(64)}`;

describe("v13 durable journal", () => {
  it("authenticates the encryption key and witness identity", () => {
    const witness = { secret: word("8"), amount: 1_000_000n };
    const sealed = sealV13Witness(word("1"), witness, word("f"));
    expect(openV13Witness(word("1"), sealed.ciphertext, word("f"))).toEqual(witness);
    expect(() => openV13Witness(word("2"), sealed.ciphertext, word("f"))).toThrow();
    expect(() => openV13Witness(word("1"), sealed.ciphertext, word("e"))).toThrow();
  });
  it("allows only one worker to claim an action and preserves it across reconnect", async () => {
    let journal = await PostgresV13BatchJournal.connect("memory://v13-journal");
    await journal.prepare(word("2"), "route", { amount: "1000000" });
    const claims = await Promise.all([journal.claim(word("2"), "route"), journal.claim(word("2"), "route")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await journal.recordBroadcast(word("2"), "route", word("3"));
    await journal.close();
    journal = await PostgresV13BatchJournal.connect("memory://v13-journal");
    try {
      expect(await journal.claim(word("2"), "route")).toBeNull();
      expect((await journal.get(word("2"), "route"))?.txHash).toBe(word("3"));
      await expect(journal.prepare(word("2"), "route", { amount: "1000001" })).rejects.toThrow("different");
      await journal.recordConfirmed(word("2"), "route");
      expect(await journal.listUnresolved()).toEqual([]);
    } finally { await journal.close(); }
  });
  it("retains an immutable private witness after reconnect", async () => {
    let vault = await PostgresV13WitnessVault.connect("memory://v13-journal", word("f"));
    const witness = { deposit: 123n, secret: word("c") };
    await vault.put(word("4"), witness);
    await vault.close();
    vault = await PostgresV13WitnessVault.connect("memory://v13-journal", word("f"));
    try {
      expect(await vault.get(word("4"))).toEqual(witness);
      await expect(vault.put(word("4"), { ...witness, deposit: 124n })).rejects.toThrow("Different");
    } finally { await vault.close(); }
  });
});
