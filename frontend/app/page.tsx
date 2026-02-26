"use client";

import { useState, useEffect } from "react";
import { createPublicClient, http } from "viem";
import MarketCard from "@/components/MarketCard";
import WalletButton from "@/components/WalletButton";
import { MOCK_MARKETS, getMarkets, type Market } from "@/lib/polymarket";
import { ACTIVE_CHAIN } from "@/lib/chain";
import { getContracts, BATCH_VAULT_ABI } from "@/lib/contracts";

const TICKER_ITEMS = [
  "SEALED BIDS",
  "BATCH AUCTIONS",
  "ZK PROOFS",
  "DARK ORACLE",
  "UNIFORM CLEARING",
  "NO FRONTRUNNING",
  "PRIVATE POSITIONS",
];

const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(process.env.NEXT_PUBLIC_RPC_URL ?? ACTIVE_CHAIN.rpcUrls.default.http[0]),
});

export default function HomePage() {
  const [markets, setMarkets] = useState<Market[]>(MOCK_MARKETS);
  const [loading, setLoading] = useState(true);
  const [liveMarketId, setLiveMarketId] = useState<string | null>(null);

  // Fetch the live Predacy batch's marketId so we can pin + badge it
  useEffect(() => {
    (async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const batchId = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "currentBatchId",
        }) as bigint;
        if (batchId > 0n) {
          const batch = await publicClient.readContract({
            address: contracts.batchVault,
            abi: BATCH_VAULT_ABI,
            functionName: "getBatch",
            args: [batchId],
          }) as { marketId: `0x${string}` };
          const mid = batch.marketId.toLowerCase();
          if (mid !== ("0x" + "0".repeat(64))) setLiveMarketId(mid);
        }
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    getMarkets(20)
      .then((fetched) => {
        // Pin the live Predacy market at index 0
        if (liveMarketId) {
          const idx = fetched.findIndex((m) => m.conditionId.toLowerCase() === liveMarketId);
          if (idx > 0) {
            const live = fetched.splice(idx, 1)[0];
            fetched.unshift(live);
          }
        }
        setMarkets(fetched);
      })
      .catch(() => setMarkets(MOCK_MARKETS))
      .finally(() => setLoading(false));
  }, [liveMarketId]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Ticker tape */}
      <div className="border-b border-border overflow-hidden py-2">
        <div className="flex ticker-content gap-8">
          {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
            <span key={i} className="text-[10px] text-muted-dim tracking-widest uppercase whitespace-nowrap flex items-center gap-2">
              <span className="text-accent/30">◆</span>
              {item}
            </span>
          ))}
        </div>
      </div>

      {/* Header */}
      <header className="border-b border-border px-6 py-5 flex items-end justify-between">
        <div>
          <h1
            className="text-4xl font-black tracking-tight leading-none text-text"
            style={{ fontFamily: "var(--font-display)" }}
          >
            PREDACY
          </h1>
          <p className="text-muted text-xs tracking-widest mt-1">
            DARK POOL PREDICTION MARKETS ·{" "}
            <span className="text-accent/70">SEALED-BID BATCH AUCTIONS</span>
          </p>
        </div>

        <div className="flex items-center gap-4">
          {/* Chain indicator */}
          <div className="flex items-center gap-1.5 border border-border px-3 py-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-[11px] text-muted tracking-widest">POLYGON</span>
          </div>

          <WalletButton />
        </div>
      </header>

      {/* Hero section */}
      <section className="border-b border-border px-6 py-8 grid grid-cols-1 md:grid-cols-3 gap-0">
        {/* Big statement */}
        <div className="md:col-span-2 pr-0 md:pr-8 md:border-r border-border pb-6 md:pb-0">
          <p className="text-muted text-[11px] tracking-widest uppercase mb-3">How it works</p>
          <div className="flex flex-col gap-2">
            {[
              { n: "01", label: "SEAL", desc: "Submit a cryptographic commitment — your order details are encrypted" },
              { n: "02", label: "BATCH", desc: "All orders accumulate privately for 30 seconds" },
              { n: "03", label: "CLEAR", desc: "A ZK proof computes the single uniform clearing price" },
              { n: "04", label: "SETTLE", desc: "Net position routes to Polymarket — only aggregate visible" },
            ].map(({ n, label, desc }) => (
              <div key={n} className="flex items-start gap-4 group">
                <span className="text-[10px] text-muted-dim mt-0.5 w-4 flex-shrink-0">{n}</span>
                <div>
                  <span
                    className="text-sm font-black text-text mr-2"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {label}
                  </span>
                  <span className="text-xs text-muted-dim">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="pl-0 md:pl-8 pt-6 md:pt-0 flex flex-col justify-between">
          <p className="text-muted text-[11px] tracking-widest uppercase mb-3">Protocol Stats</p>
          <div className="space-y-4">
            {[
              { label: "Batch Window", value: "30s", sub: "sealed order window" },
              { label: "Privacy", value: "ZK", sub: "commit-reveal + proof" },
              { label: "Settlement", value: "Polymarket", sub: "routes net position" },
              { label: "Frontrunning", value: "0%", sub: "uniform clearing price" },
            ].map(({ label, value, sub }) => (
              <div key={label} className="flex items-end justify-between">
                <div>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{label}</p>
                  <p className="text-[11px] text-muted-dim">{sub}</p>
                </div>
                <span
                  className="text-xl font-black text-text"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Market list */}
      <main className="flex-1 px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2
              className="text-lg font-black text-text tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              ACTIVE MARKETS
            </h2>
            {loading && (
              <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />
            )}
          </div>
          <span className="text-[11px] text-muted-dim tracking-widest">
            LIVE · POLYMARKET PRICES
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-border">
          {markets.map((market) => (
            <div key={market.conditionId} className="bg-bg">
              <MarketCard
                market={market}
                isLive={!!liveMarketId && market.conditionId.toLowerCase() === liveMarketId}
              />
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-4 flex items-center justify-between">
        <span className="text-[10px] text-muted-dim tracking-widest uppercase">
          Predacy · Private Prediction Markets · Powered by Polymarket Liquidity
        </span>
        <div className="flex items-center gap-4">
          <span className="text-[10px] text-muted-dim">
            <span className="text-accent/30">●</span> No position info leaks on-chain
          </span>
        </div>
      </footer>
    </div>
  );
}
