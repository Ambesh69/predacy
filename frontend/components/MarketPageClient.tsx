"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { createPublicClient, createWalletClient, custom, http, parseAbiItem } from "viem";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import BatchTimer from "@/components/BatchTimer";
import CommitmentFeed from "@/components/CommitmentFeed";
import OrderForm from "@/components/OrderForm";
import PositionsPanel from "@/components/PositionsPanel";
import PriceChart from "@/components/PriceChart";
import WalletButton from "@/components/WalletButton";
import { getMarket, MOCK_MARKETS, type Market } from "@/lib/polymarket";
import {
  BATCH_VAULT_ABI,
  CTF_ABI,
  ERC20_ABI,
  MOCK_USDC_ABI,
  BatchStatus,
  getContracts,
} from "@/lib/contracts";
import {
  ACTIVE_CHAIN,
  ACTIVE_CHAIN_ID_HEX,
  ACTIVE_CHAIN_NAME,
  CHAIN_GAS,
  IS_MAINNET,
} from "@/lib/chain";
import { clsx } from "clsx";

// ── Viem public client (read-only, no wallet needed) ─────────────────────────
const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(),
});

// ── Fallback batch state shown before chain data loads ────────────────────────
const MOCK_BATCH = {
  batchId: 0n,
  batchMarketId: ("0x" + "0".repeat(64)) as `0x${string}`,
  openedAt: Math.floor(Date.now() / 1000) - 8,
  batchWindow: 30,
  commitmentCount: 0,
  totalDeposited: 0n,
  status: BatchStatus.OPEN,
  clearingPrice: 0n,
};

const MOCK_COMMITMENTS: Array<{
  hash: `0x${string}`;
  amount: bigint;
  trader: `0x${string}`;
  timestamp: number;
}> = [];

// Gas params imported from chain.ts (CHAIN_GAS adapts to mainnet vs testnet)

// ── Provider discovery ────────────────────────────────────────────────────────
// When multiple wallet extensions are installed (e.g. Backpack + MetaMask),
// another wallet can seize window.ethereum as a read-only getter, completely
// blocking MetaMask from injecting itself. MetaMask v10+ always announces via
// EIP-6963 regardless, so we use that to find it directly.
async function findBestProvider(): Promise<{ provider: any; name: string }> {
  if (typeof window === "undefined") throw new Error("Not in browser");

  // 1. EIP-6963: ask all installed wallets to announce themselves (150 ms window)
  const eip6963 = await new Promise<{ provider: any; name: string } | null>(
    (resolve) => {
      const found: { info: any; provider: any }[] = [];
      const handler = (e: Event) => {
        const d = (e as CustomEvent).detail;
        if (d?.provider) found.push(d);
      };
      window.addEventListener("eip6963:announceProvider", handler);
      window.dispatchEvent(new CustomEvent("eip6963:requestProvider"));
      setTimeout(() => {
        window.removeEventListener("eip6963:announceProvider", handler);
        if (found.length === 0) { resolve(null); return; }
        // Prefer MetaMask specifically
        const mm = found.find(
          (p) =>
            p.info?.rdns === "io.metamask" ||
            p.info?.name?.toLowerCase().includes("metamask"),
        );
        if (mm) { resolve({ provider: mm.provider, name: "MetaMask" }); return; }
        // Fallback: first EIP-6963 responder
        resolve({ provider: found[0].provider, name: found[0].info?.name ?? "Wallet" });
      }, 150);
    },
  );
  if (eip6963) return eip6963;

  // 2. window.ethereum.providers[] (legacy multi-wallet shim)
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No Ethereum wallet found. Please install MetaMask.");
  if (Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p: any) => p.isMetaMask);
    if (mm) return { provider: mm, name: "MetaMask" };
    return { provider: eth.providers[0], name: "Wallet" };
  }

  // 3. window.ethereum as-is (might be Backpack or another wallet)
  const name = eth.isMetaMask
    ? "MetaMask"
    : eth.isBackpack
      ? "Backpack"
      : "Wallet";
  return { provider: eth, name };
}

