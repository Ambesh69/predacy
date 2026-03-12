"use client";

import { useState, useEffect, useRef, useCallback, use } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import {
  createPublicClient, createWalletClient, custom, http, fallback, parseAbiItem, pad, toHex,
  keccak256, encodeAbiParameters, encodeFunctionData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import WalletButton from "@/components/WalletButton";
import BatchTimer from "@/components/BatchTimer";
import OrderForm from "@/components/OrderForm";
import PositionsPanel from "@/components/PositionsPanel";
import OrderbookPanel from "@/components/OrderbookPanel";
import type { Market } from "@/lib/polymarket";
import { getRelayerUrl } from "@/lib/relayerUrl";
import {
  filterAndDeduplicateMarkets,
  outcomeLabel,
  fmtPct,
  fmtCents,
} from "@/lib/marketUtils";
import {
  BATCH_VAULT_ABI, CTF_ABI, ERC20_ABI, MOCK_USDC_ABI, TRANSFER_WITH_AUTH_ABI,
  PROXY_WALLET_FACTORY_ABI, PROXY_WALLET_ABI, BatchStatus, getContracts,
} from "@/lib/contracts";
import { computeCommitment } from "@/lib/commitmentHash";
import {
  ACTIVE_CHAIN, ACTIVE_CHAIN_ID_HEX, ACTIVE_CHAIN_NAME,
  CHAIN_GAS, IS_MAINNET,
} from "@/lib/chain";

// USDC.e on Polygon mainnet uses EIP712Domain with `salt` (bytes32 chainId) instead
// of `chainId` (uint256). Testnet MockUSDC uses the standard chainId domain.
// Confirmed by computing domain separator against on-chain DOMAIN_SEPARATOR().
function usdcDomain(verifyingContract: `0x${string}`) {
  return IS_MAINNET
    ? { name: "USD Coin (PoS)", version: "1", verifyingContract, salt: pad(toHex(BigInt(ACTIVE_CHAIN.id)), { size: 32 }) }
    : { name: "USD Coin (Test)", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract };
}

// ── Viem public client ────────────────────────────────────────────────────────
// polygon-rpc.com shut down Feb 2026 — viem's default transport for Polygon
// would resolve to it and silently break balance reads. Use explicit working RPCs.
const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: IS_MAINNET
    ? fallback([
        http("https://polygon.meowrpc.com"),
        http("https://rpc.ankr.com/polygon"),
        http("https://polygon.drpc.org"),
      ])
    : http(),
});

// ── Batch fallback ────────────────────────────────────────────────────────────
const MOCK_BATCH = {
  batchId: 0n,
  batchMarketId: ("0x" + "0".repeat(64)) as `0x${string}`,
  openedAt: Math.floor(Date.now() / 1000) - 8,
  batchWindow: 30,
  commitmentCount: 0,
  totalDeposited: 0n,
  status: BatchStatus.OPEN,
  clearingPrice: 0n,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Auto-split: orders larger than this are silently split into ≤$5 000 chunks
// so no single batch is dominated by one order (price-impact cap + privacy mixing).
const MAX_CHUNK_USDC_MICRO = 5_000_000_000n; // $5 000 in USDC micro-units (6 decimals)

function splitIntoChunks(total: bigint, maxChunk: bigint): bigint[] {
  const chunks: bigint[] = [];
  let remaining = total;
  while (remaining > 0n) {
    const chunk = remaining > maxChunk ? maxChunk : remaining;
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
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

// Resolves the YES token ID for CLOB price-history fetches.
// The Gamma events endpoint sometimes omits clobTokenIds but always populates
// tokens[{ token_id }], so we fall back to tokens[0].token_id.
function getTokenId(m: Market): string | undefined {
  return m.clobTokenIds?.[0] ?? m.tokens?.[0]?.token_id;
}


// ── EIP-6963 provider discovery (same as MarketPageClient) ───────────────────
async function findBestProvider(): Promise<{ provider: any; name: string }> {
  if (typeof window === "undefined") throw new Error("Not in browser");
  const eip6963 = await new Promise<{ provider: any; name: string } | null>((resolve) => {
    const found: { info: any; provider: any }[] = [];
    const handler = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.provider) found.push(d); };
    window.addEventListener("eip6963:announceProvider", handler);
    window.dispatchEvent(new CustomEvent("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", handler);
      if (found.length === 0) { resolve(null); return; }
      const mm = found.find((p) => p.info?.rdns === "io.metamask" || p.info?.name?.toLowerCase().includes("metamask"));
      if (mm) { resolve({ provider: mm.provider, name: "MetaMask" }); return; }
      resolve({ provider: found[0].provider, name: found[0].info?.name ?? "Wallet" });
    }, 150);
  });
  if (eip6963) return eip6963;
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No Ethereum wallet found. Please install MetaMask.");
  if (Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p: any) => p.isMetaMask);
    if (mm) return { provider: mm, name: "MetaMask" };
    return { provider: eth.providers[0], name: "Wallet" };
  }
  return { provider: eth, name: eth.isMetaMask ? "MetaMask" : eth.isBackpack ? "Backpack" : "Wallet" };
}

// ── Multi-outcome SVG chart with cursor hover ─────────────────────────────────
const OUTCOME_COLORS = ["#00FFB3", "#4D83FF", "#FFB800", "#FF6B35"];

type Interval = "6h" | "1d" | "1w" | "max";
const INTERVALS: { label: string; value: Interval; fidelity: number }[] = [
  { label: "6H",  value: "6h",  fidelity: 10   },
  { label: "1D",  value: "1d",  fidelity: 60   },
  { label: "1W",  value: "1w",  fidelity: 240  },
  { label: "ALL", value: "max", fidelity: 1440 },
];

interface ChartSeries { marketId: string; name: string; color: string; pts: Array<{ t: number; p: number }>; }

// SVG viewBox geometry
const VW = 960, VH = 310;
const PAD = { t: 12, r: 46, b: 30, l: 6 };
const CW  = VW - PAD.l - PAD.r;
const CH  = VH - PAD.t - PAD.b;

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
function downsample(pts: Array<{ t: number; p: number }>, max = 200) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}
function lerp(pts: Array<{ t: number; p: number }>, t: number): number {
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0].p;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].p;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
  const frac = (t - pts[lo].t) / (pts[hi].t - pts[lo].t);
  return pts[lo].p + frac * (pts[hi].p - pts[lo].p);
}

function fmtXLabel(ts: number, iv: Interval): string {
  const d = new Date(ts * 1000);
  if (iv === "6h" || iv === "1d")
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (iv === "max")
    return d.toLocaleDateString("en-US", { month: "short" }); // "Oct", "Nov", "Dec"
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); // "Nov 15" for 1W
}

