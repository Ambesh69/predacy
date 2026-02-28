"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import WalletButton from "@/components/WalletButton";
import type { Market } from "@/lib/polymarket";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function parseField(v: any) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function normalizeMarket(m: any): Market {
  return {
    ...m,
    outcomePrices: parseField(m.outcomePrices) ?? [],
    outcomes:      parseField(m.outcomes)      ?? [],
    tokens:        parseField(m.tokens)        ?? [],
    tags:          parseField(m.tags)          ?? [],
    clobTokenIds:  parseField(m.clobTokenIds)  ?? [],
  };
}

function outcomeLabel(m: Market): string {
  if (m.groupItemTitle) return m.groupItemTitle;
  return m.question
    .replace(/^Will\s+/i, "")
    .replace(/\s+as\s+the\s+next\s+.*\?$/i, "?")
    .replace(/\s+win\s+.*\?$/i, "?")
    .replace(/\s+become\s+.*\?$/i, "?");
}

// ── Multi-outcome chart ────────────────────────────────────────────────────────

const OUTCOME_COLORS = ["#00FFB3", "#4D83FF", "#FFB800", "#FF6B35"];

const W   = 600;
const H   = 160;
const PAD = { t: 12, r: 56, b: 28, l: 8 };
const CW  = W - PAD.l - PAD.r;
const CH  = H - PAD.t - PAD.b;

function toY(p: number) { return PAD.t + (1 - Math.max(0, Math.min(1, p))) * CH; }
function toX(t: number, minT: number, range: number) {
  return PAD.l + ((t - minT) / Math.max(range, 1)) * CW;
}

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function downsample(pts: Array<{ t: number; p: number }>, max = 120) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

type Interval = "6h" | "1d" | "1w" | "max";

const INTERVALS: { label: string; value: Interval; fidelity: number }[] = [
  { label: "6H",  value: "6h",  fidelity: 10   },
  { label: "1D",  value: "1d",  fidelity: 60   },
  { label: "1W",  value: "1w",  fidelity: 240  },
  { label: "ALL", value: "max", fidelity: 1440 },
];

interface ChartLine {
  name:  string;
  color: string;
  pts:   Array<{ t: number; p: number }>;
  lastP: number;
}

