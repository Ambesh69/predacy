import { OrderSide, OrderType, type SignedOrder } from "@polymarket/client";
import type { V11OrderJournal } from "./v11OrderJournal.js";

export interface V11MarketOrderSigner {
  createMarketOrder(request: {
    tokenId: string;
    side: OrderSide.BUY | OrderSide.SELL;
    amount?: string;
    maxSpend?: string;
    maxPrice?: string;
    shares?: string;
    minPrice?: string;
    orderType: OrderType.FAK;
  }): Promise<SignedOrder>;
}

export interface V11LegRequest {
  batchId: string;
  legId: string;
  tokenId: bigint;
  side: "BUY" | "SELL";
  escrowAmount: bigint;
  limitPrice: bigint;
  priceTick: bigint;
  expectedMaker: `0x${string}`;
}

// The current maximum published taker fee is 0.07 * p * (1-p), or 0.0175
// USDC/share. The remainder covers 5-decimal fee rounding on 0.01-share fills.
// Recheck this bound before enabling trading if Polymarket changes its fees.
const MAX_FEE_PER_SHARE_MICRO = 20_000n;
const PRICE_SCALE = 1_000_000n;

function executionPrice(request: V11LegRequest): bigint {
  if (request.priceTick <= 0n || PRICE_SCALE % request.priceTick !== 0n) {
    throw new Error("Invalid market price tick");
  }
  if (request.side === "BUY") {
    const beforeFee = request.limitPrice - MAX_FEE_PER_SHARE_MICRO;
    const rounded = beforeFee / request.priceTick * request.priceTick;
    if (rounded <= 0n) throw new Error("Buy limit cannot cover the fee envelope");
    return rounded;
  }
  const beforeFee = request.limitPrice + MAX_FEE_PER_SHARE_MICRO;
  const rounded = (beforeFee + request.priceTick - 1n) / request.priceTick * request.priceTick;
  if (rounded >= PRICE_SCALE) throw new Error("Sell limit cannot cover the fee envelope");
  return rounded;
}

function toDecimal(micro: bigint): string {
  if (micro < 0n) throw new Error("Negative CLOB amount");
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Signs one bounded FAK order and persists the exact bytes before any CLOB POST. */
export async function prepareV11Order(
  journal: V11OrderJournal,
  client: V11MarketOrderSigner,
  request: V11LegRequest,
): Promise<SignedOrder> {
  if ((request.side !== "BUY" && request.side !== "SELL") ||
      request.tokenId <= 0n || request.escrowAmount <= 0n ||
      request.limitPrice <= 0n || request.limitPrice >= 1_000_000n) {
    throw new Error("Invalid v11 order bounds");
  }
  const boundedPrice = executionPrice(request);
  const price = toDecimal(boundedPrice);
  const amount = toDecimal(request.escrowAmount);
  const signed = await client.createMarketOrder(request.side === "BUY"
    ? {
        tokenId: request.tokenId.toString(), side: OrderSide.BUY,
        amount, maxSpend: amount, maxPrice: price, orderType: OrderType.FAK,
      }
    : {
        tokenId: request.tokenId.toString(), side: OrderSide.SELL,
        shares: amount, minPrice: price, orderType: OrderType.FAK,
      });

  if (signed.maker.toLowerCase() !== request.expectedMaker.toLowerCase() ||
      signed.signer.toLowerCase() !== request.expectedMaker.toLowerCase() ||
      signed.tokenId.toString() !== request.tokenId.toString() ||
      signed.side !== (request.side === "BUY" ? OrderSide.BUY : OrderSide.SELL) ||
      signed.orderType !== OrderType.FAK || signed.signatureType !== 3) {
    throw new Error("Signed CLOB order does not target the configured Deposit Wallet and leg");
  }
  const makerAmount = BigInt(signed.makerAmount);
  const takerAmount = BigInt(signed.takerAmount);
  if (makerAmount <= 0n || takerAmount <= 0n) throw new Error("Signed CLOB order has zero size");
  if (request.side === "BUY") {
    if (makerAmount > request.escrowAmount || makerAmount * PRICE_SCALE > takerAmount * boundedPrice) {
      throw new Error("Signed buy exceeds escrow or limit");
    }
  } else if (makerAmount > request.escrowAmount ||
             takerAmount * PRICE_SCALE < makerAmount * boundedPrice) {
    throw new Error("Signed sell exceeds escrow or falls below limit");
  }
  await journal.prepare(request.batchId, request.legId, signed);
  return signed;
}
