import {
  USDC_DECIMALS,
  MIN_ORDER_AMOUNT_USDC,
  MAX_ORDER_AMOUNT_USDC,
} from "./constants";

/**
 * Parse a USDC amount string into bigint (6 decimal places).
 * Returns null if the input is invalid.
 *
 * @example
 * parseUsdcAmount("100") // 100_000_000n
 * parseUsdcAmount("0.5") // 500_000n
 * parseUsdcAmount("abc") // null
 * parseUsdcAmount("-10") // null
 */
export function parseUsdcAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const num = parseFloat(trimmed);

  // Check for invalid number
  if (isNaN(num) || !isFinite(num)) return null;

  // Check bounds
  if (num < MIN_ORDER_AMOUNT_USDC || num > MAX_ORDER_AMOUNT_USDC) return null;

  // Convert to bigint with 6 decimals
  const multiplier = 10 ** USDC_DECIMALS;
  return BigInt(Math.round(num * multiplier));
}

/**
 * Format a bigint USDC amount (6 decimals) to a human-readable string.
 *
 * @example
 * formatUsdcAmount(100_000_000n) // "100.00"
 * formatUsdcAmount(500_000n)    // "0.50"
 */
export function formatUsdcAmount(amount: bigint, decimals = 2): string {
  const divisor = 10 ** USDC_DECIMALS;
  const value = Number(amount) / divisor;
  return value.toFixed(decimals);
}

/**
 * Validate that a hex string is a valid Ethereum address.
 *
 * @example
 * isValidAddress("0x1234...") // true
 * isValidAddress("not-an-address") // false
 */
export function isValidAddress(address: string): address is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate that a hex string is a valid bytes32 hash.
 *
 * @example
 * isValidBytes32("0x" + "a".repeat(64)) // true
 * isValidBytes32("0x123") // false
 */
export function isValidBytes32(hash: string): hash is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

/**
 * Extract error message from unknown error type.
 * Use this in catch blocks instead of `any`.
 *
 * @example
 * try { ... } catch (err: unknown) {
 *   const message = getErrorMessage(err);
 * }
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred";
}
