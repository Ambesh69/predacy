import type { DepositWalletClient } from "./depositWalletClient.js";
import { getAddress, type Address } from "viem";

type TradePage = Awaited<ReturnType<ReturnType<DepositWalletClient["listAccountTrades"]>["firstPage"]>>;
type AccountTrade = TradePage["items"][number];

export interface V11TradeEvidence {
  tradeIds: string[];
  transactionHashes: string[];
  pendingTradeIds: string[];
  failedTradeIds: string[];
}

export type V11TradeReader = Pick<DepositWalletClient, "listAccountTrades">;

export interface V11ReceiptReader {
  getTransactionReceipt(request: { hash: `0x${string}` }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
  }>;
  getBlockNumber(): Promise<bigint>;
}

export interface V11OrderRecord {
  id: string;
  conditionId: string;
  tokenId: string;
  makerAddress: string;
  side: string;
  orderType: string;
  status: string;
  sizeMatched: string;
  associateTrades: string[];
}

function parseShares(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Invalid matched-share amount from CLOB");
  }
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"));
}

/** FAK may be delayed; only a terminal order plus every confirmed fill permits asset return. */
export async function verifyV11TerminalOrder(
  order: V11OrderRecord,
  expected: { orderId: string; marketId: string; tokenId: bigint; maker: Address; side: "BUY" | "SELL" },
  evidence: V11TradeEvidence,
  receipts: V11ReceiptReader,
): Promise<{ filledShares: bigint; confirmedTradeCount: number }> {
  if (order.id !== expected.orderId ||
      order.conditionId.toLowerCase() !== expected.marketId.toLowerCase() ||
      order.tokenId !== expected.tokenId.toString() ||
      getAddress(order.makerAddress) !== getAddress(expected.maker) ||
      order.side !== expected.side || order.orderType !== "FAK") {
    throw new Error("CLOB order identity differs from the journaled v11 leg");
  }
  if (!["MATCHED", "CANCELED", "CANCELED_MARKET_RESOLVED", "INVALID"].includes(order.status)) {
    throw new Error("CLOB FAK order is still live, delayed, or has an unknown status");
  }
  if (evidence.pendingTradeIds.length || evidence.failedTradeIds.length) {
    throw new Error("CLOB trade settlement is not final");
  }
  const associated = new Set(order.associateTrades);
  const confirmed = new Set(evidence.tradeIds);
  if (associated.size !== confirmed.size || [...associated].some((id) => !confirmed.has(id))) {
    throw new Error("CLOB order and trade history disagree");
  }
  const filledShares = parseShares(order.sizeMatched);
  if ((filledShares === 0n) !== (confirmed.size === 0)) {
    throw new Error("CLOB matched size and confirmed trades disagree");
  }
  if (confirmed.size > 0) await verifyV11TradeReceipts(receipts, evidence);
  return { filledShares, confirmedTradeCount: confirmed.size };
}

function belongsToOrder(trade: AccountTrade, orderId: string): boolean {
  return trade.takerOrderId === orderId ||
    trade.makerOrders.some((order) => order.orderId === orderId);
}

/** Read-only evidence. The caller must also verify Polygon receipts and wallet balance deltas. */
export async function collectV11TradeEvidence(
  client: V11TradeReader,
  marketId: string,
  orderId: string,
  maxPages = 20,
): Promise<V11TradeEvidence> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId) || !orderId || maxPages < 1) {
    throw new Error("Invalid v11 trade reconciliation request");
  }
  const paginator = client.listAccountTrades({ market: marketId });
  const first = await paginator.firstPage();
  const matched = new Map<string, AccountTrade>();
  const addPage = (page: { items: AccountTrade[] }) => {
    for (const trade of page.items) {
      if (belongsToOrder(trade, orderId)) matched.set(trade.id, trade);
    }
  };
  addPage(first);
  let pages = 1;
  if (first.nextCursor) {
    for await (const page of paginator.from(first.nextCursor)) {
      addPage(page);
      pages++;
      if (pages >= maxPages) {
        if (page.nextCursor) throw new Error("Trade history exceeds reconciliation page limit; manual review required");
        break;
      }
    }
  }

  const tradeIds: string[] = [];
  const transactionHashes: string[] = [];
  const pendingTradeIds: string[] = [];
  const failedTradeIds: string[] = [];
  for (const trade of matched.values()) {
    tradeIds.push(trade.id);
    if (trade.status === "CONFIRMED" || trade.status === "TRADE_STATUS_CONFIRMED") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(trade.transactionHash)) {
        pendingTradeIds.push(trade.id);
      } else {
        transactionHashes.push(trade.transactionHash);
      }
    } else if (trade.status === "FAILED" || trade.status === "TRADE_STATUS_FAILED") {
      failedTradeIds.push(trade.id);
    } else {
      pendingTradeIds.push(trade.id);
    }
  }
  return { tradeIds, transactionHashes, pendingTradeIds, failedTradeIds };
}

/** Receipt finality is necessary, but not sufficient: compare wallet asset deltas as well. */
export async function verifyV11TradeReceipts(
  reader: V11ReceiptReader,
  evidence: V11TradeEvidence,
  minConfirmations = 20n,
): Promise<void> {
  if (minConfirmations < 1n || evidence.pendingTradeIds.length || evidence.failedTradeIds.length ||
      evidence.transactionHashes.length === 0 ||
      evidence.transactionHashes.length !== evidence.tradeIds.length) {
    throw new Error("CLOB trades are not fully confirmed");
  }
  const head = await reader.getBlockNumber();
  for (const hash of new Set(evidence.transactionHashes)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid CLOB settlement transaction hash");
    const receipt = await reader.getTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status !== "success" || receipt.blockNumber > head ||
        head - receipt.blockNumber + 1n < minConfirmations) {
      throw new Error("CLOB settlement receipt is reverted or not final");
    }
  }
}
