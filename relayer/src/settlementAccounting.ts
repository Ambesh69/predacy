export const PRICE_SCALE = 1_000_000n;

export type Side = "YES_BUY" | "NO_BUY" | "YES_SELL" | "NO_SELL";

export interface OrderAllocation {
  side: Side;
  deposit: bigint;
  limitPrice: bigint;
  filledShares: bigint;
  usdcPayout: bigint;
  refund: bigint;
}

export interface ExternalExecution {
  usdcSpent: bigint;
  usdcReceived: bigint;
  yesBought: bigint;
  yesSold: bigint;
  noBought: bigint;
  noSold: bigint;
}

export interface SettlementAccounting {
  orders: readonly OrderAllocation[];
  splitShares: bigint;
  mergedShares: bigint;
  external: ExternalExecution;
}

export interface AssetTotals {
  usdc: bigint;
  yes: bigint;
  no: bigint;
}

function nonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`${label} must be non-negative`);
}

/**
 * Validate a proposed batch allocation against real net wallet transfers.
 * This is an off-chain mirror of the conservation rules required in v11's proof
 * and vault; it is not an authorization to settle the deployed v10 vault.
 */
export function validateSettlementAccounting(input: SettlementAccounting): AssetTotals {
  const { orders, splitShares, mergedShares, external } = input;
  nonNegative(splitShares, "splitShares");
  nonNegative(mergedShares, "mergedShares");
  for (const [key, value] of Object.entries(external)) nonNegative(value, `external.${key}`);

  const escrow: AssetTotals = { usdc: 0n, yes: 0n, no: 0n };
  const claims: AssetTotals = { usdc: 0n, yes: 0n, no: 0n };

  for (const [index, order] of orders.entries()) {
    const label = `orders[${index}]`;
    for (const key of ["deposit", "filledShares", "usdcPayout", "refund"] as const) {
      nonNegative(order[key], `${label}.${key}`);
    }
    if (order.limitPrice <= 0n || order.limitPrice >= PRICE_SCALE) {
      throw new Error(`${label}.limitPrice must be between zero and one`);
    }

    if (order.side === "YES_BUY" || order.side === "NO_BUY") {
      escrow.usdc += order.deposit;
      if (order.usdcPayout + order.refund !== order.deposit) {
        throw new Error(`${label}: buyer spend plus refund must equal deposit`);
      }
      if ((order.filledShares === 0n) !== (order.usdcPayout === 0n)) {
        throw new Error(`${label}: buyer shares and spend must both be zero or nonzero`);
      }
      if (order.usdcPayout * PRICE_SCALE > order.filledShares * order.limitPrice) {
        throw new Error(`${label}: buyer all-in execution price exceeds limit`);
      }
      claims.usdc += order.refund;
      if (order.side === "YES_BUY") claims.yes += order.filledShares;
      else claims.no += order.filledShares;
    } else {
      const isYes = order.side === "YES_SELL";
      if (isYes) escrow.yes += order.deposit;
      else escrow.no += order.deposit;
      if (order.filledShares + order.refund !== order.deposit) {
        throw new Error(`${label}: seller filled shares plus refund must equal deposit`);
      }
      if ((order.filledShares === 0n) !== (order.usdcPayout === 0n)) {
        throw new Error(`${label}: seller shares and proceeds must both be zero or nonzero`);
      }
      if (order.usdcPayout * PRICE_SCALE < order.filledShares * order.limitPrice) {
        throw new Error(`${label}: seller net execution price is below limit`);
      }
      claims.usdc += order.usdcPayout;
      if (isYes) claims.yes += order.refund;
      else claims.no += order.refund;
    }
  }

  const available: AssetTotals = {
    usdc: escrow.usdc - splitShares + mergedShares - external.usdcSpent + external.usdcReceived,
    yes: escrow.yes + splitShares - mergedShares + external.yesBought - external.yesSold,
    no: escrow.no + splitShares - mergedShares + external.noBought - external.noSold,
  };
  for (const asset of ["usdc", "yes", "no"] as const) {
    if (available[asset] < 0n) throw new Error(`batch has a ${asset} deficit`);
    if (available[asset] !== claims[asset]) {
      throw new Error(`${asset} allocation does not conserve assets`);
    }
  }
  return available;
}
