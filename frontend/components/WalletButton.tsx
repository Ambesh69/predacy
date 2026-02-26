"use client";

import dynamic from "next/dynamic";
import { clsx } from "clsx";

interface WalletButtonProps {
  compact?: boolean;
}

// ssr: false — Privy hooks must never run during server rendering
const WalletButtonInner = dynamic(() => import("./WalletButtonInner"), { ssr: false });

export default function WalletButton({ compact = false }: WalletButtonProps) {
  return (
    <>
      {/* Placeholder shown during client bundle load */}
      <noscript>
        <div className={clsx("bg-border", compact ? "w-28 h-6" : "w-24 h-7")} />
      </noscript>
      <WalletButtonInner compact={compact} />
    </>
  );
}
