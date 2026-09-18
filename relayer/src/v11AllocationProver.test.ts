import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { buildV11AllocationInputs, proveV11Allocation } from "./v11AllocationProver.js";

const marketId = `0x${"01".repeat(32)}` as const;
const salt = `0x${"02".repeat(32)}` as const;
const commitment = keccak256(encodeAbiParameters(
  [{ type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
  [marketId, 2, 410_000n, 420_000n, salt],
));

describe("v11 allocation witness", () => {
  it("matches the Noir circuit's public input layout", () => {
    const inputs = buildV11AllocationInputs({
      marketId, commitment, salt, side: 2,
      deposit: 410_000n, limitPrice: 420_000n,
      filledShares: 1_000_000n, usdcSettled: 405_000n, refund: 5_000n,
    });
    expect(inputs.market_hi).toBe(BigInt(`0x${"01".repeat(16)}`).toString());
    expect(inputs.side).toBe("2");
    expect(inputs.usdc_settled).toBe("405000");
    expect(inputs.refund).toBe("5000");
  });

  it("rejects a mismatched commitment before invoking the prover", () => {
    expect(() => buildV11AllocationInputs({
      marketId, commitment: marketId, salt, side: 2,
      deposit: 410_000n, limitPrice: 420_000n,
      filledShares: 0n, usdcSettled: 0n, refund: 410_000n,
    })).toThrow(/does not match/);
  });

  it.skipIf(process.env.RUN_V11_NATIVE_PROOF !== "1")("generates a real EVM proof from the packaged artifact", async () => {
    const result = await proveV11Allocation({
      marketId, commitment, salt, side: 2,
      deposit: 410_000n, limitPrice: 420_000n,
      filledShares: 1_000_000n, usdcSettled: 405_000n, refund: 5_000n,
    });
    expect(result.publicInputs).toHaveLength(9);
    expect(result.proof.length).toBeGreaterThan(1000);
  });
});
