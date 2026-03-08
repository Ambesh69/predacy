/**
 * Returns the relayer URL from the environment, trimmed of any accidental
 * whitespace or newline characters (common when copy-pasting in Vercel dashboard).
 *
 * Using NEXT_PUBLIC_RELAYER_URL?.trim() everywhere is equivalent but verbose —
 * centralising it here makes the intent clear and prevents future regressions.
 */
export function getRelayerUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_RELAYER_URL?.trim() || undefined;
}
