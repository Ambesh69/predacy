export interface Order {
  trader: `0x${string}`;
  isBuy: boolean;
  amount: bigint;        // USDC, 6 decimals
  limitPrice: bigint;    // 6-decimal fixed point (e.g. 650000n = $0.65)
  salt: `0x${string}`;
}

export interface Commitment {
  hash: `0x${string}`;
  amount: bigint;
  trader: `0x${string}`;
  index: number;
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
  commitmentCount: bigint;
  commitmentRoot: `0x${string}`;
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
}
