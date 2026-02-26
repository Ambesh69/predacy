"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { polygon } from "viem/chains";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

// Privy config — themed to match the Predacy dark palette
const privyConfig: PrivyClientConfig = {
  appearance: {
    theme: "dark" as const,
    accentColor: "#00FFB3" as `#${string}`,
    logo: "",
    showWalletLoginFirst: true,
    walletList: ["metamask", "coinbase_wallet", "wallet_connect", "phantom"],
    landingHeader: "Connect to Predacy",
    loginMessage: "Trade without trace.",
  },
  loginMethods: ["wallet"],
  defaultChain: polygon,
  supportedChains: [polygon],
  embeddedWallets: {
    createOnLogin: "off",
  },
};

export default function Providers({ children }: { children: React.ReactNode }) {
  // Skip Privy during builds without a real App ID (e.g. CI, preview deploys)
  // Once NEXT_PUBLIC_PRIVY_APP_ID is set, full wallet functionality activates.
  if (!PRIVY_APP_ID) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      {children}
    </PrivyProvider>
  );
}
