import { describe, expect, it } from "vitest";
import { collectV11TradeEvidence, verifyV11TerminalOrder, verifyV11TradeReceipts, type V11TradeReader } from "./v11OrderReconciliation.js";

const market = `0x${"11".repeat(32)}`;
const orderId = "order-123";
const txHash = `0x${"22".repeat(32)}`;

function reader(pages: unknown[][]): V11TradeReader {
  return {
    listAccountTrades: () => ({
      firstPage: async () => ({ items: pages[0], nextCursor: pages.length > 1 ? "next" : null }),
      from: async function* () {
        for (let i = 1; i < pages.length; i++) {
          yield { items: pages[i], nextCursor: i + 1 < pages.length ? "next" : null };
        }
      },
    }),
  } as unknown as V11TradeReader;
}

describe("v11 trade reconciliation", () => {
  it("does not treat an accepted order with no trades as a fill", async () => {
    expect(await collectV11TradeEvidence(reader([[]]), market, orderId)).toEqual({
      tradeIds: [], transactionHashes: [], pendingTradeIds: [], failedTradeIds: [],
    });
  });

  it("separates confirmed, pending, and failed trades across pages", async () => {
    const result = await collectV11TradeEvidence(reader([
      [
        { id: "confirmed", takerOrderId: orderId, makerOrders: [], status: "CONFIRMED", transactionHash: txHash },
        { id: "other", takerOrderId: "different", makerOrders: [], status: "CONFIRMED", transactionHash: txHash },
      ],
      [
        { id: "pending", takerOrderId: "other", makerOrders: [{ orderId }], status: "MINED", transactionHash: txHash },
        { id: "failed", takerOrderId: orderId, makerOrders: [], status: "FAILED", transactionHash: "" },
      ],
    ]), market, orderId);
    expect(result.tradeIds).toEqual(["confirmed", "pending", "failed"]);
    expect(result.transactionHashes).toEqual([txHash]);
    expect(result.pendingTradeIds).toEqual(["pending"]);
    expect(result.failedTradeIds).toEqual(["failed"]);
  });

  it("accepts the current prefixed Polymarket trade status values", async () => {
    const result = await collectV11TradeEvidence(reader([[
      { id: "confirmed", takerOrderId: orderId, makerOrders: [],
        status: "TRADE_STATUS_CONFIRMED", transactionHash: txHash },
      { id: "failed", takerOrderId: orderId, makerOrders: [],
        status: "TRADE_STATUS_FAILED", transactionHash: "" },
    ]]), market, orderId);
    expect(result).toEqual({
      tradeIds: ["confirmed", "failed"], transactionHashes: [txHash],
      pendingTradeIds: [], failedTradeIds: ["failed"],
    });
  });

  it("stops rather than silently skipping old pages", async () => {
    await expect(collectV11TradeEvidence(reader([
      [], [], [],
    ]), market, orderId, 2)).rejects.toThrow(/page limit/);
  });

  it("requires successful Polygon receipts with sufficient confirmations", async () => {
    const evidence = {
      tradeIds: ["trade-1"], transactionHashes: [txHash], pendingTradeIds: [], failedTradeIds: [],
    };
    const chain = {
      getBlockNumber: async () => 120n,
      getTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 101n }),
    };
    await expect(verifyV11TradeReceipts(chain, evidence)).resolves.toBeUndefined();
    await expect(verifyV11TradeReceipts({
      ...chain, getTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 102n }),
    }, evidence)).rejects.toThrow(/not final/);
    await expect(verifyV11TradeReceipts({
      ...chain, getTransactionReceipt: async () => ({ status: "reverted" as const, blockNumber: 101n }),
    }, evidence)).rejects.toThrow(/reverted/);
    await expect(verifyV11TradeReceipts(chain, { ...evidence, pendingTradeIds: ["trade-2"] }))
      .rejects.toThrow(/not fully confirmed/);
    await expect(verifyV11TradeReceipts(chain, {
      tradeIds: [], transactionHashes: [], pendingTradeIds: [], failedTradeIds: [],
    })).rejects.toThrow(/not fully confirmed/);
  });
});

describe("v11 FAK terminality", () => {
  const maker = "0x00000000000000000000000000000000000000aa" as const;
  const expected = { orderId, marketId: market, tokenId: 123n, maker, side: "BUY" as const };
  const order = {
    id: orderId, conditionId: market, tokenId: "123", makerAddress: maker,
    side: "BUY", orderType: "FAK", status: "CANCELED", sizeMatched: "0.5", associateTrades: ["trade-1"],
  };
  const evidence = {
    tradeIds: ["trade-1"], transactionHashes: [txHash], pendingTradeIds: [], failedTradeIds: [],
  };
  const receipts = {
    getBlockNumber: async () => 120n,
    getTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 101n }),
  };

  it("accepts a terminal partial FAK only after receipt finality", async () => {
    expect(await verifyV11TerminalOrder(order, expected, evidence, receipts)).toEqual({
      filledShares: 500_000n, confirmedTradeCount: 1,
    });
  });

  it("permits a confirmed zero-fill rejection with no trades", async () => {
    expect(await verifyV11TerminalOrder({ ...order, status: "INVALID", sizeMatched: "0", associateTrades: [] },
      expected, { tradeIds: [], transactionHashes: [], pendingTradeIds: [], failedTradeIds: [] }, receipts))
      .toEqual({ filledShares: 0n, confirmedTradeCount: 0 });
  });

  it("stops on delayed, missing, or unconfirmed trades", async () => {
    await expect(verifyV11TerminalOrder({ ...order, status: "LIVE" }, expected, evidence, receipts))
      .rejects.toThrow(/still live/);
    await expect(verifyV11TerminalOrder(order, expected, { ...evidence, tradeIds: [] }, receipts))
      .rejects.toThrow(/disagree/);
    await expect(verifyV11TerminalOrder(order, expected, evidence, {
      ...receipts, getTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 102n }),
    })).rejects.toThrow(/not final/);
  });
});
