"use client";

import { useState, useEffect, useCallback } from "react";
import { clsx } from "clsx";
import { computeCommitment, generateSalt } from "@/lib/commitmentHash";
import { getErrorMessage } from "@/lib/validation";
import type { Market } from "@/lib/polymarket";

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
}

const PRICE_STEP = 10_000;
const MARKET_BUY_LIMIT  = 2n ** 256n - 1n;
const MARKET_SELL_LIMIT = 0n;

export default function OrderForm({
  market,
  marketId,
  batchOpen,
  onSubmit,
  walletAddress,
  isConnected,
  onConnect,
  submitStep,
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

  const effectiveLimitPrice =
    orderType === "market"
      ? (isBuy ? MARKET_BUY_LIMIT : MARKET_SELL_LIMIT)
      : BigInt(limitPrice);

  const updateCommitment = useCallback(() => {
    if (!walletAddress || mode === "sell") return;
    try {
      const amountParsed = BigInt(Math.round(parseFloat(amountDisplay || "0") * 1_000_000));
      if (amountParsed === 0n) return;
      const effLP = orderType === "market"
        ? (isBuy ? MARKET_BUY_LIMIT : MARKET_SELL_LIMIT)
        : BigInt(limitPrice);
      setCommitment(computeCommitment({ marketId, isBuy, amount: amountParsed, limitPrice: effLP, salt, trader: walletAddress }));
    } catch { /* ignore parse errors while typing */ }
  }, [walletAddress, amountDisplay, isBuy, limitPrice, orderType, marketId, salt, mode]);

  useEffect(() => { updateCommitment(); }, [updateCommitment]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected || !batchOpen) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const amount = BigInt(Math.round(parseFloat(amountDisplay) * 1_000_000));
      await onSubmit({ commitment, amount, salt, isBuy, limitPrice: effectiveLimitPrice });
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

  const polymarketUrl = market.slug
    ? `https://polymarket.com/event/${market.slug}`
    : "https://polymarket.com";

  // ── Sealed state ────────────────────────────────────────────────────────────
  if (submitted) {
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
            {orderType === "market"
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
        <div className="grid grid-cols-2 gap-2 p-3 border-b border-border">
          <button
            type="button"
            onClick={() => setSellYes(true)}
            className={clsx(
              "py-2.5 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              sellYes
                ? "bg-accent/20 border border-accent/40 text-accent"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            Yes <span className="tabular-nums opacity-80">{(yesPrice * 100).toFixed(1)}¢</span>
          </button>
          <button
            type="button"
            onClick={() => setSellYes(false)}
            className={clsx(
              "py-2.5 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              !sellYes
                ? "bg-danger/20 border border-danger/40 text-danger"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            No <span className="tabular-nums opacity-80">{(noPrice * 100).toFixed(1)}¢</span>
          </button>
        </div>
      )}

      {/* ── SELL MODE: exit CTA ───────────────────────────────────────────── */}
      {mode === "sell" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6">
          <div className="text-center space-y-1.5">
            <p className="text-text text-sm font-medium">
              Selling {sellYes ? "YES" : "NO"} tokens
            </p>
            <p className="text-muted-dim text-[11px] leading-relaxed max-w-[220px] mx-auto">
              The batch vault doesn't accept token deposits yet.
              Exit your {sellYes ? "YES" : "NO"} position directly on Polymarket.
            </p>
          </div>

          <a
            href={polymarketUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-3 border border-danger text-danger text-[11px] tracking-widest uppercase text-center hover:bg-danger/10 transition-colors block"
          >
            SELL {sellYes ? "YES" : "NO"} ON POLYMARKET ↗
          </a>

          <p className="text-[10px] text-muted-dim text-center">
            Polymarket uses instant order books. Your tokens will sell at the current market price.
          </p>
        </div>
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
                    {submitStep === "approving" ? "APPROVING USDC…" : "SIGNING ORDER…"}
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
