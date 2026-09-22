import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { executeV12BatchAction, type V12BatchTransaction } from "./v12BatchAction.js";
import type { V12BatchJournal } from "./v12BatchJournal.js";
import { aggregateV12BuyLimit, allocateV12BuyFill } from "./v12BuyAllocation.js";
import {
  buildV12BuyBatchInputs, type V12BuyBatchWitness, type V12PrivateBuyOrder,
} from "./v12BuyBatchProver.js";

export interface V12BuyBatchRequest {
  marketId: Hex;
  positionTokenId: bigint;
  priceTick: bigint;
  depositWallet: Address;
  /** Fixed execution boundary selected when the private batch is assembled. */
  executeAfterUnixMs?: number;
  witness: Omit<V12BuyBatchWitness, "fills">;
}

export interface V12TerminalBuy {
  returnPusd: bigint;
  returnShares: bigint;
  confirmedTradeCount: number;
}

export interface V12ProofResult {
  proof: Hex;
  orderCommitments: Hex[];
  refundCommitments: Hex[];
  positionCommitments: Hex[];
}

/** Network implementation must journal and reconcile its CLOB POST before returning. */
export interface V12BuyDriver {
  assertBatch(request: V12BuyBatchRequest, batchId: Hex): Promise<"LOCKED" | "ROUTED" | "SETTLED">;
  route(request: V12BuyBatchRequest, proof: V12ProofResult): V12BatchTransaction;
  assertFunding(request: V12BuyBatchRequest, totalDeposit: bigint): Promise<void>;
  executeAggregateOrder(request: V12BuyBatchRequest, batchId: Hex, totalDeposit: bigint, limitPrice: bigint):
    Promise<V12TerminalBuy>;
  withdrawPusd(amount: bigint): V12BatchTransaction;
  unwrapPusd(amount: bigint): V12BatchTransaction;
  returnShares(tokenId: bigint, amount: bigint): V12BatchTransaction;
  assertPoolReturns(tokenId: bigint, pusdAmount: bigint, shareAmount: bigint): Promise<void>;
  settle(request: V12BuyBatchRequest, proof: V12ProofResult, totalSpent: bigint, totalShares: bigint):
    V12BatchTransaction;
}

export type V12BuyProver = (batch: V12BuyBatchWitness) => Promise<V12ProofResult>;

export function v12BuyBatchId(request: V12BuyBatchRequest): Hex {
  const route = buildV12BuyBatchInputs({ ...request.witness, fills: request.witness.orders.map(() => ({
    spent: 0n, shares: 0n,
  })) });
  return keccak256(encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint256" }, { type: "bytes32[2]" }, { type: "uint256" }],
    [request.witness.orders.length, request.positionTokenId,
      route.orderCommitments as [Hex, Hex], route.totalDeposit],
  ));
}

function decodePlan(payload: Record<string, string>): V12TerminalBuy {
  for (const key of ["returnPusd", "returnShares", "confirmedTradeCount"]) {
    if (!/^\d+$/.test(payload[key] ?? "")) throw new Error("Invalid journaled v12 execution plan");
  }
  return {
    returnPusd: BigInt(payload.returnPusd),
    returnShares: BigInt(payload.returnShares),
    confirmedTradeCount: Number(payload.confirmedTradeCount),
  };
}

/**
 * Resumable private-buy lifecycle. Every chain send is write-ahead journaled;
 * the driver applies the same rule to the single aggregate CLOB POST.
 */
