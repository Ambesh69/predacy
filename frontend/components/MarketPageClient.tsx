"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { createPublicClient, createWalletClient, custom, http, fallback, parseAbiItem, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import BatchTimer from "@/components/BatchTimer";
import CommitmentFeed from "@/components/CommitmentFeed";
import OrderForm from "@/components/OrderForm";
import PositionsPanel from "@/components/PositionsPanel";
import PriceChart from "@/components/PriceChart";
import WalletButton from "@/components/WalletButton";
import { getMarket, MOCK_MARKETS, type Market } from "@/lib/polymarket";
import { getRelayerUrl } from "@/lib/relayerUrl";
import {
  BATCH_VAULT_ABI,
  CTF_ABI,
  ERC20_ABI,
  MOCK_USDC_ABI,
  BatchStatus,
  getContracts,
} from "@/lib/contracts";
import { computeCommitment } from "@/lib/commitmentHash";
import {
  ACTIVE_CHAIN,
  ACTIVE_CHAIN_ID_HEX,
  ACTIVE_CHAIN_NAME,
  CHAIN_GAS,
  IS_MAINNET,
} from "@/lib/chain";
import { clsx } from "clsx";

// ── Viem public client (read-only, no wallet needed) ─────────────────────────
// polygon-rpc.com shut down Feb 2026 — viem's default transport for Polygon
// would resolve to it and silently break balance reads. Use explicit working RPCs.
const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: IS_MAINNET
    ? fallback([
        http("https://polygon.llamarpc.com"),
        http("https://polygon.meowrpc.com"),
        http("https://rpc.ankr.com/polygon"),
      ])
    : http(),
});

// ── Fallback batch state shown before chain data loads ────────────────────────
const MOCK_BATCH = {
  batchId: 0n,
  batchMarketId: ("0x" + "0".repeat(64)) as `0x${string}`,
  openedAt: Math.floor(Date.now() / 1000) - 8,
  batchWindow: 30,
  commitmentCount: 0,
  totalDeposited: 0n,
  status: BatchStatus.OPEN,
  clearingPrice: 0n,
};

const MOCK_COMMITMENTS: Array<{
  hash: `0x${string}`;
  amount?: bigint;
  trader?: `0x${string}`;
  timestamp: number;
}> = [];

// Gas params imported from chain.ts (CHAIN_GAS adapts to mainnet vs testnet)

// ── Provider discovery ────────────────────────────────────────────────────────
// When multiple wallet extensions are installed (e.g. Backpack + MetaMask),
// another wallet can seize window.ethereum as a read-only getter, completely
// blocking MetaMask from injecting itself. MetaMask v10+ always announces via
// EIP-6963 regardless, so we use that to find it directly.
async function findBestProvider(): Promise<{ provider: any; name: string }> {
  if (typeof window === "undefined") throw new Error("Not in browser");

  // 1. EIP-6963: ask all installed wallets to announce themselves (150 ms window)
  const eip6963 = await new Promise<{ provider: any; name: string } | null>(
    (resolve) => {
      const found: { info: any; provider: any }[] = [];
      const handler = (e: Event) => {
        const d = (e as CustomEvent).detail;
        if (d?.provider) found.push(d);
      };
      window.addEventListener("eip6963:announceProvider", handler);
      window.dispatchEvent(new CustomEvent("eip6963:requestProvider"));
      setTimeout(() => {
        window.removeEventListener("eip6963:announceProvider", handler);
        if (found.length === 0) { resolve(null); return; }
        // Prefer MetaMask specifically
        const mm = found.find(
          (p) =>
            p.info?.rdns === "io.metamask" ||
            p.info?.name?.toLowerCase().includes("metamask"),
        );
        if (mm) { resolve({ provider: mm.provider, name: "MetaMask" }); return; }
        // Fallback: first EIP-6963 responder
        resolve({ provider: found[0].provider, name: found[0].info?.name ?? "Wallet" });
      }, 150);
    },
  );
  if (eip6963) return eip6963;

  // 2. window.ethereum.providers[] (legacy multi-wallet shim)
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No Ethereum wallet found. Please install MetaMask.");
  if (Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p: any) => p.isMetaMask);
    if (mm) return { provider: mm, name: "MetaMask" };
    return { provider: eth.providers[0], name: "Wallet" };
  }

  // 3. window.ethereum as-is (might be Backpack or another wallet)
  const name = eth.isMetaMask
    ? "MetaMask"
    : eth.isBackpack
      ? "Backpack"
      : "Wallet";
  return { provider: eth, name };
}