function MultiOutcomeChart({ markets }: { markets: Market[] }) {
  const [iv, setIv]         = useState<Interval>("1d");
  const [lines, setLines]   = useState<ChartLine[]>([]);
  const [loading, setLoading] = useState(true);

  // Top 4 by YES price that have a clobTokenId
  const top4 = [...markets]
    .sort((a, b) => parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0"))
    .filter((m) => m.clobTokenIds?.[0])
    .slice(0, 4);

  const marketKey = top4.map((m) => m.conditionId).join(",");

  useEffect(() => {
    if (top4.length === 0) { setLoading(false); return; }
    setLoading(true);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;

    Promise.all(
      top4.map((m, idx) =>
        fetch(
          `/api/prices?token_id=${encodeURIComponent(m.clobTokenIds![0])}&interval=${iv}&fidelity=${fidelity}`,
        )
          .then((r) => r.json())
          .then((d) => {
            const pts: Array<{ t: number; p: number }> = (d.history ?? []).filter(
              (p: any) => typeof p.p === "number" && p.p > 0,
            );
            return {
              name:  outcomeLabel(m),
              color: OUTCOME_COLORS[idx],
              pts,
              lastP: pts.length ? pts[pts.length - 1].p : parseFloat(m.outcomePrices?.[0] ?? "0"),
            };
          })
          .catch(() => ({
            name:  outcomeLabel(m),
            color: OUTCOME_COLORS[idx],
            pts:   [] as Array<{ t: number; p: number }>,
            lastP: parseFloat(m.outcomePrices?.[0] ?? "0"),
          })),
      ),
    )
      .then((results) => setLines(results.filter((r) => r.pts.length >= 2)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv, marketKey]);

  const hasData = lines.some((l) => l.pts.length >= 2);
  const allT    = lines.flatMap((l) => l.pts.map((p) => p.t));
  const minT    = hasData ? Math.min(...allT) : 0;
  const maxT    = hasData ? Math.max(...allT) : 1;
  const range   = maxT - minT || 1;

  const MUTED = "#42425A";
  const MONO  = "var(--font-mono)";

  return (
    <div className="border-b border-border">
      {/* Chart header */}
      <div className="flex items-center justify-between px-4 py-2 gap-2">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          {(hasData ? lines : top4.map((m, i) => ({ name: outcomeLabel(m), color: OUTCOME_COLORS[i] }))).map(
            (l, i) => (
              <div key={i} className="flex items-center gap-1.5 min-w-0">
                <div className="w-3 h-px flex-shrink-0" style={{ backgroundColor: l.color }} />
                <span
                  className="text-[10px] tracking-widest uppercase truncate max-w-[90px]"
                  style={{ color: l.color }}
                >
                  {l.name}
                </span>
              </div>
            ),
          )}
          {loading && (
            <div className="w-2.5 h-2.5 border border-muted/40 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          {INTERVALS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setIv(value)}
              className={clsx(
                "text-[10px] px-1.5 py-0.5 tracking-widest transition-colors",
                iv === value
                  ? "text-accent border border-accent/30 bg-accent/5"
                  : "text-muted-dim hover:text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* SVG */}
      <div className="px-2 pb-1">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <line
              key={v}
              x1={PAD.l} y1={toY(v).toFixed(1)}
              x2={W - PAD.r} y2={toY(v).toFixed(1)}
              stroke="#13131F" strokeWidth="1"
            />
          ))}
          <line
            x1={PAD.l} y1={toY(0.5).toFixed(1)}
            x2={W - PAD.r} y2={toY(0.5).toFixed(1)}
            stroke="#1E1E30" strokeWidth="1"
          />

          {!hasData && !loading && (
            <text
              x={(W / 2).toFixed(1)} y={(H / 2 + 4).toFixed(1)}
              fill={MUTED} fontSize="10" fontFamily={MONO} textAnchor="middle"
            >
              NO PRICE HISTORY
            </text>
          )}

          {/* Price lines */}
          {lines.map((line, i) => {
            const ds    = downsample(line.pts);
            const svgPts = ds.map((d) => ({ x: toX(d.t, minT, range), y: toY(d.p) }));
            const path   = smoothPath(svgPts);
            const lastPt = svgPts[svgPts.length - 1];

            return (
              <g key={i}>
                <path
                  d={path}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={i === 0 ? "2" : "1.5"}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeOpacity={i === 0 ? 1 : 0.75}
                />
                {lastPt && (
                  <>
                    <line
                      x1={lastPt.x.toFixed(1)} y1={lastPt.y.toFixed(1)}
                      x2={(W - PAD.r + 4).toFixed(1)} y2={lastPt.y.toFixed(1)}
                      stroke={line.color} strokeWidth="0.75" strokeDasharray="2,3" strokeOpacity="0.5"
                    />
                    <circle cx={lastPt.x.toFixed(1)} cy={lastPt.y.toFixed(1)} r="2.5" fill={line.color} />
                    <text
                      x={(W - PAD.r + 8).toFixed(1)} y={(lastPt.y + 4).toFixed(1)}
                      fill={line.color} fontSize="11" fontFamily={MONO}
                    >
                      {Math.round(line.lastP * 100)}%
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* Y-axis ghost labels */}
          {[0.25, 0.5, 0.75].map((v) => (
            <text
              key={v}
              x={(W - PAD.r + 8).toFixed(1)} y={(toY(v) + 3.5).toFixed(1)}
              fill={MUTED} fontSize="8" fontFamily={MONO}
            >
              {Math.round(v * 100)}%
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

// ── Main event page component ──────────────────────────────────────────────────

interface EventData {
  id:        string;
  title:     string;
  slug?:     string;
  volume:    string;
  volumeNum: number;
  active:    boolean;
  closed:    boolean;
  endDate:   string;
  category?: string;
  tags?:     string[];
  markets:   Market[];
}

export default function EventPageClient({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id }   = use(params);
  const router   = useRouter();

  const [event, setEvent]     = useState<EventData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/event/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) { setEvent(null); return; }
        const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
        setEvent({
          ...data,
          tags:    parse(data.tags)    ?? [],
          markets: (data.markets ?? []).map(normalizeMarket),
        });
      })
      .catch(() => setEvent(null))
      .finally(() => setLoading(false));
  }, [id]);

  const sorted = event
    ? [...event.markets].sort(
        (a, b) =>
          parseFloat(b.outcomePrices?.[0] ?? "0") -
          parseFloat(a.outcomePrices?.[0] ?? "0"),
      )
    : [];

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Not found ────────────────────────────────────────────────────────────────
  if (!event) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-muted text-sm">Event not found.</p>
        <Link href="/" className="text-accent text-xs tracking-widest hover:underline">
          ← MARKETS
        </Link>
      </div>
    );
  }

  const volume = event.volumeNum ?? parseFloat(event.volume ?? "0");

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">

      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-muted hover:text-text transition-colors text-[11px] tracking-widest uppercase"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Markets
          </Link>
          <span className="text-border text-muted-dim">|</span>
          <Link
            href="/"
            className="text-xl font-black tracking-tight text-text"
            style={{ fontFamily: "var(--font-display)" }}
          >
            PREDACY
          </Link>
        </div>
        <WalletButton />
      </header>

      {/* Event title */}
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {event.category && (
            <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">
              {event.category}
            </span>
          )}
          {event.endDate && (
            <span className="text-[10px] text-muted">
              Ends {formatDate(event.endDate)}
            </span>
          )}
          <span className="text-[11px] text-muted ml-auto tabular-nums">
            {formatVolume(volume)} vol
          </span>
        </div>
        <h1
          className="text-2xl font-black text-text tracking-tight leading-snug"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {event.title}
        </h1>
      </div>

      {/* Multi-outcome chart */}
      <MultiOutcomeChart markets={event.markets} />

      {/* Outcome list header */}
      <div className="px-6 py-3 border-b border-border flex items-center justify-between">
        <span className="text-[11px] text-muted tracking-widest uppercase">
          {event.markets.length} Outcome{event.markets.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-1">
          <svg className="w-3 h-3 text-muted-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span className="text-[10px] text-muted-dim tracking-widest uppercase">dark pool</span>
        </div>
      </div>

      {/* Outcome rows */}
      <div className="flex-1">
        <div className="divide-y divide-border/40">
          {sorted.map((market, idx) => {
            const yesPrice = parseFloat(market.outcomePrices?.[0] ?? "0");
            const noPrice  = parseFloat(market.outcomePrices?.[1] ?? "0");
            const yesProb  = Math.round(yesPrice * 100);

            const barColor =
              yesProb > 60 ? "#00FFB3" :
              yesProb < 20 ? "#FF3355" :
              "#4D83FF";

            const label = outcomeLabel(market);

            return (
              <div
                key={market.conditionId}
                className="flex items-center gap-4 px-6 py-3.5 hover:bg-white/[0.02] transition-colors cursor-crosshair group"
                onClick={() => router.push(`/market/${market.conditionId}`)}
              >
                {/* Rank */}
                <span className="text-[10px] text-muted-dim w-5 flex-shrink-0 tabular-nums text-right">
                  {idx + 1}
                </span>

                {/* Outcome name */}
                <span className="text-sm text-text/80 flex-1 min-w-0 truncate group-hover:text-text transition-colors">
                  {label}
                </span>

                {/* Probability bar */}
                <div className="w-24 h-[3px] bg-border rounded-full overflow-hidden flex-shrink-0 hidden sm:block">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.max(yesProb, 1)}%`, background: barColor }}
                  />
                </div>

                {/* Probability % */}
                <span
                  className="text-sm font-black tabular-nums w-10 text-right flex-shrink-0"
                  style={{ fontFamily: "var(--font-display)", color: barColor }}
                >
                  {yesProb}%
                </span>

                {/* YES / NO price chips */}
                <div className="hidden md:flex items-center gap-1.5 flex-shrink-0">
                  <span
                    className="text-[11px] px-2 py-1 border font-mono tabular-nums"
                    style={{ borderColor: "#00FFB340", color: "#00FFB3", background: "#00FFB308" }}
                  >
                    YES {Math.round(yesPrice * 100)}¢
                  </span>
                  <span
                    className="text-[11px] px-2 py-1 border font-mono tabular-nums"
                    style={{ borderColor: "#FF335540", color: "#FF3355", background: "#FF335508" }}
                  >
                    NO {Math.round(noPrice * 100)}¢
                  </span>
                </div>

                {/* Arrow */}
                <svg
                  className="w-3.5 h-3.5 text-muted-dim group-hover:text-accent transition-colors flex-shrink-0"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-3 flex items-center justify-between">
        <span className="text-[10px] text-muted-dim tracking-widest uppercase">
          Predacy · Private Prediction Markets · Powered by Polymarket Liquidity
        </span>
        <span className="text-[10px] text-muted-dim">
          <span className="text-accent/30">●</span> No position info leaks on-chain
        </span>
      </footer>

    </div>
  );
}