export async function runV12BuyBatch(
  request: V12BuyBatchRequest,
  journal: V12BatchJournal,
  driver: V12BuyDriver,
  prover: V12BuyProver,
): Promise<{ batchId: Hex; terminal: V12TerminalBuy; fills: ReturnType<typeof allocateV12BuyFill> }> {
  if (request.positionTokenId <= 0n || request.priceTick <= 0n || request.witness.orders.length < 1 ||
      request.witness.orders.length > 2) throw new Error("Invalid v12 buy batch request");
  const batchId = v12BuyBatchId(request);
  const status = await driver.assertBatch(request, batchId);
  const zeroFills = request.witness.orders.map(() => ({ spent: 0n, shares: 0n }));
  const routeBuilt = buildV12BuyBatchInputs({ ...request.witness, fills: zeroFills });

  const existingPlan = await journal.get(batchId, "plan");
  if (status === "SETTLED") {
    if (!existingPlan) throw new Error("Settled v12 batch has no durable execution plan");
    const terminal = decodePlan(existingPlan.payload);
    const totalSpent = routeBuilt.totalDeposit - terminal.returnPusd;
    return { batchId, terminal, fills: allocateV12BuyFill(request.witness.orders, totalSpent, terminal.returnShares) };
  }

  const routeIntent = await journal.get(batchId, "route");
  if (status === "ROUTED" && (!routeIntent || routeIntent.state === "prepared")) {
    throw new Error("Routed v12 batch lacks a broadcast route journal; reconcile manually");
  }
  if (status === "LOCKED" && routeIntent?.state === "confirmed") {
    throw new Error("V12 route journal and on-chain state disagree");
  }

  const routeProof = await prover({ ...request.witness, fills: zeroFills });
  if (routeProof.orderCommitments.some((value, index) => value !== routeBuilt.orderCommitments[index]) ||
      routeProof.refundCommitments.some((value, index) => value !== routeBuilt.refundCommitments[index])) {
    throw new Error("V12 route proof differs from the private batch witness");
  }
  await executeV12BatchAction(journal, batchId, "route", {
    totalDeposit: routeBuilt.totalDeposit.toString(),
    positionTokenId: request.positionTokenId.toString(),
    orderSetHash: batchId,
  }, driver.route(request, routeProof));

  let terminal: V12TerminalBuy;
  if (existingPlan) {
    terminal = decodePlan(existingPlan.payload);
  } else {
    await driver.assertFunding(request, routeBuilt.totalDeposit);
    terminal = await driver.executeAggregateOrder(
      request, batchId, routeBuilt.totalDeposit, aggregateV12BuyLimit(request.witness.orders),
    );
    if (!Number.isSafeInteger(terminal.confirmedTradeCount) || terminal.confirmedTradeCount < 0 ||
        terminal.returnPusd < 0n || terminal.returnPusd > routeBuilt.totalDeposit || terminal.returnShares < 0n ||
        (terminal.returnShares === 0n) !== (terminal.confirmedTradeCount === 0)) {
      throw new Error("V12 terminal CLOB evidence is inconsistent");
    }
    await journal.prepare(batchId, "plan", {
      returnPusd: terminal.returnPusd.toString(),
      returnShares: terminal.returnShares.toString(),
      confirmedTradeCount: terminal.confirmedTradeCount.toString(),
    });
  }

  const totalSpent = routeBuilt.totalDeposit - terminal.returnPusd;
  const fills = allocateV12BuyFill(request.witness.orders, totalSpent, terminal.returnShares);
  if (terminal.returnPusd > 0n) {
    await executeV12BatchAction(journal, batchId, "withdraw_pusd", {
      amount: terminal.returnPusd.toString(), destination: "adapter",
    }, driver.withdrawPusd(terminal.returnPusd));
    await executeV12BatchAction(journal, batchId, "unwrap_pusd", {
      amount: terminal.returnPusd.toString(), destination: "pool",
    }, driver.unwrapPusd(terminal.returnPusd));
  }
  if (terminal.returnShares > 0n) {
    await executeV12BatchAction(journal, batchId, "return_shares", {
      amount: terminal.returnShares.toString(), tokenId: request.positionTokenId.toString(), destination: "pool",
    }, driver.returnShares(request.positionTokenId, terminal.returnShares));
  }
  await driver.assertPoolReturns(request.positionTokenId, terminal.returnPusd, terminal.returnShares);

  const settlementWitness = { ...request.witness, fills };
  const settlementBuilt = buildV12BuyBatchInputs(settlementWitness);
  const settlementProof = await prover(settlementWitness);
  if (settlementProof.orderCommitments.some((value, index) => value !== settlementBuilt.orderCommitments[index]) ||
      settlementProof.refundCommitments.some((value, index) => value !== settlementBuilt.refundCommitments[index]) ||
      settlementProof.positionCommitments.some((value, index) => value !== settlementBuilt.positionCommitments[index])) {
    throw new Error("V12 settlement proof differs from the reconciled execution");
  }
  await executeV12BatchAction(journal, batchId, "settle", {
    totalSpent: settlementBuilt.totalSpent.toString(), totalShares: settlementBuilt.totalShares.toString(),
    proofDigest: keccak256(settlementProof.proof),
  }, driver.settle(request, settlementProof, settlementBuilt.totalSpent, settlementBuilt.totalShares));
  return { batchId, terminal, fills };
}

export type { V12PrivateBuyOrder };