export default function MarketPageClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [market, setMarket]           = useState<Market | null>(null);
  const [batch, setBatch]             = useState(MOCK_BATCH);
  const [commitments, setCommitments] = useState(MOCK_COMMITMENTS);
  const [loading, setLoading]         = useState(true);
  const [submitStep, setSubmitStep]   = useState<"approving" | "signing" | "railgun" | null>(null);
  // Railgun private-mode state — set while waiting for user to fund the ephemeral
  // wallet through Railgun (instead of a direct on-chain Transfer from Alice's address).
  // Cleared automatically when the polling effect detects a sufficient USDC balance.
  const [useRailgun, setUseRailgun]   = useState(IS_MAINNET); // default: private on mainnet
  const [railgunPending, setRailgunPending] = useState<{
    ephemeralPrivateKey: `0x${string}`;
    ephemeralAddress:    `0x${string}`;
    fundingAmount:       bigint;
    params:              { commitment: `0x${string}`; amount: bigint; salt: `0x${string}`; side: number; limitPrice: bigint };
    batchId:             bigint;
    deadline:            bigint;
    contracts:           ReturnType<typeof getContracts>;
  } | null>(null);
  const [railgunBalance, setRailgunBalance] = useState<bigint>(0n);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [chainError, setChainError]   = useState<string | null>(null);
  const [activeTab, setActiveTab]     = useState<"order" | "positions">("order");
  const [position, setPosition]       = useState<{
    filledAmount: bigint;
    refundAmount: bigint;
    side: number;
    claimed: boolean;
  } | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [historicalMarketIds, setHistoricalMarketIds] = useState<`0x${string}`[]>([]);

  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet        = wallets[0];
  const walletAddress = wallet?.address as `0x${string}` | undefined;
  const isConnected   = authenticated && !!walletAddress;

  // Track the best available provider's chain via EIP-6963 / window.ethereum events.
  const [rawChainId, setRawChainId]   = useState<string | null>(null);
  const [walletName, setWalletName]   = useState<string | null>(null);
  useEffect(() => {
    if (!isConnected) { setRawChainId(null); setWalletName(null); return; }
    let active = true;
    findBestProvider().then(({ provider, name }) => {
      if (!active) return;
      setWalletName(name);
      provider.request({ method: "eth_chainId" }).then((id: string) => {
        if (active) setRawChainId(id);
      });
      const handler = (id: string) => { if (active) setRawChainId(id); };
      provider.on?.("chainChanged", handler);
      return () => provider.removeListener?.("chainChanged", handler);
    }).catch(() => {});
    return () => { active = false; };
  }, [isConnected]);

  const onWrongChain = isConnected && rawChainId !== null && rawChainId.toLowerCase() !== ACTIVE_CHAIN_ID_HEX;

  // ── Pre-warm: open a batch for this market before the user submits an order ──
  useEffect(() => {
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl || !id) return;
    fetch(`${relayerUrl}/warm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: id }),
    }).catch(() => { /* best-effort, ignore failures */ });
  }, [id]);

  // ── Load market ─────────────────────────────────────────────────────────────
  useEffect(() => {
    // 1. Mock fallback (dev)
    const found = MOCK_MARKETS.find((m) => m.conditionId === id);
    if (found) { setMarket(found); setLoading(false); return; }
    // 2. sessionStorage cache — set by event page when navigating here directly
    try {
      const cached = sessionStorage.getItem(`predacy:market:${id}`);
      if (cached) { setMarket(JSON.parse(cached)); setLoading(false); return; }
    } catch { /* ignore */ }
    // 3. Gamma API lookup
    getMarket(id)
      .then((m) => setMarket(m))
      .catch(() => setMarket(null))
      .finally(() => setLoading(false));
  }, [id]);

  // ── Clear stale per-batch state when batchId advances ───────────────────────
  // When a new batch opens the position from the settled batch and the old
  // commitment feed must be wiped so they don't appear for the new cycle.
  useEffect(() => {
    if (batch.batchId === 0n) return; // don't clear on initial load
    setPosition(null);
    setCommitments([]);
  }, [batch.batchId]);

  // ── Clear stale error banner when wallet reconnects ──────────────────────────
  // Watch both walletAddress (different wallet) and authenticated (same wallet
  // disconnect→reconnect cycle) so the banner clears in either case.
  useEffect(() => {
    setChainError(null);
  }, [walletAddress, authenticated]);

  // ── Fetch on-chain commitment feed via getLogs ───────────────────────────────
  // Runs once on mount and whenever the batchId advances.
  // Only fetches events for the current batchId; merges with locally-submitted.
  useEffect(() => {
    if (batch.batchId === 0n) return;
    let cancelled = false;
    const fetchOnChainCommitments = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const logs = await publicClient.getLogs({
          address:   contracts.batchVault,
          event:     parseAbiItem(
            "event OrderCommitted(uint256 indexed batchId, bytes32 indexed commitment)",
          ),
          args:      { batchId: batch.batchId }, // only current batch's orders
          fromBlock: 0n,
          toBlock:   "latest",
        });
        if (cancelled) return;
        const onChain = logs.map((log) => ({
          hash:      log.args.commitment as `0x${string}`,
          // trader and amount are intentionally not in the event (privacy)
          timestamp: Number(log.blockNumber ?? 0n) * 1000,
        }));
        setCommitments((prev) => {
          const existing = new Set(prev.map((c) => c.hash));
          const newOnes  = onChain.filter((c) => !existing.has(c.hash));
          return newOnes.length ? [...prev, ...newOnes] : prev;
        });
      } catch {
        // RPC hiccup — keep showing current state
      }
    };
    fetchOnChainCommitments();
    return () => { cancelled = true; };
  }, [batch.batchId]);

  // ── Poll batch state from chain ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchBatch = async () => {
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);

        const batchId = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args: [id as `0x${string}`],
        }) as bigint;

        if (batchId === 0n) return;

        const b = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getBatch",
          args: [batchId],
        }) as {
          marketId: `0x${string}`;
          openedAt: bigint; closedAt: bigint; status: number;
          totalDeposited: bigint; clearingPrice: bigint;
          commitmentCount: bigint;
        };

        if (!cancelled) {
          setBatch({
            batchId,
            batchMarketId:   b.marketId,
            openedAt:        Number(b.openedAt),
            batchWindow:     30,
            commitmentCount: Number(b.commitmentCount),
            totalDeposited:  b.totalDeposited,
            status:          b.status as BatchStatus,
            clearingPrice:   b.clearingPrice,
          });
        }
      } catch {
        // RPC hiccup — keep showing current state
      }
    };

    fetchBatch();
    const interval = setInterval(fetchBatch, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id]);

  // ── Poll position when batch is SETTLED ─────────────────────────────────────
  // Position is keyed by commitment hash (not wallet address) — look up from localStorage.
  useEffect(() => {
    if (batch.status !== BatchStatus.SETTLED || !isConnected || !walletAddress) return;
    let cancelled = false;
    const fetchPosition = async () => {
      try {
        // Find this user's commitment for the settled batchId from localStorage
        const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
        const storedOrders: Array<{ commitment: string; batchId: string }> =
          JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        const myOrder = storedOrders.find((o) => o.batchId === batch.batchId.toString());
        if (!myOrder) return; // no order in this batch

        const contracts = getContracts(ACTIVE_CHAIN.id);
        const pos = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getPosition",
          args: [batch.batchId, myOrder.commitment as `0x${string}`],
        }) as { filledAmount: bigint; refundAmount: bigint; side: number; claimed: boolean };
        if (!cancelled) setPosition(pos);
      } catch {
        // RPC hiccup — keep current
      }
    };
    fetchPosition();
    return () => { cancelled = true; };
  }, [batch.status, batch.batchId, walletAddress, isConnected]);

  // ── Railgun balance polling ───────────────────────────────────────────────────
  // When the user chooses Private Mode (Railgun) for a buy order, we pause at the
  // funding step and wait for the ephemeral address to receive USDC from Railgun.
  // This effect polls every 4 s. When balance ≥ fundingAmount, it resumes the order.
  useEffect(() => {
    if (!railgunPending) { setRailgunBalance(0n); return; }
    let cancelled = false;
    const { ephemeralPrivateKey, ephemeralAddress, fundingAmount, params, batchId, deadline, contracts } = railgunPending;

    const check = async () => {
      try {
        const bal = await publicClient.readContract({
          address: contracts.usdc,
          abi:     ERC20_ABI,
          functionName: "balanceOf",
          args: [ephemeralAddress],
        }) as bigint;
        if (cancelled) return;
        setRailgunBalance(bal);

        if (bal >= fundingAmount) {
          // Ephemeral wallet is funded — resume order flow
          setRailgunPending(null);
          setSubmitStep("signing");

          // Inline the signing + posting (same as direct mode, minus the fund TX)
          try {
            const ephemeralAccount = privateKeyToAccount(ephemeralPrivateKey);
            const ephemeralWalletClient = createWalletClient({ account: ephemeralAccount, chain: ACTIVE_CHAIN, transport: http() });

            const actualCommitment = computeCommitment({ marketId: id as `0x${string}`, side: params.side, amount: params.amount, limitPrice: params.limitPrice, salt: params.salt });
            const ephemeralNonce = await publicClient.readContract({ address: contracts.batchVault, abi: BATCH_VAULT_ABI, functionName: "nonces", args: [ephemeralAddress] }) as bigint;

            // v6 contract: batchId removed from CommitOrder EIP-712 — sig valid for any batch.
            const COMMIT_ORDER_TYPES = {
              CommitOrder: [
                { name: "commitment", type: "bytes32" },
                { name: "amount",     type: "uint256" },
                { name: "nonce",      type: "uint256" },
                { name: "deadline",   type: "uint256" },
              ],
            } as const;
            const COMMIT_ORDER_DOMAIN = {
              name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault,
            } as const;

            const signature = await ephemeralWalletClient.signTypedData({
              account: ephemeralAccount,
              domain:  COMMIT_ORDER_DOMAIN,
              types:   COMMIT_ORDER_TYPES,
              primaryType: "CommitOrder",
              message: { commitment: actualCommitment, amount: params.amount, nonce: ephemeralNonce, deadline },
            });

            // Pre-sign 2 requeue sigs silently — invisible to user, ~2ms, no MetaMask popup.
            const requeueDeadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
            const requeueSig1 = await ephemeralWalletClient.signTypedData({
              account: ephemeralAccount,
              domain:  COMMIT_ORDER_DOMAIN,
              types:   COMMIT_ORDER_TYPES,
              primaryType: "CommitOrder",
              message: { commitment: actualCommitment, amount: params.amount, nonce: ephemeralNonce + 1n, deadline: requeueDeadline },
            });
            const requeueSig2 = await ephemeralWalletClient.signTypedData({
              account: ephemeralAccount,
              domain:  COMMIT_ORDER_DOMAIN,
              types:   COMMIT_ORDER_TYPES,
              primaryType: "CommitOrder",
              message: { commitment: actualCommitment, amount: params.amount, nonce: ephemeralNonce + 2n, deadline: requeueDeadline },
            });
            const requeueAuths = [
              { ephemeral: ephemeralAddress, nonce: (ephemeralNonce + 1n).toString(), deadline: requeueDeadline.toString(), signature: requeueSig1 },
              { ephemeral: ephemeralAddress, nonce: (ephemeralNonce + 2n).toString(), deadline: requeueDeadline.toString(), signature: requeueSig2 },
            ];

            const nonceBytes = new Uint8Array(32);
            crypto.getRandomValues(nonceBytes);
            const transferNonce = ("0x" + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
            const validAfter  = 0n;
            const validBefore = BigInt(Math.floor(Date.now() / 1000) + 7200);

            const transferSig = await ephemeralWalletClient.signTypedData({
              account: ephemeralAccount,
              domain: { name: "USD Coin", version: "2", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.usdc },
              types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
              primaryType: "TransferWithAuthorization",
              message: { from: ephemeralAddress, to: contracts.batchVault, value: params.amount, validAfter, validBefore, nonce: transferNonce },
            });

            const r = transferSig.slice(0, 66) as `0x${string}`;
            const s = ("0x" + transferSig.slice(66, 130)) as `0x${string}`;
            const v = parseInt(transferSig.slice(130, 132), 16);
            const transferAuth = { validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce: transferNonce, v, r, s };

            const relayerUrl = getRelayerUrl();
            if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

            const resp = await fetch(`${relayerUrl}/order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ marketId: id, batchId: batchId.toString(), signer: ephemeralAddress, side: params.side, amount: params.amount.toString(), limitPrice: params.limitPrice.toString(), salt: params.salt, commitment: actualCommitment, signature, nonce: ephemeralNonce.toString(), deadline: deadline.toString(), transferAuth, requeueAuths }),
            });

            const relayerData = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(relayerData.error ?? `Relayer returned ${resp.status}`);

            const actualBatchId: string = relayerData.batchId ?? batchId.toString();
            if (walletAddress) {
              setCommitments((prev) => [...prev, { hash: actualCommitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() }]);
              setBatch((prev) => ({ ...prev, commitmentCount: prev.commitmentCount + 1, totalDeposited: prev.totalDeposited + params.amount }));
            }
            setActiveTab("positions");
            try {
              const key = `predacy:orders:${walletAddress!.toLowerCase()}`;
              const existing: unknown[] = JSON.parse(localStorage.getItem(key) ?? "[]");
              existing.unshift({ commitment: actualCommitment, salt: params.salt, amount: params.amount.toString(), side: params.side, limitPrice: params.limitPrice.toString(), batchId: actualBatchId, marketId: id, marketQuestion: market?.question ?? null, timestamp: Date.now(), ephemeralKey: ephemeralPrivateKey, ephemeralAddress, railgun: true });
              localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
            } catch { /* ignore quota / SSR errors */ }
          } catch (e: any) {
            setChainError(e.message ?? "Order failed after Railgun funding");
          } finally {
            setSubmitStep(null);
          }
        }
      } catch { /* RPC hiccup — try again next interval */ }
    };

    check(); // immediate check
    const id_ = setInterval(check, 4000);
    return () => { cancelled = true; clearInterval(id_); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railgunPending]);

  // ── ensureChain ───────────────────────────────────────────────────────────────
  // Uses EIP-6963 to find MetaMask (works even when Backpack/another wallet has
  // seized window.ethereum as a read-only property). Calls wallet_switchEthereumChain
  // on the discovered provider, then polls eth_chainId to confirm the switch
  // before handing back a ready walletClient.
  const ensureAmoy = async () => {
    if (!walletAddress || !wallet) throw new Error("Wallet not connected");
    const provider = await wallet.getEthereumProvider();
    // Do NOT call eth_requestAccounts here — Privy intercepts it and shows a SIWE
    // "Sign In" popup on Ethereum mainnet instead of authorizing the wallet session.
    const name = wallet.walletClientType ?? "wallet";

    // Only switch chain if actually needed — calling switchChain when already on
    // the right network briefly disrupts Phantom's provider authorization, causing
    // the very next eth_sendTransaction to return 4100 "not authorized".
    let alreadyOnChain = false;
    try {
      const hexId = await provider.request({ method: "eth_chainId" }) as string;
      alreadyOnChain = parseInt(hexId, 16) === ACTIVE_CHAIN.id;
    } catch { /* can't check — assume wrong chain */ }

    if (!alreadyOnChain) {
      try {
        await wallet.switchChain(ACTIVE_CHAIN.id);
      } catch (err: any) {
        if (err.code === 4001 || err.message?.includes("rejected") || err.message?.includes("cancelled")) {
          throw new Error(`Network switch cancelled — please approve switching to ${ACTIVE_CHAIN_NAME}.`);
        }
        throw new Error(
          `${name} declined the network switch. Please manually switch to ${ACTIVE_CHAIN_NAME} ` +
          `(Chain ID ${ACTIVE_CHAIN.id}) in ${name}.`
        );
      }
    }

    return createWalletClient({
      account: walletAddress,
      chain: ACTIVE_CHAIN,
      transport: custom(provider),
    });
  };

  // ── Submit order ─────────────────────────────────────────────────────────────
  //
  // EIP-3009 privacy flow:
  //   1. Sell orders only: approve CTF setApprovalForAll (1 tx — only if needed)
  //      Buy orders: NO on-chain tx at order time
  //   2. Read current nonce from nonces[walletAddress] on-chain
  //   3. Sign CommitOrder EIP-712 off-chain (relayer submits — only relayer visible)
  //   4. Buy orders only: sign TransferWithAuthorization EIP-3009 off-chain
  //      (authorises vault to pull USDC at settlement — only if the order fills)
  //   5. POST both sigs to relayer → relayer calls commitOrderFor() on-chain
  //
  // ── Ephemeral wallet privacy model ─────────────────────────────────────────
  //   BUY orders:
  //     1. Fresh keypair generated in-browser (never persisted)
  //     2. Real wallet sends USDC to ephemeral address (1 MetaMask tx)
  //     3. Ephemeral key signs CommitOrder + EIP-3009 (0 MetaMask popups!)
  //     4. On-chain: Transfer(ephemeralAddress → vault) — NOT realWallet!
  //     5. Claim: POST /claim-proof to relayer — relayer generates ZK proof + submits on-chain
  //   SELL orders: unchanged (real wallet signs everything; YES tokens must come from real wallet)
  // YES_BUY=0, YES_SELL=1, NO_BUY=2, NO_SELL=3 (matches BatchVault v8 OrderSide enum)
  const YES_BUY = 0;

  const handleOrderSubmit = async (params: {
    commitment: `0x${string}`;
    amount: bigint;
    salt: `0x${string}`;
    side: number;
    limitPrice: bigint;
  }) => {
    setChainError(null);
    const contracts = getContracts(ACTIVE_CHAIN.id);
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min from now

    setSubmitStep("approving");
    const walletClient = await ensureAmoy();

    // ── BUY ORDER: ephemeral wallet pattern ──────────────────────────────────
    if (params.side === YES_BUY) {
      // 1. Generate fresh ephemeral keypair (in-memory only)
      const ephemeralPrivateKey = generatePrivateKey();
      const ephemeralAccount    = privateKeyToAccount(ephemeralPrivateKey);
      const ephemeralAddress    = ephemeralAccount.address;

      // 2a. RAILGUN PRIVATE MODE (mainnet only) — pause here and show the Railgun UI.
      //     The polling effect (above) will detect the balance and resume the order.
      //     On-chain: Transfer(RailgunContract → ephemeral) — Alice's address is NOT visible.
      if (useRailgun && IS_MAINNET) {
        setRailgunPending({ ephemeralPrivateKey, ephemeralAddress, fundingAmount: params.amount, params, batchId: batch.batchId, deadline, contracts });
        setSubmitStep("railgun");
        return; // resumed by the railgunPending useEffect above
      }

      // 2b. DIRECT MODE — fund ephemeral with a plain USDC transfer from Alice's wallet.
      //     Less private: on-chain Transfer(Alice → ephemeral) is visible.
      //     "FUNDING EPHEMERAL WALLET…" shown here — submitStep = "approving"

      // Pre-flight balance check — gives a clear human-readable error before
      // hitting the wallet. USDC.e uses old SafeMath that reverts with empty bytes,
      // so without this check viem would show "Unexpected error".
      const usdcBalance = await publicClient.readContract({
        address: contracts.usdc,
        abi:     ERC20_ABI,
        functionName: "balanceOf",
        args:    [walletAddress!],
      }) as bigint;
      if (usdcBalance < params.amount) {
        const have = (Number(usdcBalance) / 1e6).toFixed(2);
        const need = (Number(params.amount) / 1e6).toFixed(2);
        throw new Error(`Insufficient USDC balance — you have $${have} but need $${need} USDC.e on Polygon. Bridge or swap USDC to Polygon first.`);
      }

      // Send USDC via raw provider.request (no EIP-1559 fields — viem's writeContract
      // adds maxFeePerGas/type=2 which some wallets reject on Polygon). Privy's
      // getEthereumProvider() routes to whichever wallet the user connected.
      const userProvider = await wallet.getEthereumProvider();
      const txParams = {
        from: walletAddress,
        to:   contracts.usdc as string,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ephemeralAddress, params.amount] }),
        gas:  `0x${(100_000n).toString(16)}`,   // 100k — ERC-20 transfer uses ~50k
      };
      let fundTx: `0x${string}`;
      try {
        fundTx = await userProvider.request({ method: "eth_sendTransaction", params: [txParams] }) as `0x${string}`;
      } catch (err0: any) {
        if (err0?.code === 4100 || err0?.message?.includes("Unauthorized")) {
          // Retry once on 4100 — do NOT call eth_requestAccounts first; Privy intercepts
          // it and shows a SIWE popup on Ethereum instead of re-authorizing the session.
          fundTx = await userProvider.request({ method: "eth_sendTransaction", params: [txParams] }) as `0x${string}`;
        } else {
          throw err0;
        }
      }
      await publicClient.waitForTransactionReceipt({ hash: fundTx });

      // 3. In-browser wallet client for ephemeral key — no MetaMask popups from here on
      const ephemeralWalletClient = createWalletClient({
        account:   ephemeralAccount,
        chain:     ACTIVE_CHAIN,
        transport: http(),
      });

      // 4. Recompute commitment (no trader address — salt is the 256-bit secret credential)
      // Use `id` (the Polymarket conditionId from the URL) — NOT batch.batchMarketId,
      // which is bytes32(0) when no batch is open yet (MOCK_BATCH). The contract verifies
      // commitment hashes using batch.marketId at settlement, so they must match.
      const actualCommitment = computeCommitment({
        marketId:   id as `0x${string}`,
        side:       params.side,
        amount:     params.amount,
        limitPrice: params.limitPrice,
        salt:       params.salt,
      });

      // 5. Ephemeral nonce (fresh address, always 0 on first use)
      const ephemeralNonce = await publicClient.readContract({
        address: contracts.batchVault,
        abi:     BATCH_VAULT_ABI,
        functionName: "nonces",
        args:    [ephemeralAddress],
      }) as bigint;

      setSubmitStep("signing");

      // 6. Sign CommitOrder EIP-712 from ephemeral key — no MetaMask popup!
      //    v6 contract: batchId removed from CommitOrder type — sig valid for any batch,
      //    enabling automatic requeue of excluded orders into the next batch.
      const COMMIT_ORDER_TYPES = {
        CommitOrder: [
          { name: "commitment", type: "bytes32" },
          { name: "amount",     type: "uint256" },
          { name: "nonce",      type: "uint256" },
          { name: "deadline",   type: "uint256" },
        ],
      } as const;
      const COMMIT_ORDER_DOMAIN = {
        name: "BatchVault", version: "1", chainId: BigInt(ACTIVE_CHAIN.id), verifyingContract: contracts.batchVault,
      } as const;

      const signature = await ephemeralWalletClient.signTypedData({
        account:     ephemeralAccount,
        domain:      COMMIT_ORDER_DOMAIN,
        types:       COMMIT_ORDER_TYPES,
        primaryType: "CommitOrder",
        message: { commitment: actualCommitment, amount: params.amount, nonce: ephemeralNonce, deadline },
      });

      // Pre-sign 2 requeue sigs (nonce+1, nonce+2) silently — invisible to user, ~2ms.
      // If this order is excluded at clearing, the relayer auto-requeues it (up to 2 times).
      const requeueDeadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
      const requeueSig1 = await ephemeralWalletClient.signTypedData({
        account:     ephemeralAccount,
        domain:      COMMIT_ORDER_DOMAIN,
        types:       COMMIT_ORDER_TYPES,
        primaryType: "CommitOrder",
        message: { commitment: actualCommitment, amount: params.amount, nonce: ephemeralNonce + 1n, deadline: requeueDeadline },
      });
      const requeueSig2 = await ephemeralWalletClient.signTypedData({
        account:     ephemeralAccount,
        domain:      COMMIT_ORDER_DOMAIN,
        types:       COMMIT_ORDER_TYPES,
        primaryType: "CommitOrder",
        message: { commitment: actualCommitment, amount: params.amount, nonce: ephemeralNonce + 2n, deadline: requeueDeadline },
      });
      const requeueAuths = [
        { ephemeral: ephemeralAddress, nonce: (ephemeralNonce + 1n).toString(), deadline: requeueDeadline.toString(), signature: requeueSig1 },
        { ephemeral: ephemeralAddress, nonce: (ephemeralNonce + 2n).toString(), deadline: requeueDeadline.toString(), signature: requeueSig2 },
      ];

      // 7. Sign EIP-3009 TransferWithAuthorization from ephemeral key — no MetaMask popup!
      //    from = ephemeralAddress: USDC moves ephemeral → vault at settlement (NOT realWallet!)
      const nonceBytes = new Uint8Array(32);
      crypto.getRandomValues(nonceBytes);
      const transferNonce = ("0x" + Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

      const validAfter  = 0n;
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 7200);

      const transferSig = await ephemeralWalletClient.signTypedData({
        account: ephemeralAccount,
        domain: {
          name:              "USD Coin (Test)",
          version:           "1",
          chainId:           BigInt(ACTIVE_CHAIN.id),
          verifyingContract: contracts.usdc,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from",        type: "address" },
            { name: "to",          type: "address" },
            { name: "value",       type: "uint256" },
            { name: "validAfter",  type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce",       type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from:        ephemeralAddress,  // ← ephemeral, NOT realWallet — privacy!
          to:          contracts.batchVault,
          value:       params.amount,
          validAfter,
          validBefore,
          nonce:       transferNonce,
        },
      });

      const r = transferSig.slice(0, 66) as `0x${string}`;
      const s = ("0x" + transferSig.slice(66, 130)) as `0x${string}`;
      const v = parseInt(transferSig.slice(130, 132), 16);
      const transferAuth = {
        validAfter:  validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce:       transferNonce,
        v, r, s,
      };

      // Ephemeral private key is saved in localStorage below for USDC recovery.
      // If settlement ever fails, the user can import ephemeralKey into MetaMask and sweep USDC back.

      // 8. POST to relayer
      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

      const resp = await fetch(`${relayerUrl}/order`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId:     id,
          batchId:      batch.batchId.toString(),
          signer:       ephemeralAddress,  // ← ephemeral, NOT realWallet
          side:         params.side,
          amount:       params.amount.toString(),
          limitPrice:   params.limitPrice.toString(),
          salt:         params.salt,
          commitment:   actualCommitment,
          signature,
          nonce:        ephemeralNonce.toString(),
          deadline:     deadline.toString(),
          transferAuth,
          requeueAuths,
        }),
      });

      const relayerData = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(relayerData.error ?? `Relayer returned ${resp.status}`);
      }
      // Use actual batchId from relayer (may differ from batch.batchId when batch
      // was just opened on-demand for this market).
      const actualBatchId: string = relayerData.batchId ?? batch.batchId.toString();

      // Update local state optimistically
      if (walletAddress) {
        setCommitments((prev) => [
          ...prev,
          { hash: actualCommitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() },
        ]);
        setBatch((prev) => ({
          ...prev,
          commitmentCount: prev.commitmentCount + 1,
          totalDeposited:  prev.totalDeposited + params.amount,
        }));
      }

      setActiveTab("positions");

      // Persist locally — store order preimage for ZK claim proof at claim time.
      // ephemeralKey stored for USDC recovery: if settlement ever fails, import it
      // into MetaMask (Account → Import account → Private key) to sweep USDC back.
      // Privacy note: ephemeralKey is stored locally only — it never appears on-chain.
      try {
        const key = `predacy:orders:${walletAddress!.toLowerCase()}`;
        const existing: unknown[] = JSON.parse(localStorage.getItem(key) ?? "[]");
        existing.unshift({
          commitment:      actualCommitment,
          salt:            params.salt,
          amount:          params.amount.toString(),
          side:            params.side,
          limitPrice:      params.limitPrice.toString(),
          batchId:         actualBatchId,
          marketId:        id,
          marketQuestion:  market?.question ?? null,
          timestamp:       Date.now(),
          ephemeralKey:    ephemeralPrivateKey,   // recovery: import into MetaMask if stuck
          ephemeralAddress: ephemeralAddress,
        });
        localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
      } catch { /* ignore quota / SSR errors */ }

      return; // ← buy order done
    }

    // ── SELL ORDER: real wallet signs everything (unchanged) ─────────────────
    // Sell orders cannot use ephemeral wallets — YES tokens must come from the real wallet.

    // Step 1 — CTF operator approval for YES token transfer (if not already approved)
    let isApproved = false;
    try {
      isApproved = await publicClient.readContract({
        address: contracts.ctf,
        abi: CTF_ABI,
        functionName: "isApprovedForAll",
        args: [walletAddress!, contracts.batchVault],
      }) as boolean;
    } catch {
      isApproved = false;
    }

    if (!isApproved) {
      const approveTx = await walletClient.writeContract({
        address: contracts.ctf,
        abi: CTF_ABI,
        functionName: "setApprovalForAll",
        args: [contracts.batchVault, true],
        ...CHAIN_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    // Step 2 — read nonce for real wallet
    const nonce = await publicClient.readContract({
      address: contracts.batchVault,
      abi: BATCH_VAULT_ABI,
      functionName: "nonces",
      args: [walletAddress!],
    }) as bigint;

    setSubmitStep("signing");

    // Step 3 — sign CommitOrder EIP-712 from real wallet (MetaMask popup).
    // v6 contract: batchId removed from type — no requeue sigs for sells
    // (YES tokens are pre-deposited; requeue is buy-order-only).
    const signature = await walletClient.signTypedData({
      account: walletAddress!,
      domain: {
        name: "BatchVault",
        version: "1",
        chainId: BigInt(ACTIVE_CHAIN.id),
        verifyingContract: contracts.batchVault,
      },
      types: {
        CommitOrder: [
          { name: "commitment", type: "bytes32" },
          { name: "amount",     type: "uint256" },
          { name: "nonce",      type: "uint256" },
          { name: "deadline",   type: "uint256" },
        ],
      },
      primaryType: "CommitOrder",
      message: {
        commitment: params.commitment,
        amount:     params.amount,
        nonce,
        deadline,
      },
    });

    // Step 4 — POST to relayer (no transferAuth for sell orders)
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

    const resp = await fetch(`${relayerUrl}/order`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId:   id,
        batchId:    batch.batchId.toString(),
        signer:     walletAddress,
        side:       params.side,
        amount:     params.amount.toString(),
        limitPrice: params.limitPrice.toString(),
        salt:       params.salt,
        commitment: params.commitment,
        signature,
        nonce:      nonce.toString(),
        deadline:   deadline.toString(),
        transferAuth: undefined,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Relayer error" }));
      throw new Error(err.error ?? `Relayer returned ${resp.status}`);
    }

    if (walletAddress) {
      setCommitments((prev) => [
        ...prev,
        { hash: params.commitment, amount: params.amount, trader: walletAddress, timestamp: Date.now() },
      ]);
      setBatch((prev) => ({
        ...prev,
        commitmentCount: prev.commitmentCount + 1,
        totalDeposited:  prev.totalDeposited, // sell orders don't add USDC
      }));
    }

    setActiveTab("positions");

    try {
      const key = `predacy:orders:${walletAddress!.toLowerCase()}`;
      const existing: unknown[] = JSON.parse(localStorage.getItem(key) ?? "[]");
      existing.unshift({
        commitment:     params.commitment,
        salt:           params.salt,
        amount:         params.amount.toString(),
        side:           params.side,
        limitPrice:     params.limitPrice.toString(),
        batchId:        batch.batchId.toString(),
        marketId:       id,
        marketQuestion: market?.question ?? null,
        timestamp:      Date.now(),
        // No ephemeral wallet for sell orders — real wallet signs everything directly
      });
      localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
    } catch { /* ignore quota / SSR errors */ }
  };

  // ── USDC faucet (Amoy only) ──────────────────────────────────────────────────
  const handleGetTestUsdc = async () => {
    if (!walletAddress || !wallet) return;
    setFaucetLoading(true);
    try {
      // ensureAmoy() switches to Amoy first, then returns a ready walletClient
      const walletClient = await ensureAmoy();
      const contracts = getContracts(ACTIVE_CHAIN.id);
      const tx = await walletClient.writeContract({
        address: contracts.usdc,
        abi: MOCK_USDC_ABI,
        functionName: "mint",
        args: [walletAddress, 10_000_000_000n], // $10,000 USDC
        ...CHAIN_GAS,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
    } catch (e: any) {
      if (e?.code !== 4001) { // ignore user rejection
        setChainError(e.message ?? "Faucet failed");
      }
    } finally {
      setFaucetLoading(false);
    }
  };

  // ── Claim position via ZK proof (relayer submits on-chain — no wallet tx needed) ──
  // The user provides a recipient address (defaults to their wallet).
  // The relayer generates a ZK proof of order membership and calls claimWithProof.
  // No wallet signing required — the salt in localStorage is the secret credential.
  const handleClaimPosition = async (batchId: bigint) => {
    setClaimLoading(true);
    setChainError(null);
    try {
      if (!walletAddress) throw new Error("Wallet not connected");
      const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
      const storedOrders: Array<{
        commitment: string; salt: string; isBuy: boolean;
        amount: string; limitPrice: string; batchId: string;
        marketId: string;
      }> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      const myOrder = storedOrders.find((o) => o.batchId === batchId.toString());
      if (!myOrder) throw new Error("Order preimage not found in local storage — cannot claim");
      if (!myOrder.marketId) throw new Error("Order is missing marketId — cannot claim");

      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

      // POST order preimage + desired recipient to relayer.
      // Relayer generates ZK proof and submits claimWithProof on-chain (relayer = msg.sender).
      // Recipient defaults to the user's connected wallet — can be any fresh address for privacy.
      const resp = await fetch(`${relayerUrl}/claim-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId:    batchId.toString(),
          marketId:   myOrder.marketId,
          isBuy:      myOrder.isBuy,
          amount:     myOrder.amount,
          limitPrice: myOrder.limitPrice,
          salt:       myOrder.salt,
          recipient:  walletAddress,   // payout goes to connected wallet
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? `Claim request failed (${resp.status})`);
      }

      const { txHash } = await resp.json();

      // Wait for the relayer's tx to land
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      if (receipt.status === "reverted") {
        throw new Error("Claim transaction reverted — the batch may not be fully settled yet. Try again in a few seconds.");
      }

      if (batchId === batch.batchId) {
        setPosition((p) => p ? { ...p, claimed: true } : p);
      }
      setBalanceVersion(v => v + 1);
    } catch (e: any) {
      if (e?.code !== 4001) setChainError(e.message ?? "Claim failed");
      throw e;
    } finally {
      setClaimLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!market) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <span className="text-muted text-xs tracking-widest uppercase">Market not found</span>
        <Link href="/" className="text-accent text-xs hover:underline">← Back to markets</Link>
      </div>
    );
  }

  const yesPrice = parseFloat(market.outcomePrices[0]);
  const yesProb  = Math.round(yesPrice * 100);

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xs text-text">{value}</span>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-4 md:px-6 py-4 flex items-center gap-4 bg-surface/35 backdrop-blur-[2px]">
        <Link
          href="/"
          className="text-muted hover:text-text transition-colors text-[11px] tracking-widest uppercase flex items-center gap-1.5"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
          </svg>
          Markets
        </Link>
        <span className="text-border">|</span>
        <h1
          className="text-lg font-black text-text tracking-tight leading-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          PREDACY
        </h1>
        <div className="ml-auto flex items-center gap-3">
          {/* Faucet button — testnet only (not shown on mainnet) */}
          {isConnected && !IS_MAINNET && (
            <button
              onClick={handleGetTestUsdc}
              disabled={faucetLoading}
              className="text-[10px] tracking-widest uppercase border border-border text-muted px-3 py-1.5 hover:border-border-bright hover:text-text transition-colors disabled:opacity-40"
            >
              {faucetLoading ? "MINTING…" : "GET TEST USDC"}
            </button>
          )}
          <WalletButton compact />
        </div>
      </header>

      {/* Chain error banner */}
      {chainError && (
        <div className="border-b border-danger/30 bg-danger/5 px-4 md:px-6 py-2 flex items-center justify-between gap-4">
          <p className="text-danger text-xs">{chainError}</p>
          <button onClick={() => setChainError(null)} className="text-danger/60 hover:text-danger text-xs">✕</button>
        </div>
      )}

      {/* (Market mismatch banner removed — each market now has its own batch slot) */}

      {/* Wrong-network banner */}
      {onWrongChain && (
        <div className="border-b border-yellow-500/30 bg-yellow-500/5 px-4 md:px-6 py-2">
          <p className="text-yellow-400 text-xs">
            {walletName && walletName !== "MetaMask"
              ? `Connected via ${walletName} on the wrong network. Click any action below — ${walletName} will be prompted to switch to ${ACTIVE_CHAIN_NAME}. If ${walletName} doesn't support it, disable it and reconnect with MetaMask.`
              : `Wrong network — click any action to switch to ${ACTIVE_CHAIN_NAME} automatically.`}
          </p>
        </div>
      )}

      {/* Market info bar */}
      <div className="border-b border-border px-4 md:px-6 py-5 bg-surface/20">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {market.category && (
              <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5 mb-2 inline-block">
                {market.category}
              </span>
            )}
            <h2 className="text-text text-[15px] leading-snug mt-1">{market.question}</h2>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className="text-[10px] text-muted tracking-widest uppercase">Polymarket Price</p>
            <p
              className={clsx(
                "text-3xl font-black leading-none",
                yesProb > 60 ? "text-accent glow-accent" : yesProb < 40 ? "text-danger glow-danger" : "text-blue glow-blue",
              )}
              style={{ fontFamily: "var(--font-display)" }}
            >
              {yesProb}%
            </p>
            <p className="text-[10px] text-muted mt-0.5">YES probability</p>
          </div>
        </div>
      </div>

      {/* Main layout: 3 columns */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] divide-x divide-border/90">

        {/* Column 1: Batch timer + stats */}
        <div className="p-4 md:p-6 flex flex-col gap-6 border-b lg:border-b-0 bg-surface/[0.18]">
          <BatchTimer
            openedAt={batch.openedAt}
            batchWindow={batch.batchWindow}
            commitmentCount={batch.commitmentCount}
            totalDeposited={batch.totalDeposited}
            batchId={batch.batchId}
            status={batch.status}
            clearingPrice={batch.clearingPrice}
          />

          {/* Market condition ID */}
          <div className="space-y-1">
            <p className="text-[10px] text-muted tracking-widest uppercase">Market ID</p>
            <p className="hash-text text-[11px] break-all">{id}</p>
          </div>

          {/* Privacy explainer */}
          <div className="border border-border p-3 space-y-2">
            <p className="text-[10px] text-muted-dim tracking-widest uppercase">Privacy status</p>
            <div className="space-y-1.5">
              {[
                { item: "Buy / Sell direction",          hidden: true,  note: "" },
                { item: "Your limit price",              hidden: true,  note: "" },
                { item: "Salt (blinding factor)",        hidden: true,  note: "" },
                { item: "Clearing price (until settle)", hidden: true,  note: "" },
                { item: "Commitment hash",               hidden: false, note: "order time" },
                { item: "Wallet address",                hidden: false, note: "at settlement" },
                { item: "Amount",                        hidden: false, note: "at settlement" },
              ].map(({ item, hidden, note }) => (
                <div key={item} className="flex items-center gap-2">
                  <span className={clsx("text-[10px]", hidden ? "text-accent/60" : "text-yellow-500/60")}>
                    {hidden ? "✓" : "◆"}
                  </span>
                  <span className={clsx("text-[11px]", hidden ? "text-text/70" : "text-muted-dim")}>
                    {item}
                  </span>
                  <span className={clsx(
                    "ml-auto text-[9px] tracking-widest uppercase",
                    hidden ? "text-accent/40" : "text-yellow-500/40"
                  )}>
                    {hidden ? "hidden" : note}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[9px] text-muted-dim pt-1 border-t border-border/40">
              You sign a time-locked USDC authorization off-chain (EIP-3009). The relayer submits it only if your order fills — at settlement, your address and amount appear on-chain. Zero relayer capital required.
            </p>
          </div>
        </div>

        {/* Column 2: Price chart + Commitment feed */}
        <div className="flex flex-col min-h-[400px] lg:min-h-0 border-b lg:border-b-0 bg-surface/[0.1]">
          {market.clobTokenIds?.[0] && (
            <PriceChart
              tokenId={market.clobTokenIds[0]}
              currentPrice={parseFloat(market.outcomePrices[0] ?? "0.5")}
            />
          )}
          <div className="flex-1 min-h-0">
            <CommitmentFeed entries={commitments} myAddress={walletAddress} />
          </div>
        </div>

        {/* Column 3: Order form / Positions */}
        <div className="flex flex-col bg-surface/[0.24]">
          {/* Column 3 header: tabs + batch status indicator */}
          <div className="border-b border-border px-4 py-0 flex items-center">
            {/* Tabs */}
            <div className="flex items-center flex-1">
              <button
                type="button"
                onClick={() => setActiveTab("order")}
                className={clsx(
                    "px-3 py-3 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                  activeTab === "order"
                    ? "border-accent/50 text-text bg-accent/10"
                    : "border-transparent text-muted hover:text-text"
                )}
              >
                Order
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("positions")}
                className={clsx(
                    "px-3 py-3 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                  activeTab === "positions"
                    ? "border-accent/50 text-text bg-accent/10"
                    : "border-transparent text-muted hover:text-text"
                )}
              >
                My Positions
              </button>
            </div>
            {/* Batch status dot */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className={clsx(
                "w-1.5 h-1.5 rounded-full",
                batch.status === BatchStatus.OPEN ? "bg-accent animate-pulse" : "bg-muted/40"
              )} />
              <span className={clsx(
                "text-[10px] tracking-widest uppercase",
                batch.status === BatchStatus.OPEN ? "text-accent/70" : "text-muted-dim"
              )}>
                {batch.status === BatchStatus.OPEN
                  ? "OPEN"
                  : batch.status === BatchStatus.SETTLING
                  ? "SETTLING"
                  : "SETTLED"}
              </span>
            </div>
          </div>

          {activeTab === "positions" ? (
            /* My Positions panel — multi-batch history + claim */
            isConnected && walletAddress ? (
              <PositionsPanel
                walletAddress={walletAddress}
                currentBatchId={batch.batchId}
                currentBatchStatus={batch.status}
                currentBatchClearingPrice={batch.clearingPrice}
                currentBatchCommitments={commitments
                  .filter((c) => c.trader === walletAddress)
                  .map((c) => ({ hash: c.hash, amount: c.amount }))}
                onClaim={handleClaimPosition}
                onMarketIdsFound={setHistoricalMarketIds}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
                <p className="text-muted text-xs text-center">Connect your wallet to view positions</p>
                <button
                  onClick={login}
                  className="border border-border-bright text-text text-[11px] tracking-widest uppercase px-4 py-2 hover:border-text/30 transition-colors"
                >
                  Connect Wallet
                </button>
              </div>
            )
          ) : batch.status === BatchStatus.SETTLED ? (
            /* Claim panel — shown on ORDER tab after batch settles */
            <div className="flex-1 p-5 flex flex-col gap-4">
              <div className="border border-border p-4 space-y-3">
                <Row
                  label="Clearing price"
                  value={
                    batch.clearingPrice > 0n
                      ? `${(Number(batch.clearingPrice) / 1e6 * 100).toFixed(1)}¢`
                      : "No cross"
                  }
                />
                {position && (
                  <div className="border-t border-border/40 pt-3 space-y-3">
                    <Row label="Side" value={
                      position.side === 0 ? "BUY YES" :
                      position.side === 1 ? "SELL YES" :
                      position.side === 2 ? "BUY NO" : "SELL NO"
                    } />
                    <Row label="Filled" value={`$${(Number(position.filledAmount) / 1e6).toFixed(2)}`} />
                    {position.refundAmount > 0n && (
                      <Row label="Refund" value={`$${(Number(position.refundAmount) / 1e6).toFixed(2)}`} />
                    )}
                  </div>
                )}
              </div>

              {/* Claim button / status */}
              {!isConnected ? (
                <button
                  onClick={login}
                  className="w-full border border-border text-muted text-[11px] tracking-widest uppercase py-3 hover:border-border-bright hover:text-text transition-colors"
                >
                  CONNECT TO CLAIM
                </button>
              ) : position === null ? (
                <p className="text-muted text-xs text-center animate-pulse">Loading position…</p>
              ) : position.claimed ? (
                <div className="space-y-2 text-center">
                  <p className="text-accent text-[11px] tracking-widest uppercase">✓ CLAIMED</p>
                  {position.filledAmount > 0n && (
                    <p className="text-muted-dim text-[10px]">
                      {(position.side === 0 || position.side === 2) && batch.clearingPrice > 0n
                        ? `~${(Number(position.filledAmount) / Number(batch.clearingPrice)).toFixed(2)} ${position.side === 2 ? "NO" : "YES"} tokens received`
                        : `$${(Number(position.filledAmount) / 1e6).toFixed(2)} USDC received`}
                      {position.refundAmount > 0n && ` + ${(position.side === 0 || position.side === 2)
                        ? `$${(Number(position.refundAmount) / 1e6).toFixed(2)} refund`
                        : `${(Number(position.refundAmount) / 1e6).toFixed(2)} ${position.side === 1 ? "YES" : "NO"} tokens refunded`}`}
                    </p>
                  )}
                </div>
              ) : position.filledAmount === 0n && position.refundAmount === 0n ? (
                <p className="text-muted text-xs text-center">No position in this batch</p>
              ) : (
                <button
                  onClick={() => handleClaimPosition(batch.batchId)}
                  disabled={claimLoading}
                  className="w-full border border-accent text-accent text-[11px] tracking-widest uppercase py-3 hover:bg-accent/5 transition-colors disabled:opacity-40"
                >
                  {claimLoading ? "CLAIMING…" : "CLAIM POSITION"}
                </button>
              )}
            </div>
          ) : railgunPending ? (
            /* ── Railgun private-mode: waiting for ephemeral wallet to be funded ── */
            <div className="flex-1 p-5 flex flex-col gap-4">
              <div className="border border-accent/30 bg-accent/5 p-4 space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-accent tracking-widest uppercase font-bold">
                    Private Mode — Awaiting Railgun Transfer
                  </p>
                  <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                </div>

                {/* Instructions */}
                <ol className="space-y-2 text-[11px] text-muted-dim">
                  <li className="flex gap-2">
                    <span className="text-accent/60 flex-shrink-0">1.</span>
                    Open{" "}
                    <a
                      href="https://app.railgun.org"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline hover:text-accent/80"
                    >
                      app.railgun.org
                    </a>
                    {" "}→ Unshield
                  </li>
                  <li className="flex gap-2">
                    <span className="text-accent/60 flex-shrink-0">2.</span>
                    Send exactly{" "}
                    <span className="text-text font-mono">
                      ${(Number(railgunPending.fundingAmount) / 1e6).toFixed(2)} USDC
                    </span>{" "}
                    to the address below
                  </li>
                  <li className="flex gap-2">
                    <span className="text-accent/60 flex-shrink-0">3.</span>
                    Return here — order continues automatically
                  </li>
                </ol>

                {/* Ephemeral address */}
                <div className="space-y-1">
                  <p className="text-[9px] text-muted tracking-widest uppercase">Ephemeral address (fund this)</p>
                  <div className="flex items-center gap-2">
                    <code className="hash-text text-[10px] text-accent/80 break-all flex-1">
                      {railgunPending.ephemeralAddress}
                    </code>
                    <button
                      onClick={() => navigator.clipboard.writeText(railgunPending.ephemeralAddress)}
                      className="text-[9px] text-muted hover:text-text transition-colors tracking-widest uppercase border border-border px-2 py-1 flex-shrink-0"
                    >
                      COPY
                    </button>
                  </div>
                </div>

                {/* Balance progress */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[9px] text-muted tracking-widest uppercase">
                    <span>Balance received</span>
                    <span>
                      ${(Number(railgunBalance) / 1e6).toFixed(2)} / ${(Number(railgunPending.fundingAmount) / 1e6).toFixed(2)} USDC
                    </span>
                  </div>
                  <div className="h-0.5 bg-border">
                    <div
                      className="h-full bg-accent transition-all duration-500"
                      style={{ width: `${Math.min(100, railgunBalance > 0n ? Number((railgunBalance * 100n) / railgunPending.fundingAmount) : 0)}%` }}
                    />
                  </div>
                </div>

                <p className="text-[9px] text-muted-dim">
                  Why Railgun? Your wallet address never appears on-chain as the sender —
                  only the Railgun smart contract is visible. This breaks the link between
                  your identity and this order.
                </p>
              </div>

              {/* Cancel button */}
              <button
                onClick={() => { setRailgunPending(null); setSubmitStep(null); }}
                className="text-[10px] tracking-widest uppercase text-muted hover:text-text transition-colors border border-border px-4 py-2"
              >
                CANCEL — USE DIRECT TRANSFER INSTEAD
              </button>
            </div>
          ) : (
            /* Order form — shown while batch is OPEN or SETTLING */
            <div className="flex-1">
              {/* Private Mode toggle — mainnet only (Railgun not on testnet) */}
              {IS_MAINNET && (
                <div className="border-b border-border px-4 py-2 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[10px] text-text tracking-widest uppercase">Private Mode</span>
                    <span className="text-[9px] text-muted-dim">Fund via Railgun — hides wallet link</span>
                  </div>
                  <button
                    onClick={() => setUseRailgun((v) => !v)}
                    className={clsx(
                      "relative w-8 h-4 rounded-full transition-colors",
                      useRailgun ? "bg-accent/40" : "bg-border",
                    )}
                    aria-label="Toggle Private Mode"
                  >
                    <span className={clsx(
                      "absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform",
                      useRailgun ? "translate-x-4 bg-accent" : "translate-x-0 bg-muted",
                    )} />
                  </button>
                </div>
              )}
              <OrderForm
                market={market}
                marketId={batch.batchMarketId}
                batchOpen={batch.status === BatchStatus.OPEN}
                onSubmit={handleOrderSubmit}
                walletAddress={walletAddress}
                isConnected={isConnected}
                onConnect={login}
                submitStep={submitStep}
                balanceVersion={balanceVersion}
                candidateMarketIds={[batch.batchMarketId, ...historicalMarketIds]}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
