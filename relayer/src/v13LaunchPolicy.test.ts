import { describe, expect, it } from "vitest";
import { resolveV13LaunchPolicy } from "./v13LaunchPolicy.js";

describe("v13 launch policy", () => {
  it("defaults closed", () => expect(resolveV13LaunchPolicy(137, {})).toEqual({
    enabled: false, blocker: "V13 private intake is disabled",
  }));
  it("requires both mainnet privacy acknowledgements", () => {
    expect(resolveV13LaunchPolicy(137, { V13_PRIVATE_TRADING_ENABLED: "true" }).enabled).toBe(false);
    expect(resolveV13LaunchPolicy(137, { V13_PRIVATE_TRADING_ENABLED: "true",
      V13_ACCEPT_PUBLIC_AGGREGATE_EXECUTION: "true" }).enabled).toBe(false);
    expect(resolveV13LaunchPolicy(137, { V13_PRIVATE_TRADING_ENABLED: "true",
      V13_ACCEPT_PUBLIC_AGGREGATE_EXECUTION: "true", V13_TRUST_RELAYER_WITH_WITNESSES: "true" }).enabled).toBe(true);
  });
});
