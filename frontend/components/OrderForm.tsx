"use client";

import { useState, useEffect, useCallback } from "react";
import { createPublicClient, http, encodePacked, keccak256 } from "viem";
import { clsx } from "clsx";
import { computeCommitment, generateSalt } from "@/lib/commitmentHash";
import { getErrorMessage } from "@/lib/validation";
import { getContracts, CTF_ABI } from "@/lib/contracts";
import { ACTIVE_CHAIN } from "@/lib/chain";
import type { Market } from "@/lib/polymarket";

// Module-level read-only client (same pattern as MarketPageClient)
const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(),
});

interface OrderFormProps {
  market: Market;
  marketId: `0x${string}`;
  batchOpen: boolean;
  onSubmit: (params: {
    commitment: `0x${string}`;
    amount: bigint;
    salt: `0x${string}`;
    isBuy: boolean;
    limitPrice: bigint;
  }) => Promise<void>;
  walletAddress?: `0x${string}`;
  isConnected: boolean;
  onConnect: () => void;
  submitStep?: "approving" | "signing" | null;
  balanceVersion?: number;     // bumped by parent after a successful claim
  candidateMarketIds?: `0x${string}`[];  // all market IDs from batch history to check balance against
}

const PRICE_STEP = 10_000;
const MARKET_BUY_LIMIT  = 2n ** 256n - 1n;
const MARKET_SELL_LIMIT = 0n;

/** Compute the YES token ID for a given market (mirrors BatchVault._getYesTokenId).
 *  Must use encodePacked to match Solidity abi.encodePacked — address stays 20 bytes,
 *  not padded to 32 like standard ABI encoding would do. */
function computeYesTokenId(usdcAddress: `0x${string}`, conditionId: `0x${string}`): bigint {
  // mirrors MockCTF.getCollectionId(bytes32(0), conditionId, 2)
  const parentCollectionId = ("0x" + "00".repeat(32)) as `0x${string}`;
  const collectionId = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint256"],
      [parentCollectionId, conditionId, 2n]
    )
  );
  // mirrors MockCTF.getPositionId(usdc, collectionId) — address is 20 bytes packed
  const positionId = keccak256(
    encodePacked(
      ["address", "bytes32"],
      [usdcAddress, collectionId]
    )
  );
  return BigInt(positionId);
}

