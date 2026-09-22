import { describe, expect, it, vi } from "vitest";

vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  return { Pool: newDb().adapters.createPg().Pool };
});

import { PostgresV11PilotBudget } from "./v11PilotBudget.js";

describe("v11 pilot budget", () => {
  it("caps total routed exposure at $10 and makes restart reservation idempotent", async () => {
    await expect(PostgresV11PilotBudget.connect("memory://pilot", 10_000_001n))
      .rejects.toThrow(/no greater than \$10/);
    const budget = await PostgresV11PilotBudget.connect("memory://pilot", 10_000_000n);
    try {
      await budget.reserve("1", 4_000_000n);
      await budget.reserve("1", 4_000_000n);
      await budget.reserve("2", 6_000_000n);
      await expect(budget.reserve("3", 1n)).rejects.toThrow(/exceed/);
      await expect(budget.reserve("1", 5_000_000n)).rejects.toThrow(/different amount/);
    } finally {
      await budget.close();
    }
  });
});
