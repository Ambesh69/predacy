"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import BatchTimer from "@/components/BatchTimer";
import CommitmentFeed from "@/components/CommitmentFeed";
import OrderForm from "@/components/OrderForm";
import WalletButton from "@/components/WalletButton";
import { getMarket, MOCK_MARKETS, type Market } from "@/lib/polymarket";
import {
  BATCH_VAULT_ABI,
  ERC20_ABI,
  MOCK_USDC_ABI,
  BatchStatus,
  getContracts,
} from "@/lib/contracts";
import { clsx } from "clsx";

// ── Viem public client (read-only, no wallet needed) ─────────────────────────
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(),
});

// ── Fallback batch state shown before chain data loads ────────────────────────
const MOCK_BATCH = {
  batchId: 0n,
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

// Polygon Amoy chain ID in hex
const AMOY_CHAIN_ID_HEX = "0x13882"; // 80002

export default function MarketPageClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [market, setMarket]           = useState<Market | null>(null);
  const [batch, setBatch]             = useState(MOCK_BATCH);
  const [commitments, setCommitments] = useState(MOCK_COMMITMENTS);
  const [loading, setLoading]         = useState(true);
  const [submitStep, setSubmitStep]   = useState<"approving" | "committing" | null>(null);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [chainError, setChainError]   = useState<string | null>(null);

  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet        = wallets[0];
  const walletAddress = wallet?.address as `0x${string}` | undefined;
  const isConnected   = authenticated && !!walletAddress;

  // Simple banner: Privy exposes wallet.chainId as "eip155:XXXXX" synchronously.
  // This may not update instantly after MetaMask switches, but ensureAmoy() below
  // guarantees the right chain before any tx regardless of this value.
  const onWrongChain = isConnected && !!wallet?.chainId && wallet.chainId !== `eip155:${polygonAmoy.id}`;

  // ── Load market ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const found = MOCK_MARKETS.find((m) => m.conditionId === id);
    if (found) { setMarket(found); setLoading(false); return; }
    getMarket(id)
      .then((m) => setMarket(m))
      .catch(() => setMarket(null))
      .finally(() => setLoading(false));
  }, [id]);

  // ── Poll batch state from chain ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchBatch = async () => {
      try {
        const contracts = getContracts(polygonAmoy.id);

        const batchId = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "currentBatchId",
        }) as bigint;

        if (batchId === 0n) return;

        const b = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getBatch",
          args: [batchId],
        }) as {
          openedAt: bigint; closedAt: bigint; status: number;
          totalDeposited: bigint; clearingPrice: bigint;
          commitmentCount: bigint;
        };

        if (!cancelled) {
          setBatch({
            batchId,
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

  // ── ensureAmoy ───────────────────────────────────────────────────────────────
  // Switches MetaMask to Polygon Amoy if needed, then returns a ready walletClient.
  // - Already on Amoy → wallet_switchEthereumChain returns immediately, no prompt.
  // - Wrong chain     → MetaMask shows switch-network prompt.
  // - Chain unknown   → wallet_addEthereumChain first, then switch.
  // Called at the start of every tx handler so the chain is always right.
  const ensureAmoy = async () => {
    if (!wallet || !walletAddress) throw new Error("Wallet not connected");
    const provider = await wallet.getEthereumProvider();

    try {
      await (provider as any).request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: AMOY_CHAIN_ID_HEX }],
      });
    } catch (err: any) {
      if (err.code === 4902) {
        // Chain not in wallet yet — add it, then switch
        await (provider as any).request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: AMOY_CHAIN_ID_HEX,
            chainName: "Polygon Amoy",
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            rpcUrls: ["https://rpc-amoy.polygon.technology/"],
            blockExplorerUrls: ["https://amoy.polygonscan.com/"],
          }],
        });
        await (provider as any).request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: AMOY_CHAIN_ID_HEX }],
        });
      } else if (err.code !== 4001) {
        // 4001 = user rejected — rethrow anything unexpected
        throw err;
      }
    }

    return createWalletClient({
      account: walletAddress,
      chain: polygonAmoy,
      transport: custom(provider),
    });
  };

  // ── Submit order ─────────────────────────────────────────────────────────────
  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`;
    amount: bigint;
    salt: `0x${string}`;
    isBuy: boolean;
    limitPrice: bigint;
  }) => {
    setChainError(null);

    // ensureAmoy() switches to Amoy if needed, then gives us a ready walletClient
    setSubmitStep("approving");
    const walletClient = await ensureAmoy();
    const contracts = getContracts(polygonAmoy.id);

    // Step 1 — approve USDC if allowance is insufficient
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
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    // Step 2 — submit sealed commitment
    setSubmitStep("committing");
    const commitTx = await walletClient.writeContract({
      address: contracts.batchVault,
      abi: BATCH_VAULT_ABI,
      functionName: "commitOrder",
      args: [params.commitment, params.amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: commitTx });

    // Update local state optimistically
    if (walletAddress) {
      setCommitments((prev) => [
        ...prev,
        { hash: params.commitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() },
      ]);
      setBatch((prev) => ({
        ...prev,
        commitmentCount: prev.commitmentCount + 1,
        totalDeposited:  prev.totalDeposited + params.amount,
      }));
    }
  };

  // ── USDC faucet (Amoy only) ──────────────────────────────────────────────────
  const handleGetTestUsdc = async () => {
    if (!walletAddress || !wallet) return;
    setFaucetLoading(true);
    try {
      // ensureAmoy() switches to Amoy first, then returns a ready walletClient
      const walletClient = await ensureAmoy();
      const contracts = getContracts(polygonAmoy.id);
      const tx = await walletClient.writeContract({
        address: contracts.usdc,
        abi: MOCK_USDC_ABI,
        functionName: "mint",
        args: [walletAddress, 10_000_000_000n], // $10,000 USDC
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
          {/* Faucet button — Amoy testnet only */}
          {isConnected && (
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

      {/* Wrong-network banner */}
      {onWrongChain && (
        <div className="border-b border-yellow-500/30 bg-yellow-500/5 px-6 py-2 flex items-center justify-between">
          <p className="text-yellow-400 text-xs">
            Wrong network — this app runs on Polygon Amoy.
            Clicking any action will prompt you to switch.
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
            <p className="text-[10px] text-muted/60 tracking-widest uppercase">What's hidden</p>
            <div className="space-y-1.5">
              {[
                { item: "Your direction (buy/sell)", hidden: true },
                { item: "Your limit price",          hidden: true },
                { item: "Your trade amount",         hidden: true },
                { item: "Clearing price (until settle)", hidden: true },
                { item: "Commitment hash",           hidden: false },
                { item: "USDC deposited",            hidden: false },
              ].map(({ item, hidden }) => (
                <div key={item} className="flex items-center gap-2">
                  <span className={clsx("text-[10px]", hidden ? "text-accent/60" : "text-muted/40")}>
                    {hidden ? "✓" : "○"}
                  </span>
                  <span className={clsx("text-[11px]", hidden ? "text-text/70" : "text-muted/50")}>
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

        {/* Column 2: Commitment feed */}
        <div className="flex flex-col min-h-[400px] lg:min-h-0 border-b lg:border-b-0">
          <CommitmentFeed entries={commitments} myAddress={walletAddress} />
        </div>

        {/* Column 3: Order form */}
        <div className="flex flex-col">
          <div className="border-b border-border px-4 py-3 flex items-center justify-between">
            <span className="text-[11px] text-muted tracking-widest uppercase">Place Order</span>
            <div className="flex items-center gap-1.5">
              <div className={clsx(
                "w-1.5 h-1.5 rounded-full",
                batch.status === BatchStatus.OPEN ? "bg-accent animate-pulse" : "bg-muted/40"
              )} />
              <span className={clsx(
                "text-[10px] tracking-widest uppercase",
                batch.status === BatchStatus.OPEN ? "text-accent/70" : "text-muted/40"
              )}>
                {batch.status === BatchStatus.OPEN
                  ? "OPEN"
                  : batch.status === BatchStatus.SETTLING
                  ? "SETTLING"
                  : "SETTLED"}
              </span>
            </div>
          </div>
          <div className="flex-1">
            <OrderForm
              market={market}
              marketId={id as `0x${string}`}
              batchOpen={batch.status === BatchStatus.OPEN}
              onSubmit={handleOrderSubmit}
              walletAddress={walletAddress}
              isConnected={isConnected}
              onConnect={login}
              submitStep={submitStep}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
