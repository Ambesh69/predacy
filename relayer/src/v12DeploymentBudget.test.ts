import { describe, expect, it } from "vitest";
import {
  addDeploymentSafetyMargin,
  remainingV12DeploymentGas,
  type V12DeploymentState,
} from "./v12DeploymentBudget.js";

const nothingDeployed: V12DeploymentState = {
  transcriptLibrary: false,
  verifiers: { withdraw: false, transfer: false, order: false, buyBatch: false },
  poolAndAdapter: false,
};

describe("v12 deployment budget", () => {
  it("matches the measured full deployment gas", () => {
    expect(remainingV12DeploymentGas(nothingDeployed)).toBe(26_792_703n);
  });

  it("does not charge for the already deployed withdrawal library", () => {
    const state = structuredClone(nothingDeployed);
    state.transcriptLibrary = true;
    expect(remainingV12DeploymentGas(state)).toBe(25_458_834n);
  });

  it("skips a complete verifier and applies a ten percent margin", () => {
    const state = structuredClone(nothingDeployed);
    state.transcriptLibrary = true;
    state.verifiers.withdraw = true;
    const gas = remainingV12DeploymentGas(state);
    expect(gas).toBe(20_277_697n);
    expect(addDeploymentSafetyMargin(gas)).toBe(22_305_467n);
  });
});
