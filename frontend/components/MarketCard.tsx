"use client";

import Link from "next/link";
import { clsx } from "clsx";
import type { Market } from "@/lib/polymarket";

interface MarketCardProps {
  market: Market;
  isLive?: boolean;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(0)}K`;
  return `$${vol}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export default function MarketCard({ market, isLive = false }: MarketCardProps) {
  const yesPrice = parseFloat(market.outcomePrices?.[0] ?? "0");
  const noPrice  = parseFloat(market.outcomePrices?.[1] ?? "0");
  const yesProb  = Math.round(yesPrice * 100);
  const volume   = market.volumeNum ?? parseFloat(market.volume ?? "0");

  const probColor =
    yesProb > 60 ? "#00FFB3" :
    yesProb < 40 ? "#FF3355" :
    "#4D83FF";

  return (
    <Link href={`/market/${market.conditionId}`} className="block">
      <div className={clsx(
        "market-card border bg-surface p-5 cursor-crosshair flex flex-col gap-3",
        isLive ? "border-accent/40" : "border-border",
      )}>

        {/* Row 1: badges + date */}
        <div className="flex items-center gap-2 flex-wrap">
          {isLive && (
            <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase border border-accent/30 px-2 py-0.5 bg-accent/5">
              <span className="w-1 h-1 rounded-full bg-accent animate-pulse inline-block" />
              LIVE
            </span>
          )}
          {market.category && (
            <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">
              {market.category}
            </span>
          )}
          <span className="text-[10px] text-muted ml-auto">
            Ends {formatDate(market.endDate)}
          </span>
        </div>

        {/* Row 2: question */}
        <h3 className="text-text text-sm leading-snug line-clamp-2 flex-1">
          {market.question}
        </h3>

        {/* Row 3: big % + YES/NO price pills */}
        <div className="flex items-end justify-between gap-3">
          {/* Big probability number */}
          <div className="flex items-baseline gap-1">
            <span
              className="text-3xl font-black tabular-nums leading-none"
              style={{ fontFamily: "var(--font-display)", color: probColor }}
            >
              {yesProb}%
            </span>
            <span className="text-[10px] text-muted tracking-widest uppercase">chance</span>
          </div>

          {/* YES / NO price tags */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] px-2 py-1 border font-mono tabular-nums"
              style={{ borderColor: "#00FFB340", color: "#00FFB3", background: "#00FFB308" }}>
              YES {Math.round(yesPrice * 100)}¢
            </span>
            <span className="text-[11px] px-2 py-1 border font-mono tabular-nums"
              style={{ borderColor: "#FF335540", color: "#FF3355", background: "#FF335508" }}>
              NO {Math.round(noPrice * 100)}¢
            </span>
          </div>
        </div>

        {/* Row 4: thin prob bar */}
        <div className="h-[2px] bg-border rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${yesProb}%`, background: probColor }}
          />
        </div>

        {/* Row 5: volume + dark pool tag */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted">
            {formatVolume(volume)} vol
          </span>
          <div className="flex items-center gap-1">
            <svg className="w-3 h-3 text-muted-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="text-[10px] text-muted-dim tracking-widest uppercase">dark pool</span>
          </div>
        </div>

      </div>
    </Link>
  );
}
