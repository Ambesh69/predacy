import { WalletType, type Signer } from "@polymarket/client";
import { fetchMarketInfo } from "@polymarket/client/actions";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, zeroHash,
  type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { DepositWalletClient } from "./depositWalletClient.js";
import type { V11OrderJournal } from "./v11OrderJournal.js";
import { V12PolygonDriver } from "./v12PolygonDriver.js";
import type { V12BuyBatchRequest } from "./v12BuyRunner.js";
import { buildV13RouteInputs } from "./v13Proofs.js";
import type {
  V13BuyDriver, V13BuyRequest, V13RouteProof, V13SettlementProof, V13TerminalBuy,
} from "./v13BuyRunner.js";

const poolAbi = parseAbi([
  "function collateral() view returns (address)", "function ctf() view returns (address)",
  "function routeVerifier() view returns (address)", "function settlementVerifier() view returns (address)",
  "function executionAdapter() view returns (address)", "function relayer() view returns (address)",
  "function guardian() view returns (address)", "function paused() view returns (bool)",
  "function collateralAssetId() view returns (bytes32)", "function positionAssetId(uint256) view returns (bytes32)",
  "function knownRoots(bytes32) view returns (bool)", "function spentOrderNullifiers(bytes32) view returns (bool)",
  "function activeBuy() view returns (bytes32,bytes32,uint256,uint256,bool)",
  "function liabilities(bytes32) view returns (uint256)",
  "function startBuyBatch(bytes,bytes32,uint256,bytes32[2],bytes32[2],uint256,bytes32)",
  "function settleBuyBatch(bytes,bytes32[2],bytes32[2],uint256,uint256)",
]);
const adapterAbi = parseAbi([
  "function pool() view returns (address)", "function pusd() view returns (address)",
  "function depositWallet() view returns (address)", "function operator() view returns (address)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ctfAbi = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
const STANDARD_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

export interface V13PolygonDriverConfig {
  rpcUrl: string; pool: Address; adapter: Address; usdce: Address; pusd: Address; ctf: Address;
  routeVerifier: Address; settlementVerifier: Address; guardian: Address; exchange: Address;
  relayerKey: Hex; depositWalletSigner: Signer; clob: DepositWalletClient; orderJournal: V11OrderJournal;
}

export class V13PolygonDriver implements V13BuyDriver {
  private readonly reader;
  private readonly writer;
  private readonly account;
  private readonly wallet: Address;
  private readonly execution: V12PolygonDriver;

  constructor(private readonly config: V13PolygonDriverConfig) {
    if (config.clob.account.walletType !== WalletType.DEPOSIT_WALLET) {
      throw new Error("V13 requires a Polymarket Deposit Wallet");
    }
    this.wallet = getAddress(config.clob.account.wallet);
    this.account = privateKeyToAccount(config.relayerKey);
    this.reader = createPublicClient({ chain: polygon, transport: http(config.rpcUrl) });
    this.writer = createWalletClient({ chain: polygon, transport: http(config.rpcUrl), account: this.account });
    this.execution = new V12PolygonDriver({ ...config, batchVerifier: config.routeVerifier });
  }

  private legacyRequest(request: V13BuyRequest): V12BuyBatchRequest {
    return { marketId: request.marketId, positionTokenId: request.positionTokenId, priceTick: request.priceTick,
      depositWallet: request.depositWallet, executeAfterUnixMs: request.executeAfterUnixMs, witness: {
        collateralAsset: request.witness.collateralAsset, positionAsset: request.witness.positionAsset,
        orders: request.witness.orders.map((order) => ({ inputNote: zeroHash, deposit: order.deposit,
          limitPrice: order.limitPrice, salt: zeroHash, refundPublicKey: order.refundPublicKey,
          positionPublicKey: order.positionPublicKey })),
      } };
  }

  private async confirm(hash: Hex) {
    const receipt = await this.reader.waitForTransactionReceipt({ hash, confirmations: 20, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error("V13 Polygon transaction reverted");
  }
  private transaction(send: () => Promise<Hex>) { return { send, confirm: (hash: Hex) => this.confirm(hash) }; }

  async assertBatch(request: V13BuyRequest, batchId: Hex): Promise<"READY" | "ROUTED" | "SETTLED"> {
    const built = buildV13RouteInputs(request.witness);
    if (built.binding.toLowerCase() !== batchId.toLowerCase()) throw new Error("V13 batch binding mismatch");
    const [chainId, poolCode, routeCode, settlementCode, collateral, ctf, routeVerifier, settlementVerifier,
      adapter, relayer, guardian, paused, adapterPool, pusd, wallet, operator, collateralAsset,
      positionAsset, rootKnown, firstSpent, secondSpent, active] = await Promise.all([
      this.reader.getChainId(), this.reader.getCode({ address: this.config.pool }),
      this.reader.getCode({ address: this.config.routeVerifier }),
      this.reader.getCode({ address: this.config.settlementVerifier }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "collateral" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "ctf" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "routeVerifier" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "settlementVerifier" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "executionAdapter" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "relayer" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "guardian" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "paused" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "pool" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "pusd" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "depositWallet" }),
      this.reader.readContract({ address: this.config.adapter, abi: adapterAbi, functionName: "operator" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "collateralAssetId" }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "positionAssetId",
        args: [request.positionTokenId] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "knownRoots", args: [built.root] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "spentOrderNullifiers",
        args: [built.nullifiers[0]] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "spentOrderNullifiers",
        args: [built.nullifiers[1]] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "activeBuy" }),
    ]);
    if (chainId !== polygon.id || !poolCode || poolCode === "0x" || !routeCode || routeCode === "0x" ||
        !settlementCode || settlementCode === "0x" || getAddress(collateral) !== getAddress(this.config.usdce) ||
        getAddress(ctf) !== getAddress(this.config.ctf) || getAddress(routeVerifier) !== getAddress(this.config.routeVerifier) ||
        getAddress(settlementVerifier) !== getAddress(this.config.settlementVerifier) ||
        getAddress(adapter) !== getAddress(this.config.adapter) || getAddress(relayer) !== getAddress(this.account.address) ||
        getAddress(guardian) !== getAddress(this.config.guardian) || getAddress(adapterPool) !== getAddress(this.config.pool) ||
        getAddress(pusd) !== getAddress(this.config.pusd) || getAddress(wallet) !== this.wallet ||
        getAddress(operator) !== getAddress(this.account.address) ||
        collateralAsset.toLowerCase() !== request.witness.collateralAsset.toLowerCase() ||
        positionAsset.toLowerCase() !== request.witness.positionAsset.toLowerCase()) {
      throw new Error("V13 pool, adapter, verifiers, assets, roles, or RPC identity mismatch");
    }
    if (active[4]) {
      if (active[0].toLowerCase() !== batchId.toLowerCase() || active[2] !== request.positionTokenId ||
          active[3] !== built.totalDeposit) throw new Error("Another v13 buy is active");
      return "ROUTED";
    }
    if (firstSpent || secondSpent) {
      if (!firstSpent || !secondSpent) throw new Error("V13 order-nullifier state is inconsistent");
      return "SETTLED";
    }
    if (paused) throw new Error("V13 pool intake is paused");
    if (!rootKnown) throw new Error("V13 order root is not known by the pool");

    const market = await fetchMarketInfo(this.config.clob, { conditionId: request.marketId });
    const tokenIds = new Set(market.tokens.map((token) => token.tokenId.toString()));
    const tick = market.tickSize * 1_000_000;
    if (!tokenIds.has(request.positionTokenId.toString()) || !Number.isSafeInteger(tick) || BigInt(tick) !== request.priceTick ||
        !Number.isFinite(market.feeInfo.rate) || market.feeInfo.rate < 0 || market.feeInfo.rate > 0.07 ||
        (market.feeInfo.rate > 0 && market.feeInfo.exponent !== 1) ||
        getAddress(this.config.exchange) !== getAddress(market.negRisk ? NEG_RISK_EXCHANGE : STANDARD_EXCHANGE)) {
      throw new Error("V13 private batch differs from the current CLOB market");
    }
    for await (const page of this.config.clob.listOpenOrders()) {
      if (page.items.length) throw new Error("V13 Deposit Wallet has unrelated open orders");
    }
    return "READY";
  }

  route(request: V13BuyRequest, proof: V13RouteProof) {
    return this.transaction(() => this.writer.writeContract({ address: this.config.pool, abi: poolAbi,
      functionName: "startBuyBatch", args: [proof.proof, proof.root, request.positionTokenId,
        proof.nullifiers, proof.fullRefunds, proof.totalDeposit, proof.binding] }));
  }
  assertFunding(request: V13BuyRequest, totalDeposit: bigint) {
    return this.execution.assertFunding(this.legacyRequest(request), totalDeposit);
  }
  executeAggregateOrder(request: V13BuyRequest, id: Hex, total: bigint, limit: bigint): Promise<V13TerminalBuy> {
    return this.execution.executeAggregateOrder(this.legacyRequest(request), id, total, limit);
  }
  withdrawPusd(amount: bigint) { return this.execution.withdrawPusd(amount); }
  unwrapPusd(amount: bigint) { return this.execution.unwrapPusd(amount); }
  returnShares(tokenId: bigint, amount: bigint) { return this.execution.returnShares(tokenId, amount); }

  async assertPoolReturns(tokenId: bigint, pusdAmount: bigint, shareAmount: bigint) {
    const positionAsset = await this.reader.readContract({ address: this.config.pool, abi: poolAbi,
      functionName: "positionAssetId", args: [tokenId] });
    const collateralAsset = await this.reader.readContract({ address: this.config.pool, abi: poolAbi,
      functionName: "collateralAssetId" });
    const [usdce, shares, usdceLiability, shareLiability, active] = await Promise.all([
      this.reader.readContract({ address: this.config.usdce, abi: erc20Abi, functionName: "balanceOf",
        args: [this.config.pool] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf",
        args: [this.config.pool, tokenId] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "liabilities",
        args: [collateralAsset] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "liabilities",
        args: [positionAsset] }),
      this.reader.readContract({ address: this.config.pool, abi: poolAbi, functionName: "activeBuy" }),
    ]);
    if (!active[4] || pusdAmount > active[3]) throw new Error("V13 pool has no matching active return");
    if (usdce < usdceLiability - (active[3] - pusdAmount) || shares < shareLiability + shareAmount) {
      throw new Error("V13 pool has not received the assets required by private settlement");
    }
  }
  settle(_request: V13BuyRequest, proof: V13SettlementProof) {
    return this.transaction(() => this.writer.writeContract({ address: this.config.pool, abi: poolAbi,
      functionName: "settleBuyBatch", args: [proof.proof, proof.refundCommitments,
        proof.positionCommitments, proof.totalSpent, proof.totalShares] }));
  }
}
