"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { polygon, polygonAmoy } from "viem/chains";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const privyConfig: PrivyClientConfig = {
  appearance: {
    theme: "dark",
    accentColor: "#00FFB3" as `#${string}`,
    logo: "",
    showWalletLoginFirst: true,
    walletList: ["metamask", "coinbase_wallet", "wallet_connect", "phantom"],
    landingHeader: "Connect to Predacy",
    loginMessage: "Trade without trace.",
  },
  loginMethods: ["wallet"],
  defaultChain: polygon,
  supportedChains: [polygon, polygonAmoy],
  embeddedWallets: {
    createOnLogin: "off",
  },
};

export default function PrivyInner({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID) {
    return <>{children}</>;
  }
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      {children}
    </PrivyProvider>
  );
}
