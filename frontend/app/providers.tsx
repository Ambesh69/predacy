"use client";

import type { ReactNode } from "react";
import PrivyInner from "./PrivyInner";

export default function Providers({ children }: { children: ReactNode }) {
  return <PrivyInner>{children}</PrivyInner>;
}
