/**
 * proxyWalletManager.ts
 * ──────────────────────
 * Manages ProxyWallet lifecycle for Predacy's privacy-preserving flow.
 *
 * ## Responsibilities
 *   1. Predict deterministic ProxyWallet addresses (before deploy, for funding).
 *   2. Deploy ProxyWallets on behalf of users (Builder Relayer pays MATIC gas).
 *   3. After claim, build + submit the post-claim shield batch:
 *        CTF.setApprovalForAll → WrappedCTFToken.wrap → ERC20.approve → Railgun.shield
 *      via ProxyWallet.batchExecuteWithSig (relayer pays gas, Alice signed offline).
 *
 * ## Key contracts
 *   ProxyWalletFactory: deploys wallets via CREATE2.
 *   ProxyWallet:        executeWithSig / batchExecuteWithSig — meta-tx pattern.
 *   WrappedCTFFactory:  deploys ERC-20 wrappers per (ctf, positionId).
 *   RailgunSmartWallet: shields ERC-20 into Railgun.
 */

import {
  type PublicClient,
  type WalletClient,
  type Address,
  type Hex,
  type Account,
  createWalletClient,
  createPublicClient,
  http,
  getContract,
  encodeFunctionData,
  keccak256,
  concat,
  toBytes,
  parseAbiParameters,
  encodeAbiParameters,
} from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import {
  buildShieldBatch,
  buildWrapBatch,
  buildBatchMetaTxDigest,
  RAILGUN_SMART_WALLET,
  type ShieldParams,
} from "./railgunShield.js";

