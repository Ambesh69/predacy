/// @notice EIP-3009 TransferWithAuthorization components.
///         Signed off-chain by the user at order time; submitted by the relayer
///         at settlement for filled buy orders only.
export interface TransferAuth {
  from:        `0x${string}`; // ephemeral wallet address (source of USDC pull)
  validAfter:  bigint;         // 0 = valid immediately
  validBefore: bigint;         // expiry unix timestamp
  nonce:       `0x${string}`; // random bytes32 chosen by user
  v:           number;        // ECDSA component (27 or 28)
  r:           `0x${string}`; // ECDSA component
  s:           `0x${string}`; // ECDSA component
}

/// @notice Pre-signed CommitOrder requeue authorization.
///         Frontend pre-signs 2 extra CommitOrder EIP-712 sigs (nonce+1, nonce+2)
///         at order submission time using the ephemeral wallet.
///         If the order is excluded at clearing, the relayer uses these to resubmit
///         automatically to the next batch — zero extra UX friction for the user.
///         (batchId is no longer part of the CommitOrder EIP-712 type in v6 contract,
///          so each sig is valid for whatever batch is currently open.)
export interface RequeueAuth {
  ephemeral: `0x${string}`; // ephemeral wallet address (signer)
  nonce:     bigint;        // on-chain nonce[ephemeral] at signing time
  deadline:  bigint;        // signature expiry unix timestamp
  signature: `0x${string}`; // EIP-712 CommitOrder sig (no batchId field)
}

export interface Order {
  trader:       `0x${string}`;
  isBuy:        boolean;
  amount:       bigint;        // USDC, 6 decimals
  limitPrice:   bigint;        // 6-decimal fixed point (e.g. 650000n = $0.65)
  salt:         `0x${string}`;
  transferAuth?: TransferAuth; // EIP-3009 auth for buy orders — collected at settlement
  requeueAuths?: RequeueAuth[]; // pre-signed sigs for auto-requeue (buy orders only)
}

export interface Commitment {
  hash:   `0x${string}`;
  amount: bigint;
  index:  number;
  // Note: no `trader` field — the new Commitment struct does not store trader address
}

export interface BatchInfo {
  batchId: bigint;
  marketId: `0x${string}`;
  openedAt: bigint;
  closedAt: bigint;
  status: BatchStatus;
  totalDeposited: bigint;
  clearingPrice: bigint;
  netBuyAmount: bigint;
  yesTokensReceived: bigint;
  filledSellYes: bigint;
  totalFilledBuyVol: bigint;
  commitmentCount: bigint;
  commitmentRoot: `0x${string}`;
  claimMerkleRoot: `0x${string}`;
}

export enum BatchStatus {
  OPEN = 0,
  SETTLING = 1,
  SETTLED = 2,
}

export interface ClearingResult {
  clearingPrice: bigint;
  filledBuyVolume: bigint;
  filledSellVolume: bigint;  // YES token count from filled sell orders
  filledSellYes: bigint;     // same as filledSellVolume — explicit alias for clarity
  netBuyAmount: bigint;
  netSellYes: bigint;        // YES tokens to sell on Polymarket (sell-heavy batches)
  filledOrders: Order[];
  unfilledOrders: Order[];
}

export interface PolymarketMarket {
  conditionId: string;
  questionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  tokens: Array<{ token_id: string; outcome: string }>;
  clobTokenIds?: string[];
  /** Live price fields — present when fetched via the Gamma /events endpoint. */
  bestBid?:        number;
  bestAsk?:        number;
  lastTradePrice?: number;
}
