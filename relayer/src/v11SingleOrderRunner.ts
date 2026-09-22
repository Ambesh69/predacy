import { getAddress, type Address, type Hex } from "viem";
import { executeV11BatchAction, type V11BatchTransaction } from "./v11BatchAction.js";
import type { V11BatchJournal } from "./v11BatchJournal.js";
import type { V11OrderJournal } from "./v11OrderJournal.js";
import { prepareV11Order, type V11MarketOrderSigner } from "./v11OrderPreparation.js";
import { submitV11OrderOnce, type ClobOrderPoster } from "./v11OrderSubmission.js";
import {
  collectV11TradeEvidence, verifyV11TerminalOrder,
  type V11OrderRecord, type V11ReceiptReader, type V11TradeReader,
} from "./v11OrderReconciliation.js";
import {
  planV11SingleOrderReturn, type V11SingleOrderReturn, type V11WalletBalances,
} from "./v11SingleOrderAllocation.js";
import type { Side } from "./settlementAccounting.js";
import { buildV11AllocationInputs } from "./v11AllocationProver.js";
import type { V11PilotBudget } from "./v11PilotBudget.js";

export interface V11EscrowedOrder {
  batchId: string;
  marketId: Hex;
  commitment: Hex;
  side: Side;
  deposit: bigint;
  limitPrice: bigint;
  salt: Hex;
  tokenId: bigint;
  priceTick: bigint;
  depositWallet: Address;
}

/** Chain and SDK adapter. Its assertions must read final on-chain state, not a local cache. */
export interface V11SingleOrderDriver {
  assertBatchSingleOrder(order: V11EscrowedOrder): Promise<"CLOSED" | "ROUTED" | "SETTLED">;
  readWalletBalances(): Promise<V11WalletBalances>;
  route(order: V11EscrowedOrder): V11BatchTransaction;
  assertFunding(order: V11EscrowedOrder): Promise<void>;
  signer: V11MarketOrderSigner;
  poster: ClobOrderPoster;
  fetchOrder(orderId: string): Promise<V11OrderRecord>;
  tradeReader: V11TradeReader;
  receiptReader: V11ReceiptReader;
  returnPusd(amount: bigint): V11BatchTransaction;
  returnShares(tokenId: bigint, amount: bigint): V11BatchTransaction;
  assertVaultReturns(order: V11EscrowedOrder, allocation: V11SingleOrderReturn): Promise<void>;
  proveAllocation(order: V11EscrowedOrder, allocation: V11SingleOrderReturn): Promise<Hex>;
  finalize(order: V11EscrowedOrder, allocation: V11SingleOrderReturn, proof: Hex): V11BatchTransaction;
}

function encodedBalances(balances: V11WalletBalances) {
  return { pusd: balances.pusd.toString(), yes: balances.yes.toString(), no: balances.no.toString() };
}

function decodeBalances(payload: Record<string, string>): V11WalletBalances {
  const read = (key: string) => {
    if (!/^\d+$/.test(payload[key] ?? "")) throw new Error("Invalid journaled v11 wallet balance");
    return BigInt(payload[key]);
  };
  return { pusd: read("pusd"), yes: read("yes"), no: read("no") };
}

function assertFundedWallet(order: V11EscrowedOrder, balances: V11WalletBalances): void {
  const buy = order.side === "YES_BUY" || order.side === "NO_BUY";
  const expected = buy
    ? { pusd: order.deposit, yes: 0n, no: 0n }
    : { pusd: 0n, yes: order.side === "YES_SELL" ? order.deposit : 0n,
        no: order.side === "NO_SELL" ? order.deposit : 0n };
  if (balances.pusd !== expected.pusd || balances.yes !== expected.yes || balances.no !== expected.no) {
    throw new Error("Deposit Wallet contains funds outside this v11 escrow or route is unconfirmed");
  }
}

