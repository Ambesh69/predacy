/// @notice Order side — mirrors all 4 Polymarket CLOB order types.
///         Values match the OrderSide enum in BatchVault.sol.
export enum OrderSide {
  YES_BUY  = 0, // pay USDC → receive YES tokens  (EIP-3009 deferred)
  YES_SELL = 1, // deposit YES tokens → receive USDC
  NO_BUY   = 2, // pay USDC → receive NO tokens   (EIP-3009 deferred)
  NO_SELL  = 3, // deposit NO tokens → receive USDC
}

/// @notice EIP-3009 TransferWithAuthorization components.
///         Signed off-chain by the user at order time; submitted by the relayer
///         at settlement for filled BUY orders (YES_BUY and NO_BUY) only.
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
  side:         OrderSide;     // YES_BUY / YES_SELL / NO_BUY / NO_SELL (replaces isBuy)
  amount:       bigint;        // USDC for BUY orders, token qty for SELL orders (6 decimals)
  limitPrice:   bigint;        // 6-decimal fixed point (e.g. 650000n = $0.65 for YES)
  salt:         `0x${string}`;
  transferAuth?: TransferAuth; // EIP-3009 auth for BUY orders — collected at settlement
  requeueAuths?: RequeueAuth[]; // pre-signed sigs for auto-requeue (buy orders only)
}

export interface Commitment {
  hash:   `0x${string}`;
  amount: bigint;
  index:  number;
  // Note: no `trader` field — the Commitment struct does not store trader address
}

export interface BatchInfo {
  batchId: bigint;
  marketId: `0x${string}`;
  openedAt: bigint;
  closedAt: bigint;
  status: BatchStatus;
  totalDeposited: bigint;    // USDC authorized by YES buyers
  totalDepositedNo: bigint;  // USDC authorized by NO buyers
  totalSellYes: bigint;      // YES tokens deposited by YES sellers
  totalSellNo: bigint;       // NO tokens deposited by NO sellers
  clearingPrice: bigint;
  commitmentCount: bigint;
  commitmentRoot: `0x${string}`;
  claimMerkleRoot: `0x${string}`;
  // v9 two-phase settlement state (set by lockFunds, consumed by settleBatch)
  filledYesBuyVol:  bigint;
  filledNoBuyVol:   bigint;
  filledYesSellQty: bigint;
  filledNoSellQty:  bigint;
  yesGap:           bigint;  // YES tokens relayer must deliver in settleBatch
  noGap:            bigint;  // NO  tokens relayer must deliver in settleBatch
  finalExcessYes:   bigint;  // YES sent to relayer; relayer returns USDC proceeds
  finalExcessNo:    bigint;  // NO  sent to relayer; relayer returns USDC proceeds
}

export enum BatchStatus {
  OPEN     = 0,
  SETTLING = 1,
  LOCKED   = 2,  // Between lockFunds and settleBatch (v9 two-phase)
  SETTLED  = 3,
}

export interface ClearingResult {
  clearingPrice: bigint;
  filledYesBuyVol: bigint;   // USDC from filled YES_BUY orders
  filledNoBuyVol: bigint;    // USDC from filled NO_BUY orders
  filledYesSellQty: bigint;  // YES tokens from filled YES_SELL orders
  filledNoSellQty: bigint;   // NO tokens from filled NO_SELL orders
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
