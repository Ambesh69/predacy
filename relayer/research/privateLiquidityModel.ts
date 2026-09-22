// Offline metadata/economic model only. No encryption, proofs, RPC, or order execution.
export interface ModelTrade {
  token: string;
  direction: "buy" | "sell";
  shares: bigint;
  cash: bigint;
}
export interface PublicHedge extends ModelTrade { epoch: number }
export interface PublicEpoch { epoch: number; slots: number; hedges: PublicHedge[] }
export interface ReserveState { cash: bigint; inventory: Record<string, bigint> }

export function aggregateFlow(trades: readonly ModelTrade[]): Array<{ token: string; netShares: bigint }> {
  const totals = new Map<string, bigint>();
  for (const trade of trades) {
    totals.set(trade.token, (totals.get(trade.token) ?? 0n) +
      (trade.direction === "buy" ? trade.shares : -trade.shares));
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([token, netShares]) => ({ token, netShares }));
}

export function publicEpoch(plan: readonly PublicHedge[], epoch: number, slots: number): PublicEpoch {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(slots) || slots <= 0) {
    throw new Error("Invalid public epoch");
  }
  // No access to customer flow. Equality is about metadata, not real proof/ciphertext bytes.
  return { epoch, slots, hedges: plan.filter((item) => item.epoch === epoch).map((item) => ({ ...item })) };
}

export function admitTrade(state: ReserveState, trade: ModelTrade):
  { accepted: boolean; next: ReserveState } {
  if (!trade.token || !["buy", "sell"].includes(trade.direction) || trade.shares <= 0n || trade.cash < 0n ||
      state.cash < 0n || Object.values(state.inventory).some((amount) => amount < 0n)) {
    throw new Error("Invalid reserve-model input");
  }
  const next = { cash: state.cash, inventory: { ...state.inventory } };
  const inventory = next.inventory[trade.token] ?? 0n;
  if (trade.direction === "buy") {
    if (inventory < trade.shares) return { accepted: false, next };
    next.inventory[trade.token] = inventory - trade.shares;
    next.cash += trade.cash;
  } else {
    if (state.cash < trade.cash) return { accepted: false, next };
    next.inventory[trade.token] = inventory + trade.shares;
    next.cash -= trade.cash;
  }
  return { accepted: true, next };
}

export function inventoryBound(supportedTokens: number, maxSharesPerToken: bigint, sellCashBuffer: bigint) {
  if (!Number.isSafeInteger(supportedTokens) || supportedTokens <= 0 || maxSharesPerToken < 0n || sellCashBuffer < 0n) {
    throw new Error("Invalid inventory bound");
  }
  // This is a quantity bound, not a dollar valuation or a complete-set collateral calculation.
  return { totalShares: BigInt(supportedTokens) * maxSharesPerToken, sellCashBuffer };
}

export function simulateInventoryEpoch(initial: ReserveState, trades: readonly ModelTrade[],
  plan: readonly PublicHedge[], epoch: number, slots: number) {
  if (trades.length > slots) throw new Error("Experiment exceeds modeled epoch capacity");
  let state = initial;
  const receipts: boolean[] = [];
  for (const trade of trades) {
    const result = admitTrade(state, trade);
    state = result.next;
    receipts.push(result.accepted);
  }
  return { public: publicEpoch(plan, epoch, slots), private: { state, receipts } };
}