export default function MarketPageClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [market, setMarket]           = useState<Market | null>(null);
  const [batch, setBatch]             = useState(MOCK_BATCH);
  const [commitments, setCommitments] = useState(MOCK_COMMITMENTS);
  const [loading, setLoading]         = useState(true);
  const [submitStep, setSubmitStep]   = useState<"approving" | "signing" | null>(null);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [chainError, setChainError]   = useState<string | null>(null);
  const [activeTab, setActiveTab]     = useState<"order" | "positions">("order");
  const [position, setPosition]       = useState<{
    filledAmount: bigint;
    refundAmount: bigint;
    isBuy: boolean;
    claimed: boolean;
  } | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [historicalMarketIds, setHistoricalMarketIds] = useState<`0x${string}`[]>([]);

  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet        = wallets[0];
  const walletAddress = wallet?.address as `0x${string}` | undefined;
  const isConnected   = authenticated && !!walletAddress;

  // Track the best available provider's chain via EIP-6963 / window.ethereum events.
  const [rawChainId, setRawChainId]   = useState<string | null>(null);
  const [walletName, setWalletName]   = useState<string | null>(null);
  useEffect(() => {
    if (!isConnected) { setRawChainId(null); setWalletName(null); return; }
    let active = true;
    findBestProvider().then(({ provider, name }) => {
      if (!active) return;
      setWalletName(name);
      provider.request({ method: "eth_chainId" }).then((id: string) => {
        if (active) setRawChainId(id);
      });
      const handler = (id: string) => { if (active) setRawChainId(id); };
      provider.on?.("chainChanged", handler);
      return () => provider.removeListener?.("chainChanged", handler);
    }).catch(() => {});
    return () => { active = false; };
  }, [isConnected]);

  const onWrongChain = isConnected && rawChainId !== null && rawChainId.toLowerCase() !== ACTIVE_CHAIN_ID_HEX;

  // ── Load market ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const found = MOCK_MARKETS.find((m) => m.conditionId === id);
    if (found) { setMarket(found); setLoading(false); return; }
    getMarket(id)
      .then((m) => setMarket(m))
      .catch(() => setMarket(null))
      .finally(() => setLoading(false));
  }, [id]);

  // ── Clear stale per-batch state when batchId advances ───────────────────────
  // When a new batch opens the position from the settled batch and the old
  // commitment feed must be wiped so they don't appear for the new cycle.
  useEffect(() => {
    if (batch.batchId === 0n) return; // don't clear on initial load
    setPosition(null);
    setCommitments([]);
  }, [batch.batchId]);

  // ── Fetch on-chain commitment feed via getLogs ───────────────────────────────
  // Runs once on mount and whenever the batchId advances.
  // Only fetches events for the current batchId; merges with locally-submitted.
  useEffect(() => {
    if (batch.batchId === 0n) return;
    let cancelled = false;
    const fetchOnChainCommitments = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const logs = await publicClient.getLogs({
          address:   contracts.batchVault,
          event:     parseAbiItem(
            "event OrderCommitted(uint256 indexed batchId, address indexed trader, bytes32 commitment, uint256 amount)",
          ),
          args:      { batchId: batch.batchId }, // only current batch's orders
          fromBlock: 0n,
          toBlock:   "latest",
        });
        if (cancelled) return;
        const onChain = logs.map((log) => ({
          hash:      log.args.commitment as `0x${string}`,
          amount:    log.args.amount     as bigint,
          trader:    log.args.trader     as `0x${string}`,
          timestamp: Number(log.blockNumber ?? 0n) * 1000,
        }));
        setCommitments((prev) => {
          const existing = new Set(prev.map((c) => c.hash));
          const newOnes  = onChain.filter((c) => !existing.has(c.hash));
          return newOnes.length ? [...prev, ...newOnes] : prev;
        });
      } catch {
        // RPC hiccup — keep showing current state
      }
    };
    fetchOnChainCommitments();
    return () => { cancelled = true; };
  }, [batch.batchId]);

  // ── Poll batch state from chain ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchBatch = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);

        const batchId = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args: [id as `0x${string}`],
        }) as bigint;

        if (batchId === 0n) return;

        const b = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getBatch",
          args: [batchId],
        }) as {
          marketId: `0x${string}`;
          openedAt: bigint; closedAt: bigint; status: number;
          totalDeposited: bigint; clearingPrice: bigint;
          commitmentCount: bigint;
        };

        if (!cancelled) {
          setBatch({
            batchId,
            batchMarketId:   b.marketId,
            openedAt:        Number(b.openedAt),
            batchWindow:     30,
            commitmentCount: Number(b.commitmentCount),
            totalDeposited:  b.totalDeposited,
            status:          b.status as BatchStatus,
            clearingPrice:   b.clearingPrice,
          });
        }
      } catch {
        // RPC hiccup — keep showing current state
      }
    };

    fetchBatch();
    const interval = setInterval(fetchBatch, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // ── Poll position when batch is SETTLED ─────────────────────────────────────
  useEffect(() => {
    if (batch.status !== BatchStatus.SETTLED || !isConnected || !walletAddress) return;
    let cancelled = false;
    const fetchPosition = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const pos = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getPosition",
          args: [batch.batchId, walletAddress],
        }) as { filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean };
        if (!cancelled) setPosition(pos);
      } catch {
        // RPC hiccup — keep current
      }
    };
    fetchPosition();
    return () => { cancelled = true; };
  }, [batch.status, batch.batchId, walletAddress, isConnected]);

  // ── ensureChain ───────────────────────────────────────────────────────────────
  // Uses EIP-6963 to find MetaMask (works even when Backpack/another wallet has
  // seized window.ethereum as a read-only property). Calls wallet_switchEthereumChain
  // on the discovered provider, then polls eth_chainId to confirm the switch
  // before handing back a ready walletClient.
  const ensureAmoy = async () => {
    if (!walletAddress) throw new Error("Wallet not connected");

    // Discover the best provider (prefers MetaMask via EIP-6963)
    const { provider, name } = await findBestProvider();

    // Switch to Amoy — shows the wallet's native "Switch Network" dialog
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ACTIVE_CHAIN_ID_HEX }],
      });
    } catch (err: any) {
      if (err.code === 4902) {
        // Chain unknown to this wallet — add it first
        const addParams = IS_MAINNET
          ? {
              chainId: ACTIVE_CHAIN_ID_HEX,
              chainName: "Polygon",
              nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
              rpcUrls: ["https://polygon-rpc.com/"],
              blockExplorerUrls: ["https://polygonscan.com/"],
            }
          : {
              chainId: ACTIVE_CHAIN_ID_HEX,
              chainName: "Polygon Amoy",
              nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
              rpcUrls: ["https://rpc-amoy.polygon.technology/"],
              blockExplorerUrls: ["https://amoy.polygonscan.com/"],
            };
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [addParams],
        });
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ACTIVE_CHAIN_ID_HEX }],
        });
      } else if (err.code === 4001) {
        throw new Error(`Network switch cancelled — please approve switching to ${ACTIVE_CHAIN_NAME}.`);
      } else {
        // Some wallets (e.g. Backpack) reject wallet_switchEthereumChain
        // with proprietary error codes. Surface a clear message.
        throw new Error(
          `${name} declined the network switch (${err.message ?? err.code}). ` +
          `Please manually switch ${name} to ${ACTIVE_CHAIN_NAME} (Chain ID ${ACTIVE_CHAIN.id}) ` +
          `or disable ${name} and reconnect with MetaMask.`
        );
      }
    }

    // Poll until eth_chainId confirms the target chain
    let onTargetChain = false;
    for (let i = 0; i < 15; i++) {
      const id = (await provider.request({ method: "eth_chainId" })) as string;
      if (id.toLowerCase() === ACTIVE_CHAIN_ID_HEX) { onTargetChain = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!onTargetChain) {
      throw new Error(
        `${name} is still on the wrong network. Please switch to ${ACTIVE_CHAIN_NAME} ` +
        `(Chain ID ${ACTIVE_CHAIN.id}) inside ${name} and try again.`
      );
    }

    return createWalletClient({
      account: walletAddress,
      chain: ACTIVE_CHAIN,
      transport: custom(provider),
    });
  };

  // ── Submit order ─────────────────────────────────────────────────────────────
  //
  // Privacy flow (EIP-712 meta-transaction):
  //   1. Approve USDC to BatchVault if insufficient (1 tx — only gas the user pays)
  //   2. Read current nonce from nonces[walletAddress] on-chain
  //   3. Sign CommitOrder off-chain via signTypedData (no tx, no gas)
  //   4. POST { signer, commitment, signature, nonce, deadline, ... } to relayer
  //   5. Relayer calls commitOrderFor() — only relayer address appears on-chain
  //
  // The user's wallet address never appears in any on-chain event.
  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`;
    amount: bigint;
    salt: `0x${string}`;
    isBuy: boolean;
    limitPrice: bigint;
  }) => {
    setChainError(null);
    const contracts = getContracts(ACTIVE_CHAIN.id);

    // ensureAmoy() switches to Amoy if needed, then gives us a ready walletClient
    setSubmitStep("approving");
    const walletClient = await ensureAmoy();

    // Step 1 — ensure collateral is approved:
    //   Buy orders  → approve USDC (commitOrderFor calls transferFrom)
    //   Sell orders → approve CTF setApprovalForAll (commitSellOrderFor calls safeTransferFrom)
    if (params.isBuy) {
      const allowance = await publicClient.readContract({
        address: contracts.usdc,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [walletAddress!, contracts.batchVault],
      }) as bigint;

      if (allowance < params.amount) {
        const approveTx = await walletClient.writeContract({
          address: contracts.usdc,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [contracts.batchVault, params.amount],
          ...CHAIN_GAS,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }
    } else {
      // Sell order: need CTF operator approval so vault can safeTransferFrom YES tokens
      // MockCTF doesn't expose isApprovedForAll — fall back to assuming not approved;
      // setApprovalForAll is idempotent so calling it twice is safe.
      let isApproved = false;
      try {
        isApproved = await publicClient.readContract({
          address: contracts.ctf,
          abi: CTF_ABI,
          functionName: "isApprovedForAll",
          args: [walletAddress!, contracts.batchVault],
        }) as boolean;
      } catch {
        isApproved = false;
      }

      if (!isApproved) {
        const approveTx = await walletClient.writeContract({
          address: contracts.ctf,
          abi: CTF_ABI,
          functionName: "setApprovalForAll",
          args: [contracts.batchVault, true],
          ...CHAIN_GAS,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }
    }

    // Step 2 — read current EIP-712 nonce for this signer
    const nonce = await publicClient.readContract({
      address: contracts.batchVault,
      abi: BATCH_VAULT_ABI,
      functionName: "nonces",
      args: [walletAddress!],
    }) as bigint;

    // Step 3 — sign CommitOrder off-chain (no tx, no gas — MetaMask "Sign" popup)
    setSubmitStep("signing");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min from now

    const signature = await walletClient.signTypedData({
      account: walletAddress!,
      domain: {
        name: "BatchVault",
        version: "1",
        chainId: BigInt(ACTIVE_CHAIN.id),
        verifyingContract: contracts.batchVault,
      },
      types: {
        CommitOrder: [
          { name: "commitment", type: "bytes32" },
          { name: "amount",     type: "uint256" },
          { name: "batchId",    type: "uint256" },
          { name: "nonce",      type: "uint256" },
          { name: "deadline",   type: "uint256" },
        ],
      },
      primaryType: "CommitOrder",
      message: {
        commitment: params.commitment,
        amount:     params.amount,
        batchId:    batch.batchId,
        nonce,
        deadline,
      },
    });

    // Step 4 — POST to relayer (privacy path: relayer submits commitOrderFor on-chain)
    // The relayer pays the commitment gas. Only relayer address visible on-chain.
    const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

    const resp = await fetch(`${relayerUrl}/order`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId:   id,             // Polymarket condition ID — routes to correct market's batch
        batchId:    batch.batchId.toString(),
        signer:     walletAddress,
        isBuy:      params.isBuy,
        isSell:     !params.isBuy,  // sell orders (YES token deposits) use commitSellOrderFor
        amount:     params.amount.toString(),
        limitPrice: params.limitPrice.toString(),
        salt:       params.salt,
        commitment: params.commitment,
        signature,
        nonce:      nonce.toString(),
        deadline:   deadline.toString(),
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Relayer error" }));
      throw new Error(err.error ?? `Relayer returned ${resp.status}`);
    }

    // Update local state optimistically (relayer will also emit OrderCommitted soon)
    if (walletAddress) {
      setCommitments((prev) => [
        ...prev,
        { hash: params.commitment, amount: params.amount, trader: walletAddress, timestamp: Date.now(), isBuy: params.isBuy },
      ]);
      setBatch((prev) => ({
        ...prev,
        commitmentCount: prev.commitmentCount + 1,
        // Only USDC buy orders contribute to totalDeposited; sell orders deposit YES tokens
        totalDeposited: params.isBuy ? prev.totalDeposited + params.amount : prev.totalDeposited,
      }));
    }

    // Auto-switch to "My Positions" tab so user can track their sealed order
    setActiveTab("positions");
  };

  // ── USDC faucet (Amoy only) ──────────────────────────────────────────────────
  const handleGetTestUsdc = async () => {
    if (!walletAddress || !wallet) return;
    setFaucetLoading(true);
    try {
      // ensureAmoy() switches to Amoy first, then returns a ready walletClient
      const walletClient = await ensureAmoy();
      const contracts = getContracts(ACTIVE_CHAIN.id);
      const tx = await walletClient.writeContract({
        address: contracts.usdc,
        abi: MOCK_USDC_ABI,
        functionName: "mint",
        args: [walletAddress, 10_000_000_000n], // $10,000 USDC
        ...CHAIN_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
    } catch (e: any) {
      if (e?.code !== 4001) { // ignore user rejection
        setChainError(e.message ?? "Faucet failed");
      }
    } finally {
      setFaucetLoading(false);
    }
  };

  // ── Claim position (parameterized — works for current or historical batches) ──
  const handleClaimPosition = async (batchId: bigint) => {
    setClaimLoading(true);
    setChainError(null);
    try {
      const walletClient = await ensureAmoy();
      const contracts = getContracts(ACTIVE_CHAIN.id);
      const tx = await walletClient.writeContract({
        address: contracts.batchVault,
        abi: BATCH_VAULT_ABI,
        functionName: "claimPosition",
        args: [batchId],
        ...CHAIN_GAS,
        gas: 400_000n,  // skip eth_estimateGas — Amoy RPC returns junk values for this call
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted — the batch may not be fully settled yet. Try again in a few seconds.");
      }
      // If claiming current batch, update current position state too
      if (batchId === batch.batchId) {
        setPosition((p) => p ? { ...p, claimed: true } : p);
      }
      // Signal OrderForm to re-fetch YES balance (tokens now in user's wallet)
      setBalanceVersion(v => v + 1);
    } catch (e: any) {
      if (e?.code !== 4001) setChainError(e.message ?? "Claim failed");
      throw e; // re-throw so PositionsPanel can handle per-card error state
    } finally {
      setClaimLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!market) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <span className="text-muted text-xs tracking-widest uppercase">Market not found</span>
        <Link href="/" className="text-accent text-xs hover:underline">← Back to markets</Link>
      </div>
    );
  }

  const yesPrice = parseFloat(market.outcomePrices[0]);
  const yesProb  = Math.round(yesPrice * 100);

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-[11px] text-text">{value}</span>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center gap-4">
        <Link
          href="/"
          className="text-muted hover:text-text transition-colors text-xs tracking-widest uppercase flex items-center gap-1.5"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
          </svg>
          Markets
        </Link>
        <span className="text-border">|</span>
        <h1
          className="text-lg font-black text-text tracking-tight leading-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          PREDACY
        </h1>
        <div className="ml-auto flex items-center gap-3">
          {/* Faucet button — testnet only (not shown on mainnet) */}
          {isConnected && !IS_MAINNET && (
            <button
              onClick={handleGetTestUsdc}
              disabled={faucetLoading}
              className="text-[10px] tracking-widest uppercase border border-border text-muted px-3 py-1.5 hover:border-border-bright hover:text-text transition-colors disabled:opacity-40"
            >
              {faucetLoading ? "MINTING…" : "GET TEST USDC"}
            </button>
          )}
          <WalletButton compact />
        </div>
      </header>

      {/* Chain error banner */}
      {chainError && (
        <div className="border-b border-danger/30 bg-danger/5 px-6 py-2 flex items-center justify-between gap-4">
          <p className="text-danger text-xs">{chainError}</p>
          <button onClick={() => setChainError(null)} className="text-danger/60 hover:text-danger text-xs">✕</button>
        </div>
      )}

      {/* (Market mismatch banner removed — each market now has its own batch slot) */}

      {/* Wrong-network banner */}
      {onWrongChain && (
        <div className="border-b border-yellow-500/30 bg-yellow-500/5 px-6 py-2">
          <p className="text-yellow-400 text-xs">
            {walletName && walletName !== "MetaMask"
              ? `Connected via ${walletName} on the wrong network. Click any action below — ${walletName} will be prompted to switch to ${ACTIVE_CHAIN_NAME}. If ${walletName} doesn't support it, disable it and reconnect with MetaMask.`
              : `Wrong network — click any action to switch to ${ACTIVE_CHAIN_NAME} automatically.`}
          </p>
        </div>
      )}

      {/* Market info bar */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {market.category && (
              <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5 mb-2 inline-block">
                {market.category}
              </span>
            )}
            <h2 className="text-text text-sm leading-snug mt-1">{market.question}</h2>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className="text-[10px] text-muted tracking-widest uppercase">Polymarket Price</p>
            <p
              className={clsx(
                "text-3xl font-black leading-none",
                yesProb > 60 ? "text-accent glow-accent" : yesProb < 40 ? "text-danger glow-danger" : "text-blue glow-blue",
              )}
              style={{ fontFamily: "var(--font-display)" }}
            >
              {yesProb}%
            </p>
            <p className="text-[10px] text-muted mt-0.5">YES probability</p>
          </div>
        </div>
      </div>

      {/* Main layout: 3 columns */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] divide-x divide-border">

        {/* Column 1: Batch timer + stats */}
        <div className="p-6 flex flex-col gap-6 border-b lg:border-b-0">
          <BatchTimer
            openedAt={batch.openedAt}
            batchWindow={batch.batchWindow}
            commitmentCount={batch.commitmentCount}
            totalDeposited={batch.totalDeposited}
            batchId={batch.batchId}
            status={batch.status}
            clearingPrice={batch.clearingPrice}
          />

          {/* Market condition ID */}
          <div className="space-y-1">
            <p className="text-[10px] text-muted tracking-widest uppercase">Market ID</p>
            <p className="hash-text text-[11px] break-all">{id}</p>
          </div>

          {/* Privacy explainer */}
          <div className="border border-border p-3 space-y-2">
            <p className="text-[10px] text-muted-dim tracking-widest uppercase">What's hidden</p>
            <div className="space-y-1.5">
              {[
                { item: "Your wallet address",       hidden: true },
                { item: "Your direction (buy/sell)", hidden: true },
                { item: "Your order type & price",   hidden: true },
                { item: "Your trade amount",         hidden: true },
                { item: "Clearing price (until settle)", hidden: true },
                { item: "Commitment hash",           hidden: false },
                { item: "USDC deposited",            hidden: false },
              ].map(({ item, hidden }) => (
                <div key={item} className="flex items-center gap-2">
                  <span className={clsx("text-[10px]", hidden ? "text-accent/60" : "text-muted-dim")}>
                    {hidden ? "✓" : "○"}
                  </span>
                  <span className={clsx("text-[11px]", hidden ? "text-text/70" : "text-muted-dim")}>
                    {item}
                  </span>
                  {hidden && (
                    <span className="ml-auto text-[10px] text-accent/40 tracking-widest uppercase">hidden</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Column 2: Price chart + Commitment feed */}
        <div className="flex flex-col min-h-[400px] lg:min-h-0 border-b lg:border-b-0">
          {market.clobTokenIds?.[0] && (
            <PriceChart
              tokenId={market.clobTokenIds[0]}
              currentPrice={parseFloat(market.outcomePrices[0] ?? "0.5")}
            />
          )}
          <div className="flex-1 min-h-0">
            <CommitmentFeed entries={commitments} myAddress={walletAddress} />
          </div>
        </div>

        {/* Column 3: Order form / Positions */}
        <div className="flex flex-col">
          {/* Column 3 header: tabs + batch status indicator */}
          <div className="border-b border-border px-4 py-0 flex items-center">
            {/* Tabs */}
            <div className="flex items-center flex-1">
              <button
                type="button"
                onClick={() => setActiveTab("order")}
                className={clsx(
                  "px-3 py-3 text-[10px] tracking-widest uppercase transition-colors border-b-2",
                  activeTab === "order"
                    ? "border-text/40 text-text"
                    : "border-transparent text-muted hover:text-text"
                )}
              >
                Order
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("positions")}
                className={clsx(
                  "px-3 py-3 text-[10px] tracking-widest uppercase transition-colors border-b-2",
                  activeTab === "positions"
                    ? "border-text/40 text-text"
                    : "border-transparent text-muted hover:text-text"
                )}
              >
                My Positions
              </button>
            </div>
            {/* Batch status dot */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className={clsx(
                "w-1.5 h-1.5 rounded-full",
                batch.status === BatchStatus.OPEN ? "bg-accent animate-pulse" : "bg-muted/40"
              )} />
              <span className={clsx(
                "text-[10px] tracking-widest uppercase",
                batch.status === BatchStatus.OPEN ? "text-accent/70" : "text-muted-dim"
              )}>
                {batch.status === BatchStatus.OPEN
                  ? "OPEN"
                  : batch.status === BatchStatus.SETTLING
                  ? "SETTLING"
                  : "SETTLED"}
              </span>
            </div>
          </div>

          {activeTab === "positions" ? (
            /* My Positions panel — multi-batch history + claim */
            isConnected && walletAddress ? (
              <PositionsPanel
                walletAddress={walletAddress}
                currentBatchId={batch.batchId}
                currentBatchStatus={batch.status}
                currentBatchCommitments={commitments
                  .filter((c) => c.trader === walletAddress)
                  .map((c) => ({ hash: c.hash, amount: c.amount }))}
                onClaim={handleClaimPosition}
                onMarketIdsFound={setHistoricalMarketIds}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
                <p className="text-muted text-xs text-center">Connect your wallet to view positions</p>
                <button
                  onClick={login}
                  className="border border-border-bright text-text text-[11px] tracking-widest uppercase px-4 py-2 hover:border-text/30 transition-colors"
                >
                  Connect Wallet
                </button>
              </div>
            )
          ) : batch.status === BatchStatus.SETTLED ? (
            /* Claim panel — shown on ORDER tab after batch settles */
            <div className="flex-1 p-5 flex flex-col gap-4">
              <div className="border border-border p-4 space-y-3">
                <Row
                  label="Clearing price"
                  value={
                    batch.clearingPrice > 0n
                      ? `${(Number(batch.clearingPrice) / 1e6 * 100).toFixed(1)}¢`
                      : "No cross"
                  }
                />
                {position && (
                  <div className="border-t border-border/40 pt-3 space-y-3">
                    <Row label="Side" value={position.isBuy ? "BUY YES" : "SELL YES"} />
                    <Row label="Filled" value={`$${(Number(position.filledAmount) / 1e6).toFixed(2)}`} />
                    {position.refundAmount > 0n && (
                      <Row label="Refund" value={`$${(Number(position.refundAmount) / 1e6).toFixed(2)}`} />
                    )}
                  </div>
                )}
              </div>

              {/* Claim button / status */}
              {!isConnected ? (
                <button
                  onClick={login}
                  className="w-full border border-border text-muted text-[11px] tracking-widest uppercase py-3 hover:border-border-bright hover:text-text transition-colors"
                >
                  CONNECT TO CLAIM
                </button>
              ) : position === null ? (
                <p className="text-muted text-xs text-center animate-pulse">Loading position…</p>
              ) : position.claimed ? (
                <div className="space-y-2 text-center">
                  <p className="text-accent text-[11px] tracking-widest uppercase">✓ CLAIMED</p>
                  {position.filledAmount > 0n && (
                    <p className="text-muted-dim text-[10px]">
                      {position.isBuy && batch.clearingPrice > 0n
                        ? `~${(Number(position.filledAmount) / Number(batch.clearingPrice)).toFixed(2)} YES tokens received`
                        : `$${(Number(position.filledAmount) / 1e6).toFixed(2)} USDC received`}
                      {position.refundAmount > 0n && ` + ${position.isBuy
                        ? `$${(Number(position.refundAmount) / 1e6).toFixed(2)} refund`
                        : `${(Number(position.refundAmount) / 1e6).toFixed(2)} YES tokens refunded`}`}
                    </p>
                  )}
                </div>
              ) : position.filledAmount === 0n && position.refundAmount === 0n ? (
                <p className="text-muted text-xs text-center">No position in this batch</p>
              ) : (
                <button
                  onClick={() => handleClaimPosition(batch.batchId)}
                  disabled={claimLoading}
                  className="w-full border border-accent text-accent text-[11px] tracking-widest uppercase py-3 hover:bg-accent/5 transition-colors disabled:opacity-40"
                >
                  {claimLoading ? "CLAIMING…" : "CLAIM POSITION"}
                </button>
              )}
            </div>
          ) : (
            /* Order form — shown while batch is OPEN or SETTLING */
            <div className="flex-1">
              <OrderForm
                market={market}
                marketId={batch.batchMarketId}
                batchOpen={batch.status === BatchStatus.OPEN}
                onSubmit={handleOrderSubmit}
                walletAddress={walletAddress}
                isConnected={isConnected}
                onConnect={login}
                submitStep={submitStep}
                balanceVersion={balanceVersion}
                candidateMarketIds={[batch.batchMarketId, ...historicalMarketIds]}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
