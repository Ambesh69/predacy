"use client";

import { useRouter } from "next/navigation";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { clsx } from "clsx";

interface Props {
  compact?: boolean;
}

export default function WalletButtonInner({ compact = false }: Props) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const router = useRouter();

  const address = wallets[0]?.address as `0x${string}` | undefined;
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;

  // Privy not yet initialised (e.g. no App ID configured)
  if (!ready) {
    return (
      <div className={clsx("bg-border animate-pulse", compact ? "w-32 h-6" : "w-32 h-7")} />
    );
  }

  if (authenticated && short) {
    return (
      <div
        className={clsx(
          "flex items-center border divide-x transition-colors",
          compact ? "border-border divide-border" : "border-border-bright divide-border",
        )}
      >
        {/* Address → profile */}
        <button
          type="button"
          onClick={() => router.push("/profile")}
          className={clsx(
            "flex items-center gap-2 tracking-widest uppercase text-text hover:bg-surface/50 transition-colors",
            compact ? "px-2.5 py-1 text-[10px]" : "px-3 py-1.5 text-xs",
          )}
        >
          <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
          {short}
        </button>
        {/* Disconnect */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); logout(); }}
          aria-label="Disconnect wallet"
          title="Disconnect wallet"
          className={clsx(
            "text-muted hover:text-danger hover:bg-surface/50 transition-colors",
            compact ? "px-2 py-1 text-[10px]" : "px-2.5 py-1.5 text-[11px]",
          )}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={login}
      className={clsx(
        "border transition-colors tracking-widest uppercase",
        compact
          ? "border-border px-2.5 py-1 text-[10px] text-muted hover:text-text hover:border-border-bright"
          : "border-border-bright px-4 py-1.5 text-xs text-text hover:border-text/20",
      )}
    >
      Connect
    </button>
  );
}
