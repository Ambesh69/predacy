"use client";

import type { ReactNode } from "react";
import PrivyInner from "./PrivyInner";
import PostHogProvider from "./PostHogProvider";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <PostHogProvider>
      <PrivyInner>{children}</PrivyInner>
    </PostHogProvider>
  );
}