function MultiOutcomeChart({ markets, selectedMarketId }: { markets: Market[]; selectedMarketId?: string; }) {
  const [iv, setIv]           = useState<Interval>("1d");
  const [lines, setLines]     = useState<ChartSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoverX, setHoverX]   = useState<number | null>(null); // SVG x coord

  // Sort by current YES probability descending — this is exactly how Polymarket orders its
  // chart outcomes: highest probability candidate first, then next, etc.
  // The Gamma API's own market order is NOT by probability (it's internal/alphabetical),
  // so we must sort ourselves. Judy Shelton at 4.5% should always rank above <1% candidates.
  const sortedMarkets = filterAndDeduplicateMarkets(markets)
    .filter((m) => !!getTokenId(m))
    .sort((a, b) =>
      parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0")
    );
  const selectedMkt = selectedMarketId
    ? sortedMarkets.find((m) => m.conditionId === selectedMarketId)
    : undefined;
  // Always include the selected outcome in the chart, even if it's outside the top 4 by probability.
  const chartMarkets = selectedMkt && !sortedMarkets.slice(0, 4).some((m) => m.conditionId === selectedMkt.conditionId)
    ? [selectedMkt, ...sortedMarkets.filter((m) => m.conditionId !== selectedMkt.conditionId).slice(0, 3)]
    : sortedMarkets.slice(0, 4);

  const marketKey = chartMarkets.map((m) => getTokenId(m) ?? m.conditionId).join(",");

  useEffect(() => {
    if (chartMarkets.length === 0) { setLoading(false); return; }
    setLoading(true);
    setHoverX(null);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;
    Promise.all(
      chartMarkets.map((m, idx) =>
        fetch(`/api/prices?token_id=${encodeURIComponent(getTokenId(m)!)}&interval=${iv}&fidelity=${fidelity}`)
          .then((r) => r.json())
          .then((d) => ({
            marketId: m.conditionId,
            name:  outcomeLabel(m),
            color: OUTCOME_COLORS[idx],
            pts:   (d.history ?? []).filter((p: any) => typeof p.p === "number" && p.p > 0) as Array<{ t: number; p: number }>,
          }))
          .catch(() => ({ marketId: m.conditionId, name: outcomeLabel(m), color: OUTCOME_COLORS[idx], pts: [] as Array<{ t: number; p: number }> })),
      ),
    )
      .then((results) => setLines(results.filter((r) => r.pts.length >= 2)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv, marketKey, selectedMarketId]);

  const hasData = lines.some((l) => l.pts.length >= 2);

  // ── Coordinate system ──────────────────────────────────────────────────────
  const allT  = lines.flatMap((l) => l.pts.map((p) => p.t));
  const minT  = hasData ? Math.min(...allT) : 0;
  const maxT  = hasData ? Math.max(...allT) : 1;
  const tRange = maxT - minT || 1;

  // Y: auto-scale tight to data range — like Polymarket zooms to visible prices
  const allP   = lines.flatMap((l) => l.pts.map((p) => p.p));
  const rawMin = hasData ? Math.min(...allP) : 0;
  const rawMax = hasData ? Math.max(...allP) : 1;
  // Small padding: 8% of range, min 2pp — so lines don't hug the edges
  const pPad   = Math.max((rawMax - rawMin) * 0.08, 0.02);
  const yMin   = Math.max(0, rawMin - pPad);
  const yMax   = Math.min(1, rawMax + pPad);
  const yRange = yMax - yMin || 1;

  const toX = (t: number) => PAD.l + ((t - minT) / tRange) * CW;
  const toY = (p: number) => PAD.t + (1 - (Math.max(yMin, Math.min(yMax, p)) - yMin) / yRange) * CH;

  // Y-axis ticks: all quarter-marks within the visible range
  const Y_TICKS = [0, 0.25, 0.5, 0.75, 1.0].filter((v) => v >= yMin - 0.01 && v <= yMax + 0.01);

  // X-axis ticks: calendar month/day boundaries so no month is ever skipped
  const X_TICKS = (() => {
    if (!hasData) return [] as { t: number; x: number }[];
    if (iv === "6h" || iv === "1d") {
      // Evenly-spaced for short ranges
      return [0.15, 0.38, 0.62, 0.85].map((f) => ({ t: minT + f * tRange, x: PAD.l + f * CW }));
    }
    const ticks: { t: number; x: number }[] = [];
    const start = new Date(minT * 1000);
    // Advance to first calendar boundary after minT
    const cur = iv === "1w"
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1))
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    while (cur.getTime() / 1000 <= maxT) {
      const t = cur.getTime() / 1000;
      const x = toX(t);
      if (x > PAD.l + 20 && x < PAD.l + CW - 20) ticks.push({ t, x });
      if (iv === "1w") cur.setUTCDate(cur.getUTCDate() + 1);
      else cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    // Thin out if more than 7 labels
    if (ticks.length > 7) {
      const step = Math.ceil(ticks.length / 6);
      return ticks.filter((_, i) => i % step === 0);
    }
    return ticks.length >= 2 ? ticks : [0.15, 0.38, 0.62, 0.85].map((f) => ({ t: minT + f * tRange, x: PAD.l + f * CW }));
  })();

  // Hover timestamp
  const inPlot = hoverX !== null && hoverX >= PAD.l && hoverX <= PAD.l + CW;
  const hoverT = inPlot ? minT + ((hoverX! - PAD.l) / CW) * tRange : null;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX  = ((e.clientX - rect.left) / rect.width) * VW;
    setHoverX(Math.max(PAD.l, Math.min(PAD.l + CW, svgX)));
  };

  const GRID  = "#1A1A2E";
  const LABEL = "#42425A";
  const MONO  = "var(--font-mono, monospace)";

  return (
    <div className="border-b border-border">
      {/* ── Legend: dot + name (no text), hover updates ───────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 gap-3">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          {(lines.length > 0 ? lines : chartMarkets.slice(0, 4).map((m, i) => ({ marketId: m.conditionId, name: outcomeLabel(m), color: OUTCOME_COLORS[i], pts: [] as ChartSeries["pts"] }))).map((l, i) => {
            const liveP = l.pts[l.pts.length - 1]?.p ?? 0;
            const dispP = (inPlot && hoverT) ? lerp(l.pts, hoverT) : liveP;
            const isSelected = !!selectedMarketId && l.marketId === selectedMarketId;
            return (
              <div key={i} className="flex items-center gap-1.5 flex-shrink-0">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: l.color }} />
                <span className={clsx("text-[11px] truncate max-w-[160px]", isSelected ? "text-text" : "text-text/70")}>{l.name}</span>
                <span className="text-[11px] font-bold tabular-nums" style={{ color: l.color }}>
                  {fmtPct(dispP)}
                </span>
              </div>
            );
          })}
          {loading && <div className="w-2 h-2 border border-muted/40 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {INTERVALS.map(({ label, value }) => (
            <button key={value} onClick={() => setIv(value)}
              className={clsx("text-[10px] px-1.5 py-0.5 tracking-widest transition-colors",
                iv === value ? "text-accent border border-accent/30 bg-accent/5" : "text-muted-dim hover:text-muted"
              )}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* ── SVG chart ─────────────────────────────────────────────────────── */}
      <div className="pt-0.5 pb-1 px-1" style={{ height: 330 }}>
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !hasData ? (
          <div className="h-full flex items-center justify-center">
            <span className="text-[10px] text-muted-dim tracking-widest font-mono">NO PRICE HISTORY</span>
          </div>
        ) : (
          <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height="100%"
            preserveAspectRatio="none"
            style={{ display: "block", cursor: "crosshair" }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverX(null)}
          >
            {/* Y-axis grid lines + labels on RIGHT */}
            {Y_TICKS.map((v) => {
              const y = toY(v);
              return (
                <g key={v}>
                  <line x1={PAD.l} y1={y.toFixed(1)} x2={VW - PAD.r} y2={y.toFixed(1)}
                    stroke={GRID} strokeWidth="1" strokeDasharray="3,4" />
                  <text x={(VW - PAD.r + 5).toFixed(1)} y={(y + 3.5).toFixed(1)}
                    fill={LABEL} fontSize="11" fontFamily={MONO} textAnchor="start">
                    {Math.round(v * 100)}%
                  </text>
                </g>
              );
            })}

            {/* Price lines + current-value dots */}
            {lines.map((line, i) => {
              const isSelected = !!selectedMarketId && line.marketId === selectedMarketId;
              const ds     = downsample(line.pts);
              const svgPts = ds.map((p) => ({ x: toX(p.t), y: toY(p.p) }));
              const path   = smoothPath(svgPts);
              const last   = svgPts[svgPts.length - 1];
              return (
                <g key={i}>
                  <path d={path} fill="none" stroke={line.color}
                    strokeWidth={isSelected ? "2.8" : "1.35"} strokeLinejoin="round" strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    opacity={isSelected || !selectedMarketId ? 0.95 : 0.32} />
                  <path
                    d={path}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={isSelected ? "1.8" : "1.2"}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="5 22"
                    strokeOpacity={isSelected || !selectedMarketId ? 0.52 : 0.2}
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from="0"
                      to="-108"
                      dur={isSelected ? "3.4s" : "5.1s"}
                      repeatCount="indefinite"
                    />
                  </path>
                  {last && !inPlot && (
                    <g>
                      {/* Pulsating outer ring */}
                      <circle cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="3"
                        fill="none" stroke={line.color} strokeWidth="1.5">
                        <animate attributeName="r" from="3" to="9" dur="1.8s" repeatCount="indefinite" />
                        <animate attributeName="stroke-opacity" from="0.7" to="0" dur="1.8s" repeatCount="indefinite" />
                      </circle>
                      {/* Solid inner dot */}
                      <circle cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="3"
                        fill={line.color} stroke="#0D0D1A" strokeWidth="1.5" />
                    </g>
                  )}
                </g>
              );
            })}

            {/* Hover: vertical line + dots + inline % labels */}
            {inPlot && hoverT && (() => {
              const nearRight = hoverX! > PAD.l + CW * 0.72;
              const lx  = nearRight ? hoverX! - 8 : hoverX! + 8;
              const anc = nearRight ? "end" : "start";
              return (
                <g>
                  <line x1={hoverX!.toFixed(1)} y1={PAD.t} x2={hoverX!.toFixed(1)} y2={VH - PAD.b}
                    stroke="#ffffff" strokeWidth="1" strokeOpacity="0.12" />
                  {lines.map((line, i) => {
                    const p  = lerp(line.pts, hoverT);
                    const cy = toY(p);
                    return (
                      <g key={i}>
                        <circle cx={hoverX!.toFixed(1)} cy={cy.toFixed(1)} r="3.5"
                          fill={line.color} stroke="#0D0D1A" strokeWidth="1.5" />
                        <text x={lx.toFixed(1)} y={(cy - 5).toFixed(1)}
                          fill={line.color} fontSize="11" fontFamily={MONO} textAnchor={anc}
                          style={{ fontWeight: 600 }}>
                          {fmtPct(p)}
                        </text>
                      </g>
                    );
                  })}
                  {/* Hover time label at bottom */}
                  <text x={hoverX!.toFixed(1)} y={(VH - PAD.b + 16).toFixed(1)}
                    fill="#6B6B8A" fontSize="11" fontFamily={MONO} textAnchor="middle">
                    {fmtXLabel(hoverT, iv)}
                  </text>
                </g>
              );
            })()}

            {/* X-axis static labels (hidden while hovering) */}
            {!inPlot && X_TICKS.map(({ t, x }, i) => (
              <text key={i} x={x.toFixed(1)} y={(VH - PAD.b + 16).toFixed(1)}
                fill={LABEL} fontSize="11" fontFamily={MONO} textAnchor="middle">
                {fmtXLabel(t, iv)}
              </text>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

// ── Event data type ────────────────────────────────────────────────────────────
interface EventData {
  id: string; title: string; slug?: string;
  volume: string; volumeNum: number;
  active: boolean; closed: boolean; endDate: string;
  category?: string; tags?: string[]; markets: Market[];
}

// ── Claim error parser ─────────────────────────────────────────────────────────
// Converts verbose viem/relayer error strings into user-friendly messages.
function cleanClaimError(raw: string): string {
  if (raw.includes("AlreadyClaimed"))      return "This position has already been claimed.";
  if (raw.includes("BatchNotSettled") || raw.includes("not yet settled"))
                                           return "The batch hasn't settled yet — try again in a few seconds.";
  if (raw.includes("NothingToClaim"))      return "Nothing to claim (order was unfilled or amount is zero).";
  if (raw.includes("ZKProofInvalid"))      return "ZK proof failed verification. Please try again.";
  if (raw.includes("ClaimVerifierNotSet")) return "Claim verifier not configured on-chain.";
  if (raw.includes("CommitmentMismatch"))  return "Order data doesn't match the on-chain record.";
  if (raw.includes("not found in local storage")) return "Order data missing from this browser — cannot claim.";
  if (raw.includes("transaction reverted")) return "Claim reverted — batch may not be fully settled. Try again.";
  if (raw.includes("Could not reach relayer")) return "Relayer unreachable — check your connection and retry.";
  if (raw.includes("timed out after 3 minutes")) return "Claim is taking longer than expected — please retry.";
  // Trim verbose viem boilerplate
  if (raw.length > 100) return "Claim failed — please try again.";
  return raw;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function EventPageClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  // ── Event data ───────────────────────────────────────────────────────────────
  const [event, setEvent]         = useState<EventData | null>(null);
  const [eventLoading, setEventLoading] = useState(true);

  // ── Selected outcome + trading ───────────────────────────────────────────────
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null);
  const [batch, setBatch]         = useState(MOCK_BATCH);
  const [commitments, setCommitments] = useState<Array<{
    hash: `0x${string}`; amount?: bigint; trader?: `0x${string}`; timestamp: number;
  }>>([]);
  const [submitStep, setSubmitStep] = useState<"approving" | "signing" | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [orderSealed, setOrderSealed] = useState(false);
  const [leftTab, setLeftTab]     = useState<"outcomes" | "positions" | "orderbook">("outcomes");
  const [claimLoading, setClaimLoading] = useState(false);
  const [historicalMarketIds, setHistoricalMarketIds] = useState<`0x${string}`[]>([]);
  // Pre-fill for SELL mode when user clicks "CLOSE POSITION" on a claimed entry.
  const [sellPrefill, setSellPrefill] = useState<bigint | null>(null);
  // The buy clearing price of the position being closed — stored on the sell order for P&L.
  const [closeBuyClearingPrice, setCloseBuyClearingPrice] = useState<bigint | null>(null);
  // Requeue UX: poll /order-status after buy order submission.
  // Cleared when the user dismisses the notification or places a new order.
  const [pendingRequeueCommitment, setPendingRequeueCommitment] = useState<string | null>(null);
  const [requeueNotif, setRequeueNotif] = useState<{
    type: "requeued" | "failed";
    toBatch?: string;
    remainingAuths?: number;
  } | null>(null);
  const selectedMarketId = selectedMarket?.conditionId;

  // ── Toast notifications ──────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ id: number; message: string; type: "success" | "error" } | null>(null);
  const toastIdRef = useRef(0);
  // Tracks the last non-zero batchId seen. After settlement the contract may
  // reset currentBatchId to 0n; we fall back to this ref so fetchBatch can
  // still detect the SETTLING → SETTLED transition.
  const lastBatchIdRef = useRef<bigint>(0n);
  const pushToast = (message: string, type: "success" | "error") => {
    const id = ++toastIdRef.current;
    setToast({ id, message, type });
    setTimeout(() => setToast((prev) => (prev?.id === id ? null : prev)), 4000);
  };

  // ── Requeue status polling ───────────────────────────────────────────────────
  // After a buy order is submitted, poll GET /order-status/{commitment} every 10s
  // for up to 10 minutes. Stops when a terminal status ('requeued'/'failed') arrives.
  useEffect(() => {
    if (!pendingRequeueCommitment) return;
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) return;

    let cancelled = false;
    const deadline = Date.now() + 10 * 60 * 1000; // 10-minute polling window

    const poll = async () => {
      if (cancelled || Date.now() > deadline) return;
      try {
        const res = await fetch(`${relayerUrl}/order-status/${pendingRequeueCommitment}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!data.found) return; // still pending — keep polling
        setRequeueNotif({
          type:           data.status,   // 'requeued' | 'failed'
          toBatch:        data.toBatch,
          remainingAuths: data.remainingAuths,
        });
        setPendingRequeueCommitment(null); // stop polling
      } catch { /* network error — retry next interval */ }
    };

    const iv = setInterval(poll, 10_000);
    poll(); // immediate first check
    return () => { cancelled = true; clearInterval(iv); };
  }, [pendingRequeueCommitment]);

  // ── Wallet ───────────────────────────────────────────────────────────────────
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet        = wallets[0];
  const walletAddress = wallet?.address as `0x${string}` | undefined;
  const isConnected   = authenticated && !!walletAddress;

  // ── Load event + 30-second price polling ─────────────────────────────────────
  // Polymarket prices update continuously. We poll every 30s so displayed prices
  // stay fresh and don't drift far from the real market.
  useEffect(() => {
    let cancelled = false;

    const fetchEvent = (isInitial: boolean) => {
      fetch(`/api/event/${id}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (!data || data.error) { if (isInitial) setEvent(null); return; }
          const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
          const markets = (data.markets ?? []).map(normalizeMarket);
          setEvent({ ...data, tags: parse(data.tags) ?? [], markets });
          // On subsequent polls, update the selected market's prices in-place
          // so the trading panel always shows the latest bid without resetting state.
          if (!isInitial) {
            setSelectedMarket((prev) => {
              if (!prev) return prev;
              return markets.find((m: Market) => m.conditionId === prev.conditionId) ?? prev;
            });
          }
        })
        .catch(() => { if (isInitial) setEvent(null); })
        .finally(() => { if (isInitial) setEventLoading(false); });
    };

    fetchEvent(true);
    const timer = setInterval(() => fetchEvent(false), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id]);

  // ── Auto-select top outcome on load (like Polymarket) ───────────────────────
  useEffect(() => {
    if (!event || selectedMarket) return;
    const top = filterAndDeduplicateMarkets(event.markets).sort(
      (a, b) => parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0"),
    );
    if (top.length > 0) setSelectedMarket(top[0]);
  }, [event, selectedMarket]);

  // ── Pre-warm batch for selected market ──────────────────────────────────────
  useEffect(() => {
    if (!selectedMarketId) return;
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) return;
    fetch(`${relayerUrl}/warm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: selectedMarketId }),
    }).catch(() => {});
  }, [selectedMarketId]);

  // ── Batch state polling for selected market ──────────────────────────────────
  useEffect(() => {
    if (!selectedMarketId) return;
    const marketId = selectedMarketId as `0x${string}`;
    let cancelled  = false;

    const fetchBatch = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const rawId = await publicClient.readContract({
          address: contracts.batchVault,
          abi:     BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args:    [marketId],
        }) as bigint;
        if (cancelled) return;
        // After settlement the contract may reset currentBatchId to 0n (no open
        // batch). Fall back to the last known batchId so we can still read its
        // status and detect the SETTLING → SETTLED transition.
        const batchId = rawId !== 0n ? rawId : lastBatchIdRef.current;
        if (batchId === 0n) return;
        const b = await publicClient.readContract({
          address: contracts.batchVault,
          abi:     BATCH_VAULT_ABI,
          functionName: "getBatch",
          args:    [batchId],
        }) as { marketId: `0x${string}`; openedAt: bigint; closedAt: bigint; status: number; totalDeposited: bigint; clearingPrice: bigint; commitmentCount: bigint };
        if (!cancelled) {
          if (rawId !== 0n) lastBatchIdRef.current = rawId;
          setBatch({
            batchId,
            batchMarketId:   b.marketId,
            openedAt:        Number(b.openedAt),
            batchWindow:     30,
            commitmentCount: Number(b.commitmentCount),
            totalDeposited:  b.totalDeposited,
            status:          b.status as BatchStatus,
            clearingPrice:   b.clearingPrice,
          });
        }
      } catch { /* RPC hiccup */ }
    };

    // Reset batch and order state when market changes
    setBatch({ ...MOCK_BATCH, openedAt: Math.floor(Date.now() / 1000) - 8 });
    setCommitments([]);
    setOrderSealed(false);
    setChainError(null);
    lastBatchIdRef.current = 0n;

    fetchBatch();
    const iv = setInterval(fetchBatch, 2000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selectedMarketId]);

  // Auto-switch left panel to My Positions when batch settles so claim CTA is visible.
  useEffect(() => {
    if (batch.status === BatchStatus.SETTLED && isConnected) {
      setLeftTab("positions");
    }
  }, [batch.status, isConnected]);

  // ── Clear stale per-batch state when batchId advances ───────────────────────
  // When a new batch opens, commitments from the settled batch must be wiped so
  // they don't appear as "ORDER SEALED" in PositionsPanel for the new cycle.
  useEffect(() => {
    if (batch.batchId === 0n) return; // don't clear on initial load
    setCommitments([]);
    setOrderSealed(false);
  }, [batch.batchId]);

  // ── Clear stale error banner on success or wallet reconnect ─────────────────
  // When an order is sealed, any lingering error from a previous failed attempt
  // should disappear — the success supercedes it.
  useEffect(() => {
    if (orderSealed) setChainError(null);
  }, [orderSealed]);

  // Watch both walletAddress (different wallet) and authenticated (same wallet
  // disconnect→reconnect cycle) so the banner clears in either case.
  useEffect(() => {
    setChainError(null);
  }, [walletAddress, authenticated]);

  // ── Chain switching ──────────────────────────────────────────────────────────
  const ensureAmoy = async () => {
    if (!walletAddress || !wallet) throw new Error("Wallet not connected");
    const provider = await wallet.getEthereumProvider();
    // Do NOT call eth_requestAccounts here — Privy intercepts it and shows a SIWE
    // "Sign In" popup on Ethereum mainnet instead of authorizing the wallet session.
    const name = wallet.walletClientType ?? "wallet";

    // Only switch chain if actually needed — calling switchChain when already on
    // the right network briefly disrupts Phantom's provider authorization, causing
    // the very next eth_sendTransaction to return 4100 "not authorized".
    let alreadyOnChain = false;
    try {
      const hexId = await provider.request({ method: "eth_chainId" }) as string;
      alreadyOnChain = parseInt(hexId, 16) === ACTIVE_CHAIN.id;
    } catch { /* can't check — assume wrong chain */ }

    if (!alreadyOnChain) {
      try {
        await wallet.switchChain(ACTIVE_CHAIN.id);
      } catch (err: any) {
        if (err.code === 4001 || err.message?.includes("rejected") || err.message?.includes("cancelled")) {
          throw new Error(`Network switch cancelled — please approve switching to ${ACTIVE_CHAIN_NAME}.`);
        }
        throw new Error(`Please switch to ${ACTIVE_CHAIN_NAME} (Chain ID ${ACTIVE_CHAIN.id}) in ${name}.`);
      }
    }
    return createWalletClient({ account: walletAddress, chain: ACTIVE_CHAIN, transport: custom(provider) });
  };

  // ── Close position: pre-fill the SELL order form and switch to ORDER tab ────────
  const handleClosePosition = useCallback((yesAmount: bigint, clearingPrice: bigint) => {
    setSellPrefill(yesAmount);
    setCloseBuyClearingPrice(clearingPrice);
    setLeftTab("outcomes"); // Switch left panel back to outcomes so user sees trade form
  }, []);

  // ── Claim position via ZK proof (relayer submits on-chain — no wallet tx needed) ──
  // The relayer generates a ZK proof of order membership and calls claimWithProof.
  // No wallet signing required — the salt in localStorage is the secret credential.
  const handleClaimPosition = async (batchId: bigint) => {
    setClaimLoading(true);
    setChainError(null);
    try {
      if (!walletAddress) throw new Error("Wallet not connected");
      const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
      const storedOrders: Array<{
        commitment: string; salt: string; side?: number; isBuy?: boolean;
        amount: string; limitPrice: string; batchId: string; marketId: string;
        ephemeralKey?: string; ephemeralAddress?: string; ctfTokenId?: string | null;
      }> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      const myOrder = storedOrders.find((o) => o.batchId === batchId.toString());
      if (!myOrder) throw new Error("Order preimage not found in local storage — cannot claim");
      if (!myOrder.marketId) throw new Error("Order is missing marketId — cannot claim");

      // Support legacy localStorage entries that used isBuy (v7.x) instead of side (v8)
      const orderSide = myOrder.side ?? (myOrder.isBuy ? 0 : 1);

      // ── Determine recipient ───────────────────────────────────────────────
      // Privacy flow: if the order was placed via an ephemeral wallet (ProxyWallet flow),
      // route YES/NO tokens to the deterministic ProxyWallet address so they can be
      // wrapped (ERC-1155→ERC-20) and shielded into Railgun privately.
      // Legacy flow: use the user-chosen recipient address.
      let recipient: `0x${string}`;
      let proxyWalletAddress: `0x${string}` | null = null;

      const proxyFactoryAddress = process.env.NEXT_PUBLIC_PROXY_WALLET_FACTORY as `0x${string}` | undefined;

      if (myOrder.ephemeralAddress && proxyFactoryAddress) {
        // Compute deterministic ProxyWallet address from ephemeral EOA
        proxyWalletAddress = await publicClient.readContract({
          address:      proxyFactoryAddress,
          abi:          PROXY_WALLET_FACTORY_ABI,
          functionName: "computeAddress",
          args:         [myOrder.ephemeralAddress as `0x${string}`],
        }) as `0x${string}`;
        recipient = proxyWalletAddress;
      } else {
        // Legacy: read payout address from profile settings (set once on profile page)
        recipient = (
          localStorage.getItem(`predacy:claim-recipient:${walletAddress.toLowerCase()}`) || walletAddress
        ) as `0x${string}`;
      }

      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

      // POST order preimage + desired recipient to relayer.
      // Returns { jobId } immediately — ZK proof generation runs in background on Railway.
      // We then poll GET /claim-proof/status?jobId=... until done (avoids Railway 60s timeout).
      // Retry the initial POST up to 3× in case of a transient network error (e.g. Railway restart).
      const claimBody = JSON.stringify({
        batchId:    batchId.toString(),
        marketId:   myOrder.marketId,
        side:       orderSide,
        amount:     myOrder.amount,
        limitPrice: myOrder.limitPrice,
        salt:       myOrder.salt,
        recipient,
        // ProxyWallet fields — present only when ephemeral key exists
        ...(proxyWalletAddress ? {
          proxyWallet:      proxyWalletAddress,
          ephemeralAddress: myOrder.ephemeralAddress,
          // CTF tokenId lets relayer deploy wrapper + build wrap digest
          ctfTokenId:       myOrder.ctfTokenId ?? undefined,
        } : {}),
      });

      // Helper: POST /claim-proof and return the jobId (retries on network error).
      const submitClaimJob = async (): Promise<string> => {
        let resp: Response | null = null;
        let lastErr: Error | null = null;
        for (let r = 0; r < 3; r++) {
          if (r > 0) await new Promise((res) => setTimeout(res, 3000 * r));
          try {
            resp = await fetch(`${relayerUrl}/claim-proof`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: claimBody,
            });
            lastErr = null;
            break;
          } catch (e: any) { lastErr = e; }
        }
        if (!resp) throw new Error(
          `Could not reach relayer — check your connection and retry. (${lastErr?.message ?? "Network error"})`
        );
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error((err as any).error ?? `Claim request failed (${resp.status})`);
        }
        const { jobId: id } = await resp.json();
        if (!id) throw new Error("Relayer did not return a job ID — please retry");
        return id as string;
      };

      let jobId = await submitClaimJob();

      // Poll for proof completion (ZK proof takes ~60-90 s on Railway).
      // Up to 60 polls × 3 s = 3 minutes before timing out.
      // - Network errors during polling are swallowed (Railway may be briefly restarting).
      // - If the job vanishes (404 = Railway restarted and lost in-memory jobs), re-submit.
      type ClaimJobResult = {
        status: "pending" | "done" | "error";
        txHash?: string; wrapDigest?: string; wrappedToken?: string;
        ctfAddress?: string; tokenAmount?: string; wrapError?: string; error?: string;
      };
      let claimResult: ClaimJobResult | null = null;
      let consecutiveNotFound = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const statusResp = await fetch(
            `${relayerUrl}/claim-proof/status?jobId=${encodeURIComponent(jobId)}`,
          );
          if (statusResp.status === 404) {
            // Job not found — Railway may have restarted and lost the in-memory job map.
            // After 3 consecutive 404s (9 s), re-submit the claim to get a fresh jobId.
            consecutiveNotFound++;
            if (consecutiveNotFound >= 3) {
              jobId = await submitClaimJob();
              consecutiveNotFound = 0;
            }
            continue;
          }
          consecutiveNotFound = 0;
          if (!statusResp.ok) continue; // other transient error — keep polling
          const statusData: ClaimJobResult = await statusResp.json();
          if (statusData.status === "done") { claimResult = statusData; break; }
          if (statusData.status === "error") {
            throw new Error(statusData.error ?? "Claim proof failed");
          }
          // status === "pending" — keep polling
        } catch (pollErr: any) {
          // If it's an application-level error thrown above, re-throw it.
          // Otherwise it's a network error — swallow and keep polling.
          if (pollErr.message &&
              !pollErr.message.includes("Failed to fetch") &&
              !pollErr.message.includes("NetworkError") &&
              !pollErr.message.includes("Load failed")) {
            throw pollErr;
          }
        }
      }
      if (!claimResult) throw new Error("Claim timed out after 3 minutes — please retry");

      const { txHash, wrapDigest, wrappedToken, ctfAddress: wrapCtfAddress, tokenAmount } = claimResult;

      if (txHash) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
        if (receipt.status === "reverted") {
          throw new Error("Claim transaction reverted — the batch may not be fully settled yet. Try again in a few seconds.");
        }
      }

      // If relayer returned a wrapDigest, sign it with the ephemeral key and call /wrap-execute.
      // This wraps the CTF ERC-1155 tokens to ERC-20 inside the ProxyWallet (relayer pays gas).
      let wrapTxHash: string | null = null;
      if (wrapDigest && wrappedToken && wrapCtfAddress && tokenAmount && proxyWalletAddress && myOrder.ephemeralKey) {
        try {
          const ephemeralAccount = privateKeyToAccount(myOrder.ephemeralKey as `0x${string}`);
          // Sign with signMessage — viem applies the eth_sign prefix that ProxyWallet expects.
          const wrapSig = await ephemeralAccount.signMessage({
            message: { raw: wrapDigest as `0x${string}` },
          });

          const wrapResp = await fetch(`${relayerUrl}/wrap-execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              proxyWallet: proxyWalletAddress,
              wrappedToken,
              ctfAddress:  wrapCtfAddress,
              tokenAmount,
              wrapSig,
            }),
          });

          if (wrapResp.ok) {
            const wrapResult = await wrapResp.json();
            wrapTxHash = wrapResult.wrapTxHash ?? null;
            console.log("[Predacy] Wrap batch confirmed:", wrapTxHash);
          } else {
            const wrapErr = await wrapResp.json().catch(() => ({}));
            console.warn("[Predacy] Wrap batch failed:", wrapErr.error ?? wrapResp.status);
            // Non-fatal — claim succeeded, tokens are in ProxyWallet as ERC-1155.
            // User can retry wrapping manually via app.railgun.org or future UI.
          }
        } catch (wrapErr: any) {
          console.warn("[Predacy] Wrap batch error (tokens still in ProxyWallet):", wrapErr?.message);
          // Non-fatal.
        }
      }

      // Persist claimed=true + proxyWalletAddress (and wrappedToken if wrap succeeded).
      try {
        const allOrders: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        const updated = allOrders.map((o) =>
          o.batchId === batchId.toString()
            ? {
                ...o,
                claimed: true,
                ...(proxyWalletAddress ? { proxyWalletAddress } : {}),
                ...(wrapTxHash && wrappedToken ? { wrappedToken, wrapTxHash } : {}),
              }
            : o
        );
        localStorage.setItem(storageKey, JSON.stringify(updated));
      } catch { /* ignore storage errors */ }

      setBalanceVersion(v => v + 1);

      if (proxyWalletAddress && wrapTxHash) {
        pushToast(
          "Position claimed + tokens wrapped to ERC-20. Visit app.railgun.org to shield into Railgun.",
          "success"
        );
      } else if (proxyWalletAddress) {
        pushToast(
          "Position claimed — tokens in ProxyWallet. Shield via Railgun to complete privacy.",
          "success"
        );
      } else {
        pushToast("Position claimed — payout sent to wallet.", "success");
      }
    } catch (e: any) {
      if (e?.code !== 4001) {
        setChainError(e.message ?? "Claim failed");
        pushToast(cleanClaimError(e.message ?? "Claim failed"), "error");
      }
      throw e;
    } finally {
      setClaimLoading(false);
    }
  };

  // ── Sweep unfilled ephemeral USDC back to real wallet ────────────────────────
  // When a buy order isn't filled (limit below clearing price), USDC sits in the
  // ephemeral wallet. We already have the private key in localStorage, so we can
  // sign a gasless EIP-3009 TransferWithAuthorization and have the real wallet
  // submit it (one MetaMask popup, real wallet pays the gas).
  const handleSweepUnfilled = async (ephemeralKey: string, ephemeralAddress: string, amount: bigint) => {
    const contracts = getContracts(ACTIVE_CHAIN.id);

    // Check live balance — may differ from stored amount if partially swept already.
    const balance = await publicClient.readContract({
      address: contracts.usdc, abi: ERC20_ABI, functionName: "balanceOf",
      args: [ephemeralAddress as `0x${string}`],
    }) as bigint;
    if (balance === 0n) throw new Error("No USDC left in ephemeral wallet");

    // Sign EIP-3009 auth with the ephemeral key (pure JS, no MetaMask).
    const ephemeralAccount      = privateKeyToAccount(ephemeralKey as `0x${string}`);
    const ephemeralWalletClient = createWalletClient({ account: ephemeralAccount, chain: ACTIVE_CHAIN, transport: http() });

    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const transferNonce = ("0x" + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const sig = await ephemeralWalletClient.signTypedData({
      account: ephemeralAccount,
      domain: usdcDomain(contracts.usdc),
      types: {
        TransferWithAuthorization: [
          { name: "from",        type: "address" }, { name: "to",          type: "address" },
          { name: "value",       type: "uint256" }, { name: "validAfter",  type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce",       type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: ephemeralAddress as `0x${string}`, to: walletAddress as `0x${string}`, value: balance, validAfter: 0n, validBefore, nonce: transferNonce },
    });

    const r = sig.slice(0, 66) as `0x${string}`;
    const s = ("0x" + sig.slice(66, 130)) as `0x${string}`;
    const v = parseInt(sig.slice(130, 132), 16);

    // Real wallet submits transferWithAuthorization (1 MetaMask popup, pays gas).
    const walletClient = await ensureAmoy();
    const txHash = await walletClient.writeContract({
      address: contracts.usdc, abi: TRANSFER_WITH_AUTH_ABI,
      functionName: "transferWithAuthorization",
      args: [ephemeralAddress as `0x${string}`, walletAddress as `0x${string}`, balance, 0n, validBefore, transferNonce, v, r, s],
      ...CHAIN_GAS,
    });

    // Mark swept immediately — don't block UI on receipt (Polygon can take 30–120s).
    try {
      const key = `predacy:orders:${walletAddress!.toLowerCase()}`;
      const all: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(key) ?? "[]");
      localStorage.setItem(key, JSON.stringify(
        all.map((o) => o.ephemeralAddress === ephemeralAddress ? { ...o, swept: true } : o)
      ));
    } catch { /* ignore */ }

    setBalanceVersion(v => v + 1);
    pushToast(`${(Number(balance) / 1e6).toFixed(2)} USDC sweep submitted — tx: ${txHash.slice(0, 10)}…`, "success");

    // Wait for receipt in background to refresh balance once confirmed.
    publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 })
      .then(() => setBalanceVersion(v => v + 1))
      .catch(() => { /* tx is on-chain, just slow — balance will refresh on next poll */ });
  };

  // ── Transfer CTF tokens from ProxyWallet to main wallet ──────────────────────
  // Called when user clicks "MOVE TO WALLET" on a ProxyWallet-claimed position.
  // Signs a ProxyWallet meta-tx with the ephemeral key from localStorage and
  // posts to /proxy-transfer — the relayer submits executeWithSig (pays gas).
  // After success the tokens land in the user's main wallet for selling.
  const handleTransferFromProxy = async (batchId: bigint) => {
    if (!walletAddress) throw new Error("Wallet not connected");

    const contracts = getContracts(ACTIVE_CHAIN.id);
    const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
    const storedOrders: Array<{
      batchId: string; ephemeralKey?: string; ephemeralAddress?: string;
      ctfTokenId?: string | null; proxyWalletAddress?: string;
      side?: number; marketId?: string;
    }> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");

    const myOrder = storedOrders.find((o) => o.batchId === batchId.toString());
    if (!myOrder)                    throw new Error("Order not found in local storage");
    if (!myOrder.ephemeralKey)       throw new Error("No ephemeral key — cannot sign transfer");
    if (!myOrder.proxyWalletAddress) throw new Error("No ProxyWallet address stored");

    const proxyWallet = myOrder.proxyWalletAddress as `0x${string}`;

    // Resolve token ID: use stored value if present, otherwise read from BatchVault on-chain.
    // The on-chain fallback handles orders claimed before ctfTokenId storage was added.
    let tokenId: bigint;
    if (myOrder.ctfTokenId) {
      tokenId = BigInt(myOrder.ctfTokenId);
    } else if (myOrder.marketId) {
      // side 0=YES_BUY → YES tokens; side 2=NO_BUY → NO tokens; default YES
      const isYes = !myOrder.side || myOrder.side === 0;
      const onChainId = await publicClient.readContract({
        address:      contracts.batchVault,
        abi:          BATCH_VAULT_ABI,
        functionName: isYes ? "yesTokenIds" : "noTokenIds",
        args:         [myOrder.marketId as `0x${string}`],
      }) as bigint;
      if (onChainId === 0n) throw new Error("Token ID not found on-chain — contact support");
      tokenId = onChainId;
    } else {
      throw new Error("No token ID stored — cannot identify tokens");
    }

    // Read actual balance — use this rather than computed amount in case of rounding.
    const balance = await publicClient.readContract({
      address:      contracts.ctf,
      abi:          CTF_ABI,
      functionName: "balanceOf",
      args:         [proxyWallet, tokenId],
    }) as bigint;
    if (balance === 0n) {
      // Tokens already moved (e.g. prior transfer tx succeeded but receipt polling
      // timed out and returned an error — so proxyWalletAddress was never cleared).
      // Treat as success: just wipe proxyWalletAddress so the UI shows CLOSE POSITION.
      const allOrders: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      localStorage.setItem(storageKey, JSON.stringify(
        allOrders.map((o) => o.batchId === batchId.toString() ? { ...o, proxyWalletAddress: null } : o)
      ));
      setBalanceVersion(v => v + 1);
      pushToast("Tokens already in your wallet — ready to sell.", "success");
      return;
    }

    // Read ProxyWallet nonce for replay protection.
    // If the wallet isn't deployed yet, nonce() returns 0x — default to 0n.
    // The relayer will deploy the wallet before submitting executeWithSig.
    let proxyNonce: bigint;
    try {
      proxyNonce = await publicClient.readContract({
        address:      proxyWallet,
        abi:          PROXY_WALLET_ABI,
        functionName: "nonce",
      }) as bigint;
    } catch {
      proxyNonce = 0n; // wallet not deployed yet; relayer deploys it (nonce starts at 0)
    }

    // Build CTF.safeTransferFrom(proxyWallet, walletAddress, tokenId, balance, "0x") calldata.
    const calldata = encodeFunctionData({
      abi:          CTF_ABI,
      functionName: "safeTransferFrom",
      args:         [proxyWallet, walletAddress, tokenId, balance, "0x"],
    });

    // Build single-call meta-tx digest matching ProxyWallet._metaTxDigest():
    //   keccak256(abi.encode(nonce, chainId, proxyWallet, ctfAddress, 0, keccak256(data)))
    const digest = keccak256(encodeAbiParameters(
      [
        { type: "uint256" }, // nonce
        { type: "uint256" }, // chainId
        { type: "address" }, // address(this) = proxyWallet
        { type: "address" }, // to            = ctfAddress
        { type: "uint256" }, // value          = 0
        { type: "bytes32" }, // keccak256(data)
      ],
      [proxyNonce, BigInt(ACTIVE_CHAIN.id), proxyWallet, contracts.ctf, 0n, keccak256(calldata)],
    ));

    // Sign with ephemeral key using signMessage (viem adds eth_sign prefix —
    // ProxyWallet._recoverEthSign adds the same prefix before recovering).
    const ephemeralAccount = privateKeyToAccount(myOrder.ephemeralKey as `0x${string}`);
    const sig = await ephemeralAccount.signMessage({ message: { raw: digest } });

    // POST to relayer — relayer calls ProxyWallet.executeWithSig and pays MATIC.
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

    const resp = await fetch(`${relayerUrl}/proxy-transfer`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proxyWallet,
        to:               walletAddress,
        tokenId:          tokenId.toString(),
        amount:           balance.toString(),
        sig,
        ephemeralAddress: myOrder.ephemeralAddress, // relayer needs this to ensureDeployed
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error ?? `Transfer failed (${resp.status})`);
    }

    const { txHash } = await resp.json();
    // Receipt polling — treat timeout as success (tx is already submitted).
    try {
      await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 120_000 });
    } catch (receiptErr: any) {
      const msg: string = receiptErr?.message ?? "";
      if (!msg.includes("could not be found") && !msg.includes("not be processed")) throw receiptErr;
      // Timeout — tx is in-flight, continue to clear proxyWalletAddress
    }

    // Clear proxyWalletAddress from localStorage — tokens are now in main wallet.
    try {
      const allOrders: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      localStorage.setItem(storageKey, JSON.stringify(
        allOrders.map((o) => o.batchId === batchId.toString()
          ? { ...o, proxyWalletAddress: null }
          : o
        )
      ));
    } catch { /* ignore */ }

    setBalanceVersion(v => v + 1);
    pushToast("Tokens moved to your wallet — you can now place a SELL order.", "success");
  };

  // OrderSide constants (must match BatchVault v8 OrderSide enum)
  const YES_BUY  = 0;
  const YES_SELL = 1;
  const NO_BUY   = 2;
  // const NO_SELL  = 3; // reserved for future use

  // ── Submit order (ephemeral wallet privacy pattern) ───────────────────────────
  // BUY (YES or NO): ephemeral keypair → fund → sign all 3 sigs in-browser → no settlement leak
  // SELL (YES or NO): CTF approval + real wallet sign + relayer commitment
  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`; amount: bigint; salt: `0x${string}`; side: number; limitPrice: bigint;
  }) => {
    if (!selectedMarket) return;
    setChainError(null);
    const contracts = getContracts(ACTIVE_CHAIN.id);
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 600);

    setSubmitStep("approving");
    const walletClient = await ensureAmoy();

    if (params.side === YES_BUY || params.side === NO_BUY) {
      // ── BUY: ephemeral wallet pattern ──────────────────────────────────────
      const ephemeralPrivateKey = generatePrivateKey();
      const ephemeralAccount    = privateKeyToAccount(ephemeralPrivateKey);
      const ephemeralAddress    = ephemeralAccount.address;

      // Pre-flight balance check — gives a clear human-readable error before
      // hitting the wallet. USDC.e uses old SafeMath that reverts with empty bytes,
      // so without this check viem would show "Unexpected error".
      const usdcBalance = await publicClient.readContract({
        address: contracts.usdc, abi: ERC20_ABI, functionName: "balanceOf",
        args: [walletAddress!],
      }) as bigint;
      if (usdcBalance < params.amount) {
        const have = (Number(usdcBalance) / 1e6).toFixed(2);
        const need = (Number(params.amount) / 1e6).toFixed(2);
        throw new Error(`Insufficient USDC balance — you have $${have} but need $${need} USDC.e on Polygon. Bridge or swap USDC to Polygon first.`);
      }

      // Send USDC via raw provider.request (no EIP-1559 fields — viem's writeContract
      // adds maxFeePerGas/type=2 which some wallets reject on Polygon). Privy's
      // getEthereumProvider() routes to whichever wallet the user connected.
      const userProvider = await wallet.getEthereumProvider();
      const txParams = {
        from: walletAddress,
        to:   contracts.usdc as string,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ephemeralAddress, params.amount] }),
        gas:  `0x${(100_000n).toString(16)}`,   // 100k — ERC-20 transfer uses ~50k
      };
      let fundTx: `0x${string}`;
      try {
        fundTx = await userProvider.request({ method: "eth_sendTransaction", params: [txParams] }) as `0x${string}`;
      } catch (err0: any) {
        if (err0?.code === 4100 || err0?.message?.includes("Unauthorized")) {
          // Retry once on 4100 — do NOT call eth_requestAccounts first; Privy intercepts
          // it and shows a SIWE popup on Ethereum instead of re-authorizing the session.
          fundTx = await userProvider.request({ method: "eth_sendTransaction", params: [txParams] }) as `0x${string}`;
        } else {
          throw err0;
        }
      }
      await publicClient.waitForTransactionReceipt({ hash: fundTx });

      // Persist ephemeral key immediately after funding so USDC can always be swept
      // back even if the relayer submission fails and the order is never saved below.
      if (walletAddress) {
        try {
          const recoveryKey = `predacy:orders:${walletAddress.toLowerCase()}`;
          const existing: unknown[] = JSON.parse(localStorage.getItem(recoveryKey) ?? "[]");
          existing.unshift({
            commitment:     null,   // filled in after relayer confirms
            salt:           null,
            amount:         params.amount.toString(),
            side:           params.side,  // 0=YES_BUY, 2=NO_BUY
            limitPrice:     params.limitPrice.toString(),
            batchId:        "0",
            marketId:       selectedMarket.conditionId,
            marketQuestion: selectedMarket.question ?? null,
            timestamp:      Date.now(),
            ephemeralKey:   ephemeralPrivateKey,
            ephemeralAddress,
            pending:        true,   // draft — no on-chain commitment yet
          });
          localStorage.setItem(recoveryKey, JSON.stringify(existing.slice(0, 200)));
        } catch { /* ignore */ }
      }

      const ephemeralWalletClient = createWalletClient({
        account: ephemeralAccount, chain: ACTIVE_CHAIN, transport: http(),
      });

      const ephemeralNonce = await publicClient.readContract({
        address: contracts.batchVault, abi: BATCH_VAULT_ABI, functionName: "nonces",
        args: [ephemeralAddress],
      }) as bigint;

      setSubmitStep("signing");

      // Split large orders into ≤$5 000 chunks so no single batch is dominated
      // by one order, preserving the price-impact cap and privacy mixing goal.
      const chunks        = splitIntoChunks(params.amount, MAX_CHUNK_USDC_MICRO);
      const isSplit       = chunks.length > 1;
      const K             = chunks.length;
      const requeueDeadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600); // 7-day window

      // EIP-712 types/domain shared across all chunks — no batchId in v6.
      const COMMIT_ORDER_TYPES = {
        CommitOrder: [
          { name: "commitment", type: "bytes32" },
          { name: "amount",     type: "uint256" },
          { name: "nonce",      type: "uint256" },
          { name: "deadline",   type: "uint256" },
        ],
      } as const;
      const COMMIT_ORDER_DOMAIN = {
        name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault,
      } as const;

      // Pre-sign all CommitOrder sigs + requeue auths + transferAuths before any
      // on-chain submission. Nonce allocation for K chunks, starting at ephemeral nonce N:
      //   Chunk i  main commit : N + i
      //   Chunk i  requeue 1   : N + K + 2i
      //   Chunk i  requeue 2   : N + K + 2i + 1
      const chunkOrders = await Promise.all(chunks.map(async (chunkAmount, i) => {
        // Each chunk gets its own random salt → unique commitment (independent sealed bids).
        // generatePrivateKey() produces 32 cryptographically random bytes — perfect as salt.
        const chunkSalt       = generatePrivateKey();
        const chunkCommitment = computeCommitment({
          // Use the actual Polymarket conditionId — this is what the contract uses
          // in _verifyCommitments at settlement. Using batch.batchMarketId was wrong
          // when batch.batchId === 0n (MOCK_BATCH has bytes32(0) as marketId).
          marketId:   selectedMarket.conditionId as `0x${string}`,
          side:       params.side,  // YES_BUY=0 or NO_BUY=2
          amount:     chunkAmount,
          limitPrice: params.limitPrice,
          salt:       chunkSalt,
        });

        const mainNonce = ephemeralNonce + BigInt(i);
        const rq1Nonce  = ephemeralNonce + BigInt(K) + BigInt(2 * i);
        const rq2Nonce  = ephemeralNonce + BigInt(K) + BigInt(2 * i + 1);

        // Sign all 3 CommitOrder sigs in parallel (pure JS crypto, no MetaMask popup).
        const [sig, rqSig1, rqSig2] = await Promise.all([
          ephemeralWalletClient.signTypedData({
            account: ephemeralAccount, domain: COMMIT_ORDER_DOMAIN, types: COMMIT_ORDER_TYPES, primaryType: "CommitOrder",
            message: { commitment: chunkCommitment, amount: chunkAmount, nonce: mainNonce, deadline },
          }),
          ephemeralWalletClient.signTypedData({
            account: ephemeralAccount, domain: COMMIT_ORDER_DOMAIN, types: COMMIT_ORDER_TYPES, primaryType: "CommitOrder",
            message: { commitment: chunkCommitment, amount: chunkAmount, nonce: rq1Nonce, deadline: requeueDeadline },
          }),
          ephemeralWalletClient.signTypedData({
            account: ephemeralAccount, domain: COMMIT_ORDER_DOMAIN, types: COMMIT_ORDER_TYPES, primaryType: "CommitOrder",
            message: { commitment: chunkCommitment, amount: chunkAmount, nonce: rq2Nonce, deadline: requeueDeadline },
          }),
        ]);

        // Fresh random EIP-3009 nonce per chunk — allows multiple transferAuths from
        // the same ephemeral wallet to coexist (they're independent authorizations).
        const chunkNonceBytes = new Uint8Array(32);
        crypto.getRandomValues(chunkNonceBytes);
        const chunkTransferNonce = ("0x" + Array.from(chunkNonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 7200);

        const chunkTransferSig = await ephemeralWalletClient.signTypedData({
          account: ephemeralAccount,
          domain: usdcDomain(contracts.usdc),
          types: {
            TransferWithAuthorization: [
              { name: "from", type: "address" }, { name: "to",          type: "address" },
              { name: "value", type: "uint256"}, { name: "validAfter",  type: "uint256" },
              { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: { from: ephemeralAddress, to: contracts.batchVault, value: chunkAmount, validAfter: 0n, validBefore, nonce: chunkTransferNonce },
        });

        const r = chunkTransferSig.slice(0, 66) as `0x${string}`;
        const s = ("0x" + chunkTransferSig.slice(66, 130)) as `0x${string}`;
        const v = parseInt(chunkTransferSig.slice(130, 132), 16);

        return {
          chunkAmount, chunkSalt, chunkCommitment, mainNonce, sig, rqSig1, rqSig2, rq1Nonce, rq2Nonce,
          transferAuth: { from: ephemeralAddress, validAfter: "0", validBefore: validBefore.toString(), nonce: chunkTransferNonce, v, r, s },
        };
      }));

      // Submit chunks sequentially — each await blocks until relayer confirms on-chain,
      // ensuring the ephemeral nonce increments correctly for subsequent chunks.
      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

      let actualBatchId = batch.batchId.toString();
      for (const chunk of chunkOrders) {
        const resp = await fetch(`${relayerUrl}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marketId:       selectedMarket.conditionId,
            batchId:        actualBatchId,
            signer:         ephemeralAddress,
            side:           params.side,  // 0=YES_BUY, 2=NO_BUY
            amount:         chunk.chunkAmount.toString(),
            limitPrice:     params.limitPrice.toString(),
            salt:           chunk.chunkSalt,
            commitment:     chunk.chunkCommitment,
            signature:      chunk.sig,
            nonce:          chunk.mainNonce.toString(),
            deadline:       deadline.toString(),
            transferAuth:   chunk.transferAuth,
            requeueAuths: [
              { ephemeral: ephemeralAddress, nonce: chunk.rq1Nonce.toString(), deadline: requeueDeadline.toString(), signature: chunk.rqSig1 },
              { ephemeral: ephemeralAddress, nonce: chunk.rq2Nonce.toString(), deadline: requeueDeadline.toString(), signature: chunk.rqSig2 },
            ],
            // Cross-device history sync: relayer stores summary keyed by real wallet
            walletAddress:  walletAddress ?? null,
            marketQuestion: selectedMarket.question ?? null,
          }),
        });
        const relayerData = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(relayerData.error ?? `Relayer returned ${resp.status}`);

        // Track the batchId from each response — a large order may span two batches.
        actualBatchId = relayerData.batchId ?? actualBatchId;

        if (walletAddress) {
          setCommitments((prev) => [...prev, { hash: chunk.chunkCommitment, amount: chunk.chunkAmount, trader: walletAddress, timestamp: Date.now() }]);
          setBatch((prev) => ({ ...prev, commitmentCount: prev.commitmentCount + 1, totalDeposited: prev.totalDeposited + chunk.chunkAmount }));
          try {
            const key = `predacy:orders:${walletAddress.toLowerCase()}`;
            // Remove the draft entry saved at funding time — replace it with the real committed entry.
            const existing: unknown[] = (JSON.parse(localStorage.getItem(key) ?? "[]") as Array<Record<string, unknown>>)
              .filter((o) => !(o.pending && o.ephemeralAddress === ephemeralAddress));
            existing.unshift({
              commitment:       chunk.chunkCommitment,
              salt:             chunk.chunkSalt,
              amount:           chunk.chunkAmount.toString(),
              side:             params.side,  // 0=YES_BUY, 2=NO_BUY
              limitPrice:       params.limitPrice.toString(),
              batchId:          actualBatchId,
              marketId:         selectedMarket.conditionId,
              marketQuestion:   selectedMarket.question ?? null,
              timestamp:        Date.now(),
              ephemeralKey:     ephemeralPrivateKey,
              ephemeralAddress,
              // CTF ERC-1155 tokenId for the outcome token — used for wrap-after-claim.
              // side=0 (YES_BUY) receives YES tokens; side=2 (NO_BUY) receives NO tokens.
              ctfTokenId: params.side === 0
                ? (selectedMarket.tokens?.[0]?.token_id ?? null)
                : (selectedMarket.tokens?.[1]?.token_id ?? null),
            });
            localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
          } catch { /* ignore */ }
        }
      }

      if (isSplit) pushToast(`Order split across ${K} batches for lower price impact`, "success");
      setOrderSealed(true);
      setLeftTab("positions");
      // Poll requeue status for the last chunk (most recently committed).
      setRequeueNotif(null);
      setPendingRequeueCommitment(chunkOrders[chunkOrders.length - 1].chunkCommitment.toLowerCase());
      return;
    }

    // ── SELL: real wallet signs (unchanged) ───────────────────────────────────
    let isApproved = false;
    try {
      isApproved = await publicClient.readContract({
        address: contracts.ctf, abi: CTF_ABI, functionName: "isApprovedForAll",
        args: [walletAddress!, contracts.batchVault],
      }) as boolean;
    } catch { isApproved = false; }
    if (!isApproved) {
      const tx = await walletClient.writeContract({
        address: contracts.ctf, abi: CTF_ABI, functionName: "setApprovalForAll",
        args: [contracts.batchVault, true], ...CHAIN_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
    }

    const nonce = await publicClient.readContract({
      address: contracts.batchVault, abi: BATCH_VAULT_ABI, functionName: "nonces",
      args: [walletAddress!],
    }) as bigint;

    setSubmitStep("signing");

    // Sell orders: sign CommitOrder without batchId (v6 contract removes it).
    // No requeue sigs for sells — YES tokens are pre-deposited so requeue is not applicable.
    const signature = await walletClient.signTypedData({
      account: walletAddress!,
      domain: { name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault },
      types: { CommitOrder: [
        { name: "commitment", type: "bytes32" },
        { name: "amount",     type: "uint256" },
        { name: "nonce",      type: "uint256" },
        { name: "deadline",   type: "uint256" },
      ]},
      primaryType: "CommitOrder",
      message: { commitment: params.commitment, amount: params.amount, nonce, deadline },
    });

    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");
    const resp = await fetch(`${relayerUrl}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId:       selectedMarket.conditionId,
        batchId:        batch.batchId.toString(),
        signer:         walletAddress,
        side:           params.side,  // 1=YES_SELL or 3=NO_SELL
        amount:         params.amount.toString(),
        limitPrice:     params.limitPrice.toString(),
        salt:           params.salt,
        commitment:     params.commitment,
        signature,
        nonce:          nonce.toString(),
        deadline:       deadline.toString(),
        transferAuth:   undefined,
        // Cross-device history sync: relayer stores summary keyed by real wallet
        walletAddress:  walletAddress ?? null,
        marketQuestion: selectedMarket.question ?? null,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Relayer error" }));
      throw new Error(err.error ?? `Relayer returned ${resp.status}`);
    }
    if (walletAddress) {
      setCommitments((prev) => [...prev, { hash: params.commitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() }]);
      setBatch((prev) => ({ ...prev, commitmentCount: prev.commitmentCount + 1 }));
      try {
        const key = `predacy:orders:${walletAddress.toLowerCase()}`;
        const existing: unknown[] = JSON.parse(localStorage.getItem(key) ?? "[]");
        existing.unshift({
          commitment:       params.commitment,
          salt:             params.salt,
          amount:           params.amount.toString(),
          side:             params.side,   // 1=YES_SELL or 3=NO_SELL
          limitPrice:       params.limitPrice.toString(),
          batchId:          batch.batchId.toString(),
          marketId:         selectedMarket.conditionId,
          marketQuestion:   selectedMarket.question ?? null,
          timestamp:        Date.now(),
          // Cost basis of the position being closed — used for P&L display
          buyClearingPrice: closeBuyClearingPrice != null ? closeBuyClearingPrice.toString() : undefined,
        });
        localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
      } catch { /* ignore */ }
    }
    setOrderSealed(true);
    setLeftTab("positions");
  };

  // ── Faucet ───────────────────────────────────────────────────────────────────
  const handleGetTestUsdc = async () => {
    if (!walletAddress) return;
    setFaucetLoading(true);
    try {
      const walletClient = await ensureAmoy();
      const contracts = getContracts(ACTIVE_CHAIN.id);
      const tx = await walletClient.writeContract({
        address: contracts.usdc, abi: MOCK_USDC_ABI, functionName: "mint",
        args: [walletAddress, 10_000_000_000n], ...CHAIN_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
    } catch (e: any) {
      if (e?.code !== 4001) setChainError(e.message ?? "Faucet failed");
    } finally {
      setFaucetLoading(false);
    }
  };

  // ── Loading / not found ──────────────────────────────────────────────────────
  if (eventLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!event) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-muted text-sm">Event not found.</p>
        <Link href="/" className="text-accent text-xs tracking-widest hover:underline">← MARKETS</Link>
      </div>
    );
  }

  const sorted  = filterAndDeduplicateMarkets(event.markets).sort(
    (a, b) => parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0"),
  );
  const volume  = event.volumeNum ?? parseFloat(event.volume ?? "0");
  const selYesPrice = selectedMarket ? parseFloat(selectedMarket.outcomePrices?.[0] ?? "0") : 0;
  const selNoPriceRaw = selectedMarket ? parseFloat(selectedMarket.outcomePrices?.[1] ?? "0") : 0;
  const selNoPrice    = selNoPriceRaw >= 0.999 ? (1 - selNoPriceRaw) : selNoPriceRaw;
  const selYesProb  = Math.round(selYesPrice * 100);

  return (
    <div className="h-screen flex flex-col overflow-hidden">

      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-1.5 text-muted hover:text-text transition-colors text-[11px] tracking-widest uppercase">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Markets
          </Link>
          <span className="text-border">|</span>
          <Link href="/" className="text-xl font-black tracking-tight text-text" style={{ fontFamily: "var(--font-display)" }}>
            PREDACY
          </Link>
        </div>
        <div className="flex items-center gap-3">
          {isConnected && !IS_MAINNET && (
            <button
              onClick={handleGetTestUsdc}
              disabled={faucetLoading}
              className="text-[10px] tracking-widest uppercase border border-border text-muted px-3 py-1.5 hover:border-accent/40 hover:text-text transition-colors disabled:opacity-40"
            >
              {faucetLoading ? "MINTING…" : "GET TEST USDC"}
            </button>
          )}
          <WalletButton />
        </div>
      </header>

      {/* Event title + selected outcome context */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          {event.category && (
            <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">
              {event.category}
            </span>
          )}
          {event.endDate && <span className="text-[10px] text-muted">Ends {formatDate(event.endDate)}</span>}
          <span className="text-[11px] text-muted ml-auto tabular-nums">{formatVolume(volume)} vol</span>
        </div>
        <h1 className="text-xl font-black text-text tracking-tight leading-snug" style={{ fontFamily: "var(--font-display)" }}>
          {event.title}
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 border border-border bg-surface/35 px-3 py-2">
          <span className="text-[10px] text-muted tracking-widest uppercase">Selected</span>
          <span className="text-sm font-bold text-text">
            {selectedMarket ? outcomeLabel(selectedMarket) : "Select an outcome"}
          </span>
          {selectedMarket && (
            <>
              <span className="text-muted">•</span>
              <span className="text-sm font-black text-text tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
                {selYesProb}% chance
              </span>
              <span className="text-muted">•</span>
              <span className="text-[11px] text-accent tabular-nums">
                YES {fmtCents(selYesPrice)}
              </span>
              <span className="text-[11px] text-danger tabular-nums">
                NO {fmtCents(selNoPrice)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Chain error */}
      {chainError && (
        <div className="mx-6 mt-3 px-3 py-2 border border-danger/30 bg-danger/5 text-[11px] text-danger">
          {chainError}
          <button onClick={() => setChainError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Exploration + trading layout */}
      <div className="flex flex-1 min-h-0 flex-col xl:flex-row xl:divide-x xl:divide-border">

        {/* ── Left column: compact chart + scrollable outcome list ──────── */}
        <div className="flex-1 flex flex-col min-h-[320px] min-w-0">

          {/* Chart only shown on Outcomes tab — hide when Orderbook active to give it full height */}
          {leftTab === "outcomes" && <MultiOutcomeChart markets={event.markets} selectedMarketId={selectedMarket?.conditionId} />}

          {/* Subheader with Outcomes / My Positions / Orderbook tab toggle */}
          <div className="px-5 py-2.5 border-b border-border flex items-center justify-between flex-shrink-0">
            <span className="text-[10px] text-muted tracking-widest uppercase">
              {sorted.length} Outcomes
            </span>
            <div className="flex border border-border text-[10px] tracking-widest uppercase">
              <button
                type="button"
                onClick={() => setLeftTab("outcomes")}
                className={clsx(
                  "px-3 py-1 transition-colors",
                  leftTab === "outcomes" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted"
                )}
              >
                Outcomes
              </button>
              <button
                type="button"
                onClick={() => setLeftTab("positions")}
                className={clsx(
                  "px-3 py-1 border-l border-border transition-colors",
                  leftTab === "positions" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted"
                )}
              >
                My Positions
              </button>
              <button
                type="button"
                onClick={() => setLeftTab("orderbook")}
                className={clsx(
                  "px-3 py-1 border-l border-border transition-colors",
                  leftTab === "orderbook" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted"
                )}
              >
                Orderbook
              </button>
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto flex flex-col">

          {leftTab === "orderbook" ? (
            <OrderbookPanel market={selectedMarket} />
          ) : leftTab === "positions" ? (
            isConnected && walletAddress ? (
              <>
                {/* Requeue notification banner */}
                {requeueNotif && (
                  <div className={clsx(
                    "px-4 py-3 border-b border-border flex items-start gap-3",
                    requeueNotif.type === "requeued" ? "bg-accent/5" : "bg-red-900/10",
                  )}>
                    <div className="flex-1 space-y-0.5">
                      {requeueNotif.type === "requeued" ? (
                        <>
                          <p className="text-[10px] text-accent tracking-widest uppercase">Order Requeued</p>
                          <p className="text-[11px] text-muted-dim">
                            Your limit was outside this batch&apos;s clearing price. Your order has been automatically moved to
                            {requeueNotif.toBatch ? ` Batch #${requeueNotif.toBatch}` : " the next batch"}.
                            {requeueNotif.remainingAuths === 0 && " This is your last auto-requeue — if excluded again, the order expires."}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-[10px] tracking-widest uppercase" style={{ color: "#FF6B6B" }}>Order Expired</p>
                          <p className="text-[11px] text-muted-dim">
                            Your limit price was consistently outside the clearing price. The order has been dropped. Place a new order closer to the current market price.
                          </p>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => setRequeueNotif(null)}
                      className="text-muted hover:text-text transition-colors text-lg leading-none mt-0.5"
                      aria-label="Dismiss"
                    >×</button>
                  </div>
                )}
                <PositionsPanel
                  walletAddress={walletAddress}
                  marketId={selectedMarketId}
                  currentBatchId={batch.batchId}
                  currentBatchStatus={batch.status}
                  currentBatchClearingPrice={batch.clearingPrice}
                  currentBatchCommitments={commitments
                    .filter((c) => c.trader === walletAddress)
                    .map((c) => ({ hash: c.hash, amount: c.amount }))}
                  onClaim={handleClaimPosition}
                  onClosePosition={handleClosePosition}
                  onMarketIdsFound={setHistoricalMarketIds}
                  onSweepUnfilled={handleSweepUnfilled}
                  onTransferFromProxy={handleTransferFromProxy}
                />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
                <p className="text-muted text-xs text-center">Connect your wallet to view positions</p>
                <button
                  onClick={login}
                  className="border border-border-bright text-text text-[11px] tracking-widest uppercase px-4 py-2 hover:border-text/30 transition-colors"
                >
                  Connect Wallet
                </button>
              </div>
            )
          ) : (
          <div className="divide-y divide-border/40">
            {sorted.length === 0 && (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-muted">All outcomes resolved</p>
                <p className="text-[11px] text-muted-dim mt-1">This event has fully settled.</p>
              </div>
            )}
            {sorted.map((market, idx) => {
              const yp   = parseFloat(market.outcomePrices?.[0] ?? "0");
              const np   = parseFloat(market.outcomePrices?.[1] ?? "0");
              const prob = Math.round(yp * 100);
              const bar  = prob > 60 ? "#00FFB3" : prob < 20 ? "#FF3355" : "#4D83FF";
              const sel  = selectedMarket?.conditionId === market.conditionId;
              const label = outcomeLabel(market);
              // When Gamma returns outcomePrices[1] ≈ 1.0 (illiquid market, no real NO price),
              // invert it so we show a tiny value like Polymarket does (e.g. "0¢" not "100¢").
              // Threshold 0.999 preserves real near-100¢ values like Michelle Bowman's 99.6¢.
              const npDisplay = np >= 0.999 ? (1 - np) : np;

              return (
                <div
                  key={market.conditionId}
                  onClick={() => { setSelectedMarket(market); setOrderSealed(false); }}
                  className={clsx(
                    "flex items-center gap-3 px-5 py-3 cursor-crosshair transition-colors group border-l-2",
                    sel
                      ? "bg-surface/70 border-l-accent shadow-[inset_0_0_0_1px_rgba(78,163,255,0.22)]"
                      : "border-l-transparent hover:bg-white/[0.02]",
                  )}
                >
                  {/* Rank */}
                  <span className="text-[10px] text-muted-dim w-4 flex-shrink-0 tabular-nums text-right">{idx + 1}</span>

                  {/* Selection indicator */}
                  <div className={clsx("w-1 h-6 rounded-full flex-shrink-0 transition-all", sel ? "opacity-100" : "opacity-0")} style={{ background: bar }} />

                  {/* Name + Volume */}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className={clsx("text-sm truncate transition-colors", sel ? "text-text" : "text-text/70 group-hover:text-text/90")}>
                      {label}
                    </span>
                    <span className="text-[10px] text-muted-dim tabular-nums">
                      {formatVolume(market.volumeNum || parseFloat(market.volume ?? "0"))} vol
                    </span>
                  </div>

                  {/* Prob bar */}
                  <div className="w-20 h-[2px] bg-border rounded-full overflow-hidden flex-shrink-0 hidden sm:block">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(prob, 1)}%`, background: bar }} />
                  </div>

                  {/* Prob % */}
                  <span className="text-sm font-black tabular-nums w-9 text-right flex-shrink-0" style={{ fontFamily: "var(--font-display)", color: bar }}>
                    {fmtPct(yp)}
                  </span>

                  {/* YES / NO chips */}
                  <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums"
                      style={{ borderColor: "#00FFB330", color: "#00FFB3", background: "#00FFB305" }}>
                      {fmtCents(yp)}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums"
                      style={{ borderColor: "#FF335530", color: "#FF3355", background: "#FF335505" }}>
                      {fmtCents(npDisplay)}
                    </span>
                  </div>

                  {/* Arrow */}
                  <svg className={clsx("w-3 h-3 flex-shrink-0 transition-colors", sel ? "text-accent" : "text-muted-dim group-hover:text-muted")}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              );
            })}
          </div>
          )}{/* end leftTab === "outcomes" */}
          </div>{/* end flex-1 tab content */}
        </div>{/* end left column */}

        {/* ── Trading panel ────────────────────────────────────────────────── */}
        <div className="w-full xl:w-[380px] xl:flex-shrink-0 flex flex-col overflow-hidden border-t border-border xl:border-t-0">

          {selectedMarket ? (
            <>
              <div className="px-4 py-3 border-b border-border bg-surface/20">
                <p className="text-[11px] text-muted tracking-widest uppercase">Trade</p>
                <div className="mt-2">
                  <label className="text-[10px] text-muted tracking-widest uppercase block mb-1">Outcome</label>
                  <select
                    value={selectedMarket.conditionId}
                    onChange={(e) => {
                      const next = sorted.find((m) => m.conditionId === e.target.value);
                      if (!next) return;
                      setSelectedMarket(next);
                      setOrderSealed(false);
                    }}
                    className="w-full bg-surface border border-border text-[12px] text-text px-2.5 py-2 focus:outline-none focus:border-border-bright"
                  >
                    {sorted.map((market) => (
                      <option key={market.conditionId} value={market.conditionId}>
                        {outcomeLabel(market)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tab content — scrolls internally, BatchTimer pinned below */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                <>
                  {/* Order sealed confirmation */}
                  {orderSealed && (
                    <div className="px-4 py-3 border-b border-border bg-accent/5">
                      <div className="flex items-center gap-2 mb-1">
                        <svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-[11px] text-accent tracking-widest uppercase">Order Sealed</span>
                      </div>
                      <p className="text-[11px] text-muted-dim">
                        Your commitment is sealed in the current batch. It will settle at the uniform clearing price.
                      </p>
                      <button
                        onClick={() => setOrderSealed(false)}
                        className="mt-2 text-[10px] text-muted hover:text-text tracking-widest uppercase"
                      >
                        PLACE ANOTHER ORDER
                      </button>
                    </div>
                  )}

                  {/* Settled nudge — shown on Order tab after batch settles (e.g. post-refresh) */}
                  {!orderSealed && batch.status === BatchStatus.SETTLED && (
                    <div className="px-4 py-4 border-b border-border">
                      <div className="border border-accent/20 bg-accent/5 p-3 space-y-2">
                        <p className="text-[11px] text-accent tracking-widest uppercase">Batch Settled</p>
                        <p className="text-[11px] text-muted-dim">
                          This batch has cleared at {batch.clearingPrice > 0n
                            ? `${(Number(batch.clearingPrice) / 1e6 * 100).toFixed(1)}¢`
                            : "no cross"}.
                        </p>
                        <button
                          onClick={() => setLeftTab("positions")}
                          className="text-[10px] text-accent tracking-widest uppercase hover:underline"
                        >
                          VIEW MY POSITIONS →
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Order form */}
                  {!orderSealed && batch.status !== BatchStatus.SETTLED && (
                    <div className="px-4 py-3">
                      {submitStep && (
                        <div className="mb-3 flex items-center gap-2 text-[11px] text-muted">
                          <div className="w-2.5 h-2.5 border border-muted/40 border-t-transparent rounded-full animate-spin" />
                          {submitStep === "approving" ? "Approving USDC…" : "Waiting for signature…"}
                        </div>
                      )}
                      <OrderForm
                        market={selectedMarket}
                        marketId={selectedMarket.conditionId as `0x${string}`}
                        batchOpen={batch.status === BatchStatus.OPEN}
                        onSubmit={async (p) => {
                          setOrderSealed(false);
                          setSubmitStep(null);
                          try { await handleOrderSubmit(p); }
                          catch (e: any) {
                            if (e?.code === 4001) return; // user rejected
                            if (e?.code === 4100 || e?.message?.includes("Unauthorized")) {
                              setChainError("Order failed — please try again. If the problem persists, disconnect and reconnect your wallet.");
                            } else {
                              setChainError(e.message ?? "Order failed");
                            }
                          } finally { setSubmitStep(null); }
                        }}
                        walletAddress={walletAddress}
                        isConnected={isConnected}
                        onConnect={login}
                        submitStep={submitStep}
                        balanceVersion={balanceVersion}
                        candidateMarketIds={[selectedMarket.conditionId as `0x${string}`, ...historicalMarketIds]}
                        sellPrefill={sellPrefill}
                        onSellPrefillConsumed={() => { setSellPrefill(null); setCloseBuyClearingPrice(null); }}
                      />
                    </div>
                  )}
                </>
              
              </div>{/* end flex-1 scrollable tab content */}

              {/* Compact batch timer — pinned at bottom of trading panel */}
              <div className="border-t border-border px-4 py-3 flex-shrink-0">
                <BatchTimer
                  openedAt={batch.openedAt}
                  batchWindow={batch.batchWindow}
                  commitmentCount={batch.commitmentCount}
                  totalDeposited={batch.totalDeposited}
                  batchId={batch.batchId}
                  status={batch.status}
                  clearingPrice={batch.clearingPrice}
                  mini={true}
                />
              </div>
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <div className="w-10 h-10 border border-border flex items-center justify-center">
                <svg className="w-5 h-5 text-muted-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="square" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <p className="text-[11px] text-muted tracking-widest uppercase">Select an outcome to trade</p>
              <p className="text-[10px] text-muted-dim leading-relaxed">
                Your order is sealed in a batch. No one can see your direction until settlement.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-3 flex items-center justify-between flex-shrink-0">
        <span className="text-[10px] text-muted-dim tracking-widest uppercase">
          Predacy · Dark Pool · Powered by Polymarket Liquidity
        </span>
        <span className="text-[10px] text-muted-dim">
          <span className="text-accent/30">●</span> No position info leaks on-chain
        </span>
      </footer>

      {/* Toast notification */}
      {toast && (
        <div
          key={toast.id}
          className={clsx(
            "fixed bottom-6 left-1/2 -translate-x-1/2 z-50",
            "px-4 py-3 border text-[11px] tracking-wide animate-slide-up",
            "shadow-lg max-w-xs w-full",
            toast.type === "success"
              ? "bg-surface border-accent/40 text-accent"
              : "bg-surface border-danger/40 text-danger",
          )}
        >
          <div className="flex items-center gap-2">
            {toast.type === "success" ? (
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {toast.message}
          </div>
        </div>
      )}

    </div>
  );
}
