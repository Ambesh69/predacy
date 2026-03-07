import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Compute a sealed-bid order commitment.
 * Matches BatchVault.sol's commitment verification exactly.
 *
 * commitment = keccak256(abi.encode(marketId, side, amount, limitPrice, salt))
 *
 * side: 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL  (matches OrderSide enum in BatchVault v8)
 *
 * Note: `trader` address is NOT included in the commitment hash.
 * The 256-bit salt is the secret credential — only the holder of the salt can
 * reconstruct the commitment and generate a valid ZK claim proof.
 */
export function computeCommitment(params: {
  marketId: `0x${string}`;
  side: number;         // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
  amount: bigint;       // USDC (buy) or token qty (sell), 6 decimals
  limitPrice: bigint;   // 6-decimal fixed point
  salt: `0x${string}`;  // random 32 bytes (the secret credential)
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint8, uint256, uint256, bytes32"),
      [params.marketId, params.side, params.amount, params.limitPrice, params.salt]
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
