import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Compute a sealed-bid order commitment.
 * Matches BatchVault.sol's commitment verification exactly.
 *
 * commitment = keccak256(abi.encode(marketId, isBuy, amount, limitPrice, salt, trader))
 */
export function computeCommitment(params: {
  marketId: `0x${string}`;
  isBuy: boolean;
  amount: bigint;       // USDC, 6 decimals
  limitPrice: bigint;   // 6-decimal fixed point
  salt: `0x${string}`;  // random 32 bytes
  trader: `0x${string}`;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bool, uint256, uint256, bytes32, address"),
      [params.marketId, params.isBuy, params.amount, params.limitPrice, params.salt, params.trader]
    )
  );
}

/** Generate a random 32-byte salt */
export function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

/** Format USDC amount (6 decimals) to display string */
export function formatUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
}

/** Parse display string to USDC bigint */
export function parseUsdc(display: string): bigint {
  const [whole, frac = ""] = display.split(".");
  const fracPadded = frac.padEnd(6, "0").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}

/** Format price (6-decimal fixed point) to display percentage */
export function formatPrice(price: bigint): string {
  return (Number(price) / 10_000).toFixed(2) + "¢";
}

/** Format price as probability percentage (0-100%) */
export function formatProb(price: bigint): string {
  return (Number(price) / 10_000).toFixed(1) + "%";
}
