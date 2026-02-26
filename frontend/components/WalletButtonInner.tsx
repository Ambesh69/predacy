"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { clsx } from "clsx";

interface Props {
  compact?: boolean;
}

export default function WalletButtonInner({ compact = false }: Props) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const address = wallets[0]?.address as `0x${string}` | undefined;
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;

  // Privy not yet initialised (e.g. no App ID configured)
  if (!ready) {
    return (
      <div className={clsx("bg-border animate-pulse", compact ? "w-28 h-6" : "w-24 h-7")} />
    );
  }

  if (authenticated && short) {
    return (
      <button
        onClick={logout}
        className={clsx(
          "group flex items-center gap-2 border transition-colors tracking-widest uppercase",
          compact ? "border-border px-2.5 py-1 text-[10px]" : "border-border-bright px-3 py-1.5 text-xs",
          "text-text hover:border-danger/40 hover:text-danger",
        )}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-accent group-hover:bg-danger transition-colors flex-shrink-0" />
        {short}
      </button>
    );
  }

  return (
    <button
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
