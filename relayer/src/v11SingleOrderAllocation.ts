import {
  validateSettlementAccounting,
  type ExternalExecution,
  type OrderAllocation,
  type Side,
} from "./settlementAccounting.js";

export interface V11WalletBalances {
  pusd: bigint;
  yes: bigint;
  no: bigint;
}

export interface V11SingleOrderSettlement {
  side: Side;
  deposit: bigint;
  limitPrice: bigint;
  walletBeforeRoute: V11WalletBalances;
  walletAfterTerminalOrder: V11WalletBalances;
  terminalOrderConfirmed: boolean;
  confirmedTradeCount: number;
  matchedShares: bigint;
}

export interface V11SingleOrderReturn {
  allocation: OrderAllocation;
  returnPusd: bigint;
  returnYes: bigint;
  returnNo: bigint;
}

/** Dedicated, empty Deposit Wallet only; mixed funds cannot be attributed to a user. */
export function planV11SingleOrderReturn(input: V11SingleOrderSettlement): V11SingleOrderReturn {
  const { side, deposit, limitPrice, walletBeforeRoute: before, walletAfterTerminalOrder: after } = input;
  if (!input.terminalOrderConfirmed || !Number.isSafeInteger(input.confirmedTradeCount) ||
      input.confirmedTradeCount < 0 || input.matchedShares < 0n || deposit <= 0n ||
      before.pusd !== 0n || before.yes !== 0n || before.no !== 0n ||
      after.pusd < 0n || after.yes < 0n || after.no < 0n) {
    throw new Error("V11 settlement needs terminal CLOB evidence and an isolated Deposit Wallet");
  }

  const isBuy = side === "YES_BUY" || side === "NO_BUY";
  const isYes = side === "YES_BUY" || side === "YES_SELL";
  const outcome = isYes ? after.yes : after.no;
  const opposite = isYes ? after.no : after.yes;
  if (opposite !== 0n || (isBuy ? after.pusd > deposit : outcome > deposit)) {
    throw new Error("Deposit Wallet balance does not belong solely to this order");
  }

  const filledShares = isBuy ? outcome : deposit - outcome;
  const usdcPayout = isBuy ? deposit - after.pusd : after.pusd;
  if (filledShares !== input.matchedShares ||
      (filledShares === 0n) !== (usdcPayout === 0n) ||
      (filledShares > 0n && input.confirmedTradeCount === 0) ||
      (filledShares === 0n && input.confirmedTradeCount > 0)) {
    throw new Error("CLOB trade evidence and wallet deltas disagree");
  }

  const allocation: OrderAllocation = {
    side, deposit, limitPrice, filledShares, usdcPayout,
    refund: isBuy ? after.pusd : outcome,
  };
  const external: ExternalExecution = {
    usdcSpent: isBuy ? usdcPayout : 0n,
    usdcReceived: isBuy ? 0n : usdcPayout,
    yesBought: side === "YES_BUY" ? filledShares : 0n,
    yesSold: side === "YES_SELL" ? filledShares : 0n,
    noBought: side === "NO_BUY" ? filledShares : 0n,
    noSold: side === "NO_SELL" ? filledShares : 0n,
  };
  const totals = validateSettlementAccounting({
    orders: [allocation], splitShares: 0n, mergedShares: 0n, external,
  });
  if (totals.usdc !== after.pusd || totals.yes !== after.yes || totals.no !== after.no) {
    throw new Error("V11 wallet returns do not conserve escrowed assets");
  }
  return { allocation, returnPusd: after.pusd, returnYes: after.yes, returnNo: after.no };
}
