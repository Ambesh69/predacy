import { describe, expect, it, vi } from "vitest";

vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  return { Pool: newDb().adapters.createPg().Pool };
});

import {
  openV12Witness, PostgresV12BatchJournal, PostgresV12WitnessVault, sealV12Witness,
} from "./v12BatchJournal.js";

const batchId = `0x${"12".repeat(32)}`;
const otherBatch = `0x${"13".repeat(32)}`;
const txHash = `0x${"ab".repeat(32)}`;
const key = `0x${"44".repeat(32)}`;

describe("v12 encrypted PostgreSQL journal", () => {
  it("encrypts bigint witnesses and binds ciphertext to one batch", () => {
    const witness = { deposit: 1_350_000n, secret: `0x${"aa".repeat(32)}` };
    const sealed = sealV12Witness(batchId, witness, key);
    expect(sealed.ciphertext).not.toContain("1350000");
    expect(openV12Witness(batchId, sealed.ciphertext, key)).toEqual(witness);
    expect(() => openV12Witness(otherBatch, sealed.ciphertext, key)).toThrow();
    expect(() => openV12Witness(batchId, sealed.ciphertext, `0x${"45".repeat(32)}`)).toThrow();
  });

  it("stores one immutable encrypted witness without plaintext JSON", async () => {
    const vault = await PostgresV12WitnessVault.connect("memory://v12-witness", key);
    try {
      const witness = { orders: [{ deposit: 600_000n, salt: `0x${"aa".repeat(32)}` }] };
      await vault.put(batchId, witness);
      await vault.put(batchId, witness);
      expect(await vault.get(batchId)).toEqual(witness);
      await expect(vault.put(batchId, { orders: [{ deposit: 600_001n }] }))
        .rejects.toThrow(/different private witness/);
    } finally {
      await vault.close();
    }
  });

  it("claims each public chain action once and quarantines uncertainty", async () => {
    const journal = await PostgresV12BatchJournal.connect("memory://v12-actions");
    try {
      expect((await journal.prepare(batchId, "route", { totalDeposit: "100" })).state).toBe("prepared");
      const [a, b] = await Promise.all([journal.claim(batchId, "route"), journal.claim(batchId, "route")]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      await journal.recordBroadcast(batchId, "route", txHash);
      await journal.recordConfirmed(batchId, "route");
      expect((await journal.get(batchId, "route"))?.state).toBe("confirmed");

      await journal.prepare(otherBatch, "withdraw_pusd", { amount: "100" });
      await journal.claim(otherBatch, "withdraw_pusd");
      await journal.recordUncertain(otherBatch, "withdraw_pusd", "timeout");
      expect(await journal.claim(otherBatch, "withdraw_pusd")).toBeNull();
      expect((await journal.listUnresolved()).map((entry) => entry.batchId)).toContain(otherBatch);
    } finally {
      await journal.close();
    }
  });
});
