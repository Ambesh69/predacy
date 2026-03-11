"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActionProgressState, ProgressStage } from "@/lib/ui/action-progress";

interface ActionModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  progress?: ActionProgressState;
  txUrl?: string | null;
  retryLabel?: string;
  onRetry?: (() => void) | null;
  children?: ReactNode;
}

const STAGES: ProgressStage[] = ["submitting", "confirming", "settled"];

function stageIndex(stage: ProgressStage) {
  if (stage === "failed") return 1;
  return STAGES.indexOf(stage);
}

export default function ActionModal({
  open,
  title,
  onClose,
  progress,
  txUrl,
  retryLabel = "Retry",
  onRetry,
  children,
}: ActionModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const activeTitle = progress?.title || title;
  const activeStage = progress?.stage ?? "idle";
  const stepCursor = stageIndex(activeStage);

  const waitHint = useMemo(() => {
    if (!progress?.startedAt) return "";
    if ((activeStage === "submitting" || activeStage === "confirming") && elapsedSeconds >= 25) {
      return "Taking longer than usual. Funds are safe and we are still confirming on-chain.";
    }
    return "";
  }, [progress?.startedAt, activeStage, elapsedSeconds]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !progress?.startedAt) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - progress.startedAt!) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open, progress?.startedAt]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-[2px] p-0 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-modal="true"
      role="dialog"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full sm:max-w-[540px] border border-border-bright bg-bg shadow-[0_18px_70px_rgba(0,0,0,0.55)] focus:outline-none"
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-[11px] tracking-widest uppercase text-text">{activeTitle}</p>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-text transition-colors text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          {progress && (
            <>
              <div className="grid grid-cols-3 gap-2">
                {STAGES.map((step, idx) => {
                  const isDone = stepCursor > idx || activeStage === "settled";
                  const isCurrent = stepCursor === idx && activeStage !== "settled";
                  return (
                    <div key={step} className="space-y-1">
                      <div className="h-1 bg-border">
                        <div
                          className="h-full transition-all duration-300"
                          style={{
                            width: isDone || isCurrent ? "100%" : "0%",
                            background: isDone ? "#2CE8C6" : isCurrent ? "#4EA3FF" : "transparent",
                          }}
                        />
                      </div>
                      <p className="text-[9px] tracking-widest uppercase text-muted-dim">{step}</p>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1">
                <p className="text-[13px] text-text">{progress.message}</p>
                {progress.helper && <p className="text-[11px] text-muted-dim">{progress.helper}</p>}
                {waitHint && <p className="text-[11px] text-amber-300/90">{waitHint}</p>}
                {progress.startedAt && (
                  <p className="text-[10px] text-muted tracking-widest uppercase">Elapsed {elapsedSeconds}s</p>
                )}
                {progress.error && <p className="text-[11px] text-danger">{progress.error}</p>}
              </div>

              {(txUrl || progress.txHash) && (
                <a
                  href={txUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[10px] tracking-widest uppercase border border-border px-2.5 py-1 text-muted hover:text-text hover:border-border-bright transition-colors"
                >
                  View on explorer ↗
                </a>
              )}
            </>
          )}

          {children}
        </div>

        {(onRetry || progress?.stage === "failed") && (
          <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[10px] tracking-widest uppercase border border-border text-muted hover:text-text hover:border-border-bright transition-colors"
            >
              Close
            </button>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-3 py-1.5 text-[10px] tracking-widest uppercase border border-accent text-accent hover:bg-accent/5 transition-colors"
              >
                {retryLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
