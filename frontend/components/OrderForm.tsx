"use client";

import { useState, useEffect, useCallback } from "react";
import { encodePacked, keccak256 } from "viem";
import { clsx } from "clsx";
import { computeCommitment, generateSalt } from "@/lib/commitmentHash";
import { getErrorMessage } from "@/lib/validation";
import { getContracts, CTF_ABI, BATCH_VAULT_ABI } from "@/lib/contracts";
import { ACTIVE_CHAIN } from "@/lib/chain";
import type { Market } from "@/lib/polymarket";
import { publicClient } from "@/lib/publicClient";

// OrderSide mirrors BatchVault v8 enum
export const YES_BUY  = 0;
export const YES_SELL = 1;
export const NO_BUY   = 2;
export const NO_SELL  = 3;

interface OrderFormProps {
  market: Market;
  marketId: `0x${string}`;
  batchOpen: boolean;
  onSubmit: (params: {
    commitment: `0x${string}`;
    amount: bigint;
    salt: `0x${string}`;
    side: number;         // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
    limitPrice: bigint;
  }) => Promise<void>;
  walletAddress?: `0x${string}`;
  isConnected: boolean;
  onConnect: () => void;
  submitStep?: "approving" | "signing" | "railgun" | null;
  balanceVersion?: number;     // bumped by parent after a successful claim
  candidateMarketIds?: `0x${string}`[];  // all market IDs from batch history to check balance against
  sellPrefill?: bigint | null;           // YES token amount to pre-fill in SELL mode (from "CLOSE POSITION")
  onSellPrefillConsumed?: () => void;    // called so parent can clear the prefill
}

const PRICE_STEP        = 10_000;
const MARKET_SELL_LIMIT = 0n;

/** Compute the YES or NO token ID for a given market.
 *  Mirrors Gnosis CTF: YES uses indexSet=2, NO uses indexSet=1.
 *  Must use encodePacked to match Solidity abi.encodePacked — address stays 20 bytes,
 *  not padded to 32 like standard ABI encoding would do. */