export default function OrderForm({
  market,
  marketId,
  batchOpen,
  onSubmit,
  walletAddress,
  isConnected,
  onConnect,
  submitStep,
  balanceVersion = 0,
  candidateMarketIds = [],
}: OrderFormProps) {
  const [mode, setMode]           = useState<"buy" | "sell">("buy");
  const [isBuy, setIsBuy]         = useState(true);   // YES vs NO within buy mode
  const [sellYes, setSellYes]     = useState(true);   // YES vs NO within sell mode
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [amountDisplay, setAmountDisplay] = useState("100");
  const [limitPrice, setLimitPrice] = useState(
    Math.round(parseFloat(market.outcomePrices[0]) * 1_000_000)
  );
  const [salt] = useState<`0x${string}`>(() => generateSalt());
  const [commitment, setCommitment] = useState<`0x${string}`>(("0x" + "0".repeat(64)) as `0x${string}`);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // YES balance for sell mode
  const [yesBalance, setYesBalance] = useState<bigint | null>(null);
  const [yesBalanceLoading, setYesBalanceLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);  // manual ↻ button

  const effectiveLimitPrice = mode === "sell"
    ? (orderType === "market" ? MARKET_SELL_LIMIT : BigInt(limitPrice))
    : (orderType === "market" ? (isBuy ? MARKET_BUY_LIMIT : MARKET_SELL_LIMIT) : BigInt(limitPrice));

  const updateCommitment = useCallback(() => {
    if (!walletAddress) return;
    try {
      const amountParsed = BigInt(Math.round(parseFloat(amountDisplay || "0") * 1_000_000));
      if (amountParsed === 0n) return;
      const effLP = mode === "sell"
        ? (orderType === "market" ? MARKET_SELL_LIMIT : BigInt(limitPrice))
        : (orderType === "market"
          ? (isBuy ? MARKET_BUY_LIMIT : MARKET_SELL_LIMIT)
          : BigInt(limitPrice));
      const isOrderBuy = mode === "buy" ? isBuy : false; // sell mode always isBuy=false
      setCommitment(computeCommitment({ marketId, isBuy: isOrderBuy, amount: amountParsed, limitPrice: effLP, salt, trader: walletAddress }));
    } catch { /* ignore parse errors while typing */ }
  }, [walletAddress, amountDisplay, isBuy, limitPrice, orderType, marketId, salt, mode]);

  useEffect(() => { updateCommitment(); }, [updateCommitment]);

  // Fetch YES balance when switching to sell mode.
  // Checks ALL candidate market IDs (current batch + historical batches) because the
  // batch.batchMarketId can differ from where the user's tokens were originally minted.
  // Sums balances across all distinct conditionIds so nothing is missed.
  useEffect(() => {
    if (mode !== "sell" || !walletAddress || !sellYes) {
      if (!sellYes) setYesBalance(null);
      return;
    }
    setYesBalanceLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        // Collect all unique conditionIds to check: URL market + batch + history
        const allIds = [...new Set([
          market.conditionId as `0x${string}`,
          marketId,
          ...candidateMarketIds,
        ])];
        let total = 0n;
        for (const condId of allIds) {
          const yesTokenId = computeYesTokenId(contracts.usdc, condId);
          const bal = await publicClient.readContract({
            address: contracts.ctf,
            abi: CTF_ABI,
            functionName: "balanceOf",
            args: [walletAddress, yesTokenId],
          }) as bigint;
          total += bal;
        }
        if (!cancelled) setYesBalance(total);
      } catch (err) {
        console.error("[OrderForm] Failed to fetch YES balance:", err);
        if (!cancelled) setYesBalance(0n);
      } finally {
        if (!cancelled) setYesBalanceLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, walletAddress, marketId, sellYes, balanceVersion, refreshTick, candidateMarketIds.join(",")]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected || !batchOpen) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const amount = BigInt(Math.round(parseFloat(amountDisplay) * 1_000_000));
      const isOrderBuy = mode === "buy" ? isBuy : false;
      await onSubmit({ commitment, amount, salt, isBuy: isOrderBuy, limitPrice: effectiveLimitPrice });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const yesPrice  = parseFloat(market.outcomePrices[0]);
  const noPrice   = parseFloat(market.outcomePrices[1] ?? (1 - yesPrice).toFixed(4));
  const pricePercent = (limitPrice / 10_000).toFixed(1);
  const priceDiff    = ((limitPrice / 1_000_000) - yesPrice) * 100;

  // ── Order summary derived values ────────────────────────────────────────────
  const amountNum = parseFloat(amountDisplay || "0") || 0;
  // Effective fill price for display (limit = slider, market = Polymarket mid)
  const fillPrice = orderType === "limit"
    ? limitPrice / 1_000_000
    : (mode === "sell" ? yesPrice : (isBuy ? yesPrice : noPrice));
  // Buy: how many YES/NO shares the USDC buys; Sell: USDC proceeds
  const sharesOut    = fillPrice > 0 && amountNum > 0 ? amountNum / fillPrice : 0;
  const toWin        = sharesOut;          // $1 per share at resolution
  const potentialPct = fillPrice > 0 ? (1 / fillPrice - 1) * 100 : 0;
  const receiveUSDC  = amountNum * fillPrice;

  const yesBalanceDisplay = yesBalance !== null
    ? (Number(yesBalance) / 1_000_000).toFixed(2)
    : null;

  // ── Sealed state ────────────────────────────────────────────────────────────
  if (submitted) {
    const isSellOrder = mode === "sell";
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
        <div className="relative">
          <div className="w-16 h-16 border border-accent/30 flex items-center justify-center">
            <svg className="w-8 h-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeWidth={1.5} d="M5 12l5 5L20 7" />
            </svg>
          </div>
          <div className="absolute -inset-2 border border-accent/10 animate-ping" style={{ animationDuration: "2s" }} />
        </div>
        <div className="text-center space-y-1">
          <p className="text-accent text-sm tracking-wide">ORDER SEALED</p>
          <p className="text-muted text-xs">Your commitment is locked in the batch.</p>
          <p className="text-muted text-xs">
            {isSellOrder
              ? "Sell order — YES tokens locked. USDC paid out at clearing price."
              : orderType === "market"
              ? "Market order — fills at the batch clearing price."
              : "Limit order — fills only if clearing price meets your limit."}
          </p>
        </div>
        <div className="w-full p-3 border border-border bg-surface/50 space-y-1">
          <p className="text-[10px] text-muted tracking-widest uppercase">commitment hash</p>
          <p className="hash-text text-[11px] break-all">{commitment}</p>
        </div>
        <p className="text-[11px] text-muted-dim text-center">
          Wait for batch settlement. Clearing price and positions will be revealed in aggregate only.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Top tabs: Buy | Sell ──────────────────────────────────────────── */}
      <div className="flex border-b border-border">
        <button
          type="button"
          onClick={() => setMode("buy")}
          className={clsx(
            "flex-1 py-3 text-xs tracking-widest uppercase font-medium transition-all duration-150 border-b-2",
            mode === "buy"
              ? "border-accent text-accent"
              : "border-transparent text-muted hover:text-text"
          )}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => setMode("sell")}
          className={clsx(
            "flex-1 py-3 text-xs tracking-widest uppercase font-medium transition-all duration-150 border-b-2 border-l border-border",
            mode === "sell"
              ? "border-danger text-danger"
              : "border-transparent text-muted hover:text-text"
          )}
        >
          Sell
        </button>
      </div>

      {/* ── YES / NO outcome toggle ───────────────────────────────────────── */}
      {mode === "buy" ? (
        <div className="grid grid-cols-2 gap-2 p-3 border-b border-border">
          <button
            type="button"
            onClick={() => setIsBuy(true)}
            className={clsx(
              "py-2.5 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              isBuy
                ? "bg-accent text-black"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            Yes <span className="tabular-nums opacity-80">{(yesPrice * 100).toFixed(1)}¢</span>
          </button>
          <button
            type="button"
            onClick={() => setIsBuy(false)}
            className={clsx(
              "py-2.5 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              !isBuy
                ? "bg-danger text-white"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            No <span className="tabular-nums opacity-80">{(noPrice * 100).toFixed(1)}¢</span>
          </button>
        </div>
      ) : (
        // Sell mode: only YES is supported in V1 (NO token selling is V2)
        <div className="grid grid-cols-2 gap-2 p-3 border-b border-border">
          <button
            type="button"
            onClick={() => setSellYes(true)}
            className={clsx(
              "py-2.5 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              sellYes
                ? "bg-danger/20 border border-danger/40 text-danger"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            Yes <span className="tabular-nums opacity-80">{(yesPrice * 100).toFixed(1)}¢</span>
          </button>
          <button
            type="button"
            disabled
            className="py-2.5 px-3 text-xs font-medium tracking-wide rounded-sm bg-surface/30 border border-border/40 text-muted/40 cursor-not-allowed"
          >
            No <span className="text-[10px] opacity-60">V2</span>
          </button>
        </div>
      )}

      {/* ── SELL MODE: native sell form ───────────────────────────────────── */}
      {mode === "sell" && (
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">

          {/* Order type toggle */}
          <div className="grid grid-cols-2 border-b border-border">
            <button type="button" onClick={() => setOrderType("market")}
              className={clsx("py-1.5 text-[10px] tracking-widest uppercase transition-colors",
                orderType === "market" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted")} >
              Market
            </button>
            <button type="button" onClick={() => setOrderType("limit")}
              className={clsx("py-1.5 text-[10px] tracking-widest uppercase transition-colors border-l border-border",
                orderType === "limit" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted")} >
              Limit
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* YES Token Amount */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-muted tracking-widest uppercase">YES Tokens to Sell</label>
                {isConnected && (
                  <span className="flex items-center gap-1 text-[10px] text-muted-dim tabular-nums">
                    {yesBalanceLoading
                      ? "loading…"
                      : yesBalanceDisplay !== null
                      ? `Balance: ${yesBalanceDisplay}`
                      : "Balance: —"}
                    <button
                      type="button"
                      onClick={() => setRefreshTick(t => t + 1)}
                      className="hover:text-muted transition-colors leading-none"
                      title="Refresh balance"
                    >↻</button>
                  </span>
                )}
              </div>
              <div className="flex items-center border border-border bg-surface focus-within:border-border-bright transition-colors">
                <input
                  type="number"
                  value={amountDisplay}
                  onChange={(e) => setAmountDisplay(e.target.value)}
                  className="flex-1 bg-transparent px-3 py-3 text-text text-sm tabular-nums focus:outline-none"
                  placeholder="0.00"
                  min="0"
                  step="any"
                />
                <span className="pr-3 text-muted text-[11px]">YES</span>
              </div>
              {/* Quick-fill from balance */}
              {yesBalance !== null && yesBalance > 0n && (
                <div className="flex gap-1">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        const amt = Number(yesBalance) * pct / 100 / 1_000_000;
                        setAmountDisplay(amt.toFixed(6).replace(/\.?0+$/, ""));
                      }}
                      className="flex-1 py-1 text-[10px] border border-border text-muted hover:border-border-bright hover:text-muted transition-colors"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── Sell order summary ── */}
            {amountNum > 0 && (
              <div className="border border-border divide-y divide-border/60 text-[11px]">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-muted uppercase tracking-wider text-[10px]">Avg price</span>
                  <span className="tabular-nums text-text">{(fillPrice * 100).toFixed(2)}¢</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-muted uppercase tracking-wider text-[10px]">You&apos;ll receive</span>
                  <span className="tabular-nums font-medium text-danger">${receiveUSDC.toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* Limit price (sell mode) */}
            {orderType === "limit" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-muted tracking-widest uppercase">Min Sell Price</label>
                  <span className={clsx("text-[11px] tabular-nums",
                    priceDiff >= 0 ? "text-accent" : "text-danger")}>
                    {priceDiff > 0 ? "+" : ""}{priceDiff.toFixed(1)}% vs Polymarket
                  </span>
                </div>
                <div className="flex items-center border border-border bg-surface px-3 py-3">
                  <span className="text-2xl font-black tabular-nums tracking-tight text-danger"
                    style={{ fontFamily: "var(--font-display)" }}>
                    {pricePercent}¢
                  </span>
                  <div className="ml-auto text-right">
                    <p className="text-[10px] text-muted">Polymarket</p>
                    <p className="text-xs text-text tabular-nums">{(yesPrice * 100).toFixed(1)}¢</p>
                  </div>
                </div>
                <input
                  type="range" min={1_000} max={990_000} step={PRICE_STEP}
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(parseInt(e.target.value))}
                  className="w-full danger"
                />
                <div className="flex justify-between text-[10px] text-muted-dim">
                  <span>1¢</span><span>50¢</span><span>99¢</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between border border-border bg-surface/40 px-3 py-2.5">
                <div>
                  <p className="text-[10px] text-muted tracking-widest uppercase">Fill price</p>
                  <p className="text-[11px] text-muted-dim mt-0.5">At batch clearing price</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-muted">Polymarket now</p>
                  <p className="text-lg font-black tabular-nums text-danger"
                    style={{ fontFamily: "var(--font-display)" }}>
                    {(yesPrice * 100).toFixed(1)}¢
                  </p>
                </div>
              </div>
            )}

            {/* Commitment hash */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-muted tracking-widest uppercase">Sealed Commitment</label>
                <span className="text-[10px] text-muted-dim">keccak256</span>
              </div>
              <div className="p-2 border border-border bg-surface/50 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 w-1 bg-danger/30" />
                <p className="hash-text text-[11px] break-all pl-2">
                  {walletAddress ? commitment : "0x" + "?".repeat(64)}
                </p>
              </div>
              <p className="text-[10px] text-muted-dim">
                This hash — not your YES token amount — is what gets recorded on-chain.
              </p>
            </div>

            {error && (
              <div className="p-2 border border-danger/30 bg-danger/5">
                <p className="text-danger text-xs">{error}</p>
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="p-4 border-t border-border">
            {!isConnected ? (
              <button type="button" onClick={onConnect}
                className="w-full py-3 border border-border-bright text-text text-xs tracking-widest uppercase hover:border-text/30 transition-colors">
                Connect Wallet
              </button>
            ) : !batchOpen ? (
              <button type="button" disabled
                className="w-full py-3 border border-border text-muted text-xs tracking-widest uppercase cursor-not-allowed">
                Batch Closed
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSubmitting || !amountDisplay}
                className={clsx(
                  "w-full py-3 text-xs tracking-widest uppercase font-medium transition-all duration-150",
                  "border border-danger text-danger hover:bg-danger/10 disabled:opacity-40",
                  isSubmitting && "opacity-60 cursor-wait",
                )}
                style={{ boxShadow: isSubmitting ? "none" : "0 0 16px rgba(255, 51, 85, 0.15)" }}
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                    {submitStep === "approving" ? "APPROVING CTF…" : "SIGNING ORDER…"}
                  </span>
                ) : (
                  `SEAL ${orderType === "market" ? "MKT" : "LMT"} SELL YES — ${amountDisplay || "0"} tokens`
                )}
              </button>
            )}
            {isConnected && batchOpen && (
              <p className="text-center text-[10px] text-muted-dim mt-2">
                {yesBalance === 0n
                  ? "No YES tokens in wallet — buy YES first."
                  : "1 tx (CTF approve, if needed) + 1 signature — no commitment gas"}
              </p>
            )}
          </div>
        </form>
      )}

      {/* ── BUY MODE: order form ──────────────────────────────────────────── */}
      {mode === "buy" && (
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">

          {/* Order type toggle */}
          <div className="grid grid-cols-2 border-b border-border">
            <button type="button" onClick={() => setOrderType("market")}
              className={clsx("py-1.5 text-[10px] tracking-widest uppercase transition-colors",
                orderType === "market" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted")} >
              Market
            </button>
            <button type="button" onClick={() => setOrderType("limit")}
              className={clsx("py-1.5 text-[10px] tracking-widest uppercase transition-colors border-l border-border",
                orderType === "limit" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted")} >
              Limit
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Amount */}
            <div className="space-y-2">
              <label className="text-[11px] text-muted tracking-widest uppercase">USDC Amount</label>
              <div className="flex items-center border border-border bg-surface focus-within:border-border-bright transition-colors">
                <span className="pl-3 text-muted text-sm">$</span>
                <input
                  type="number"
                  value={amountDisplay}
                  onChange={(e) => setAmountDisplay(e.target.value)}
                  className="flex-1 bg-transparent px-2 py-3 text-text text-sm tabular-nums focus:outline-none"
                  placeholder="0.00"
                  min="1"
                  step="1"
                />
                <span className="pr-3 text-muted text-[11px]">USDC</span>
              </div>
              <div className="flex gap-1">
                {[50, 100, 500, 1000].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setAmountDisplay(amt.toString())}
                    className={clsx(
                      "flex-1 py-1 text-[10px] border transition-colors",
                      amountDisplay === amt.toString()
                        ? "border-text/30 text-text"
                        : "border-border text-muted hover:border-border-bright hover:text-muted",
                    )}
                  >
                    ${amt}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Buy order summary ── */}
            {amountNum > 0 && (
              <div className="border border-border divide-y divide-border/60 text-[11px]">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-muted uppercase tracking-wider text-[10px]">Avg price</span>
                  <span className="tabular-nums text-text">{(fillPrice * 100).toFixed(2)}¢</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-muted uppercase tracking-wider text-[10px]">Shares</span>
                  <span className="tabular-nums text-text">{sharesOut.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-muted uppercase tracking-wider text-[10px]">Potential return</span>
                  <span className={clsx("tabular-nums font-medium", isBuy ? "text-accent" : "text-danger")}>
                    ${toWin.toFixed(2)}{" "}
                    <span className="text-muted font-normal">(+{potentialPct.toFixed(0)}%)</span>
                  </span>
                </div>
              </div>
            )}

            {/* Limit price */}
            {orderType === "limit" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-muted tracking-widest uppercase">Limit Price</label>
                  <span className={clsx("text-[11px] tabular-nums",
                    priceDiff > 0 ? "text-accent" : priceDiff < 0 ? "text-danger" : "text-muted")}>
                    {priceDiff > 0 ? "+" : ""}{priceDiff.toFixed(1)}% vs Polymarket
                  </span>
                </div>
                <div className="flex items-center border border-border bg-surface px-3 py-3">
                  <span className={clsx("text-2xl font-black tabular-nums tracking-tight",
                    isBuy ? "text-accent" : "text-danger")}
                    style={{ fontFamily: "var(--font-display)" }}>
                    {pricePercent}¢
                  </span>
                  <div className="ml-auto text-right">
                    <p className="text-[10px] text-muted">Polymarket</p>
                    <p className="text-xs text-text tabular-nums">{(yesPrice * 100).toFixed(1)}¢</p>
                  </div>
                </div>
                <input
                  type="range" min={1_000} max={990_000} step={PRICE_STEP}
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(parseInt(e.target.value))}
                  className={clsx("w-full", !isBuy && "danger")}
                />
                <div className="flex justify-between text-[10px] text-muted-dim">
                  <span>1¢</span><span>50¢</span><span>99¢</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between border border-border bg-surface/40 px-3 py-2.5">
                <div>
                  <p className="text-[10px] text-muted tracking-widest uppercase">Fill price</p>
                  <p className="text-[11px] text-muted-dim mt-0.5">At batch clearing price</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-muted">Polymarket now</p>
                  <p className={clsx("text-lg font-black tabular-nums",
                    isBuy ? "text-accent" : "text-danger")}
                    style={{ fontFamily: "var(--font-display)" }}>
                    {((isBuy ? yesPrice : noPrice) * 100).toFixed(1)}¢
                  </p>
                </div>
              </div>
            )}

            {/* Commitment hash */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-muted tracking-widest uppercase">Sealed Commitment</label>
                <span className="text-[10px] text-muted-dim">keccak256</span>
              </div>
              <div className="p-2 border border-border bg-surface/50 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 w-1 bg-blue/40" />
                <p className="hash-text text-[11px] break-all pl-2">
                  {walletAddress ? commitment : "0x" + "?".repeat(64)}
                </p>
              </div>
              <p className="text-[10px] text-muted-dim">
                This hash — not your order details — is what gets recorded on-chain.
              </p>
            </div>

            {error && (
              <div className="p-2 border border-danger/30 bg-danger/5">
                <p className="text-danger text-xs">{error}</p>
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="p-4 border-t border-border">
            {!isConnected ? (
              <button type="button" onClick={onConnect}
                className="w-full py-3 border border-border-bright text-text text-xs tracking-widest uppercase hover:border-text/30 transition-colors">
                Connect Wallet
              </button>
            ) : !batchOpen ? (
              <button type="button" disabled
                className="w-full py-3 border border-border text-muted text-xs tracking-widest uppercase cursor-not-allowed">
                Batch Closed
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSubmitting || !amountDisplay}
                className={clsx(
                  "w-full py-3 text-xs tracking-widest uppercase font-medium transition-all duration-150",
                  isBuy
                    ? "border border-accent text-accent hover:bg-accent/10 disabled:opacity-40"
                    : "border border-danger text-danger hover:bg-danger/10 disabled:opacity-40",
                  isSubmitting && "opacity-60 cursor-wait",
                )}
                style={{
                  boxShadow: isSubmitting ? "none"
                    : isBuy ? "0 0 16px rgba(0, 255, 179, 0.15)"
                    : "0 0 16px rgba(255, 51, 85, 0.15)",
                }}
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                    {submitStep === "approving" ? "APPROVING…" : "SIGNING ORDER…"}
                  </span>
                ) : (
                  `SEAL ${orderType === "market" ? "MKT" : "LMT"} ${isBuy ? "BUY YES" : "BUY NO"} — $${amountDisplay || "0"}`
                )}
              </button>
            )}
            {isConnected && batchOpen && (
              <p className="text-center text-[10px] text-muted-dim mt-2">
                1 tx (USDC approve) + 1 signature — no commitment gas
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
