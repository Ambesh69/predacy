"use client";

import { useState, useEffect } from "react";

interface Props {
  tokenId:      string;  // clobTokenIds[0] — large decimal integer string
  currentPrice: number;  // current YES price 0–1 (used as fallback dot)
}

const W   = 80;
const H   = 28;
const PAD = 2;

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

/**
 * Tiny 80×28 sparkline + 24h Δ badge for the home page event cards.
 * Fetches 1D price history; shows a flat grey skeleton until data arrives.
 */
export default function MiniSparkline({ tokenId, currentPrice }: Props) {
  const [pts, setPts]     = useState<Array<{ t: number; p: number }>>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!tokenId) { setReady(true); return; }
    fetch(
      `/api/prices?token_id=${encodeURIComponent(tokenId)}&interval=1d&fidelity=120`,
    )
      .then((r) => r.json())
      .then((d) => {
        const history: Array<{ t: number; p: number }> = (d.history ?? []).filter(
          (p: any) => typeof p.p === "number" && p.p > 0,
        );
        setPts(history);
      })
      .catch(() => setPts([]))
      .finally(() => setReady(true));
  }, [tokenId]);

  // ── Skeleton — flat muted line until data arrives ────────────────────────
  if (!ready) {
    return (
      <div className="flex items-center gap-2 pt-0.5">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <line
            x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2}
            stroke="#1E1E2E" strokeWidth="1.5"
          />
        </svg>
        <span className="text-[10px] font-mono text-muted-dim w-8" />
      </div>
    );
  }

  // ── No data — don't render ────────────────────────────────────────────────
  if (pts.length < 2) return null;

  const minT  = pts[0].t;
  const maxT  = pts[pts.length - 1].t;
  const range = maxT - minT || 1;

  const toX = (t: number) => PAD + ((t - minT) / range) * (W - PAD * 2);
  const toY = (p: number) => PAD + (1 - p) * (H - PAD * 2);

  const svgPts  = pts.map((d) => ({ x: toX(d.t), y: toY(d.p) }));
  const linePath = smoothPath(svgPts);

  // Area fill from line down to bottom
  const lastPt  = svgPts[svgPts.length - 1];
  const areaPath =
    `${linePath} L ${lastPt.x.toFixed(1)} ${(H - PAD).toFixed(1)}` +
    ` L ${PAD} ${(H - PAD).toFixed(1)} Z`;

  const firstP = pts[0].p;
  const lastP  = pts[pts.length - 1].p;
  const delta  = lastP - firstP;

  // Colour by direction
  const color =
    delta >  0.005 ? "#00FFB3" :
    delta < -0.005 ? "#FF3355" :
    "#4D83FF";

  const gradId = `msp-${tokenId.slice(-8)}`;

  return (
    <div className="flex items-center gap-2 pt-0.5">
      <svg
        width={W} height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0"    />
          </linearGradient>
        </defs>
        {/* Area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />
        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Current-price dot */}
        <circle
          cx={lastPt.x.toFixed(1)}
          cy={lastPt.y.toFixed(1)}
          r="2"
          fill={color}
        />
      </svg>

      {/* 24 h delta badge */}
      <span
        className="text-[10px] font-mono tabular-nums"
        style={{ color, minWidth: "2rem" }}
      >
        {delta >= 0 ? "+" : ""}
        {Math.round(delta * 100)}%
      </span>
    </div>
  );
}
