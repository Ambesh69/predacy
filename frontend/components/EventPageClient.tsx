"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import {
  createPublicClient, createWalletClient, custom, http, parseAbiItem,
} from "viem";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import WalletButton from "@/components/WalletButton";
import BatchTimer from "@/components/BatchTimer";
import OrderForm from "@/components/OrderForm";
import type { Market } from "@/lib/polymarket";
import {
  BATCH_VAULT_ABI, CTF_ABI, ERC20_ABI, MOCK_USDC_ABI,
  BatchStatus, getContracts,
} from "@/lib/contracts";
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
function outcomeLabel(m: Market): string {
  if (m.groupItemTitle) return m.groupItemTitle;
  return m.question
    .replace(/^Will\s+/i, "")
    .replace(/\s+as\s+the\s+next\s+.*\?$/i, "?")
    .replace(/\s+win\s+.*\?$/i, "?")
    .replace(/\s+become\s+.*\?$/i, "?");
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

// ── Multi-outcome chart (improved: auto-scale Y, real date x-axis) ───────────
const OUTCOME_COLORS = ["#00FFB3", "#4D83FF", "#FFB800", "#FF6B35"];

const W   = 600;
const H   = 130;
const PAD = { t: 10, r: 52, b: 24, l: 40 };
const CW  = W - PAD.l - PAD.r;
const CH  = H - PAD.t - PAD.b;

type Interval = "6h" | "1d" | "1w" | "max";
const INTERVALS: { label: string; value: Interval; fidelity: number }[] = [
  { label: "6H",  value: "6h",  fidelity: 10   },
  { label: "1D",  value: "1d",  fidelity: 60   },
  { label: "1W",  value: "1w",  fidelity: 240  },
  { label: "ALL", value: "max", fidelity: 1440 },
];

interface ChartLine { name: string; color: string; pts: Array<{ t: number; p: number }>; }

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
function downsample(pts: Array<{ t: number; p: number }>, max = 150) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}
function fmtXLabel(ts: number, iv: Interval): string {
  const d = new Date(ts * 1000);
  if (iv === "6h" || iv === "1d") return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function MultiOutcomeChart({ markets }: { markets: Market[] }) {
  const [iv, setIv]           = useState<Interval>("1d");
  const [lines, setLines]     = useState<ChartLine[]>([]);
  const [loading, setLoading] = useState(true);

  const top4 = [...markets]
    .sort((a, b) => (b.volumeNum ?? parseFloat(b.volume ?? "0")) - (a.volumeNum ?? parseFloat(a.volume ?? "0")))
    .filter((m) => !!getTokenId(m))
    .slice(0, 4);

  const marketKey = top4.map((m) => getTokenId(m) ?? m.conditionId).join(",");

  useEffect(() => {
    if (top4.length === 0) { setLoading(false); return; }
    setLoading(true);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;
    Promise.all(
      top4.map((m, idx) =>
        fetch(`/api/prices?token_id=${encodeURIComponent(getTokenId(m)!)}&interval=${iv}&fidelity=${fidelity}`)
          .then((r) => r.json())
          .then((d) => ({
            name:  outcomeLabel(m),
            color: OUTCOME_COLORS[idx],
            pts:   (d.history ?? []).filter((p: any) => typeof p.p === "number" && p.p > 0),
          }))
          .catch(() => ({ name: outcomeLabel(m), color: OUTCOME_COLORS[idx], pts: [] })),
      ),
    )
      .then((results) => setLines(results.filter((r) => r.pts.length >= 2)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv, marketKey]);

  const hasData = lines.some((l) => l.pts.length >= 2);

  // ── Auto-scale Y to actual price range ──────────────────────────────────────
  const allPrices = lines.flatMap((l) => l.pts.map((p) => p.p));
  const rawMin    = hasData ? Math.min(...allPrices) : 0;
  const rawMax    = hasData ? Math.max(...allPrices) : 1;
  const pad       = Math.max((rawMax - rawMin) * 0.12, 0.04);
  const chartMin  = Math.max(0, rawMin - pad);
  const chartMax  = Math.min(1, rawMax + pad);
  const chartRange = chartMax - chartMin || 1;

  const allT  = lines.flatMap((l) => l.pts.map((p) => p.t));
  const minT  = hasData ? Math.min(...allT) : 0;
  const maxT  = hasData ? Math.max(...allT) : 1;
  const timeRange = maxT - minT || 1;

  const toX = (t: number)  => PAD.l + ((t - minT) / timeRange) * CW;
  const toY = (p: number)  => PAD.t + (1 - (Math.max(chartMin, Math.min(chartMax, p)) - chartMin) / chartRange) * CH;

  // Y-axis grid lines at nice rounded values
  const ySteps = 5;
  const yGrid: number[] = [];
  for (let i = 0; i <= ySteps; i++) {
    const v = chartMin + (i / ySteps) * chartRange;
    yGrid.push(Math.round(v * 100) / 100);
  }
  // X-axis ticks at 4 positions
  const xTicks = [0.2, 0.4, 0.6, 0.8].map((f) => ({ t: minT + f * timeRange, x: PAD.l + f * CW }));

  const MUTED = "#42425A";
  const MONO  = "var(--font-mono)";

  return (
    <div className="border-b border-border">
      {/* Legend + interval selector */}
      <div className="flex items-center justify-between px-4 py-2.5 gap-2">
        <div className="flex items-center gap-4 flex-wrap min-w-0">
          {(hasData ? lines : top4.slice(0, 4).map((m, i) => ({ name: outcomeLabel(m), color: OUTCOME_COLORS[i] }))).map(
            (l, i) => (
              <div key={i} className="flex items-center gap-1.5 min-w-0">
                <div className="w-4 h-px flex-shrink-0" style={{ backgroundColor: l.color }} />
                <span className="text-[10px] tracking-widest uppercase truncate max-w-[100px]" style={{ color: l.color }}>
                  {l.name}
                </span>
              </div>
            ),
          )}
          {loading && <div className="w-2.5 h-2.5 border border-muted/40 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {INTERVALS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setIv(value)}
              className={clsx(
                "text-[10px] px-1.5 py-0.5 tracking-widest transition-colors",
                iv === value ? "text-accent border border-accent/30 bg-accent/5" : "text-muted-dim hover:text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* SVG */}
      <div className="px-2 pb-2">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
          {/* Y-axis grid + labels */}
          {yGrid.map((v) => {
            const y = toY(v);
            return (
              <g key={v}>
                <line x1={PAD.l} y1={y.toFixed(1)} x2={W - PAD.r} y2={y.toFixed(1)} stroke="#13131F" strokeWidth="1" />
                <text x={(PAD.l - 6).toFixed(1)} y={(y + 3.5).toFixed(1)} fill={MUTED} fontSize="8" fontFamily={MONO} textAnchor="end">
                  {Math.round(v * 100)}%
                </text>
              </g>
            );
          })}

          {/* No data */}
          {!hasData && !loading && (
            <text x={(W / 2).toFixed(1)} y={(H / 2 + 4).toFixed(1)} fill={MUTED} fontSize="10" fontFamily={MONO} textAnchor="middle">
              NO PRICE HISTORY
            </text>
          )}

          {/* Price lines */}
          {lines.map((line, i) => {
            const ds     = downsample(line.pts);
            const svgPts = ds.map((d) => ({ x: toX(d.t), y: toY(d.p) }));
            const path   = smoothPath(svgPts);
            const lastPt = svgPts[svgPts.length - 1];
            const lastP  = ds[ds.length - 1]?.p ?? 0;

            return (
              <g key={i}>
                <path d={path} fill="none" stroke={line.color}
                  strokeWidth={i === 0 ? "2" : "1.5"} strokeLinejoin="round" strokeLinecap="round"
                  strokeOpacity={i === 0 ? 1 : 0.8} />
                {lastPt && (
                  <>
                    <line x1={lastPt.x.toFixed(1)} y1={lastPt.y.toFixed(1)}
                      x2={(W - PAD.r + 4).toFixed(1)} y2={lastPt.y.toFixed(1)}
                      stroke={line.color} strokeWidth="0.75" strokeDasharray="2,3" strokeOpacity="0.5" />
                    <circle cx={lastPt.x.toFixed(1)} cy={lastPt.y.toFixed(1)} r="2.5" fill={line.color} />
                    <text x={(W - PAD.r + 8).toFixed(1)} y={(lastPt.y + 4).toFixed(1)} fill={line.color} fontSize="11" fontFamily={MONO}>
                      {Math.round(lastP * 100)}%
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* X-axis ticks */}
          {hasData && xTicks.map(({ t, x }, i) => (
            <text key={i} x={x.toFixed(1)} y={(H - 5).toFixed(1)} fill={MUTED} fontSize="8" fontFamily={MONO} textAnchor="middle">
              {fmtXLabel(t, iv)}
            </text>
          ))}
        </svg>
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
    hash: `0x${string}`; amount: bigint; trader: `0x${string}`; timestamp: number;
  }>>([]);
  const [submitStep, setSubmitStep] = useState<"approving" | "signing" | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [orderSealed, setOrderSealed] = useState(false);

  // ── Wallet ───────────────────────────────────────────────────────────────────
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet        = wallets[0];
  const walletAddress = wallet?.address as `0x${string}` | undefined;
  const isConnected   = authenticated && !!walletAddress;

  // ── Load event ───────────────────────────────────────────────────────────────
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
      .finally(() => setEventLoading(false));
  }, [id]);

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

  // ── Submit order ─────────────────────────────────────────────────────────────
  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`; amount: bigint; salt: `0x${string}`; isBuy: boolean; limitPrice: bigint;
  }) => {
    if (!selectedMarket) return;
    setChainError(null);
    const contracts = getContracts(ACTIVE_CHAIN.id);

    setSubmitStep("approving");
    const walletClient = await ensureAmoy();

    if (params.isBuy) {
      const allowance = await publicClient.readContract({
        address: contracts.usdc, abi: ERC20_ABI, functionName: "allowance",
        args: [walletAddress!, contracts.batchVault],
      }) as bigint;
      if (allowance < params.amount) {
        const tx = await walletClient.writeContract({
          address: contracts.usdc, abi: ERC20_ABI, functionName: "approve",
          args: [contracts.batchVault, params.amount], ...CHAIN_GAS,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
      }
    } else {
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
    }

    const nonce = await publicClient.readContract({
      address: contracts.batchVault, abi: BATCH_VAULT_ABI, functionName: "nonces",
      args: [walletAddress!],
    }) as bigint;

    setSubmitStep("signing");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const signature = await walletClient.signTypedData({
      account: walletAddress!,
      domain: { name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault },
      types: { CommitOrder: [
        { name: "commitment", type: "bytes32" }, { name: "amount",     type: "uint256" },
        { name: "batchId",    type: "uint256" }, { name: "nonce",      type: "uint256" },
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
        signer:     walletAddress, isBuy: params.isBuy, isSell: !params.isBuy,
        amount:     params.amount.toString(), limitPrice: params.limitPrice.toString(),
        salt:       params.salt, commitment: params.commitment, signature,
        nonce:      nonce.toString(), deadline: deadline.toString(),
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Relayer error" }));
      throw new Error(err.error ?? `Relayer returned ${resp.status}`);
    }
    if (walletAddress) {
      setCommitments((prev) => [...prev, { hash: params.commitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() }]);
      setBatch((prev) => ({
        ...prev,
        commitmentCount: prev.commitmentCount + 1,
        totalDeposited: params.isBuy ? prev.totalDeposited + params.amount : prev.totalDeposited,
      }));
    }
    setOrderSealed(true);
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

  const sorted  = [...event.markets].sort(
    (a, b) => (b.volumeNum ?? parseFloat(b.volume ?? "0")) - (a.volumeNum ?? parseFloat(a.volume ?? "0")),
  );
  const volume  = event.volumeNum ?? parseFloat(event.volume ?? "0");
  const selYesPrice = selectedMarket ? parseFloat(selectedMarket.outcomePrices?.[0] ?? "0") : 0;
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
          <div className="px-5 py-2.5 border-b border-border">
            <span className="text-[10px] text-muted tracking-widest uppercase">
              {event.markets.length} Outcomes · select to trade
            </span>
          </div>

          <div className="divide-y divide-border/40">
            {sorted.map((market, idx) => {
              const yp   = parseFloat(market.outcomePrices?.[0] ?? "0");
              const np   = parseFloat(market.outcomePrices?.[1] ?? "0");
              const prob = Math.round(yp * 100);
              const bar  = prob > 60 ? "#00FFB3" : prob < 20 ? "#FF3355" : "#4D83FF";
              const sel  = selectedMarket?.conditionId === market.conditionId;
              const label = outcomeLabel(market);

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
                      {formatVolume(market.volumeNum ?? market.volume ?? 0)} vol
                    </span>
                  </div>

                  {/* Prob bar */}
                  <div className="w-20 h-[2px] bg-border rounded-full overflow-hidden flex-shrink-0 hidden sm:block">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(prob, 1)}%`, background: bar }} />
                  </div>

                  {/* Prob % */}
                  <span className="text-sm font-black tabular-nums w-9 text-right flex-shrink-0" style={{ fontFamily: "var(--font-display)", color: bar }}>
                    {prob}%
                  </span>

                  {/* YES / NO chips */}
                  <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums"
                      style={{ borderColor: "#00FFB330", color: "#00FFB3", background: "#00FFB305" }}>
                      {Math.round(yp * 100)}¢
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums"
                      style={{ borderColor: "#FF335530", color: "#FF3355", background: "#FF335505" }}>
                      {Math.round(np * 100)}¢
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
                    {selYesProb}%
                  </span>
                  <span className="text-[10px] text-muted tracking-widest uppercase">chance</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono" style={{ borderColor: "#00FFB340", color: "#00FFB3", background: "#00FFB308" }}>
                      YES {Math.round(selYesPrice * 100)}¢
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono"
                      style={{ borderColor: "#FF335540", color: "#FF3355", background: "#FF335508" }}>
                      NO {Math.round((1 - selYesPrice) * 100)}¢
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

              {/* Order form */}
              {!orderSealed && (
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
                    candidateMarketIds={[selectedMarket.conditionId as `0x${string}`]}
                  />
                </div>
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
