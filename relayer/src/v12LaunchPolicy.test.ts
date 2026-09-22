import { describe, expect, it } from "vitest";
import { resolveV12LaunchPolicy } from "./v12LaunchPolicy.js";

describe("v12 launch policy", () => {
  it("keeps disabled intake closed", () => {
    expect(resolveV12LaunchPolicy(137, {})).toEqual({
      enabled: false,
      blocker: "V12 private intake is disabled",
    });
  });

  it("blocks mainnet when public per-order asset linkage is not explicitly accepted", () => {
    const policy = resolveV12LaunchPolicy(137, { V12_PRIVATE_TRADING_ENABLED: "true" });
    expect(policy.enabled).toBe(false);
    expect(policy.blocker).toMatch(/outcome asset/);
  });

  it("requires both independent mainnet gates", () => {
    expect(resolveV12LaunchPolicy(137, {
      V12_PRIVATE_TRADING_ENABLED: "true",
      V12_ACCEPT_PUBLIC_ORDER_LINKAGE: "true",
    })).toEqual({ enabled: true, blocker: null });
  });
});