function computeTokenId(usdcAddress: `0x${string}`, conditionId: `0x${string}`, indexSet: bigint): bigint {
  const parentCollectionId = ("0x" + "00".repeat(32)) as `0x${string}`;
  const collectionId = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint256"],
      [parentCollectionId, conditionId, indexSet]
    )
  );
  const positionId = keccak256(
    encodePacked(
      ["address", "bytes32"],
      [usdcAddress, collectionId]
    )
  );
  return BigInt(positionId);
}
/** YES token — indexSet=2 (Gnosis CTF convention for outcome 0) */
function computeYesTokenId(usdcAddress: `0x${string}`, conditionId: `0x${string}`): bigint {
  return computeTokenId(usdcAddress, conditionId, 2n);
}
/** NO token — indexSet=1 (Gnosis CTF convention for outcome 1) */
function computeNoTokenId(usdcAddress: `0x${string}`, conditionId: `0x${string}`): bigint {
  return computeTokenId(usdcAddress, conditionId, 1n);
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
  sellPrefill,
  onSellPrefillConsumed,
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
  const [showPrivacy,  setShowPrivacy]  = useState(false);

  // ── Sell prefill (from "CLOSE POSITION" button) ──────────────────────────
  useEffect(() => {
    if (!sellPrefill || sellPrefill === 0n) return;
    setMode("sell");
    setSellYes(true);
    // Convert 6-decimal YES token bigint to a display string (trim trailing zeros)
    const displayAmount = (Number(sellPrefill) / 1_000_000)
      .toFixed(6)
      .replace(/\.?0+$/, "");
    setAmountDisplay(displayAmount);
    onSellPrefillConsumed?.();
  }, [sellPrefill]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Slippage (market orders) ─────────────────────────────────────────────
  const [slippageBps, setSlippageBpsState] = useState<number>(() => {
    if (typeof window === "undefined") return 200;
    return parseInt(localStorage.getItem("predacy_slippage_bps") ?? "50");
  });
  const [showSlippage,       setShowSlippage]       = useState(false);
  const [customSlippageInput, setCustomSlippageInput] = useState<string>(() => {
    if (typeof window === "undefined") return "0.5";
    const stored = parseInt(localStorage.getItem("predacy_slippage_bps") ?? "50");
    return (stored / 100).toFixed(1);
  });
  const setSlippageBps = (bps: number) => {
    setSlippageBpsState(bps);
    localStorage.setItem("predacy_slippage_bps", String(bps));
  };

  // Derived from market props — needed before effectiveLimitPrice
  const yesPrice = parseFloat(market.outcomePrices[0]);
  const noPrice  = parseFloat(market.outcomePrices[1] ?? (1 - yesPrice).toFixed(4));

  // Market buy limits: current price + user slippage tolerance, capped at 99.9999¢
  const marketBuyLimit = BigInt(
    Math.min(999_999, Math.ceil(yesPrice * (1 + slippageBps / 10_000) * 1_000_000))
  );
  const marketNoBuyLimit = BigInt(
    Math.min(999_999, Math.ceil(noPrice * (1 + slippageBps / 10_000) * 1_000_000))
  );

  // Derived order side (0–3) from mode + token toggle
  const orderSide: number = mode === "buy"
    ? (isBuy ? YES_BUY : NO_BUY)
    : (sellYes ? YES_SELL : NO_SELL);

  // YES/NO token balances for sell mode
  const [yesBalance, setYesBalance] = useState<bigint | null>(null);
  const [noBalance,  setNoBalance]  = useState<bigint | null>(null);
  const [yesBalanceLoading, setYesBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);  // manual ↻ button

  const effectiveLimitPrice = mode === "sell"
    ? (orderType === "market" ? MARKET_SELL_LIMIT : BigInt(limitPrice))
    : (orderType === "market"
        ? (isBuy ? marketBuyLimit : marketNoBuyLimit)
        : BigInt(limitPrice));

  const updateCommitment = useCallback(() => {
    if (!walletAddress) return;
    try {
      const amountParsed = BigInt(Math.round(parseFloat(amountDisplay || "0") * 1_000_000));
      if (amountParsed === 0n) return;
      const effLP = mode === "sell"
        ? (orderType === "market" ? MARKET_SELL_LIMIT : BigInt(limitPrice))
        : (orderType === "market"
          ? (isBuy ? marketBuyLimit : marketNoBuyLimit)
          : BigInt(limitPrice));
      setCommitment(computeCommitment({ marketId, side: orderSide, amount: amountParsed, limitPrice: effLP, salt }));
    } catch { /* ignore parse errors while typing */ }
  }, [walletAddress, amountDisplay, isBuy, limitPrice, orderType, marketId, salt, mode, marketBuyLimit, marketNoBuyLimit, orderSide]);

  useEffect(() => { updateCommitment(); }, [updateCommitment]);

  // Fetch YES or NO balance when switching to sell mode.
  useEffect(() => {
    if (mode !== "sell" || !walletAddress) return;
    setYesBalanceLoading(true);
    setBalanceError(null);
    let cancelled = false;
    (async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const allIds = [...new Set([
          market.conditionId as `0x${string}`,
          marketId,
          ...candidateMarketIds,
        ])];
        console.log("[OrderForm] Balance check | wallet:", walletAddress, "| condIds:", allIds);
        let totalYes = 0n;
        let totalNo  = 0n;
        for (const condId of allIds) {
          // Per-condId isolation: a single bad market ID (e.g. from old testnet orders)
          // must not zero out the entire balance by crashing the outer try-block.
          try {
            // Standard CTF token IDs (indexSet convention)
            const [yesBal, noBal] = await Promise.all([
              publicClient.readContract({
                address: contracts.ctf, abi: CTF_ABI, functionName: "balanceOf",
                args: [walletAddress, computeYesTokenId(contracts.usdc, condId)],
              }) as Promise<bigint>,
              publicClient.readContract({
                address: contracts.ctf, abi: CTF_ABI, functionName: "balanceOf",
                args: [walletAddress, computeNoTokenId(contracts.usdc, condId)],
              }) as Promise<bigint>,
            ]);
            totalYes += yesBal;
            totalNo  += noBal;

            // NegRisk token IDs (v10: stored on BatchVault, different from standard CTF IDs)
            const [negRiskYesId, negRiskNoId] = await Promise.all([
              publicClient.readContract({
                address: contracts.batchVault, abi: BATCH_VAULT_ABI,
                functionName: "yesTokenIds", args: [condId],
              }) as Promise<bigint>,
              publicClient.readContract({
                address: contracts.batchVault, abi: BATCH_VAULT_ABI,
                functionName: "noTokenIds", args: [condId],
              }) as Promise<bigint>,
            ]);
            console.log(`[OrderForm] condId=${condId.slice(0,10)} | stdYes=${yesBal} stdNo=${noBal} | negRiskYesId=${negRiskYesId} negRiskNoId=${negRiskNoId}`);
            if (negRiskYesId !== 0n) {
              const negRiskYesBal = await publicClient.readContract({
                address: contracts.ctf, abi: CTF_ABI, functionName: "balanceOf",
                args: [walletAddress, negRiskYesId],
              }) as bigint;
              console.log(`[OrderForm] negRiskYesBal=${negRiskYesBal} for tokenId=${negRiskYesId}`);
              totalYes += negRiskYesBal;
            }
            if (negRiskNoId !== 0n) {
              const negRiskNoBal = await publicClient.readContract({
                address: contracts.ctf, abi: CTF_ABI, functionName: "balanceOf",
                args: [walletAddress, negRiskNoId],
              }) as bigint;
              totalNo += negRiskNoBal;
            }
          } catch (condErr) {
            // One bad condId — log and skip; don't let it wipe the whole balance.
            console.warn(`[OrderForm] Balance check failed for condId ${condId}:`, condErr);
          }
        }
        console.log("[OrderForm] Balance result | totalYes:", totalYes, "totalNo:", totalNo);
        if (!cancelled) { setYesBalance(totalYes); setNoBalance(totalNo); }
      } catch (err) {
        // Outer catch for setup errors (e.g. getContracts throws on unsupported chain).
        console.error("[OrderForm] Failed to fetch token balance:", err);
        if (!cancelled) {
          setYesBalance(null);
          setNoBalance(null);
          setBalanceError("Balance unavailable");
        }
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
      await onSubmit({ commitment, amount, salt, side: orderSide, limitPrice: effectiveLimitPrice });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const pricePercent = (limitPrice / 10_000).toFixed(1);
  const priceDiff    = ((limitPrice / 1_000_000) - yesPrice) * 100;

  // ── Order summary derived values ────────────────────────────────────────────
  const amountNum = parseFloat(amountDisplay || "0") || 0;
  const fillPrice = orderType === "limit"
    ? limitPrice / 1_000_000
    : (mode === "sell"
        ? (sellYes ? yesPrice : noPrice)
        : (isBuy ? yesPrice : noPrice));
  const sharesOut    = fillPrice > 0 && amountNum > 0 ? amountNum / fillPrice : 0;
  const toWin        = sharesOut;
  const potentialPct = fillPrice > 0 ? (1 / fillPrice - 1) * 100 : 0;
  const receiveUSDC  = amountNum * fillPrice;

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

  // ── Privacy toggle section (shared by both buy + sell) ───────────────────
  const privacyToggle = (
    <div>
      <button
        type="button"
        onClick={() => setShowPrivacy(v => !v)}
        className="flex items-center gap-1.5 text-[10px] text-muted-dim hover:text-muted transition-colors w-full text-left py-1"
      >
        <span>🔒</span>
        <span className="tracking-widest uppercase">Privacy &amp; commitment hash</span>
        <svg
          className={clsx("ml-auto w-3 h-3 transition-transform flex-shrink-0", showPrivacy && "rotate-180")}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {showPrivacy && (
        <div className="mt-2 space-y-2">
          <div className="p-2 border border-border bg-surface/50 relative overflow-hidden">
            <div className="absolute inset-y-0 left-0 w-1 bg-blue/40" />
            <p className="hash-text text-[11px] break-all pl-2">
              {walletAddress ? commitment : "0x" + "?".repeat(64)}
            </p>
          </div>
          <p className="text-[10px] text-muted-dim">
            This hash — not your order details — is what gets recorded on-chain.
          </p>
          {mode === "buy" && (
            <div className="border border-accent/20 bg-accent/5 px-3 py-2 space-y-1">
              <p className="text-[10px] text-accent tracking-widest uppercase font-medium">Privacy</p>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
                <span className="text-accent">✓</span>
                <span className="text-muted-dim">Wallet address hidden from settlement events</span>
                <span className="text-accent">✓</span>
                <span className="text-muted-dim">USDC amount hidden until claim</span>
                <span className="text-accent">✓</span>
                <span className="text-muted-dim">Ephemeral address used for on-chain commit</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full">

      {/* ── Header: BUY | SELL + Market | Limit (one row) ─────────────────── */}
      <div className="flex border-b border-border">
        <button
          type="button"
          onClick={() => setMode("buy")}
          className={clsx(
            "px-4 py-2.5 text-[11px]",
            "tracking-widest uppercase font-medium border-b-2 transition-colors",
            mode === "buy" ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"
          )}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => setMode("sell")}
          className={clsx(
            "px-4 py-2.5 text-[11px]",
            "tracking-widest uppercase font-medium border-b-2 border-l border-border transition-colors",
            mode === "sell" ? "border-danger text-danger" : "border-transparent text-muted hover:text-text"
          )}
        >
          Sell
        </button>
        {/* Market | Limit — right side of same bar */}
        <div className="ml-auto flex items-stretch border-l border-border">
          <button
            type="button"
            onClick={() => setOrderType("market")}
            className={clsx(
              "px-3 text-[10px] tracking-widest uppercase transition-colors",
              orderType === "market" ? "text-text" : "text-muted-dim hover:text-muted"
            )}
          >
            Market
          </button>
          <button
            type="button"
            onClick={() => setOrderType("limit")}
            className={clsx(
              "px-3 text-[10px] tracking-widest uppercase border-l border-border transition-colors",
              orderType === "limit" ? "text-text" : "text-muted-dim hover:text-muted"
            )}
          >
            Limit
          </button>
        </div>
      </div>

      {/* ── YES / NO outcome toggle ───────────────────────────────────────── */}
      {mode === "buy" ? (
        <div className="grid grid-cols-2 gap-2 px-3 py-2.5 border-b border-border">
          <button
            type="button"
            onClick={() => setIsBuy(true)}
            className={clsx(
              "py-2 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
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
              "py-2 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              !isBuy
                ? "bg-danger text-white"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            No <span className="tabular-nums opacity-80">{(noPrice * 100).toFixed(1)}¢</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 px-3 py-2.5 border-b border-border">
          <button
            type="button"
            onClick={() => setSellYes(true)}
            className={clsx(
              "py-2 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              sellYes
                ? "bg-danger/20 border border-danger/40 text-danger"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            Yes <span className="tabular-nums opacity-80">{(yesPrice * 100).toFixed(1)}¢</span>
          </button>
          <button
            type="button"
            onClick={() => setSellYes(false)}
            className={clsx(
              "py-2 px-3 text-xs font-medium tracking-wide transition-all duration-150 rounded-sm",
              !sellYes
                ? "bg-danger/20 border border-danger/40 text-danger"
                : "bg-surface/60 border border-border text-muted hover:border-border-bright hover:text-text"
            )}
          >
            No <span className="tabular-nums opacity-80">{(noPrice * 100).toFixed(1)}¢</span>
          </button>
        </div>
      )}

      {/* ── SELL MODE ────────────────────────────────────────────────────── */}
      {mode === "sell" && (
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex flex-col gap-3 px-3 py-3">

            {/* Token Amount (YES or NO depending on sellYes) */}
            {(() => {
              const tokenLabel   = sellYes ? "YES" : "NO";
              const tokenBalance = sellYes ? yesBalance : noBalance;
              const balDisplay   = tokenBalance !== null ? (Number(tokenBalance) / 1_000_000).toFixed(2) : null;
              return (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-muted tracking-widest uppercase">{tokenLabel} Tokens to Sell</label>
                    {isConnected && (
                      <span className="flex items-center gap-1 text-[10px] tabular-nums">
                        {yesBalanceLoading
                          ? <span className="text-muted-dim">loading…</span>
                          : balanceError
                          ? <span className="text-amber-400">⚠ {balanceError}</span>
                          : balDisplay !== null
                          ? <span className="text-muted-dim">Balance: {balDisplay}</span>
                          : <span className="text-muted-dim">Balance: —</span>}
                        <button type="button" onClick={() => setRefreshTick(t => t + 1)}
                          className="text-muted-dim hover:text-muted transition-colors leading-none" title="Refresh balance">↻</button>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center border border-border bg-surface focus-within:border-border-bright transition-colors">
                    <input
                      type="number"
                      value={amountDisplay}
                      onChange={(e) => setAmountDisplay(e.target.value)}
                      className="flex-1 bg-transparent px-3 py-2.5 text-text text-sm tabular-nums focus:outline-none"
                      placeholder="0.00" min="0" step="any"
                    />
                    <span className="pr-3 text-muted text-[11px]">{tokenLabel}</span>
                  </div>
                  {tokenBalance !== null && tokenBalance > 0n && (
                    <div className="flex gap-1">
                      {[25, 50, 75, 100].map((pct) => (
                        <button key={pct} type="button"
                          onClick={() => {
                            const amt = Number(tokenBalance) * pct / 100 / 1_000_000;
                            setAmountDisplay(amt.toFixed(6).replace(/\.?0+$/, ""));
                          }}
                          className="flex-1 py-1 text-[10px] border border-border text-muted hover:border-border-bright hover:text-muted transition-colors">
                          {pct}%
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Sell: compact "You'll receive" summary */}
            {amountNum > 0 && (
              <div className="flex items-end justify-between pt-2 border-t border-border/40">
                <div>
                  <p className="text-[10px] text-muted-dim mb-0.5">
                    You&apos;ll receive · Avg. Price {(fillPrice * 100).toFixed(1)}¢
                  </p>
                  <p className="text-2xl font-black tabular-nums leading-none text-danger"
                    style={{ fontFamily: "var(--font-display)" }}>
                    ${receiveUSDC.toFixed(2)}
                  </p>
                </div>
              </div>
            )}

            {/* Limit price (sell mode) */}
            {orderType === "limit" && (
              <div className="space-y-1.5 pt-2 border-t border-border/40">
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] text-muted tracking-widest uppercase">Min Sell Price</span>
                  <span className="font-black tabular-nums text-sm text-danger"
                        style={{ fontFamily: "var(--font-display)" }}>
                    {pricePercent}¢
                    <span className="text-[10px] text-muted font-normal ml-1">
                      {priceDiff > 0 ? "+" : ""}{priceDiff.toFixed(1)}% vs PM
                    </span>
                  </span>
                </div>
                <input type="range" min={1_000} max={990_000} step={PRICE_STEP}
                  value={limitPrice} onChange={(e) => setLimitPrice(parseInt(e.target.value))}
                  className="w-full danger" />
                <div className="flex justify-between text-[10px] text-muted-dim">
                  <span>1¢</span><span>50¢</span><span>99¢</span>
                </div>
              </div>
            )}

            {privacyToggle}

            {error && (
              <div className="p-2 border border-danger/30 bg-danger/5">
                <p className="text-danger text-xs">{error}</p>
              </div>
            )}
          </div>

          <div className="flex-1" />

          {/* Submit */}
          <div className="px-3 pb-3">
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
              <button type="submit" disabled={isSubmitting || !amountDisplay}
                className={clsx(
                  "w-full py-3 text-xs tracking-widest uppercase font-medium transition-all duration-150",
                  "border border-danger text-danger hover:bg-danger/10 disabled:opacity-40",
                  isSubmitting && "opacity-60 cursor-wait",
                )}
                style={{ boxShadow: isSubmitting ? "none" : "0 0 16px rgba(255, 51, 85, 0.15)" }}>
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                    {submitStep === "approving" ? "APPROVING CTF…" : "SIGNING ORDER…"}
                  </span>
                ) : (
                  `Sell ${sellYes ? "YES" : "NO"}`
                )}
              </button>
            )}
            {isConnected && batchOpen && amountNum > 0 && (
              <p className="text-center text-[10px] text-muted-dim mt-2 tabular-nums">
                Receive ${receiveUSDC.toFixed(2)} • Avg {(fillPrice * 100).toFixed(1)}¢
              </p>
            )}
          </div>
        </form>
      )}

      {/* ── BUY MODE ─────────────────────────────────────────────────────── */}
      {mode === "buy" && (
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex flex-col gap-3 px-3 py-3">

            {/* Amount */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-muted tracking-widest uppercase">Amount</label>
                <span className="text-[10px] text-muted-dim">Balance $0.00</span>
              </div>
              <div className="flex items-center border border-border bg-surface focus-within:border-border-bright transition-colors">
                <span className="pl-3 text-muted text-sm">$</span>
                <input
                  type="number"
                  value={amountDisplay}
                  onChange={(e) => setAmountDisplay(e.target.value)}
                  className="flex-1 bg-transparent px-2 py-2.5 text-text text-lg font-bold tabular-nums focus:outline-none"
                  placeholder="0" min="1" step="1"
                />
                <span className="pr-3 text-muted text-[11px]">USDC</span>
              </div>
              {/* Additive quick-fills like Polymarket */}
              <div className="flex gap-1">
                {[1, 5, 10, 100].map((n) => (
                  <button key={n} type="button"
                    onClick={() => setAmountDisplay(String(Math.max(0, (parseFloat(amountDisplay || "0") || 0) + n)))}
                    className="flex-1 py-1 text-[10px] border border-border text-muted hover:border-border-bright hover:text-muted transition-colors">
                    +${n}
                  </button>
                ))}
                <button type="button" disabled
                  className="px-2 py-1 text-[10px] border border-border/40 text-muted/40 cursor-not-allowed">
                  Max
                </button>
              </div>
            </div>

            {/* Market mode: compact "To win" block */}
            {amountNum > 0 && orderType === "market" && (
              <div className="flex items-end justify-between pt-2.5 border-t border-border/40">
                <div>
                  <p className="text-[10px] text-muted-dim mb-0.5">
                    To win 💰 &nbsp;·&nbsp; Avg. Price {(fillPrice * 100).toFixed(1)}¢
                  </p>
                  <p className={clsx(
                      "text-2xl font-black tabular-nums leading-none",
                      isBuy ? "text-accent" : "text-danger"
                    )}
                    style={{ fontFamily: "var(--font-display)" }}>
                    ${toWin.toFixed(2)}
                  </p>
                </div>
                <span className="text-[10px] text-muted-dim pb-0.5">(+{potentialPct.toFixed(0)}%)</span>
              </div>
            )}

            {/* Slippage tolerance — market orders only */}
            {orderType === "market" && (
              <div className="pt-0.5">
                <button
                  type="button"
                  onClick={() => setShowSlippage(v => !v)}
                  className="flex items-center gap-1.5 text-[10px] text-muted-dim hover:text-muted transition-colors w-full"
                >
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span>Max slippage:</span>
                  <span className={clsx("font-medium tabular-nums", slippageBps > 500 ? "text-amber-400" : "text-text")}>
                    {(slippageBps / 100).toFixed(1)}%
                  </span>
                  <svg
                    className={clsx("ml-auto w-2.5 h-2.5 transition-transform flex-shrink-0", showSlippage && "rotate-180")}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showSlippage && (
                  <div className="mt-2 space-y-2">
                    {/* Presets + custom input */}
                    <div className="flex items-center gap-1">
                      {[50, 100, 200, 500].map((bps) => (
                        <button
                          key={bps}
                          type="button"
                          onClick={() => { setSlippageBps(bps); setCustomSlippageInput((bps / 100).toFixed(1)); }}
                          className={clsx(
                            "flex-1 py-1 text-[10px] border transition-colors",
                            slippageBps === bps
                              ? "border-accent text-accent bg-accent/5"
                              : "border-border text-muted-dim hover:border-border-bright hover:text-muted"
                          )}
                        >
                          {(bps / 100).toFixed(1)}%
                        </button>
                      ))}
                      <div className={clsx(
                        "flex items-center border bg-surface transition-colors ml-0.5",
                        ![50, 100, 200, 500].includes(slippageBps) ? "border-accent" : "border-border"
                      )}>
                        <input
                          type="number" min={0.1} max={50} step={0.1}
                          value={customSlippageInput}
                          onChange={(e) => {
                            setCustomSlippageInput(e.target.value);
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v) && v >= 0.1 && v <= 50) setSlippageBps(Math.round(v * 100));
                          }}
                          className="w-10 bg-transparent px-1.5 py-1 text-[10px] text-text focus:outline-none tabular-nums"
                          placeholder="…"
                        />
                        <span className="pr-1.5 text-[10px] text-muted-dim">%</span>
                      </div>
                    </div>

                    {/* Ceiling + hint */}
                    <p className="text-[10px] text-muted-dim">
                      Max fill price:{" "}
                      <span className="text-text tabular-nums">
                        {((Number(marketBuyLimit) / 1_000_000) * 100).toFixed(2)}¢
                      </span>
                      &nbsp;·&nbsp;
                      {slippageBps > 500
                        ? <span className="text-amber-400">High — may fill at a worse price</span>
                        : slippageBps <= 100
                        ? "Conservative — may not fill in busy batches"
                        : "Fills in most batches"}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Limit mode: compact slider + inline to-win */}
            {orderType === "limit" && (
              <div className="space-y-1.5 pt-2.5 border-t border-border/40">
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] text-muted tracking-widest uppercase">Limit Price</span>
                  <span className={clsx("font-black tabular-nums text-sm", isBuy ? "text-accent" : "text-danger")}
                        style={{ fontFamily: "var(--font-display)" }}>
                    {pricePercent}¢
                    <span className="text-[10px] text-muted font-normal ml-1">
                      {priceDiff > 0 ? "+" : ""}{priceDiff.toFixed(1)}% vs PM
                    </span>
                  </span>
                </div>
                <input type="range" min={1_000} max={990_000} step={PRICE_STEP}
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(parseInt(e.target.value))}
                  className={clsx("w-full", !isBuy && "danger")} />
                <div className="flex justify-between text-[10px] text-muted-dim">
                  <span>1¢</span><span>50¢</span><span>99¢</span>
                </div>
                {amountNum > 0 && (
                  <p className="text-[10px] text-muted-dim">
                    To win:&nbsp;
                    <span className={clsx("font-medium", isBuy ? "text-accent" : "text-danger")}>
                      ${toWin.toFixed(2)}
                    </span>
                    &nbsp;·&nbsp;Shares: {sharesOut.toFixed(2)}
                  </p>
                )}
              </div>
            )}

            {privacyToggle}

            {error && (
              <div className="p-2 border border-danger/30 bg-danger/5">
                <p className="text-danger text-xs">{error}</p>
              </div>
            )}
          </div>

          <div className="flex-1" />

          {/* Submit — always visible, no scroll */}
          <div className="px-3 pb-3">
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
              <button type="submit" disabled={isSubmitting || !amountDisplay}
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
                }}>
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                    {submitStep === "approving" ? "FUNDING EPHEMERAL…" : "SIGNING ORDER…"}
                  </span>
                ) : (
                  isBuy ? "Buy YES" : "Buy NO"
                )}
              </button>
            )}
            {isConnected && batchOpen && amountNum > 0 && (
              <p className="text-center text-[10px] text-muted-dim mt-2 tabular-nums">
                Cost ${amountNum.toFixed(2)} • Est payout ${toWin.toFixed(2)}
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
