import { WalletType, type Signer } from "@polymarket/client";
import { fetchMarketInfo, postOrder } from "@polymarket/client/actions";
import {
  createPublicClient, createWalletClient, getAddress, http, parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { awaitRoutedDepositWalletFunding, type DepositWalletClient } from "./depositWalletClient.js";
import { withdrawPositionFromDepositWallet, withdrawPusdFromDepositWallet } from "./depositWalletWithdrawals.js";
import { prepareV11Order } from "./v11OrderPreparation.js";
import { submitV11OrderOnce } from "./v11OrderSubmission.js";
import {
  collectV11TradeEvidence, verifyV11TerminalOrder, verifyV11TradeReceipts,
} from "./v11OrderReconciliation.js";
import type { V11OrderJournal } from "./v11OrderJournal.js";
import type {
  V12BuyBatchRequest, V12BuyDriver, V12ProofResult, V12TerminalBuy,
} from "./v12BuyRunner.js";

const poolAbi = parseAbi([
  "function collateral() view returns (address)",
  "function ctf() view returns (address)",
  "function batchVerifier() view returns (address)",
  "function executionAdapter() view returns (address)",
  "function relayer() view returns (address)",
  "function guardian() view returns (address)",
  "function collateralAssetId() view returns (bytes32)",
  "function positionAssetId(uint256) view returns (bytes32)",
  "function lockedOrderAsset(bytes32) view returns (bytes32)",
  "function settledOrders(bytes32) view returns (bool)",
  "function activeBuy() view returns (bytes32,bytes32,uint256,uint256,uint8,bool)",
  "function liabilities(bytes32) view returns (uint256)",
  "function startBuyBatch(bytes,uint8,uint256,bytes32[2],bytes32[2],uint256)",
  "function settleBuyBatch(bytes,bytes32[2],bytes32[2],bytes32[2],uint256,uint256)",
]);
const adapterAbi = parseAbi([
  "function pool() view returns (address)",
  "function pusd() view returns (address)",
  "function depositWallet() view returns (address)",
  "function operator() view returns (address)",
  "function returnPusd(uint256)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ctfAbi = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
const STANDARD_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

export interface V12PolygonDriverConfig {
  rpcUrl: string;
  pool: Address;
  adapter: Address;
  usdce: Address;
  pusd: Address;
  ctf: Address;
  batchVerifier: Address;
  guardian: Address;
  exchange: Address;
  relayerKey: Hex;
  depositWalletSigner: Signer;
  clob: DepositWalletClient;
  orderJournal: V11OrderJournal;
}

export class V12PolygonDriver implements V12BuyDriver {
  private readonly reader;
  private readonly writer;
  private readonly account;
  private readonly wallet: Address;

  constructor(private readonly config: V12PolygonDriverConfig) {
    if (config.clob.account.walletType !== WalletType.DEPOSIT_WALLET) {
      throw new Error("V12 requires a Polymarket Deposit Wallet");
    }
    this.wallet = getAddress(config.clob.account.wallet);
    this.account = privateKeyToAccount(config.relayerKey);
    this.reader = createPublicClient({ chain: polygon, transport: http(config.rpcUrl) });
    this.writer = createWalletClient({ chain: polygon, transport: http(config.rpcUrl), account: this.account });
  }

  private async confirm(hash: Hex): Promise<void> {
    const receipt = await this.reader.waitForTransactionReceipt({ hash, confirmations: 20, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error("V12 Polygon transaction reverted");
  }

  private transaction(send: () => Promise<Hex>) {
    return { send, confirm: (hash: Hex) => this.confirm(hash) };
  }

  async assertBatch(request: V12BuyBatchRequest, batchId: Hex): Promise<"LOCKED" | "ROUTED" | "SETTLED"> {
    const built = (await import("./v12BuyBatchProver.js")).buildV12BuyBatchInputs({
      ...request.witness, fills: request.witness.orders.map(() => ({ spent: 0n, shares: 0n })),
    });
    const [chainId, poolCode, verifierCode, collateral, ctf, verifier, adapter, relayer, guardian,
      adapterPool, pusd, wallet, operator, collateralAsset, positionAsset, active] = await Promise.all([
      this.reader.getChainId(), this.reader.getCode({ address: this.config.pool }),
      this.reader.getCode({ address: this.config.batchVerifier }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "collateral" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "ctf" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "batchVerifier" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "executionAdapter" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "relayer" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "guardian" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "pool" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "pusd" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "depositWallet" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "operator" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "collateralAssetId" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "positionAssetId",
        args: [request.positionTokenId] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "activeBuy" }),
    ]);
    if (chainId !== polygon.id || !poolCode || poolCode === "0x" || !verifierCode || verifierCode === "0x" ||
        getAddress(collateral) !== getAddress(this.config.usdce) || getAddress(ctf) !== getAddress(this.config.ctf) ||
        getAddress(verifier) !== getAddress(this.config.batchVerifier) || getAddress(adapter) !== getAddress(this.config.adapter) ||
        getAddress(relayer) !== getAddress(this.account.address) || getAddress(guardian) !== getAddress(this.config.guardian) ||
        getAddress(adapterPool) !== getAddress(this.config.pool) || getAddress(pusd) !== getAddress(this.config.pusd) ||
        getAddress(wallet) !== this.wallet || getAddress(operator) !== getAddress(this.account.address) ||
        collateralAsset.toLowerCase() !== request.witness.collateralAsset.toLowerCase() ||
        positionAsset.toLowerCase() !== request.witness.positionAsset.toLowerCase()) {
      throw new Error("V12 pool, adapter, verifier, assets, roles, or RPC identity mismatch");
    }
    const settled = await Promise.all(built.orderCommitments.slice(0, request.witness.orders.length).map((order) =>
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "settledOrders", args: [order] })));
    if (settled.every(Boolean)) return "SETTLED";
    if (active[5]) {
      if (active[0].toLowerCase() !== batchId.toLowerCase() || active[2] !== request.positionTokenId ||
          active[3] !== built.totalDeposit || active[4] !== request.witness.orders.length) {
        throw new Error("Another v12 buy is active");
      }
      return "ROUTED";
    }
    const locks = await Promise.all(built.orderCommitments.slice(0, request.witness.orders.length).map((order) =>
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "lockedOrderAsset", args: [order] })));
    if (locks.some((asset) => asset.toLowerCase() !== request.witness.positionAsset.toLowerCase())) {
      throw new Error("V12 private orders are not locked for this outcome asset");
    }
    const market = await fetchMarketInfo(this.config.clob, { conditionId: request.marketId });
    const tokenIds = new Set(market.tokens.map((token) => token.tokenId.toString()));
    const tick = market.tickSize * 1_000_000;
    if (!tokenIds.has(request.positionTokenId.toString()) || !Number.isSafeInteger(tick) || BigInt(tick) !== request.priceTick ||
        !Number.isFinite(market.feeInfo.rate) || market.feeInfo.rate < 0 || market.feeInfo.rate > 0.07 ||
        (market.feeInfo.rate > 0 && market.feeInfo.exponent !== 1) ||
        getAddress(this.config.exchange) !== getAddress(market.negRisk ? NEG_RISK_EXCHANGE : STANDARD_EXCHANGE)) {
      throw new Error("V12 private batch differs from the current CLOB market");
    }
    for await (const page of this.config.clob.listOpenOrders()) {
      if (page.items.length) throw new Error("V12 Deposit Wallet has unrelated open orders");
    }
    return "LOCKED";
  }

  route(request: V12BuyBatchRequest, proof: V12ProofResult) {
    const orders = proof.orderCommitments as [Hex, Hex];
    const refunds = proof.refundCommitments as [Hex, Hex];
    const total = request.witness.orders.reduce((sum, order) => sum + order.deposit, 0n);
    return this.transaction(() => this.writer.writeContract({ address: this.config.pool, abi: poolAbi,
      functionName: "startBuyBatch", args: [proof.proof, request.witness.orders.length, request.positionTokenId,
        orders, refunds, total] }));
  }

  async assertFunding(_request: V12BuyBatchRequest, totalDeposit: bigint) {
    await awaitRoutedDepositWalletFunding(this.config.clob, { rpcUrl: this.config.rpcUrl,
      tokenAddress: this.config.pusd, exchange: this.config.exchange, asset: "COLLATERAL",
      startingBalance: 0n, incomingAmount: totalDeposit, orderAmount: totalDeposit });
  }

  async executeAggregateOrder(
    request: V12BuyBatchRequest, batchId: Hex, totalDeposit: bigint, limitPrice: bigint,
  ): Promise<V12TerminalBuy> {
    const key = BigInt(batchId).toString();
    let intent = await this.config.orderJournal.get(key, "aggregate");
    if (!intent) {
      const [pusdBefore, sharesBefore] = await Promise.all([
        this.reader.readContract({ address: this.config.pusd, abi: erc20Abi, functionName: "balanceOf", args: [this.wallet] }),
        this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf",
          args: [this.wallet, request.positionTokenId] }),
      ]);
      if (pusdBefore !== totalDeposit || sharesBefore !== 0n) {
        throw new Error("V12 requires an isolated Deposit Wallet containing only this routed batch");
      }
      await prepareV11Order(this.config.orderJournal, this.config.clob, { batchId: key, legId: "aggregate",
        tokenId: request.positionTokenId, side: "BUY", escrowAmount: totalDeposit, limitPrice,
        priceTick: request.priceTick, expectedMaker: this.wallet });
      intent = await this.config.orderJournal.get(key, "aggregate");
    }
    if (!intent) throw new Error("V12 aggregate order was not journaled");
    if (intent.state === "prepared") {
      try {
        await submitV11OrderOnce(this.config.orderJournal, { postOrder: postOrder(this.config.clob) }, key, "aggregate",
          () => this.assertFunding(request, totalDeposit));
      } catch (error) {
        const current = await this.config.orderJournal.get(key, "aggregate");
        if (current?.state !== "rejected") throw error;
      }
      intent = await this.config.orderJournal.get(key, "aggregate");
    }
    if (!intent || !["accepted", "rejected"].includes(intent.state)) {
      throw new Error("V12 CLOB submission is uncertain; reconcile before continuing");
    }
    if (intent.state === "rejected") {
      const [returnPusd, returnShares] = await Promise.all([
        this.reader.readContract({ address: this.config.pusd, abi: erc20Abi, functionName: "balanceOf", args: [this.wallet] }),
        this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf",
          args: [this.wallet, request.positionTokenId] }),
      ]);
      if (returnPusd !== totalDeposit || returnShares !== 0n) {
        throw new Error("Rejected v12 order does not have an exact zero-fill wallet balance");
      }
      return { returnPusd, returnShares, confirmedTradeCount: 0 };
    }
    if (!intent.orderId) throw new Error("Accepted v12 CLOB order has no ID");
    const evidence = await collectV11TradeEvidence(this.config.clob, request.marketId, intent.orderId);
    let record = null;
    try { record = await this.config.clob.fetchOrder({ orderId: intent.orderId }); } catch {}
    let confirmedTradeCount: number;
    let matchedShares: bigint;
    if (record) {
      ({ filledShares: matchedShares, confirmedTradeCount } = await verifyV11TerminalOrder({
        ...record, tokenId: record.tokenId.toString(), conditionId: record.conditionId.toString(),
      }, { orderId: intent.orderId, marketId: request.marketId, tokenId: request.positionTokenId,
        maker: this.wallet, side: "BUY" }, evidence, this.reader));
    } else {
      if (!evidence.tradeIds.length || evidence.pendingTradeIds.length || evidence.failedTradeIds.length) {
        throw new Error("Missing v12 terminal order lacks confirmed trade evidence");
      }
      await verifyV11TradeReceipts(this.reader, evidence);
      confirmedTradeCount = evidence.tradeIds.length;
      matchedShares = await this.reader.readContract({ address: this.config.ctf, abi: ctfAbi,
        functionName: "balanceOf", args: [this.wallet, request.positionTokenId] });
    }
    const [returnPusd, returnShares] = await Promise.all([
      this.reader.readContract({ address: this.config.pusd, abi: erc20Abi, functionName: "balanceOf", args: [this.wallet] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf",
        args: [this.wallet, request.positionTokenId] }),
    ]);
    if (returnPusd > totalDeposit || returnShares !== matchedShares) {
      throw new Error("V12 CLOB evidence and Deposit Wallet balances disagree");
    }
    return { returnPusd, returnShares, confirmedTradeCount };
  }

  withdrawPusd(amount: bigint) {
    return this.transaction(async () => (await (await withdrawPusdFromDepositWallet(this.config.clob,
      this.config.depositWalletSigner, this.config.rpcUrl, this.config.pusd, this.config.adapter, amount)).wait()).transactionHash);
  }

  unwrapPusd(amount: bigint) {
    return this.transaction(() => this.writer.writeContract({ address: this.config.adapter, abi: adapterAbi,
      functionName: "returnPusd", args: [amount] }));
  }

  returnShares(tokenId: bigint, amount: bigint) {
    return this.transaction(async () => (await (await withdrawPositionFromDepositWallet(this.config.clob,
      this.config.depositWalletSigner, this.config.rpcUrl, this.config.ctf, this.config.pool, tokenId, amount)).wait()).transactionHash);
  }

  async assertPoolReturns(tokenId: bigint, pusdAmount: bigint, shareAmount: bigint) {
    const positionAsset = await this.reader.readContract({ address: this.config.pool, abi: poolAbi,
      functionName: "positionAssetId", args: [tokenId] });
    const collateralAsset = await this.reader.readContract({ address: this.config.pool, abi: poolAbi,
      functionName: "collateralAssetId" });
    const [usdce, shares, usdceLiability, shareLiability, active] = await Promise.all([
      this.reader.readContract({ address: this.config.usdce, abi: erc20Abi, functionName: "balanceOf", args: [this.config.pool] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf", args: [this.config.pool, tokenId] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "liabilities", args: [collateralAsset] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "liabilities", args: [positionAsset] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "activeBuy" }),
    ]);
    if (!active[5] || pusdAmount > active[3]) throw new Error("V12 pool has no matching active return");
    const expectedUsdce = usdceLiability - (active[3] - pusdAmount);
    const expectedShares = shareLiability + shareAmount;
    if (usdce < expectedUsdce || shares < expectedShares) {
      throw new Error("V12 pool has not received the assets required by private settlement");
    }
  }

  settle(request: V12BuyBatchRequest, proof: V12ProofResult, totalSpent: bigint, totalShares: bigint) {
    return this.transaction(() => this.writer.writeContract({ address: this.config.pool, abi: poolAbi,
      functionName: "settleBuyBatch", args: [proof.proof, proof.orderCommitments as [Hex, Hex],
        proof.refundCommitments as [Hex, Hex], proof.positionCommitments as [Hex, Hex], totalSpent, totalShares] }));
  }
}
