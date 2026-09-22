import { WalletType, type Signer } from "@polymarket/client";
import { fetchMarketInfo, postOrder } from "@polymarket/client/actions";
import {
  createPublicClient, createWalletClient, getAddress, http, parseAbi,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { awaitRoutedDepositWalletFunding, type DepositWalletClient } from "./depositWalletClient.js";
import { withdrawPositionFromDepositWallet, withdrawPusdFromDepositWallet } from "./depositWalletWithdrawals.js";
import { proveV11Allocation } from "./v11AllocationProver.js";
import { assertV11MarketBinding } from "./v11MarketBinding.js";
import { assertV11PolygonAssets } from "./v11PolygonAssets.js";
import type { V11BatchTransaction } from "./v11BatchAction.js";
import type { V11EscrowedOrder, V11SingleOrderDriver } from "./v11SingleOrderRunner.js";
import type { V11SingleOrderReturn, V11WalletBalances } from "./v11SingleOrderAllocation.js";

const vaultAbi = parseAbi([
  "function batches(uint256) view returns (bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8)",
  "function orders(uint256,uint256) view returns (bytes32,uint8,uint256,address,bool)",
  "function depositWallet() view returns (address)",
  "function usdce() view returns (address)",
  "function pusd() view returns (address)",
  "function ctf() view returns (address)",
  "function onramp() view returns (address)",
  "function offramp() view returns (address)",
  "function allocationVerifier() view returns (address)",
  "function relayer() view returns (address)",
  "function guardian() view returns (address)",
  "function activeBatchId() view returns (uint256)",
  "function reservedTokens(uint256) view returns (uint256)",
  "function routeAssets(uint256,uint256,uint256,uint256)",
  "function finalize(uint256,(uint8,uint256,uint256,uint256,uint256,uint256)[],bytes[],uint256)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ctfAbi = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);

export interface V11PolygonDriverConfig {
  rpcUrl: string;
  vault: Address;
  usdce: Address;
  pusd: Address;
  ctf: Address;
  onramp: Address;
  offramp: Address;
  allocationVerifier: Address;
  guardian: Address;
  exchange: Address;
  relayerKey: Hex;
  depositWalletSigner: Signer;
  clob: DepositWalletClient;
}

export class V11PolygonDriver implements V11SingleOrderDriver {
  private readonly reader;
  private readonly writer;
  private readonly account;
  private readonly wallet: Address;
  readonly signer;
  readonly poster;
  readonly tradeReader;
  readonly receiptReader;

  constructor(private readonly config: V11PolygonDriverConfig) {
    assertV11PolygonAssets(config);
    if (config.clob.account.walletType !== WalletType.DEPOSIT_WALLET) {
      throw new Error("V11 requires a Polymarket Deposit Wallet");
    }
    this.wallet = getAddress(config.clob.account.wallet);
    this.account = privateKeyToAccount(config.relayerKey);
    this.reader = createPublicClient({ chain: polygon, transport: http(config.rpcUrl) });
    this.writer = createWalletClient({ chain: polygon, transport: http(config.rpcUrl), account: this.account });
    this.signer = config.clob;
    this.poster = { postOrder: postOrder(config.clob) };
    this.tradeReader = config.clob;
    this.receiptReader = this.reader;
  }

  private async confirm(hash: `0x${string}`): Promise<void> {
    const receipt = await this.reader.waitForTransactionReceipt({ hash, confirmations: 20, timeout: 180_000 });
    if (receipt.status !== "success") {
      throw new Error("V11 Polygon transaction is reverted or lacks 20 confirmations");
    }
  }

  async assertBatchSingleOrder(order: V11EscrowedOrder): Promise<"CLOSED" | "ROUTED" | "SETTLED"> {
    const [chainId, code, verifierCode, wallet, usdce, pusd, ctf, onramp,
      offramp, verifier, relayer, guardian, activeBatchId] = await Promise.all([
      this.reader.getChainId(),
      this.reader.getCode({ address: this.config.vault }),
      this.reader.getCode({ address: this.config.allocationVerifier }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "depositWallet" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "usdce" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "pusd" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "ctf" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "onramp" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "offramp" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "allocationVerifier" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "relayer" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "guardian" }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "activeBatchId" }),
    ]);
    if (chainId !== polygon.id || !code || code === "0x" || !verifierCode || verifierCode === "0x" ||
        getAddress(order.depositWallet) !== this.wallet || getAddress(wallet) !== this.wallet ||
        getAddress(usdce) !== getAddress(this.config.usdce) ||
        getAddress(pusd) !== getAddress(this.config.pusd) ||
        getAddress(ctf) !== getAddress(this.config.ctf) ||
        getAddress(onramp) !== getAddress(this.config.onramp) ||
        getAddress(offramp) !== getAddress(this.config.offramp) ||
        getAddress(verifier) !== getAddress(this.config.allocationVerifier) ||
        getAddress(relayer) !== getAddress(this.account.address) ||
        getAddress(guardian) !== getAddress(this.config.guardian)) {
      throw new Error("V11 vault, collateral, relayer, Deposit Wallet, or RPC identity mismatch");
    }
    const batch = await this.reader.readContract({ address: this.config.vault, abi: vaultAbi,
      functionName: "batches", args: [BigInt(order.batchId)] });
    const escrow = await this.reader.readContract({ address: this.config.vault, abi: vaultAbi,
      functionName: "orders", args: [BigInt(order.batchId), 0n] });
    const side = order.side === "YES_BUY" ? 0 : order.side === "YES_SELL" ? 1
      : order.side === "NO_BUY" ? 2 : 3;
    const tokenId = side <= 1 ? batch[1] : batch[2];
    if (batch[0].toLowerCase() !== order.marketId.toLowerCase() || batch[5] !== 1n ||
        ![2, 3, 4].includes(batch[12]) || tokenId !== order.tokenId ||
        (batch[12] !== 4 && activeBatchId !== BigInt(order.batchId)) ||
        escrow[0].toLowerCase() !== order.commitment.toLowerCase() ||
        escrow[1] !== side || escrow[2] !== order.deposit) {
      throw new Error("V11 on-chain batch is not this closed, single-order escrow");
    }
    const market = await fetchMarketInfo(this.config.clob, { conditionId: order.marketId });
    assertV11MarketBinding(market, {
      yesTokenId: batch[1], noTokenId: batch[2],
      tokenId: order.tokenId, priceTick: order.priceTick, exchange: this.config.exchange,
    });
    for await (const page of this.config.clob.listOpenOrders()) {
      if (page.items.length) throw new Error("Deposit Wallet has unrelated open CLOB orders");
    }
    return batch[12] === 2 ? "CLOSED" : batch[12] === 3 ? "ROUTED" : "SETTLED";
  }

  async readWalletBalances(): Promise<V11WalletBalances> {
    const batchId = await this.reader.readContract({ address: this.config.vault, abi: vaultAbi,
      functionName: "activeBatchId" });
    const batch = await this.reader.readContract({ address: this.config.vault, abi: vaultAbi,
      functionName: "batches", args: [batchId] });
    const [pusd, yes, no] = await Promise.all([
      this.reader.readContract({ address: this.config.pusd, abi: erc20Abi, functionName: "balanceOf", args: [this.wallet] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf", args: [this.wallet, batch[1]] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf", args: [this.wallet, batch[2]] }),
    ]);
    return { pusd, yes, no };
  }

  route(order: V11EscrowedOrder): V11BatchTransaction {
    const buy = order.side === "YES_BUY" || order.side === "NO_BUY";
    const yes = order.side === "YES_SELL" ? order.deposit : 0n;
    const no = order.side === "NO_SELL" ? order.deposit : 0n;
    return {
      send: () => this.writer.writeContract({ address: this.config.vault, abi: vaultAbi,
        functionName: "routeAssets", args: [BigInt(order.batchId), buy ? order.deposit : 0n, yes, no] }),
      confirm: (hash) => this.confirm(hash),
    };
  }

  async assertFunding(order: V11EscrowedOrder): Promise<void> {
    const buy = order.side === "YES_BUY" || order.side === "NO_BUY";
    await awaitRoutedDepositWalletFunding(this.config.clob, {
      rpcUrl: this.config.rpcUrl, tokenAddress: buy ? this.config.pusd : this.config.ctf,
      exchange: this.config.exchange, asset: buy ? "COLLATERAL" : "CONDITIONAL",
      ...(buy ? {} : { tokenId: order.tokenId }), startingBalance: 0n,
      incomingAmount: order.deposit, orderAmount: order.deposit,
    });
  }

  async fetchOrder(orderId: string) {
    try {
      const record = await this.config.clob.fetchOrder({ orderId });
      return { ...record, tokenId: record.tokenId.toString(), conditionId: record.conditionId.toString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes(`/data/order/${orderId}`) &&
          message.includes("expected object, received null")) return null;
      throw error;
    }
  }

  returnPusd(amount: bigint): V11BatchTransaction {
    return {
      send: async () => {
        const handle = await withdrawPusdFromDepositWallet(this.config.clob, this.config.depositWalletSigner,
          this.config.rpcUrl, this.config.pusd, this.config.vault, amount);
        return (await handle.wait()).transactionHash;
      },
      confirm: (hash) => this.confirm(hash),
    };
  }

  returnShares(tokenId: bigint, amount: bigint): V11BatchTransaction {
    return {
      send: async () => {
        const handle = await withdrawPositionFromDepositWallet(this.config.clob, this.config.depositWalletSigner,
          this.config.rpcUrl, this.config.ctf, this.config.vault, tokenId, amount);
        return (await handle.wait()).transactionHash;
      },
      confirm: (hash) => this.confirm(hash),
    };
  }

  async assertVaultReturns(order: V11EscrowedOrder, allocation: V11SingleOrderReturn): Promise<void> {
    const batch = await this.reader.readContract({ address: this.config.vault, abi: vaultAbi,
      functionName: "batches", args: [BigInt(order.batchId)] });
    const [pusd, yes, no, reservedYes, reservedNo] = await Promise.all([
      this.reader.readContract({ address: this.config.pusd, abi: erc20Abi, functionName: "balanceOf", args: [this.config.vault] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf", args: [this.config.vault, batch[1]] }),
      this.reader.readContract({ address: this.config.ctf, abi: ctfAbi, functionName: "balanceOf", args: [this.config.vault, batch[2]] }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "reservedTokens", args: [batch[1]] }),
      this.reader.readContract({ address: this.config.vault, abi: vaultAbi, functionName: "reservedTokens", args: [batch[2]] }),
    ]);
    if (pusd !== allocation.returnPusd || yes < reservedYes || no < reservedNo ||
        yes - reservedYes !== allocation.returnYes || no - reservedNo !== allocation.returnNo) {
      throw new Error("Vault has not received the exact Deposit Wallet assets");
    }
  }

  async proveAllocation(order: V11EscrowedOrder, result: V11SingleOrderReturn): Promise<Hex> {
    const side = order.side === "YES_BUY" ? 0 : order.side === "YES_SELL" ? 1
      : order.side === "NO_BUY" ? 2 : 3;
    const { proof } = await proveV11Allocation({
      marketId: order.marketId, commitment: order.commitment, side,
      deposit: order.deposit, limitPrice: order.limitPrice, salt: order.salt,
      filledShares: result.allocation.filledShares, usdcSettled: result.allocation.usdcPayout,
      refund: result.allocation.refund,
    });
    return proof;
  }

  finalize(order: V11EscrowedOrder, result: V11SingleOrderReturn, proof: Hex): V11BatchTransaction {
    const side = order.side === "YES_BUY" ? 0 : order.side === "YES_SELL" ? 1
      : order.side === "NO_BUY" ? 2 : 3;
    const allocation = result.allocation;
    return {
      send: () => this.writer.writeContract({ address: this.config.vault, abi: vaultAbi,
        functionName: "finalize", args: [BigInt(order.batchId), [[side, order.deposit, 0n,
          allocation.filledShares, allocation.usdcPayout, allocation.refund]], [proof], result.returnPusd] }),
      confirm: (hash) => this.confirm(hash),
    };
  }
}
