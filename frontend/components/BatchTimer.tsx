"use client";

import { useState, useEffect, useRef } from "react";
import { clsx } from "clsx";

interface BatchTimerProps {
  openedAt: number;      // unix timestamp (seconds)
  batchWindow: number;   // seconds (default: 30)
  commitmentCount: number;
  totalDeposited: bigint; // USDC 6 decimals
  batchId: bigint;
  status: number;         // 0=OPEN, 1=SETTLING, 2=SETTLED
  clearingPrice?: bigint;
}

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function BatchTimer({
  openedAt,
  batchWindow,
  commitmentCount,
  totalDeposited,
  batchId,
  status,
  clearingPrice,
}: BatchTimerProps) {
  const [remaining, setRemaining] = useState(batchWindow);
  const [progress, setProgress] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - openedAt;
      const rem = Math.max(0, batchWindow - elapsed);
      setRemaining(rem);
      setProgress(rem / batchWindow);
    };

    update();
    if (status === 0) {
      intervalRef.current = setInterval(update, 200);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [openedAt, batchWindow, status]);

  const strokeDashoffset = CIRCUMFERENCE * (1 - progress);
  const isUrgent = remaining <= 8 && status === 0;
  const isOpen = status === 0;

  const strokeColor = status === 2
    ? "#4D83FF"
    : isUrgent
    ? "#FF3355"
    : "#00FFB3";

  const formatTime = (sec: number) => {
    const s = Math.ceil(sec);
    return s.toString().padStart(2, "0");
  };

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Ring timer */}
      <div className="relative flex items-center justify-center">
        {/* Outer glow ring */}
        <div
          className="absolute inset-0 rounded-full opacity-20 blur-xl"
          style={{ background: strokeColor }}
        />

        <svg width="140" height="140" className="rotate-[-90deg]">
          {/* Background track */}
          <circle
            cx="70" cy="70" r={RADIUS}
            fill="none"
            stroke="#13131F"
            strokeWidth="3"
          />
          {/* Progress arc */}
          <circle
            cx="70" cy="70" r={RADIUS}
            fill="none"
            stroke={strokeColor}
            strokeWidth="3"
            strokeLinecap="square"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            style={{
              transition: "stroke-dashoffset 0.2s linear, stroke 0.3s ease",
              filter: `drop-shadow(0 0 6px ${strokeColor}80)`,
            }}
          />
          {/* Tick marks */}
          {Array.from({ length: 30 }).map((_, i) => {
            const angle = (i / 30) * 360 - 90;
            const rad = (angle * Math.PI) / 180;
            const x1 = 70 + 62 * Math.cos(rad);
            const y1 = 70 + 62 * Math.sin(rad);
            const x2 = 70 + 66 * Math.cos(rad);
            const y2 = 70 + 66 * Math.sin(rad);
            return (
              <line
                key={i}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={i % 5 === 0 ? "#1E1E30" : "#13131F"}
                strokeWidth={i % 5 === 0 ? 1.5 : 1}
              />
            );
          })}
        </svg>

        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {status === 0 ? (
            <>
              <span
                className={clsx(
                  "font-display text-5xl font-black leading-none tracking-tight",
                  isUrgent ? "glow-danger" : "glow-accent"
                )}
                style={{
                  color: strokeColor,
                  fontFamily: "var(--font-display)",
                }}
              >
                {formatTime(remaining)}
              </span>
              <span className="text-muted text-[10px] tracking-widest uppercase mt-1">
                seconds
              </span>
            </>
          ) : status === 1 ? (
            <div className="flex flex-col items-center gap-1">
              <div className="w-5 h-5 border-2 border-blue border-t-transparent rounded-full animate-spin" />
              <span className="text-blue text-[10px] tracking-widest uppercase mt-1">settling</span>
            </div>
          ) : (
            <>
              <span
                className="font-display text-3xl font-black glow-blue"
                style={{ fontFamily: "var(--font-display)", color: "#4D83FF" }}
              >
                DONE
              </span>
              <span className="text-blue text-[10px] tracking-widest uppercase mt-1">settled</span>
            </>
          )}
        </div>
      </div>

      {/* Batch metadata */}
      <div className="w-full space-y-2">
        {/* Status badge */}
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs tracking-widest uppercase">batch</span>
          <span className="text-text text-xs font-medium">#{batchId.toString()}</span>
        </div>

        <div className="h-px bg-border" />

        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">orders sealed</span>
          <span className={clsx("text-xs font-medium tabular-nums", isOpen ? "text-accent" : "text-text")}>
            {commitmentCount}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">volume locked</span>
          <span className="text-text text-xs font-medium tabular-nums">
            ${(Number(totalDeposited) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </span>
        </div>

        {status === 2 && clearingPrice !== undefined && (
          <>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-muted text-xs">clearing price</span>
              <span className="text-blue text-xs font-medium tabular-nums glow-blue">
                {(Number(clearingPrice) / 10_000).toFixed(1)}¢
              </span>
            </div>
          </>
        )}
      </div>

      {/* Status indicator */}
      <div
        className="w-full h-[2px] rounded-full overflow-hidden"
        style={{ background: "#13131F" }}
      >
        <div
          className="h-full rounded-full transition-all duration-200"
          style={{
            width: status === 2 ? "100%" : `${progress * 100}%`,
            background: `linear-gradient(90deg, ${strokeColor}40, ${strokeColor})`,
            boxShadow: `0 0 8px ${strokeColor}`,
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        <div
          className={clsx("w-1.5 h-1.5 rounded-full", {
            "animate-pulse": isOpen,
          })}
          style={{ background: strokeColor, boxShadow: `0 0 4px ${strokeColor}` }}
        />
        <span className="text-[11px] tracking-widest uppercase" style={{ color: strokeColor }}>
          {status === 0 ? (isUrgent ? "CLOSING SOON" : "ACCEPTING ORDERS") : status === 1 ? "COMPUTING PRICE" : "POSITIONS CLAIMABLE"}
        </span>
      </div>
    </div>
  );
}