/** One escrowed order, one FAK attempt, exact returned assets. Never resolves ambiguous sends by retrying. */
export async function runV11SingleOrder(
  order: V11EscrowedOrder,
  batchJournal: V11BatchJournal,
  orderJournal: V11OrderJournal,
  driver: V11SingleOrderDriver,
  pilotBudget: V11PilotBudget,
): Promise<V11SingleOrderReturn> {
  if (!/^\d+$/.test(order.batchId) || order.deposit <= 0n || order.tokenId <= 0n) {
    throw new Error("Invalid v11 escrowed order");
  }
  buildV11AllocationInputs({
    marketId: order.marketId, commitment: order.commitment,
    side: order.side === "YES_BUY" ? 0 : order.side === "YES_SELL" ? 1
      : order.side === "NO_BUY" ? 2 : 3,
    deposit: order.deposit, limitPrice: order.limitPrice, salt: order.salt,
    filledShares: 0n, usdcSettled: 0n, refund: order.deposit,
  });
  const batchStatus = await driver.assertBatchSingleOrder(order);
  await pilotBudget.reserve(order.batchId, order.deposit);
  const routeIntent = await batchJournal.get(order.batchId, "route");
  if (batchStatus === "SETTLED") {
    const finalized = await batchJournal.get(order.batchId, "finalize");
    const snapshot = await batchJournal.get(order.batchId, "plan");
    if (!finalized || !snapshot || !["broadcast", "confirmed"].includes(finalized.state)) {
      throw new Error("Settled v11 batch has no fully reconciled local journal");
    }
    if (finalized.state === "broadcast") {
      if (!finalized.txHash) throw new Error("Settled v11 batch has no finalize transaction hash");
      const receipt = await driver.receiptReader.getTransactionReceipt({ hash: finalized.txHash as Hex });
      const head = await driver.receiptReader.getBlockNumber();
      if (receipt.status !== "success" || head < receipt.blockNumber ||
          head - receipt.blockNumber + 1n < 20n) {
        throw new Error("V11 finalize transaction is not confirmed");
      }
      await batchJournal.recordConfirmed(order.batchId, "finalize");
    }
    const payload = snapshot.payload;
    if (payload.commitment !== order.commitment || payload.side !== order.side ||
        payload.deposit !== order.deposit.toString() ||
        !/^\d+$/.test(payload.matchedShares ?? "") ||
        !/^\d+$/.test(payload.confirmedTradeCount ?? "")) {
      throw new Error("Settled v11 batch snapshot differs from escrow");
    }
    return planV11SingleOrderReturn({
      side: order.side, deposit: order.deposit, limitPrice: order.limitPrice,
      walletBeforeRoute: { pusd: 0n, yes: 0n, no: 0n },
      walletAfterTerminalOrder: decodeBalances(payload), terminalOrderConfirmed: true,
      confirmedTradeCount: Number(payload.confirmedTradeCount),
      matchedShares: BigInt(payload.matchedShares),
    });
  }
  if (batchStatus === "ROUTED" && (!routeIntent || routeIntent.state === "prepared")) {
    throw new Error("Routed v11 batch has no broadcast route journal; manual reconciliation required");
  }
  if (batchStatus === "CLOSED" && routeIntent?.state === "confirmed") {
    throw new Error("V11 route journal and on-chain batch status disagree");
  }
  const routePayload = {
    commitment: order.commitment, side: order.side, deposit: order.deposit.toString(),
    wallet: getAddress(order.depositWallet),
  };
  if (!routeIntent) {
    const before = await driver.readWalletBalances();
    if (before.pusd !== 0n || before.yes !== 0n || before.no !== 0n) {
      throw new Error("V11 requires an empty, dedicated Deposit Wallet before routing");
    }
  }
  await executeV11BatchAction(batchJournal, order.batchId, "route", routePayload, driver.route(order));

  const side = order.side === "YES_BUY" || order.side === "NO_BUY" ? "BUY" : "SELL";
  let intent = await orderJournal.get(order.batchId, "0");
  if (!intent) {
    assertFundedWallet(order, await driver.readWalletBalances());
    await prepareV11Order(orderJournal, driver.signer, {
      batchId: order.batchId, legId: "0", tokenId: order.tokenId, side,
      escrowAmount: order.deposit, limitPrice: order.limitPrice, priceTick: order.priceTick,
      expectedMaker: order.depositWallet,
    });
    intent = await orderJournal.get(order.batchId, "0");
  }
  if (!intent) throw new Error("V11 signed order was not journaled");
  if (getAddress(intent.signedOrder.maker) !== getAddress(order.depositWallet) ||
      getAddress(intent.signedOrder.signer) !== getAddress(order.depositWallet) ||
      intent.signedOrder.signatureType !== 3 ||
      intent.signedOrder.tokenId.toString() !== order.tokenId.toString() ||
      intent.signedOrder.side !== side) {
    throw new Error("Journaled CLOB order differs from this Deposit Wallet escrow");
  }

  if (intent.state === "prepared") {
    assertFundedWallet(order, await driver.readWalletBalances());
    try {
      await submitV11OrderOnce(orderJournal, driver.poster, order.batchId, "0",
        () => driver.assertFunding(order));
    } catch (error) {
      const current = await orderJournal.get(order.batchId, "0");
      if (current?.state !== "rejected") throw error;
    }
    intent = await orderJournal.get(order.batchId, "0");
  }
  if (!intent || (intent.state !== "accepted" && intent.state !== "rejected")) {
    throw new Error("V11 CLOB submission is not reconciled; no assets may be returned");
  }

  let matchedShares = 0n;
  let confirmedTradeCount = 0;
  if (intent.state === "accepted") {
    if (!intent.orderId) throw new Error("Accepted CLOB order has no ID");
    const record = await driver.fetchOrder(intent.orderId);
    const evidence = await collectV11TradeEvidence(driver.tradeReader, order.marketId, intent.orderId);
    ({ filledShares: matchedShares, confirmedTradeCount } = await verifyV11TerminalOrder(record, {
      orderId: intent.orderId, marketId: order.marketId, tokenId: order.tokenId,
      maker: order.depositWallet, side,
    }, evidence, driver.receiptReader));
  }

  const existingPlan = await batchJournal.get(order.batchId, "plan");
  const after = existingPlan ? decodeBalances(existingPlan.payload) : await driver.readWalletBalances();
  const allocation = planV11SingleOrderReturn({
    side: order.side, deposit: order.deposit, limitPrice: order.limitPrice,
    walletBeforeRoute: { pusd: 0n, yes: 0n, no: 0n },
    walletAfterTerminalOrder: after, terminalOrderConfirmed: true,
    confirmedTradeCount, matchedShares,
  });
  const planPayload = { ...encodedBalances(after), commitment: order.commitment, side: order.side,
    deposit: order.deposit.toString(), matchedShares: matchedShares.toString(),
    confirmedTradeCount: confirmedTradeCount.toString() };
  await batchJournal.prepare(order.batchId, "plan", planPayload);

  if (allocation.returnPusd > 0n) {
    await executeV11BatchAction(batchJournal, order.batchId, "return_pusd",
      { amount: allocation.returnPusd.toString(), commitment: order.commitment },
      driver.returnPusd(allocation.returnPusd));
  }
  const shares = order.side === "YES_BUY" || order.side === "YES_SELL"
    ? allocation.returnYes : allocation.returnNo;
  if (shares > 0n) {
    await executeV11BatchAction(batchJournal, order.batchId, "return_shares",
      { amount: shares.toString(), tokenId: order.tokenId.toString(), commitment: order.commitment },
      driver.returnShares(order.tokenId, shares));
  }
  await driver.assertVaultReturns(order, allocation);
  const proof = await driver.proveAllocation(order, allocation);
  await executeV11BatchAction(batchJournal, order.batchId, "finalize", {
    commitment: order.commitment, filledShares: allocation.allocation.filledShares.toString(),
    usdcPayout: allocation.allocation.usdcPayout.toString(), refund: allocation.allocation.refund.toString(),
  }, driver.finalize(order, allocation, proof));
  return allocation;
}
