"use client";

import { usePostHog } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";
import { usePrivy } from "@privy-io/react-auth";

function PageViewInner() {
  const pathname      = usePathname();
  const searchParams  = useSearchParams();
  const posthog       = usePostHog();
  const { user, authenticated } = usePrivy();

  // Track page views on route change
  useEffect(() => {
    if (!posthog) return;
    posthog.capture("$pageview", { $current_url: window.location.href });
  }, [pathname, searchParams, posthog]);

  // Identify user as soon as they connect a wallet
  useEffect(() => {
    if (!posthog || !authenticated) return;
    const walletAddress = user?.wallet?.address;
    if (!walletAddress) return;
    posthog.identify(walletAddress, {
      wallet_address: walletAddress,
      connected_at:   new Date().toISOString(),
    });
    posthog.capture("wallet_connected", { address: walletAddress });
  }, [authenticated, user?.wallet?.address, posthog]);

  return null;
}

// Suspense boundary required by Next.js for useSearchParams
export default function PostHogPageView() {
  return (
    <Suspense fallback={null}>
      <PageViewInner />
    </Suspense>
  );
}
