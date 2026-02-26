"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import BatchTimer from "@/components/BatchTimer";
import CommitmentFeed from "@/components/CommitmentFeed";
import OrderForm from "@/components/OrderForm";
import { getMarket, MOCK_MARKETS, type Market } from "@/lib/polymarket";
import { BatchStatus } from "@/lib/contracts";
import { clsx } from "clsx";

// Mock batch state for prototype UI (replace with wagmi hooks for production)
const MOCK_BATCH = {
  batchId: 47n,
  openedAt: Math.floor(Date.now() / 1000) - 8, // opened 8s ago
  batchWindow: 30,
  commitmentCount: 6,
  totalDeposited: 2840_000_000n, // $2840
  status: BatchStatus.OPEN,
  clearingPrice: 0n,
};

const MOCK_COMMITMENTS = [
  { hash: "0x4f2ac3d1e89b5f72a06c1d3e8f9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b" as `0x${string}`, amount: 500_000_000n, trader: "0xaB1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9C" as `0x${string}`, timestamp: Date.now() - 22000 },
  { hash: "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b" as `0x${string}`, amount: 100_000_000n, trader: "0xdEaDbEeFdEaDbEeFdEaDbEeFdEaDbEeFdEaDbEeF" as `0x${string}`, timestamp: Date.now() - 18000 },
  { hash: "0x3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d" as `0x${string}`, amount: 750_000_000n, trader: "0xfEeFEEfEefEEFEEFEEfEefEEfEEfEEfEEFEEFEEF" as `0x${string}`, timestamp: Date.now() - 14000 },
  { hash: "0x7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f" as `0x${string}`, amount: 200_000_000n, trader: "0xBaDbAdBaDbAdBaDbAdBaDbAdBaDbAdBaDbAdBaDb" as `0x${string}`, timestamp: Date.now() - 10000 },
  { hash: "0x2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c" as `0x${string}`, amount: 1000_000_000n, trader: "0xC0FFEEC0fFEEC0FFEEC0fFEEC0FFEEC0FFEEC0FF" as `0x${string}`, timestamp: Date.now() - 6000 },
  { hash: "0x8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e" as `0x${string}`, amount: 290_000_000n, trader: "0x1234567890123456789012345678901234567890" as `0x${string}`, timestamp: Date.now() - 2000 },
];

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [market, setMarket] = useState<Market | null>(null);
  const [batch, setBatch] = useState(MOCK_BATCH);
  const [commitments, setCommitments] = useState(MOCK_COMMITMENTS);
  const [loading, setLoading] = useState(true);

  // In production: replace with useAccount() from wagmi
  const walletAddress: `0x${string}` | undefined = undefined;
  const isConnected = false;

  useEffect(() => {
    const found = MOCK_MARKETS.find((m) => m.conditionId === id);
    if (found) {
      setMarket(found);
      setLoading(false);
      return;
    }
    getMarket(id)
      .then((m) => setMarket(m))
      .catch(() => setMarket(null))
      .finally(() => setLoading(false));
  }, [id]);

  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`;
    amount: bigint;
    salt: `0x${string}`;
    isBuy: boolean;
    limitPrice: bigint;
  }) => {
    // Production flow:
    // 1. Approve USDC for the BatchVault contract
    // 2. Call BatchVault.commitOrder(commitment, amount)
    // 3. POST order details to relayer API (off-chain order book)
    //
    // For prototype: simulate with a 1.5s delay
    await new Promise((r) => setTimeout(r, 1500));

    // Simulate adding a new commitment
    if (walletAddress) {
      setCommitments((prev) => [
        ...prev,
        {
          hash: params.commitment,
          amount: params.amount,
          trader: walletAddress,
          timestamp: Date.now(),
        },
      ]);
      setBatch((prev) => ({
        ...prev,
        commitmentCount: prev.commitmentCount + 1,
        totalDeposited: prev.totalDeposited + params.amount,
      }));
    }
  };

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
  const yesProb = Math.round(yesPrice * 100);

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
      </header>

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
                { item: "Your limit price", hidden: true },
                { item: "Your trade amount", hidden: true },
                { item: "Clearing price (until settle)", hidden: true },
                { item: "Commitment hash", hidden: false },
                { item: "USDC deposited", hidden: false },
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
          <CommitmentFeed
            entries={commitments}
            myAddress={walletAddress}
          />
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
                {batch.status === BatchStatus.OPEN ? "OPEN" : batch.status === BatchStatus.SETTLING ? "SETTLING" : "SETTLED"}
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
              onConnect={() => {
                // In production: call wagmi's `connect()` or RainbowKit's modal
                alert("Connect wallet — integrate RainbowKit here");
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
