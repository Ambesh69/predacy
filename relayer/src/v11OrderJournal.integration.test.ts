import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SignedOrder } from "@polymarket/client";
import { PostgresV11OrderJournal } from "./v11OrderJournal.js";

const databaseUrl = process.env.TEST_V11_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL v11 journal", () => {
  it("persists a signed order and atomically allows only one submitting worker", async () => {
    const journal = await PostgresV11OrderJournal.connect(databaseUrl!);
    const batchId = String(BigInt(`0x${randomUUID().replaceAll("-", "")}`));
    const signed = { salt: randomUUID(), maker: "0x01" } as unknown as SignedOrder;
    try {
      await journal.prepare(batchId, "buy-0", signed);
      await expect(journal.prepare(batchId, "buy-0", { ...signed, salt: "different" }))
        .rejects.toThrow(/different signed order/);
      const [a, b] = await Promise.all([
        journal.claimForSubmission(batchId, "buy-0"),
        journal.claimForSubmission(batchId, "buy-0"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      await journal.recordUncertain(batchId, "buy-0", "test timeout");
      expect(await journal.claimForSubmission(batchId, "buy-0")).toBeNull();
      expect((await journal.get(batchId, "buy-0"))?.state).toBe("uncertain");
      expect((await journal.listUnresolved()).some((entry) => entry.batchId === batchId)).toBe(true);
    } finally {
      await journal.close();
    }
  });
});
