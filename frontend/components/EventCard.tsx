"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import type { PolyEvent } from "@/lib/polymarket";
import MiniSparkline from "@/components/MiniSparkline";
import {
  filterAndDeduplicateMarkets,
  outcomeLabel,
  fmtPct,
  fmtCents,
} from "@/lib/marketUtils";

interface EventCardProps {
  event: PolyEvent;
  liveMarketIds: Set<string>;
}

function formatVolume(vol: number | string): string {
  const n = typeof vol === "string" ? parseFloat(vol) : vol;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export default function EventCard({ event, liveMarketIds }: EventCardProps) {
  const router   = useRouter();
  const isMulti  = event.markets.length > 1;
  const isLive   = event.markets.some((m) => liveMarketIds.has(m.conditionId.toLowerCase()));
  const volume   = event.volumeNum ?? parseFloat(event.volume ?? "0");
  const endDate  = event.endDate ?? event.markets[0]?.endDate;
  const category = event.category ?? event.markets[0]?.category;

  // ── Single-outcome binary card ─────────────────────────────────────────────
  if (!isMulti) {
    const market   = event.markets[0];
    if (!market) return null;
    const yesPrice = parseFloat(market.outcomePrices?.[0] ?? "0");
    const noRaw    = parseFloat(market.outcomePrices?.[1] ?? "0");
    // Invert near-1.0 NO prices (Gamma API returns "1" for illiquid markets)
    const noDisplay = noRaw >= 0.999 ? (1 - noRaw) : noRaw;
    const probColor =
      yesPrice > 0.6 ? "#00FFB3" :
      yesPrice < 0.4 ? "#FF3355" :
      "#4D83FF";

    return (
      <Link href={`/market/${market.conditionId}`} className="block h-full">
        <div className={clsx(
          "market-card border bg-surface p-5 cursor-crosshair flex flex-col gap-3 h-full",
          isLive ? "border-accent/40" : "border-border",
        )}>
          {/* badges + date */}
          <div className="flex items-center gap-2 flex-wrap">
            {isLive && (
              <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase border border-accent/30 px-2 py-0.5 bg-accent/5">
                <span className="w-1 h-1 rounded-full bg-accent animate-pulse inline-block" />
                LIVE
              </span>
            )}
            {category && (
              <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">
                {category}
              </span>
            )}
            {endDate && (
              <span className="text-[10px] text-muted ml-auto">Ends {formatDate(endDate)}</span>
            )}
          </div>

          {/* question */}
          <h3 className="text-text text-sm leading-snug line-clamp-2 flex-1">
            {event.title || market.question}
          </h3>

          {/* probability + chips */}
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-black tabular-nums leading-none"
                style={{ fontFamily: "var(--font-display)", color: probColor }}>
                {fmtPct(yesPrice)}
              </span>
              <span className="text-[10px] text-muted tracking-widest uppercase">chance</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] px-2 py-1 border font-mono tabular-nums"
                style={{ borderColor: "#00FFB340", color: "#00FFB3", background: "#00FFB308" }}>
                YES {fmtCents(yesPrice)}
              </span>
              <span className="text-[11px] px-2 py-1 border font-mono tabular-nums"
                style={{ borderColor: "#FF335540", color: "#FF3355", background: "#FF335508" }}>
                NO {fmtCents(noDisplay)}
              </span>
            </div>
          </div>

          {/* prob bar */}
          <div className="h-[2px] bg-border rounded-full overflow-hidden">
            <div className="h-full transition-all duration-500"
              style={{ width: `${Math.max(Math.round(yesPrice * 100), 1)}%`, background: probColor }} />
          </div>

          {/* Mini sparkline — 1D price trend + delta */}
          {market.clobTokenIds?.[0] && (
            <MiniSparkline tokenId={market.clobTokenIds[0]} currentPrice={yesPrice} />
          )}

          {/* volume + dark pool */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted">{formatVolume(volume)} vol</span>
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

  // ── Multi-outcome event card ───────────────────────────────────────────────
  // Filter out phantom placeholders and deduplicate same-person entries FIRST,
  // then sort by YES price. This ensures the card and the event detail page
  // show exactly the same set of outcomes.
  const filtered = filterAndDeduplicateMarkets(event.markets);
  const sorted   = [...filtered].sort((a, b) => {
    const pa = parseFloat(a.outcomePrices?.[0] ?? "0");
    const pb = parseFloat(b.outcomePrices?.[0] ?? "0");
    return pb - pa;
  });

  // Show top 4 real outcomes; "+N more" count is from the filtered set
  const visible = sorted.slice(0, 4);
  const hidden  = sorted.length - visible.length;

  return (
    <div
      className={clsx(
        "market-card border bg-surface flex flex-col h-full cursor-crosshair",
        isLive ? "border-accent/40" : "border-border",
      )}
      onClick={() => router.push(`/event/${event.id}`)}
      role="link"
    >
      {/* Header */}
      <div className="p-4 pb-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            {isLive && (
              <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase border border-accent/30 px-2 py-0.5 bg-accent/5">
                <span className="w-1 h-1 rounded-full bg-accent animate-pulse inline-block" />
                LIVE
              </span>
            )}
            {category && (
              <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">
                {category}
              </span>
            )}
            {endDate && (
              <span className="text-[10px] text-muted ml-auto">Ends {formatDate(endDate)}</span>
            )}
          </div>
          <h3 className="text-text text-sm font-medium leading-snug line-clamp-2">
            {event.title}
          </h3>
        </div>
      </div>

      {/* Outcome rows */}
      <div className="flex flex-col flex-1 divide-y divide-border/40">
        {visible.map((market) => {
          const yesPrice     = parseFloat(market.outcomePrices?.[0] ?? "0");
          const isMarketLive = liveMarketIds.has(market.conditionId.toLowerCase());
          const barColor =
            yesPrice > 0.6 ? "#00FFB3" :
            yesPrice < 0.2 ? "#FF3355" :
            "#4D83FF";

          return (
            <Link
              key={market.conditionId}
              href={`/event/${event.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-crosshair group"
            >
              {/* Outcome name */}
              <span className="text-[12px] text-text/80 flex-1 truncate group-hover:text-text transition-colors">
                {outcomeLabel(market)}
              </span>

              {/* Prob bar */}
              <div className="w-20 h-[3px] bg-border rounded-full overflow-hidden flex-shrink-0">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(Math.round(yesPrice * 100), 1)}%`, background: barColor }}
                />
              </div>

              {/* Percent */}
              <span
                className="text-[12px] font-black tabular-nums w-8 text-right flex-shrink-0"
                style={{ fontFamily: "var(--font-display)", color: barColor }}
              >
                {fmtPct(yesPrice)}
              </span>

              {isMarketLive && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse flex-shrink-0" />
              )}
            </Link>
          );
        })}

        {hidden > 0 && (
          <div className="px-4 py-2 text-[10px] text-muted-dim tracking-widest">
            +{hidden} more outcome{hidden > 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border/40 flex items-center justify-between">
        <span className="text-[11px] text-muted">{formatVolume(volume)} vol</span>
        <div className="flex items-center gap-1">
          <svg className="w-3 h-3 text-muted-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span className="text-[10px] text-muted-dim tracking-widest uppercase">dark pool</span>
        </div>
      </div>
    </div>
  );
}
