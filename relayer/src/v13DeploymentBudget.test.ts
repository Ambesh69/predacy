import { describe, expect, it } from "vitest";
import { remainingV13DeploymentGas, v13DeploymentCostWei } from "./v13DeploymentBudget.js";

const nothingDeployed = {
  verifiers: { order: false, route: false, settlement: false, cancel: false },
  poolAndAdapter: false,
};

describe("v13 deployment budget", () => {
  it("matches the measured five-script deployment", () => {
    expect(remainingV13DeploymentGas(nothingDeployed)).toBe(32_892_461n);
  });

  it("skips completed deployments", () => {
    expect(remainingV13DeploymentGas({
      verifiers: { ...nothingDeployed.verifiers, order: true, route: true },
      poolAndAdapter: false,
    })).toBe(19_420_476n);
  });

  it("prices a ten-percent EIP-1559 reserve", () => {
    expect(v13DeploymentCostWei(32_892_461n, 280_000_000_000n)).toBe(10_130_877_988_000_000_000n);
  });
});
