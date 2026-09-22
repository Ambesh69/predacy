import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresV11BatchJournal } from "./v11BatchJournal.js";

const databaseUrl = process.env.TEST_V11_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL v11 batch journal", () => {
  it("persists exact parameters and atomically claims a route once", async () => {
    const journal = await PostgresV11BatchJournal.connect(databaseUrl!);
    const batchId = String(BigInt(`0x${randomUUID().replaceAll("-", "")}`));
    const hash = `0x${"ab".repeat(32)}`;
    try {
      await journal.prepare(batchId, "route", { usdc: "100", yes: "0", no: "0" });
      await expect(journal.prepare(batchId, "route", { usdc: "101", yes: "0", no: "0" }))
        .rejects.toThrow(/different v11 batch action/);
      const [a, b] = await Promise.all([journal.claim(batchId, "route"), journal.claim(batchId, "route")]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      await journal.recordBroadcast(batchId, "route", hash);
      expect((await journal.get(batchId, "route"))?.txHash).toBe(hash);
      await journal.recordConfirmed(batchId, "route");
      expect(await journal.claim(batchId, "route")).toBeNull();
      expect((await journal.get(batchId, "route"))?.state).toBe("confirmed");
    } finally {
      await journal.close();
    }
  });
});
