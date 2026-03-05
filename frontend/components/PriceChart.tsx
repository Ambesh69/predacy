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

// ── SVG geometry ──────────────────────────────────────────────────────────────
const W   = 600;
const H   = 160;
const PAD = { t: 12, r: 52, b: 28, l: 8 };
const CW  = W - PAD.l - PAD.r;  // 540
const CH  = H - PAD.t - PAD.b;  // 120

function toY(p: number): number {
  return PAD.t + (1 - Math.max(0, Math.min(1, p))) * CH;
}
function toX(t: number, minT: number, range: number): number {
  return PAD.l + ((t - minT) / Math.max(range, 1)) * CW;
}

// Smooth cubic-bezier path — no overshoot, mirrors FactMachine-style curves
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

function downsample(pts: PricePoint[], max = 120): PricePoint[] {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

function fmtTime(ts: number, iv: Interval): string {
  const d = new Date(ts * 1000);
  if (iv === "6h" || iv === "1d") {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Colours ───────────────────────────────────────────────────────────────────
const YES_COLOR = "#2CE8C6";   // accent green — always YES
const NO_COLOR  = "#FF5F6D";   // danger red   — always NO
const BORDER    = "#1A2B3D";
const MUTED     = "#65798F";
const MONO      = "var(--font-mono)";

// ── Component ─────────────────────────────────────────────────────────────────
interface PriceChartProps {
  tokenId:      string;  // CLOB token ID (large decimal integer)
  currentPrice: number;  // Current YES price 0–1 (fallback label)
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

  // YES svg points + path
  const yesSvgPts = pts.map((d) => ({ x: toX(d.t, minT, range), y: toY(d.p) }));
  const yesLine   = smoothPath(yesSvgPts);
  const yesLast   = yesSvgPts[yesSvgPts.length - 1];
  const yesLastP  = pts.length ? pts[pts.length - 1].p : currentPrice;

  // NO svg points + path — NO = 1 - YES, derived without a second API call
  const noSvgPts = pts.map((d, i) => ({ x: yesSvgPts[i].x, y: toY(1 - d.p) }));
  const noLine   = smoothPath(noSvgPts);
  const noLast   = noSvgPts[noSvgPts.length - 1];
  const noLastP  = pts.length ? 1 - pts[pts.length - 1].p : 1 - currentPrice;

  // YES area fill (under the YES line down to 50% midpoint for cleaner look)
  const yesArea = hasData
    ? `${yesLine} L ${(PAD.l + CW).toFixed(1)} ${toY(0).toFixed(1)} L ${PAD.l.toFixed(1)} ${toY(0).toFixed(1)} Z`
    : "";

  const yGrid  = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0.25, 0.5, 0.75].map((f) => ({ t: minT + f * range, x: PAD.l + f * CW }));
  const gradId = `pg-${tokenId.slice(0, 8)}`;

  return (
    <div className="border-b border-border bg-surface/[0.12]">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3">
          {/* Legend chips */}
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-px" style={{ backgroundColor: YES_COLOR }} />
            <span className="text-[10px] tracking-widest uppercase" style={{ color: YES_COLOR }}>YES</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-px" style={{ backgroundColor: NO_COLOR }} />
            <span className="text-[10px] tracking-widest uppercase" style={{ color: NO_COLOR }}>NO</span>
          </div>
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
          aria-label="YES / NO price chart"
        >
          <defs>
            {/* YES gradient fill — top of chart down to 0 */}
            <linearGradient id={`${gradId}-yes`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={YES_COLOR} stopOpacity="0.12" />
              <stop offset="100%" stopColor={YES_COLOR} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Horizontal grid lines */}
          {yGrid.map((v) => (
            <line
              key={v}
              x1={PAD.l} y1={toY(v).toFixed(1)}
              x2={W - PAD.r} y2={toY(v).toFixed(1)}
              stroke={BORDER} strokeWidth="1"
            />
          ))}

          {/* 50% centre line — brighter, acts as the axis between YES and NO */}
          <line
            x1={PAD.l}     y1={toY(0.5).toFixed(1)}
            x2={W - PAD.r} y2={toY(0.5).toFixed(1)}
            stroke="#2B4560" strokeWidth="1"
          />

          {/* YES area fill */}
          {hasData && <path d={yesArea} fill={`url(#${gradId}-yes)`} />}

          {/* NO line — drawn first (below YES) */}
          {hasData && (
            <path
              d={noLine}
              fill="none"
              stroke={NO_COLOR}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeOpacity="0.7"
            />
          )}

          {/* YES line — drawn on top */}
          {hasData && (
            <path
              d={yesLine}
              fill="none"
              stroke={YES_COLOR}
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

          {/* ── YES annotation (dot + dashed leader + label) ─────────────── */}
          {hasData && yesLast && (
            <>
              <line
                x1={yesLast.x.toFixed(1)}        y1={yesLast.y.toFixed(1)}
                x2={(W - PAD.r + 4).toFixed(1)}  y2={yesLast.y.toFixed(1)}
                stroke={YES_COLOR} strokeWidth="0.75" strokeDasharray="2,3" strokeOpacity="0.5"
              />
              <circle cx={yesLast.x.toFixed(1)} cy={yesLast.y.toFixed(1)} r="2.5" fill={YES_COLOR} />
              <text
                x={(W - PAD.r + 8).toFixed(1)} y={(yesLast.y + 4).toFixed(1)}
                fill={YES_COLOR} fontSize="11" fontFamily={MONO}
              >
                {Math.round(yesLastP * 100)}%
              </text>
            </>
          )}

          {/* ── NO annotation (dot + dashed leader + label) ──────────────── */}
          {hasData && noLast && (
            <>
              <line
                x1={noLast.x.toFixed(1)}         y1={noLast.y.toFixed(1)}
                x2={(W - PAD.r + 4).toFixed(1)}  y2={noLast.y.toFixed(1)}
                stroke={NO_COLOR} strokeWidth="0.75" strokeDasharray="2,3" strokeOpacity="0.5"
              />
              <circle cx={noLast.x.toFixed(1)} cy={noLast.y.toFixed(1)} r="2.5" fill={NO_COLOR} />
              {/* Only show NO label if it doesn't overlap YES label */}
              {Math.abs(noLast.y - yesLast.y) > 14 && (
                <text
                  x={(W - PAD.r + 8).toFixed(1)} y={(noLast.y + 4).toFixed(1)}
                  fill={NO_COLOR} fontSize="11" fontFamily={MONO}
                >
                  {Math.round(noLastP * 100)}%
                </text>
              )}
            </>
          )}

          {/* ── Y-axis ghost labels — dodge both line annotations ─────────── */}
          {[0.25, 0.5, 0.75].map((v) => {
            const ySelf = toY(v);
            const tooCloseYes = yesLast && Math.abs(ySelf - yesLast.y) < 14;
            const tooCloseNo  = noLast  && Math.abs(ySelf - noLast.y)  < 14;
            if (tooCloseYes || tooCloseNo) return null;
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