// ── ABIs ──────────────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  {
    name: "deploy",
    type: "function" as const,
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "wallet", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    name: "computeAddress",
    type: "function" as const,
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    name: "walletOf",
    type: "function" as const,
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const PROXY_WALLET_ABI = [
  {
    name: "nonce",
    type: "function" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "batchExecuteWithSig",
    type: "function" as const,
    inputs: [
      { name: "targets",  type: "address[]" },
      { name: "values",   type: "uint256[]" },
      { name: "payloads", type: "bytes[]"   },
      { name: "sig",      type: "bytes"     },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
    stateMutability: "nonpayable",
  },
] as const;

const WRAPPED_CTF_FACTORY_ABI = [
  {
    name: "wrapperOf",
    type: "function" as const,
    inputs: [
      { name: "ctf",        type: "address" },
      { name: "positionId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    name: "deploy",
    type: "function" as const,
    inputs: [
      { name: "ctf",        type: "address"  },
      { name: "positionId", type: "uint256"  },
      { name: "name",       type: "string"   },
      { name: "symbol",     type: "string"   },
    ],
    outputs: [{ name: "wrapper", type: "address" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── Config ────────────────────────────────────────────────────────────────────

export interface ProxyWalletManagerConfig {
  /** ProxyWalletFactory address (deployed). */
  factoryAddress:         Address;
  /** WrappedCTFFactory address (deployed). */
  wrappedCtfFactory:      Address;
  /** CTF (ERC-1155) contract address. */
  ctfAddress:             Address;
  /** Relayer wallet client (pays gas). */
  walletClient:           WalletClient;
  /** Public client for reads. */
  publicClient:           PublicClient;
  /** Chain ID (137 = Polygon mainnet, 80002 = Amoy). */
  chainId:                number;
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class ProxyWalletManager {
  private cfg: ProxyWalletManagerConfig;

  constructor(cfg: ProxyWalletManagerConfig) {
    this.cfg = cfg;
  }

  // ── Address prediction (gas-free) ─────────────────────────────────────────

  /**
   * Predict the ProxyWallet address for an ephemeral EOA.
   * Returns the same address as after deployment — use this to tell Alice
   * where to fund her proxy wallet via Railgun.
   */
  async computeProxyAddress(ephemeralEOA: Address): Promise<Address> {
    const result = await this.cfg.publicClient.readContract({
      address:      this.cfg.factoryAddress,
      abi:          FACTORY_ABI,
      functionName: "computeAddress",
      args:         [ephemeralEOA],
    });
    return result as Address;
  }

  /**
   * Check if a ProxyWallet is already deployed for this ephemeral EOA.
   */
  async isDeployed(ephemeralEOA: Address): Promise<boolean> {
    const addr = await this.cfg.publicClient.readContract({
      address:      this.cfg.factoryAddress,
      abi:          FACTORY_ABI,
      functionName: "walletOf",
      args:         [ephemeralEOA],
    }) as Address;
    return addr !== "0x0000000000000000000000000000000000000000";
  }

  // ── Deployment (relayer pays gas) ─────────────────────────────────────────

  /**
   * Deploy a ProxyWallet for `ephemeralEOA` if not already deployed.
   * The Builder Relayer is msg.sender and pays MATIC.
   * @returns The ProxyWallet address (predicted or newly deployed).
   */
  async ensureDeployed(ephemeralEOA: Address): Promise<Address> {
    const existing = await this.cfg.publicClient.readContract({
      address:      this.cfg.factoryAddress,
      abi:          FACTORY_ABI,
      functionName: "walletOf",
      args:         [ephemeralEOA],
    }) as Address;

    if (existing !== "0x0000000000000000000000000000000000000000") {
      console.log(`[ProxyWalletManager] wallet already deployed: ${existing}`);
      return existing;
    }

    console.log(`[ProxyWalletManager] deploying ProxyWallet for ${ephemeralEOA} ...`);
    const { request } = await this.cfg.publicClient.simulateContract({
      address:      this.cfg.factoryAddress,
      abi:          FACTORY_ABI,
      functionName: "deploy",
      args:         [ephemeralEOA],
      account:      this.cfg.walletClient.account,
    });
    const hash = await this.cfg.walletClient.writeContract(request as any);
    try {
      await this.cfg.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    } catch (receiptErr: any) {
      const msg: string = receiptErr?.message ?? "";
      if (
        msg.includes("could not be found") ||
        msg.includes("not be processed") ||
        msg.includes("Timed out") ||
        msg.includes("timed out")
      ) {
        // Receipt polling timed out — RPC may be slow but the tx likely landed.
        // Confirm via walletOf before proceeding.
        console.warn(`[ProxyWalletManager] ensureDeployed receipt timeout for ${hash} — verifying via walletOf`);
        const check = await this.cfg.publicClient.readContract({
          address:      this.cfg.factoryAddress,
          abi:          FACTORY_ABI,
          functionName: "walletOf",
          args:         [ephemeralEOA],
        }) as Address;
        if (check === "0x0000000000000000000000000000000000000000") {
          throw new Error(`ProxyWallet deploy timed out and wallet not found for ${ephemeralEOA}`);
        }
        console.log(`[ProxyWalletManager] deploy confirmed via walletOf: ${check}`);
        return check;
      }
      throw receiptErr;
    }

    const deployed = await this.cfg.publicClient.readContract({
      address:      this.cfg.factoryAddress,
      abi:          FACTORY_ABI,
      functionName: "walletOf",
      args:         [ephemeralEOA],
    }) as Address;

    console.log(`[ProxyWalletManager] deployed: ${deployed}`);
    return deployed;
  }

  // ── WrappedCTFToken lookup / deployment ───────────────────────────────────

  /**
   * Get or deploy the WrappedCTFToken for a given positionId.
   * On first call for a new market, the relayer deploys the wrapper.
   */
  async ensureWrapper(
    positionId: bigint,
    name:       string,
    symbol:     string,
  ): Promise<Address> {
    const existing = await this.cfg.publicClient.readContract({
      address:      this.cfg.wrappedCtfFactory,
      abi:          WRAPPED_CTF_FACTORY_ABI,
      functionName: "wrapperOf",
      args:         [this.cfg.ctfAddress, positionId],
    }) as Address;

    if (existing !== "0x0000000000000000000000000000000000000000") {
      return existing;
    }

    console.log(`[ProxyWalletManager] deploying WrappedCTFToken for positionId ${positionId} ...`);
    const { request } = await this.cfg.publicClient.simulateContract({
      address:      this.cfg.wrappedCtfFactory,
      abi:          WRAPPED_CTF_FACTORY_ABI,
      functionName: "deploy",
      args:         [this.cfg.ctfAddress, positionId, name, symbol],
      account:      this.cfg.walletClient.account,
    });
    const hash = await this.cfg.walletClient.writeContract(request as any);
    await this.cfg.publicClient.waitForTransactionReceipt({ hash });

    return await this.cfg.publicClient.readContract({
      address:      this.cfg.wrappedCtfFactory,
      abi:          WRAPPED_CTF_FACTORY_ABI,
      functionName: "wrapperOf",
      args:         [this.cfg.ctfAddress, positionId],
    }) as Address;
  }

  // ── Post-claim shield submission ──────────────────────────────────────────

  /**
   * After BatchVault sends YES/NO tokens to the ProxyWallet via claimWithProof,
   * submit the post-claim shield batch:
   *   1. CTF.setApprovalForAll(wrappedToken, true)
   *   2. WrappedCTFToken.wrap(amount)
   *   3. WrappedCTFToken.approve(RailgunSmartWallet, amount)
   *   4. RailgunSmartWallet.shield(...)
   *
   * Alice must have signed the batch digest with her ephemeral EOA key.
   * The Builder Relayer submits the tx (pays MATIC).
   *
   * @param proxyWallet   ProxyWallet address.
   * @param shieldParams  Shield parameters including Alice's Railgun NPK + ciphertext.
   * @param sig           Alice's ephemeral EOA signature over the batch digest.
   */
  async submitShieldBatch(
    proxyWallet:  Address,
    shieldParams: ShieldParams,
    sig:          Hex,
  ): Promise<Hex> {
    const batch = buildShieldBatch(shieldParams);

    console.log(
      `[ProxyWalletManager] submitting shield batch for proxy ${proxyWallet}: ` +
      `${shieldParams.amount} of ${shieldParams.wrappedToken} → Railgun`
    );

    const { request } = await this.cfg.publicClient.simulateContract({
      address:      proxyWallet,
      abi:          PROXY_WALLET_ABI,
      functionName: "batchExecuteWithSig",
      args:         [batch.targets, batch.values, batch.payloads, sig],
      account:      this.cfg.walletClient.account,
    });
    const hash = await this.cfg.walletClient.writeContract(request as any);
    await this.cfg.publicClient.waitForTransactionReceipt({ hash });

    console.log(`[ProxyWalletManager] shield batch confirmed: ${hash}`);
    return hash;
  }

  // ── Wrap batch (ERC-1155 → ERC-20, no Railgun shield) ────────────────────

  /**
   * Build the 2-call wrap batch digest Alice's ephemeral key must sign.
   * Returns the inner digest — caller signs with:
   *   account.signMessage({ message: { raw: digest } })
   *
   * @param proxyWallet  ProxyWallet address.
   * @param ctfAddress   CTF (ERC-1155) contract address.
   * @param wrappedToken WrappedCTFToken ERC-20 address (wYES or wNO).
   * @param amount       Amount of CTF tokens to wrap (same units as ERC-1155).
   */
  async buildWrapDigest(
    proxyWallet:  Address,
    ctfAddress:   Address,
    wrappedToken: Address,
    amount:       bigint,
  ): Promise<Hex> {
    const nonce = await this.cfg.publicClient.readContract({
      address:      proxyWallet,
      abi:          PROXY_WALLET_ABI,
      functionName: "nonce",
    }) as bigint;

    const batch = buildWrapBatch(ctfAddress, wrappedToken, amount);
    return buildBatchMetaTxDigest(nonce, this.cfg.chainId, proxyWallet, batch);
  }

  /**
   * Submit the 2-call wrap batch on behalf of the ProxyWallet owner.
   * Alice signs buildWrapDigest() client-side; relayer submits (pays MATIC).
   *
   * @param proxyWallet  ProxyWallet address.
   * @param ctfAddress   CTF (ERC-1155) contract address.
   * @param wrappedToken WrappedCTFToken ERC-20 address.
   * @param amount       Amount of tokens to wrap.
   * @param sig          Alice's ephemeral EOA signature over the wrap digest.
   */
  async submitWrapBatch(
    proxyWallet:  Address,
    ctfAddress:   Address,
    wrappedToken: Address,
    amount:       bigint,
    sig:          Hex,
  ): Promise<Hex> {
    const batch = buildWrapBatch(ctfAddress, wrappedToken, amount);

    console.log(
      `[ProxyWalletManager] submitting wrap batch for proxy ${proxyWallet}: ` +
      `${amount} of token → ${wrappedToken} (ERC-20)`
    );

    const { request } = await this.cfg.publicClient.simulateContract({
      address:      proxyWallet,
      abi:          PROXY_WALLET_ABI,
      functionName: "batchExecuteWithSig",
      args:         [batch.targets, batch.values, batch.payloads, sig],
      account:      this.cfg.walletClient.account,
    });
    const hash = await this.cfg.walletClient.writeContract(request as any);
    await this.cfg.publicClient.waitForTransactionReceipt({ hash });

    console.log(`[ProxyWalletManager] wrap batch confirmed: ${hash}`);
    return hash;
  }

  // ── Digest (for Alice to sign client-side before shield) ──────────────────

  /**
   * Build the full 4-call shield batch meta-tx digest Alice's ephemeral key must sign.
   * Called by the frontend when Alice requests a full Railgun shield — provides NPK,
   * encryptedBundle, shieldKey from her Railgun wallet.
   */
  async buildShieldDigest(
    proxyWallet:  Address,
    shieldParams: ShieldParams,
  ): Promise<Hex> {
    const nonce = await this.cfg.publicClient.readContract({
      address:      proxyWallet,
      abi:          PROXY_WALLET_ABI,
      functionName: "nonce",
    }) as bigint;

    const batch = buildShieldBatch(shieldParams);
    return buildBatchMetaTxDigest(nonce, this.cfg.chainId, proxyWallet, batch);
  }
}
