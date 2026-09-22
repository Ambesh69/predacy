import { type Address, type Hex } from "viem";
import { executeV13Action, type V13Transaction } from "./v13BatchAction.js";
import type { V13BatchJournal } from "./v13BatchJournal.js";
import { aggregateV12BuyLimit, allocateV12BuyFill } from "./v12BuyAllocation.js";
import {
  buildV13RouteInputs, buildV13SettlementInputs, type V13BatchWitness, type V13Fill,
} from "./v13Proofs.js";

export interface V13BuyRequest {
  marketId: Hex;
  positionTokenId: bigint;
  priceTick: bigint;
  depositWallet: Address;
  executeAfterUnixMs?: number;
  witness: V13BatchWitness;
}
export interface V13TerminalBuy { returnPusd: bigint; returnShares: bigint; confirmedTradeCount: number }
export interface V13RouteProof {
  proof: Hex; nullifiers: [Hex, Hex]; fullRefunds: [Hex, Hex]; binding: Hex; root: Hex; totalDeposit: bigint;
}
export interface V13SettlementProof {
  proof: Hex; binding: Hex; refundCommitments: [Hex, Hex]; positionCommitments: [Hex, Hex];
  totalSpent: bigint; totalShares: bigint;
}
export interface V13BuyDriver {
  assertBatch(request: V13BuyRequest, batchId: Hex): Promise<"READY" | "ROUTED" | "SETTLED">;
  route(request: V13BuyRequest, proof: V13RouteProof): V13Transaction;
  assertFunding(request: V13BuyRequest, totalDeposit: bigint): Promise<void>;
  executeAggregateOrder(request: V13BuyRequest, batchId: Hex, totalDeposit: bigint, limitPrice: bigint):
    Promise<V13TerminalBuy>;
  withdrawPusd(amount: bigint): V13Transaction;
  unwrapPusd(amount: bigint): V13Transaction;
  returnShares(tokenId: bigint, amount: bigint): V13Transaction;
  assertPoolReturns(tokenId: bigint, pusdAmount: bigint, shareAmount: bigint): Promise<void>;
  settle(request: V13BuyRequest, proof: V13SettlementProof): V13Transaction;
}
export type V13RouteProver = (batch: V13BatchWitness) => Promise<V13RouteProof>;
export type V13SettlementProver = (batch: V13BatchWitness, fills: [V13Fill, V13Fill]) => Promise<V13SettlementProof>;

function plan(payload: Record<string, string>): V13TerminalBuy {
  for (const key of ["returnPusd", "returnShares", "confirmedTradeCount"]) {
    if (!/^\d+$/.test(payload[key] ?? "")) throw new Error("Invalid journaled v13 execution plan");
  }
  return { returnPusd: BigInt(payload.returnPusd), returnShares: BigInt(payload.returnShares),
    confirmedTradeCount: Number(payload.confirmedTradeCount) };
}

