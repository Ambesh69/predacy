"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import {
  createPublicClient, createWalletClient, custom, http, parseAbiItem,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import WalletButton from "@/components/WalletButton";
import BatchTimer from "@/components/BatchTimer";
import OrderForm from "@/components/OrderForm";
import PositionsPanel from "@/components/PositionsPanel";
import type { Market } from "@/lib/polymarket";
import {
  filterAndDeduplicateMarkets,
  outcomeLabel,
  fmtPct,
  fmtCents,
} from "@/lib/marketUtils";
import {
  BATCH_VAULT_ABI, CTF_ABI, ERC20_ABI, MOCK_USDC_ABI,
  BatchStatus, getContracts,
} from "@/lib/contracts";
import { computeCommitment } from "@/lib/commitmentHash";
import {
  ACTIVE_CHAIN, ACTIVE_CHAIN_ID_HEX, ACTIVE_CHAIN_NAME,
  CHAIN_GAS, IS_MAINNET,
} from "@/lib/chain";

// ── Viem public client ────────────────────────────────────────────────────────
const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(),
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

interface ChartSeries { name: string; color: string; pts: Array<{ t: number; p: number }>; }

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

function MultiOutcomeChart({ markets }: { markets: Market[] }) {
  const [iv, setIv]           = useState<Interval>("1d");
  const [lines, setLines]     = useState<ChartSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoverX, setHoverX]   = useState<number | null>(null); // SVG x coord

  // Sort by current YES probability descending — this is exactly how Polymarket orders its
  // chart outcomes: highest probability candidate first, then next, etc.
  // The Gamma API's own market order is NOT by probability (it's internal/alphabetical),
  // so we must sort ourselves. Judy Shelton at 4.5% should always rank above <1% candidates.
  const top4 = filterAndDeduplicateMarkets(markets)
    .filter((m) => !!getTokenId(m))
    .sort((a, b) =>
      parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0")
    )
    .slice(0, 4);

  const marketKey = top4.map((m) => getTokenId(m) ?? m.conditionId).join(",");

  useEffect(() => {
    if (top4.length === 0) { setLoading(false); return; }
    setLoading(true);
    setHoverX(null);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;
    Promise.all(
      top4.map((m, idx) =>
        fetch(`/api/prices?token_id=${encodeURIComponent(getTokenId(m)!)}&interval=${iv}&fidelity=${fidelity}`)
          .then((r) => r.json())
          .then((d) => ({
            name:  outcomeLabel(m),
            color: OUTCOME_COLORS[idx],
            pts:   (d.history ?? []).filter((p: any) => typeof p.p === "number" && p.p > 0) as Array<{ t: number; p: number }>,
          }))
          .catch(() => ({ name: outcomeLabel(m), color: OUTCOME_COLORS[idx], pts: [] as Array<{ t: number; p: number }> })),
      ),
    )
      .then((results) => setLines(results.filter((r) => r.pts.length >= 2)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv, marketKey]);

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
          {(lines.length > 0 ? lines : top4.slice(0, 4).map((m, i) => ({ name: outcomeLabel(m), color: OUTCOME_COLORS[i], pts: [] as ChartSeries["pts"] }))).map((l, i) => {
            const liveP = l.pts[l.pts.length - 1]?.p ?? 0;
            const dispP = (inPlot && hoverT) ? lerp(l.pts, hoverT) : liveP;
            return (
              <div key={i} className="flex items-center gap-1.5 flex-shrink-0">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: l.color }} />
                <span className="text-[11px] text-text/70 truncate max-w-[160px]">{l.name}</span>
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
              const ds     = downsample(line.pts);
              const svgPts = ds.map((p) => ({ x: toX(p.t), y: toY(p.p) }));
              const path   = smoothPath(svgPts);
              const last   = svgPts[svgPts.length - 1];
              return (
                <g key={i}>
                  <path d={path} fill="none" stroke={line.color}
                    strokeWidth={i === 0 ? "2" : "1.5"} strokeLinejoin="round" strokeLinecap="round"
                    opacity={i === 0 ? 1 : 0.85} />
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
  const [activeTab, setActiveTab] = useState<"order" | "positions">("order");
  const [claimLoading, setClaimLoading] = useState(false);
  const [historicalMarketIds, setHistoricalMarketIds] = useState<`0x${string}`[]>([]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  // ── Pre-warm batch for selected market ──────────────────────────────────────
  useEffect(() => {
    if (!selectedMarket) return;
    const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayerUrl) return;
    fetch(`${relayerUrl}/warm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: selectedMarket.conditionId }),
    }).catch(() => {});
  }, [selectedMarket?.conditionId]);

  // ── Batch state polling for selected market ──────────────────────────────────
  useEffect(() => {
    if (!selectedMarket) return;
    const marketId = selectedMarket.conditionId as `0x${string}`;
    let cancelled  = false;

    const fetchBatch = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const batchId   = await publicClient.readContract({
          address: contracts.batchVault,
          abi:     BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args:    [marketId],
        }) as bigint;
        if (batchId === 0n || cancelled) return;
        const b = await publicClient.readContract({
          address: contracts.batchVault,
          abi:     BATCH_VAULT_ABI,
          functionName: "getBatch",
          args:    [batchId],
        }) as { marketId: `0x${string}`; openedAt: bigint; closedAt: bigint; status: number; totalDeposited: bigint; clearingPrice: bigint; commitmentCount: bigint };
        if (!cancelled) {
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

    fetchBatch();
    const iv = setInterval(fetchBatch, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selectedMarket?.conditionId]);

  // Auto-switch to My Positions when the batch settles so the user sees the
  // claim button immediately without having to refresh or click a tab.
  useEffect(() => {
    if (batch.status === BatchStatus.SETTLED && isConnected) {
      setActiveTab("positions");
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

  // ── Chain switching ──────────────────────────────────────────────────────────
  const ensureAmoy = async () => {
    if (!walletAddress) throw new Error("Wallet not connected");
    const { provider, name } = await findBestProvider();
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ACTIVE_CHAIN_ID_HEX }] });
    } catch (err: any) {
      if (err.code === 4902) {
        const addParams = IS_MAINNET
          ? { chainId: ACTIVE_CHAIN_ID_HEX, chainName: "Polygon", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: ["https://polygon-rpc.com/"], blockExplorerUrls: ["https://polygonscan.com/"] }
          : { chainId: ACTIVE_CHAIN_ID_HEX, chainName: "Polygon Amoy", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: ["https://rpc-amoy.polygon.technology/"], blockExplorerUrls: ["https://amoy.polygonscan.com/"] };
        await provider.request({ method: "wallet_addEthereumChain", params: [addParams] });
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ACTIVE_CHAIN_ID_HEX }] });
      } else if (err.code === 4001) {
        throw new Error(`Network switch cancelled — please approve switching to ${ACTIVE_CHAIN_NAME}.`);
      } else {
        throw new Error(`${name} declined the network switch. Please manually switch to ${ACTIVE_CHAIN_NAME} (Chain ID ${ACTIVE_CHAIN.id}).`);
      }
    }
    let onTarget = false;
    for (let i = 0; i < 15; i++) {
      const cid = await provider.request({ method: "eth_chainId" });
      if ((cid as string).toLowerCase() === ACTIVE_CHAIN_ID_HEX) { onTarget = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!onTarget) throw new Error(`Still on wrong network. Please switch to ${ACTIVE_CHAIN_NAME} in your wallet.`);
    return createWalletClient({ account: walletAddress, chain: ACTIVE_CHAIN, transport: custom(provider) });
  };

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
        commitment: string; salt: string; isBuy: boolean;
        amount: string; limitPrice: string; batchId: string;
        marketId: string;
      }> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      const myOrder = storedOrders.find((o) => o.batchId === batchId.toString());
      if (!myOrder) throw new Error("Order preimage not found in local storage — cannot claim");
      if (!myOrder.marketId) throw new Error("Order is missing marketId — cannot claim");

      const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

      // POST order preimage + desired recipient to relayer.
      // Relayer generates ZK proof and submits claimWithProof on-chain (relayer = msg.sender).
      const resp = await fetch(`${relayerUrl}/claim-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId:    batchId.toString(),
          marketId:   myOrder.marketId,
          isBuy:      myOrder.isBuy,
          amount:     myOrder.amount,
          limitPrice: myOrder.limitPrice,
          salt:       myOrder.salt,
          recipient:  walletAddress,   // payout goes to connected wallet
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? `Claim request failed (${resp.status})`);
      }

      const { txHash } = await resp.json();

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      if (receipt.status === "reverted") {
        throw new Error("Claim transaction reverted — the batch may not be fully settled yet. Try again in a few seconds.");
      }
      setBalanceVersion(v => v + 1);
    } catch (e: any) {
      if (e?.code !== 4001) setChainError(e.message ?? "Claim failed");
      throw e;
    } finally {
      setClaimLoading(false);
    }
  };

  // ── Submit order (ephemeral wallet privacy pattern) ───────────────────────────
  // BUY: ephemeral keypair → fund → sign all 3 sigs in-browser → no settlement leak
  // SELL: unchanged — YES tokens must come from real wallet
  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`; amount: bigint; salt: `0x${string}`; isBuy: boolean; limitPrice: bigint;
  }) => {
    if (!selectedMarket) return;
    setChainError(null);
    const contracts = getContracts(ACTIVE_CHAIN.id);
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 600);

    setSubmitStep("approving");
    const walletClient = await ensureAmoy();

    if (params.isBuy) {
      // ── BUY: ephemeral wallet pattern ──────────────────────────────────────
      const ephemeralPrivateKey = generatePrivateKey();
      const ephemeralAccount    = privateKeyToAccount(ephemeralPrivateKey);
      const ephemeralAddress    = ephemeralAccount.address;

      // Fund ephemeral with USDC from real wallet (1 MetaMask tx)
      const fundTx = await walletClient.writeContract({
        address: contracts.usdc, abi: ERC20_ABI, functionName: "transfer",
        args: [ephemeralAddress, params.amount], ...CHAIN_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: fundTx });

      const ephemeralWalletClient = createWalletClient({
        account: ephemeralAccount, chain: ACTIVE_CHAIN, transport: http(),
      });

      const actualCommitment = computeCommitment({
        // Use the actual Polymarket conditionId — this is what the contract uses
        // in _verifyCommitments at settlement. Using batch.batchMarketId was wrong
        // when batch.batchId === 0n (MOCK_BATCH has bytes32(0) as marketId).
        marketId:   selectedMarket.conditionId as `0x${string}`,
        isBuy:      true,
        amount:     params.amount,
        limitPrice: params.limitPrice,
        salt:       params.salt,
      });

      const ephemeralNonce = await publicClient.readContract({
        address: contracts.batchVault, abi: BATCH_VAULT_ABI, functionName: "nonces",
        args: [ephemeralAddress],
      }) as bigint;

      setSubmitStep("signing");

      const signature = await ephemeralWalletClient.signTypedData({
        account: ephemeralAccount,
        domain: { name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault },
        types: { CommitOrder: [
          { name: "commitment", type: "bytes32" }, { name: "amount",  type: "uint256" },
          { name: "batchId",    type: "uint256" }, { name: "nonce",   type: "uint256" },
          { name: "deadline",   type: "uint256" },
        ]},
        primaryType: "CommitOrder",
        message: { commitment: actualCommitment, amount: params.amount, batchId: batch.batchId, nonce: ephemeralNonce, deadline },
      });

      const nonceBytes = new Uint8Array(32);
      crypto.getRandomValues(nonceBytes);
      const transferNonce = ("0x" + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
      const validAfter  = 0n;
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 7200);

      const transferSig = await ephemeralWalletClient.signTypedData({
        account: ephemeralAccount,
        domain: { name: "USD Coin (Test)", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.usdc },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" }, { name: "to",          type: "address" },
            { name: "value", type: "uint256"}, { name: "validAfter",  type: "uint256" },
            { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: ephemeralAddress, to: contracts.batchVault, value: params.amount, validAfter, validBefore, nonce: transferNonce },
      });

      const r = transferSig.slice(0, 66) as `0x${string}`;
      const s = ("0x" + transferSig.slice(66, 130)) as `0x${string}`;
      const v = parseInt(transferSig.slice(130, 132), 16);
      const transferAuth = { from: ephemeralAddress, validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce: transferNonce, v, r, s };

      const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");
      const resp = await fetch(`${relayerUrl}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId:   selectedMarket.conditionId,
          batchId:    batch.batchId.toString(),
          signer:     ephemeralAddress,
          isBuy: true, isSell: false,
          amount:     params.amount.toString(),
          limitPrice: params.limitPrice.toString(),
          salt:       params.salt,
          commitment: actualCommitment,
          signature,
          nonce:      ephemeralNonce.toString(),
          deadline:   deadline.toString(),
          transferAuth,
        }),
      });
      const relayerData = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(relayerData.error ?? `Relayer returned ${resp.status}`);
      }
      // Use the actual batchId returned by the relayer — it may differ from
      // batch.batchId if the batch was just opened on-demand for this market.
      const actualBatchId: string = relayerData.batchId ?? batch.batchId.toString();

      if (walletAddress) {
        setCommitments((prev) => [...prev, { hash: actualCommitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() }]);
        setBatch((prev) => ({ ...prev, commitmentCount: prev.commitmentCount + 1, totalDeposited: prev.totalDeposited + params.amount }));
        try {
          const key = `predacy:orders:${walletAddress.toLowerCase()}`;
          const existing: unknown[] = JSON.parse(localStorage.getItem(key) ?? "[]");
          // Persist order preimage for ZK claim proof at claim time.
          // ephemeralKey stored for USDC recovery: if settlement ever fails, import it
          // into MetaMask (Account → Import account → Private key) to sweep USDC back.
          existing.unshift({
            commitment:      actualCommitment,
            salt:            params.salt,
            amount:          params.amount.toString(),
            isBuy:           true,
            limitPrice:      params.limitPrice.toString(),
            batchId:         actualBatchId,
            marketId:        selectedMarket.conditionId,
            marketQuestion:  selectedMarket.question ?? null,
            timestamp:       Date.now(),
            ephemeralKey:    ephemeralPrivateKey,   // recovery: import into MetaMask if stuck
            ephemeralAddress: ephemeralAddress,
          });
          localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
        } catch { /* ignore */ }
      }
      setOrderSealed(true);
      setActiveTab("positions");
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

    const signature = await walletClient.signTypedData({
      account: walletAddress!,
      domain: { name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault },
      types: { CommitOrder: [
        { name: "commitment", type: "bytes32" }, { name: "amount",  type: "uint256" },
        { name: "batchId",    type: "uint256" }, { name: "nonce",   type: "uint256" },
        { name: "deadline",   type: "uint256" },
      ]},
      primaryType: "CommitOrder",
      message: { commitment: params.commitment, amount: params.amount, batchId: batch.batchId, nonce, deadline },
    });

    const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");
    const resp = await fetch(`${relayerUrl}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId:   selectedMarket.conditionId,
        batchId:    batch.batchId.toString(),
        signer:     walletAddress,
        isBuy: false, isSell: true,
        amount:     params.amount.toString(),
        limitPrice: params.limitPrice.toString(),
        salt:       params.salt,
        commitment: params.commitment,
        signature,
        nonce:      nonce.toString(),
        deadline:   deadline.toString(),
        transferAuth: undefined,
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
          commitment:     params.commitment,
          salt:           params.salt,
          amount:         params.amount.toString(),
          isBuy:          false,
          limitPrice:     params.limitPrice.toString(),
          batchId:        batch.batchId.toString(),
          marketId:       selectedMarket.conditionId,
          marketQuestion: selectedMarket.question ?? null,
          timestamp:      Date.now(),
        });
        localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
      } catch { /* ignore */ }
    }
    setOrderSealed(true);
    setActiveTab("positions");
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
  const selBarColor = selYesProb > 60 ? "#00FFB3" : selYesProb < 20 ? "#FF3355" : "#4D83FF";

  return (
    <div className="min-h-screen flex flex-col">

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

      {/* Event title */}
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
      </div>

      {/* Chain error */}
      {chainError && (
        <div className="mx-6 mt-3 px-3 py-2 border border-danger/30 bg-danger/5 text-[11px] text-danger">
          {chainError}
          <button onClick={() => setChainError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Two-column: outcome list | trading panel */}
      <div className="flex flex-1 min-h-0 divide-x divide-border">

        {/* ── Left column: compact chart + scrollable outcome list ──────── */}
        <div className="flex-1 flex flex-col min-h-0">

          {/* Chart pinned at top of left column */}
          <MultiOutcomeChart markets={event.markets} />

          {/* Outcome list scrolls below */}
          <div className="flex-1 overflow-y-auto">
          {/* Subheader */}
          <div className="px-5 py-3 border-b border-border">
            <span className="text-[10px] text-muted tracking-widest uppercase">
              {sorted.length} Outcomes · select to trade
            </span>
          </div>

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
                    "flex items-center gap-3 px-5 py-3 cursor-crosshair transition-colors group",
                    sel ? "bg-white/[0.04]" : "hover:bg-white/[0.02]",
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
        </div>{/* end scroll area */}
        </div>{/* end left column */}

        {/* ── Trading panel ────────────────────────────────────────────────── */}
        <div className="w-[340px] xl:w-[380px] flex-shrink-0 flex flex-col overflow-y-auto">

          {selectedMarket ? (
            <>
              {/* Selected outcome header */}
              <div className="px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: selBarColor }} />
                  <span className="text-xs text-muted tracking-widest uppercase">{event.title}</span>
                </div>
                <p className="text-sm font-bold text-text leading-snug">{outcomeLabel(selectedMarket)}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-2xl font-black" style={{ fontFamily: "var(--font-display)", color: selBarColor }}>
                    {fmtPct(selYesPrice)}
                  </span>
                  <span className="text-[10px] text-muted tracking-widest uppercase">chance</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono" style={{ borderColor: "#00FFB340", color: "#00FFB3", background: "#00FFB308" }}>
                      YES {fmtCents(selYesPrice)}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono"
                      style={{ borderColor: "#FF335540", color: "#FF3355", background: "#FF335508" }}>
                      NO {fmtCents(selNoPrice)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Batch timer */}
              <div className="border-b border-border px-4 py-3 flex justify-center">
                <BatchTimer
                  openedAt={batch.openedAt}
                  batchWindow={batch.batchWindow}
                  commitmentCount={batch.commitmentCount}
                  totalDeposited={batch.totalDeposited}
                  batchId={batch.batchId}
                  status={batch.status}
                  clearingPrice={batch.clearingPrice}
                />
              </div>

              {/* Order / My Positions tab bar */}
              <div className="border-b border-border px-4 flex items-center">
                <button
                  type="button"
                  onClick={() => { setActiveTab("order"); setOrderSealed(false); }}
                  className={clsx(
                    "px-3 py-3 text-[10px] tracking-widest uppercase transition-colors border-b-2",
                    activeTab === "order"
                      ? "border-text/40 text-text"
                      : "border-transparent text-muted hover:text-text"
                  )}
                >
                  Order
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("positions")}
                  className={clsx(
                    "px-3 py-3 text-[10px] tracking-widest uppercase transition-colors border-b-2",
                    activeTab === "positions"
                      ? "border-text/40 text-text"
                      : "border-transparent text-muted hover:text-text"
                  )}
                >
                  My Positions
                </button>
              </div>

              {/* Tab content */}
              {activeTab === "positions" ? (
                isConnected && walletAddress ? (
                  <PositionsPanel
                    walletAddress={walletAddress}
                    currentBatchId={batch.batchId}
                    currentBatchStatus={batch.status}
                    currentBatchCommitments={commitments
                      .filter((c) => c.trader === walletAddress)
                      .map((c) => ({ hash: c.hash, amount: c.amount }))}
                    onClaim={handleClaimPosition}
                    onMarketIdsFound={setHistoricalMarketIds}
                  />
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
                          onClick={() => setActiveTab("positions")}
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
                          setSubmitStep(null);
                          try { await handleOrderSubmit(p); }
                          catch (e: any) {
                            if (e?.code !== 4001) setChainError(e.message ?? "Order failed");
                          } finally { setSubmitStep(null); }
                        }}
                        walletAddress={walletAddress}
                        isConnected={isConnected}
                        onConnect={login}
                        submitStep={submitStep}
                        balanceVersion={balanceVersion}
                        candidateMarketIds={[selectedMarket.conditionId as `0x${string}`, ...historicalMarketIds]}
                      />
                    </div>
                  )}
                </>
              )}
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

    </div>
  );
}
