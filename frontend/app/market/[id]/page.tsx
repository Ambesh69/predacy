"use client";

import dynamic from "next/dynamic";

// Dynamically imported with ssr:false so Privy hooks never execute during
// server-side rendering (they require the PrivyProvider client context).
const MarketPageClient = dynamic(
  () => import("@/components/MarketPageClient"),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    ),
  }
);

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  return <MarketPageClient params={params} />;
}
