"use client";

import { useState, useEffect } from "react";
import { clsx } from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface PricePoint { t: number; p: number; }

const INTERVALS = [
  { label: "6H",  value: "6h",  fidelity: 10  },
  { label: "1D",  value: "1d",  fidelity: 60  },
  { label: "1W",  value: "1w",  fidelity: 240 },
  { label: "ALL", value: "max", fidelity: 1440 },
] as const;
type Interval = typeof INTERVALS[number]["value"];

// ── SVG geometry constants ────────────────────────────────────────────────────
const W   = 600;
const H   = 152;
const PAD = { t: 10, r: 50, b: 26, l: 8 };
const CW  = W - PAD.l - PAD.r;  // 542
const CH  = H - PAD.t - PAD.b;  // 116

// Map a price (0–1) to an SVG y coordinate
function toY(p: number): number {
  return PAD.t + (1 - Math.max(0, Math.min(1, p))) * CH;
}

// Map a timestamp to an SVG x coordinate
function toX(t: number, minT: number, range: number): number {
  return PAD.l + ((t - minT) / Math.max(range, 1)) * CW;
}

// Smooth monotone-ish cubic bezier path (no overshooting)
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

// Downsample to keep SVG path manageable (≤ 120 points)
function downsample(pts: PricePoint[], max = 120): PricePoint[] {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

// Format x-axis tick label
function fmtTime(ts: number, iv: Interval): string {
  const d = new Date(ts * 1000);
  if (iv === "6h" || iv === "1d") {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Theme colours (match globals.css) ────────────────────────────────────────
const ACCENT  = "#00FFB3";
const DANGER  = "#FF3355";
const BLUE    = "#4D83FF";
const BORDER  = "#13131F";
const MUTED   = "#42425A";
const MONO    = "var(--font-mono)";

function priceColor(p: number) {
  return p > 0.6 ? ACCENT : p < 0.4 ? DANGER : BLUE;
}

// ── Component ─────────────────────────────────────────────────────────────────
interface PriceChartProps {
  /** CLOB token ID (large decimal integer string from clobTokenIds[0]) */
  tokenId: string;
  /** Current YES price 0–1 (used as fallback label when history is empty) */
  currentPrice: number;
}

export default function PriceChart({ tokenId, currentPrice }: PriceChartProps) {
  const [iv, setIv]           = useState<Interval>("1d");
  const [raw, setRaw]         = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tokenId) return;
    setLoading(true);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;
    fetch(`/api/prices?token_id=${encodeURIComponent(tokenId)}&interval=${iv}&fidelity=${fidelity}`)
      .then((r) => r.json())
      .then((d) => {
        const pts: PricePoint[] = (d.history ?? []).filter(
          (p: any) => typeof p.p === "number" && p.p > 0,
        );
        setRaw(pts);
      })
      .catch(() => setRaw([]))
      .finally(() => setLoading(false));
  }, [tokenId, iv]);

  const pts     = downsample(raw);
  const hasData = pts.length >= 2;

  const minT  = hasData ? pts[0].t : 0;
  const maxT  = hasData ? pts[pts.length - 1].t : 1;
  const range = maxT - minT;

  const svgPts  = pts.map((d) => ({ x: toX(d.t, minT, range), y: toY(d.p) }));
  const line    = smoothPath(svgPts);
  const lastPt  = svgPts[svgPts.length - 1];
  const lastP   = pts.length ? pts[pts.length - 1].p : currentPrice;
  const color   = priceColor(lastP);

  // Closed area path: line + lower-right corner + lower-left corner
  const area = hasData
    ? `${line} L ${(PAD.l + CW).toFixed(1)} ${(PAD.t + CH).toFixed(1)} L ${PAD.l.toFixed(1)} ${(PAD.t + CH).toFixed(1)} Z`
    : "";

  // Horizontal grid lines
  const yGrid = [0, 0.25, 0.5, 0.75, 1];

  // X-axis tick positions (3 interior labels)
  const xTicks = [0.25, 0.5, 0.75].map((f) => ({
    t: minT + f * range,
    x: PAD.l + f * CW,
  }));

  // Unique gradient id per tokenId to avoid SVG id collisions across chart instances
  const gradId = `pg-${tokenId.slice(0, 8)}`;

  return (
    <div className="border-b border-border">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted tracking-widest uppercase">YES Price</span>
          {loading && (
            <div className="w-2.5 h-2.5 border border-muted/40 border-t-transparent rounded-full animate-spin" />
          )}
        </div>

        {/* Interval selector */}
        <div className="flex items-center gap-0.5">
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

      {/* ── SVG chart ──────────────────────────────────────────────────────── */}
      <div className="px-2 pb-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ display: "block" }}
          aria-label="YES price chart"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Horizontal grid lines */}
          {yGrid.map((v) => (
            <line
              key={v}
              x1={PAD.l}          y1={toY(v).toFixed(1)}
              x2={W - PAD.r}      y2={toY(v).toFixed(1)}
              stroke={BORDER}     strokeWidth="1"
            />
          ))}

          {/* 50% centre line — slightly brighter */}
          <line
            x1={PAD.l}     y1={toY(0.5).toFixed(1)}
            x2={W - PAD.r} y2={toY(0.5).toFixed(1)}
            stroke="#1E1E30" strokeWidth="1"
          />

          {/* Area fill */}
          {hasData && <path d={area} fill={`url(#${gradId})`} />}

          {/* Price line */}
          {hasData && (
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* No-data state */}
          {!hasData && !loading && (
            <text
              x={(W / 2).toFixed(1)} y={(H / 2 + 4).toFixed(1)}
              fill={MUTED} fontSize="10" fontFamily={MONO} textAnchor="middle"
            >
              NO PRICE HISTORY
            </text>
          )}

          {/* ── Last price annotation ─────────────────────────────────────── */}
          {hasData && lastPt && (
            <>
              {/* Dashed leader line to right edge */}
              <line
                x1={lastPt.x.toFixed(1)}      y1={lastPt.y.toFixed(1)}
                x2={(W - PAD.r + 4).toFixed(1)} y2={lastPt.y.toFixed(1)}
                stroke={color} strokeWidth="0.75" strokeDasharray="2,3" strokeOpacity="0.5"
              />
              {/* Dot */}
              <circle
                cx={lastPt.x.toFixed(1)} cy={lastPt.y.toFixed(1)}
                r="2.5" fill={color}
              />
              {/* % label */}
              <text
                x={(W - PAD.r + 8).toFixed(1)} y={(lastPt.y + 4).toFixed(1)}
                fill={color} fontSize="11" fontFamily={MONO}
              >
                {Math.round(lastP * 100)}%
              </text>
            </>
          )}

          {/* ── Y-axis ghost labels (25% 50% 75%) ────────────────────────── */}
          {[0.25, 0.5, 0.75].map((v) => {
            // Don't render if too close to the current-price label
            const ySelf    = toY(v);
            const yLast    = lastPt ? lastPt.y : -999;
            if (Math.abs(ySelf - yLast) < 14) return null;
            return (
              <text
                key={v}
                x={(W - PAD.r + 8).toFixed(1)} y={(ySelf + 3.5).toFixed(1)}
                fill={MUTED} fontSize="8" fontFamily={MONO}
              >
                {Math.round(v * 100)}%
              </text>
            );
          })}

          {/* ── X-axis time labels ────────────────────────────────────────── */}
          {hasData && xTicks.map(({ t, x }, i) => (
            <text
              key={i}
              x={x.toFixed(1)} y={(H - 5).toFixed(1)}
              fill={MUTED} fontSize="8" fontFamily={MONO} textAnchor="middle"
            >
              {fmtTime(t, iv)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