export async function runV13BuyBatch(request: V13BuyRequest, journal: V13BatchJournal,
  driver: V13BuyDriver, routeProver: V13RouteProver, settlementProver: V13SettlementProver,
  options: { allowNewRoute?: boolean } = {}) {
  if (request.positionTokenId <= 0n || request.priceTick <= 0n || request.witness.orders.length !== 2) {
    throw new Error("Invalid v13 buy batch request");
  }
  const routeBuilt = buildV13RouteInputs(request.witness);
  const batchId = routeBuilt.binding;
  const status = await driver.assertBatch(request, batchId);
  const existingPlan = await journal.get(batchId, "plan");
  if (status === "SETTLED") {
    if (!existingPlan) throw new Error("Settled v13 batch has no durable execution plan");
    const terminal = plan(existingPlan.payload);
    const spent = routeBuilt.totalDeposit - terminal.returnPusd;
    const settlement = await journal.get(batchId, "settle");
    if (!settlement || !["broadcast", "confirmed"].includes(settlement.state) || !settlement.txHash) {
      throw new Error("Spent v13 nullifiers have no matching settlement transaction; reconcile manually");
    }
    const fills = allocateV12BuyFill(request.witness.orders, spent, terminal.returnShares) as [V13Fill, V13Fill];
    const built = buildV13SettlementInputs(request.witness, fills);
    await executeV13Action(journal, batchId, "settle", {
      totalSpent: built.totalSpent.toString(), totalShares: built.totalShares.toString(),
    }, driver.settle(request, { ...built, proof: "0x" }));
    return { batchId, terminal, fills };
  }
  const routeIntent = await journal.get(batchId, "route");
  if (status === "ROUTED" && (!routeIntent || routeIntent.state === "prepared")) {
    throw new Error("Routed v13 batch lacks a broadcast journal; reconcile manually");
  }
  if (status === "READY" && routeIntent?.state === "confirmed") {
    throw new Error("V13 route journal and on-chain state disagree");
  }
  if (status === "READY") {
    if (options.allowNewRoute === false) throw new Error("V13 intake is disabled; only routed batches may recover");
    const proof = await routeProver(request.witness);
    if (proof.binding !== routeBuilt.binding || proof.root !== routeBuilt.root ||
        proof.totalDeposit !== routeBuilt.totalDeposit ||
        proof.nullifiers.some((value, i) => value !== routeBuilt.nullifiers[i]) ||
        proof.fullRefunds.some((value, i) => value !== routeBuilt.fullRefunds[i])) {
      throw new Error("V13 route proof differs from private witness");
    }
    await executeV13Action(journal, batchId, "route", {
      binding: batchId, root: routeBuilt.root, totalDeposit: routeBuilt.totalDeposit.toString(),
      positionTokenId: request.positionTokenId.toString(),
    }, driver.route(request, proof));
  } else {
    // Reconfirm the recorded route before inspecting a possibly already-filled wallet.
    await executeV13Action(journal, batchId, "route", {
      binding: batchId, root: routeBuilt.root, totalDeposit: routeBuilt.totalDeposit.toString(),
      positionTokenId: request.positionTokenId.toString(),
    }, driver.route(request, { ...routeBuilt, proof: "0x" }));
  }

  let terminal: V13TerminalBuy;
  if (existingPlan) terminal = plan(existingPlan.payload);
  else {
    await driver.assertFunding(request, routeBuilt.totalDeposit);
    terminal = await driver.executeAggregateOrder(request, batchId, routeBuilt.totalDeposit,
      aggregateV12BuyLimit(request.witness.orders));
    if (!Number.isSafeInteger(terminal.confirmedTradeCount) || terminal.confirmedTradeCount < 0 ||
        terminal.returnPusd < 0n || terminal.returnPusd > routeBuilt.totalDeposit || terminal.returnShares < 0n ||
        (terminal.returnShares === 0n) !== (terminal.confirmedTradeCount === 0)) {
      throw new Error("V13 terminal CLOB evidence is inconsistent");
    }
    await journal.prepare(batchId, "plan", { returnPusd: terminal.returnPusd.toString(),
      returnShares: terminal.returnShares.toString(), confirmedTradeCount: String(terminal.confirmedTradeCount) });
  }

  const totalSpent = routeBuilt.totalDeposit - terminal.returnPusd;
  const fills = allocateV12BuyFill(request.witness.orders, totalSpent, terminal.returnShares) as [V13Fill, V13Fill];
  if (terminal.returnPusd > 0n) {
    await executeV13Action(journal, batchId, "withdraw_pusd", { amount: terminal.returnPusd.toString(),
      destination: "adapter" }, driver.withdrawPusd(terminal.returnPusd));
    await executeV13Action(journal, batchId, "unwrap_pusd", { amount: terminal.returnPusd.toString(),
      destination: "pool" }, driver.unwrapPusd(terminal.returnPusd));
  }
  if (terminal.returnShares > 0n) {
    await executeV13Action(journal, batchId, "return_shares", { amount: terminal.returnShares.toString(),
      tokenId: request.positionTokenId.toString(), destination: "pool" },
    driver.returnShares(request.positionTokenId, terminal.returnShares));
  }
  await driver.assertPoolReturns(request.positionTokenId, terminal.returnPusd, terminal.returnShares);
  const expected = buildV13SettlementInputs(request.witness, fills);
  const proof = await settlementProver(request.witness, fills);
  if (proof.binding !== batchId || proof.totalSpent !== expected.totalSpent || proof.totalShares !== expected.totalShares ||
      proof.refundCommitments.some((value, i) => value !== expected.refundCommitments[i]) ||
      proof.positionCommitments.some((value, i) => value !== expected.positionCommitments[i])) {
    throw new Error("V13 settlement proof differs from reconciled execution");
  }
  await executeV13Action(journal, batchId, "settle", { totalSpent: proof.totalSpent.toString(),
    totalShares: proof.totalShares.toString() }, driver.settle(request, proof));
  return { batchId, terminal, fills };
}
