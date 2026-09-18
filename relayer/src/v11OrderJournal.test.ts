import { describe, expect, it, vi } from "vitest";
import type { SignedOrder } from "@polymarket/client";

vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  return { Pool: newDb().adapters.createPg().Pool };
});

import { PostgresV11OrderJournal } from "./v11OrderJournal.js";

const signed = { salt: "1", maker: "0x01" } as unknown as SignedOrder;

describe("v11 PostgreSQL journal SQL", () => {
  it("preserves one immutable signed order and one submission claim", async () => {
    const journal = await PostgresV11OrderJournal.connect("memory://v11");
    try {
      expect((await journal.prepare("1001", "buy-0", signed)).state).toBe("prepared");
      expect((await journal.prepare("1001", "buy-0", signed)).state).toBe("prepared");
      await expect(journal.prepare("1001", "buy-0", { ...signed, salt: "2" }))
        .rejects.toThrow(/different signed order/);
      const [first, second] = await Promise.all([
        journal.claimForSubmission("1001", "buy-0"),
        journal.claimForSubmission("1001", "buy-0"),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      await journal.recordAccepted("1001", "buy-0", "clob-order-1", { ok: true, status: "delayed" });
      expect((await journal.get("1001", "buy-0"))?.orderId).toBe("clob-order-1");
      expect((await journal.listUnresolved()).map((entry) => entry.legId)).toContain("buy-0");
      expect(await journal.claimForSubmission("1001", "buy-0")).toBeNull();
      await expect(journal.recordRejected("1001", "buy-0", { ok: false }))
        .rejects.toThrow(/transition/);
    } finally {
      await journal.close();
    }
  });
});
