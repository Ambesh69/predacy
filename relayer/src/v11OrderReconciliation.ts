import type { DepositWalletClient } from "./depositWalletClient.js";

type TradePage = Awaited<ReturnType<ReturnType<DepositWalletClient["listAccountTrades"]>["firstPage"]>>;
type AccountTrade = TradePage["items"][number];

export interface V11TradeEvidence {
  tradeIds: string[];
  transactionHashes: string[];
  pendingTradeIds: string[];
  failedTradeIds: string[];
}

export interface V11TradeReader {
  listAccountTrades(request: { market: string }): {
    firstPage(): Promise<{ items: AccountTrade[]; nextCursor?: string | null }>;
    from(cursor: string): AsyncIterable<{ items: AccountTrade[]; nextCursor?: string | null }>;
  };
}

export interface V11ReceiptReader {
  getTransactionReceipt(request: { hash: `0x${string}` }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
  }>;
  getBlockNumber(): Promise<bigint>;
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
    if (trade.status === "CONFIRMED") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(trade.transactionHash)) {
        pendingTradeIds.push(trade.id);
      } else {
        transactionHashes.push(trade.transactionHash);
      }
    } else if (trade.status === "FAILED") {
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
