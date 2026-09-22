import { describe, expect, it, vi } from "vitest";

vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  return { Pool: newDb().adapters.createPg().Pool };
});

import { PostgresV11BatchJournal } from "./v11BatchJournal.js";

const hash = `0x${"ab".repeat(32)}`;

describe("v11 PostgreSQL batch journal SQL", () => {
  it("preserves immutable route parameters and claims exactly once", async () => {
    const journal = await PostgresV11BatchJournal.connect("memory://v11");
    try {
      expect((await journal.prepare("1001", "route", { usdc: "100" })).state).toBe("prepared");
      expect((await journal.prepare("1001", "route", { usdc: "100" })).state).toBe("prepared");
      await expect(journal.prepare("1001", "route", { usdc: "101" }))
        .rejects.toThrow(/different v11 batch action/);
      const [a, b] = await Promise.all([journal.claim("1001", "route"), journal.claim("1001", "route")]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      await journal.recordBroadcast("1001", "route", hash);
      expect((await journal.get("1001", "route"))?.txHash).toBe(hash);
      await journal.recordConfirmed("1001", "route");
      expect((await journal.get("1001", "route"))?.state).toBe("confirmed");
      expect(await journal.claim("1001", "route")).toBeNull();
      await journal.prepare("1002", "return_pusd", { amount: "100" });
      await journal.claim("1002", "return_pusd");
      await journal.recordUncertain("1002", "return_pusd", "timeout");
      expect(await journal.claim("1002", "return_pusd")).toBeNull();
      expect((await journal.listUnresolved()).some((intent) => intent.batchId === "1002")).toBe(true);
    } finally {
      await journal.close();
    }
  });

});
