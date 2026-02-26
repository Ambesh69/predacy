"use client";

import { useState, useEffect, type ReactNode } from "react";
import dynamic from "next/dynamic";

// PrivyInner is only ever imported on the client (ssr: false) so that
// @privy-io/react-auth's module-level localStorage access never runs
// during Next.js server prerendering.
const PrivyInner = dynamic(() => import("./PrivyInner"), { ssr: false });

export default function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Before mount: render children directly (SSR + first hydration pass).
  // This prevents hydration mismatches and keeps the initial HTML intact.
  if (!mounted) {
    return <>{children}</>;
  }

  // After mount: wrap children with the client-only Privy context.
  return <PrivyInner>{children}</PrivyInner>;
}
