"use client";

import Link from "next/link";
import { clsx } from "clsx";
import type { Market } from "@/lib/polymarket";

interface MarketCardProps {
  market: Market;
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

function ProbBar({ prob }: { prob: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-[2px] bg-border relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 transition-all duration-500"
          style={{
            width: `${prob}%`,
            background: prob > 60
              ? "linear-gradient(90deg, #00C48A, #00FFB3)"
              : prob < 40
              ? "linear-gradient(90deg, #CC2244, #FF3355)"
              : "linear-gradient(90deg, #2D5AE0, #4D83FF)",
          }}
        />
      </div>
      <span
        className={clsx(
          "text-sm font-bold tabular-nums w-10 text-right",
          prob > 60 ? "text-accent" : prob < 40 ? "text-danger" : "text-blue",
        )}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {prob}%
      </span>
    </div>
  );
}

export default function MarketCard({ market }: MarketCardProps) {
  const yesPrice = parseFloat(market.outcomePrices[0]);
  const yesProb = Math.round(yesPrice * 100);
  const volume = market.volumeNum ?? parseFloat(market.volume ?? "0");

  return (
    <Link href={`/market/${market.conditionId}`} className="block">
      <div className="market-card border border-border bg-surface p-5 cursor-crosshair">
        {/* Category tag */}
        {market.category && (
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">
              {market.category}
            </span>
            <span className="text-[10px] text-muted">
              Closes {formatDate(market.endDate)}
            </span>
          </div>
        )}

        {/* Question */}
        <h3 className="text-text text-sm leading-snug mb-4 line-clamp-2">
          {market.question}
        </h3>

        {/* Probability bar */}
        <ProbBar prob={yesProb} />

        {/* Footer */}
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
          <div className="flex items-center gap-1">
            <div
              className="w-1 h-1 rounded-full"
              style={{
                background: yesProb > 60 ? "#00FFB3" : yesProb < 40 ? "#FF3355" : "#4D83FF",
              }}
            />
            <span className="text-[11px] text-muted">
              {formatVolume(volume)} vol
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Private indicator */}
            <svg className="w-3 h-3 text-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="text-[10px] text-muted/40 tracking-widest uppercase">dark pool</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
