import axios from "axios";
import { createHmac } from "node:crypto";
import { createPublicClient, http, decodeFunctionData, hashTypedData } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { PolymarketMarket } from "./types.js";

const CLOB_API  = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/**
 * Polymarket exchange contracts on Polygon mainnet.
 * Standard CTFExchange: binary/scalar markets.
 * NegRiskExchange: group/neg-risk markets (most live markets, e.g. EPL, US elections).
 * All orders are signed against the correct contract's EIP-712 domain.
 */
const CTF_EXCHANGE      = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const;
const POLYGON_CHAIN_ID  = 137;

/**
 * EIP-712 domains — one per exchange contract.
 * Fixed to Polygon mainnet — Polymarket CLOB only operates on mainnet.
 * Domain name MUST be "Polymarket CTF Exchange" (matches on-chain DOMAIN_SEPARATOR).
 */
const POLYMARKET_DOMAIN = {
  name:              "Polymarket CTF Exchange",
  version:           "1",
  chainId:           POLYGON_CHAIN_ID,
  verifyingContract: CTF_EXCHANGE,
} as const;

const NEG_RISK_DOMAIN = {
  name:              "Polymarket CTF Exchange",
  version:           "1",
  chainId:           POLYGON_CHAIN_ID,
  verifyingContract: NEG_RISK_EXCHANGE,
} as const;

/**
 * EIP-712 Order type definition.
 * Matches the Order struct in Polymarket's CTFExchange contract.
 */
const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ],
} as const;

const SIDE_BUY  = 0;
const SIDE_SELL = 1;
const SIG_TYPE_EOA = 0;  // normal ECDSA from EOA
const TAKER_ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// ─── On-chain decoding constants (v7.2 vault-as-taker) ───────────────────────

/** ABI for decoding CTFExchange fillOrders / fillOrder calldata */
const FILL_ORDERS_ABI = [
  {
    name: "fillOrders",
    type: "function",
    inputs: [
      {
        name: "makerOrders",
        type: "tuple[]",
        components: [
          { name: "salt",          type: "uint256" },
          { name: "maker",         type: "address" },
          { name: "signer",        type: "address" },
          { name: "taker",         type: "address" },
          { name: "tokenId",       type: "uint256" },
          { name: "makerAmount",   type: "uint256" },
          { name: "takerAmount",   type: "uint256" },
          { name: "expiration",    type: "uint256" },
          { name: "nonce",         type: "uint256" },
          { name: "feeRateBps",    type: "uint256" },
          { name: "side",          type: "uint8"   },
          { name: "signatureType", type: "uint8"   },
          { name: "signature",     type: "bytes"   },
        ],
      },
      { name: "fillAmounts", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "fillOrder",
    type: "function",
    inputs: [
      {
        name: "makerOrder",
        type: "tuple",
        components: [
          { name: "salt",          type: "uint256" },
          { name: "maker",         type: "address" },
          { name: "signer",        type: "address" },
          { name: "taker",         type: "address" },
          { name: "tokenId",       type: "uint256" },
          { name: "makerAmount",   type: "uint256" },
          { name: "takerAmount",   type: "uint256" },
          { name: "expiration",    type: "uint256" },
          { name: "nonce",         type: "uint256" },
          { name: "feeRateBps",    type: "uint256" },
          { name: "side",          type: "uint8"   },
          { name: "signatureType", type: "uint8"   },
          { name: "signature",     type: "bytes"   },
        ],
      },
      { name: "fillAmount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** ABI for CTFExchange.getOrderStatus */
const ORDER_STATUS_ABI = [
  {
    name: "getOrderStatus",
    type: "function",
    inputs:  [{ name: "orderHash", type: "bytes32" }],
    outputs: [
      { name: "isFilledOrCancelled", type: "bool"    },
      { name: "remaining",           type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

/** EIP-712 Order struct fields used for hashing (no `signature` field). */
const ORDER_TYPES_FOR_HASH = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ],
} as const;

// Gamma API returns some fields as JSON-encoded strings — parse them.
function normalizeMarket(m: any): PolymarketMarket {
  const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    ...m,
    tokens:        parse(m.tokens)        ?? [],
    outcomes:      parse(m.outcomes)      ?? [],
    outcomePrices: parse(m.outcomePrices) ?? [],
    clobTokenIds:  parse(m.clobTokenIds)  ?? [],
    // Live price fields only present on /events endpoint responses.
    bestBid:        typeof m.bestBid        === "number" ? m.bestBid        : undefined,
    bestAsk:        typeof m.bestAsk        === "number" ? m.bestAsk        : undefined,
    lastTradePrice: typeof m.lastTradePrice === "number" ? m.lastTradePrice : undefined,
  };
}

/**
 * Polymarket CLOB REST API client.
 *
 * Auth: two-layer scheme.
 *
 *   Layer 1 — HTTP request signing (all authenticated endpoints):
 *     Headers: POLY-API-KEY, POLY-SIGNATURE, POLY-TIMESTAMP, POLY-PASSPHRASE
 *     Signature = base64( HMAC-SHA256( apiSecret, timestamp + method + path + body ) )
 *     Docs: https://docs.polymarket.com/#authentication
 *
 *   Layer 2 — EIP-712 order signing (POST /order only):
 *     Each order is signed with an Ethereum private key against the CTFExchange
 *     EIP-712 domain. The signature is embedded in the order body.
 *     The `maker` address must match the address that created the API key.
 *
 * To obtain API keys:
 *   1. Go to polymarket.com, connect your wallet
 *   2. Settings → API Keys → Generate new key
 *   3. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE in .env
 *
 * The `signerPrivateKey` must be the Ethereum private key of the wallet used to
 * create the API key. Set POLYMARKET_SIGNER_KEY in .env (falls back to RELAYER_PRIVATE_KEY).
 */
export class PolymarketClient {
  private apiKey:        string;
  private apiSecret:     string;
  private apiPassphrase: string;
  private account:       ReturnType<typeof privateKeyToAccount> | null;
  /** Polymarket proxy wallet address (maker). If set, used as `maker`; signer stays as EOA. */
  private proxyWallet:   string | null;
  /** In-process cache: conditionId (lower) → PolymarketMarket */
  private _marketCache  = new Map<string, PolymarketMarket>();
  /** In-process cache: tokenId → isNegRisk (avoids repeated /neg-risk lookups per session) */
  private _negRiskCache = new Map<string, boolean>();
  /** Alchemy/custom RPC URL for on-chain scanning (uses default polygon RPC if unset) */
  private rpcUrl: string | undefined;

  /** Builder API credentials (optional) — adds POLY_BUILDER_* headers for order attribution */
  private builderKey:        string | null;
  private builderSecret:     string | null;
  private builderPassphrase: string | null;

  constructor(
    apiKey:        string,
    apiSecret:     string,
    apiPassphrase: string,
    signerPrivateKey?: `0x${string}`,
    proxyWallet?:  string,
    rpcUrl?:       string,
    builderKey?:        string,
    builderSecret?:     string,
    builderPassphrase?: string,
  ) {
    this.apiKey        = apiKey;
    this.apiSecret     = apiSecret;
    this.apiPassphrase = apiPassphrase;
    this.account       = signerPrivateKey ? privateKeyToAccount(signerPrivateKey) : null;
    this.proxyWallet   = proxyWallet ?? null;
    this.rpcUrl        = rpcUrl;
    this.builderKey        = builderKey        ?? null;
    this.builderSecret     = builderSecret     ?? null;
    this.builderPassphrase = builderPassphrase ?? null;
  }

  // ─── Market data (no auth required) ────────────────────────────────────────

  /** Fetch active markets from Polymarket Gamma API */
  async getMarkets(limit = 20, offset = 0): Promise<PolymarketMarket[]> {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { limit, offset, active: true, closed: false },
    });
    return (res.data ?? []).map(normalizeMarket);
  }

  /**
   * Get a single market by its Polymarket conditionId.
   *
   * IMPORTANT: The Gamma /markets?condition_id= endpoint matches against questionId,
   * not conditionId, for neg-risk / group markets. This means it can return an entirely
   * wrong market (e.g. a closed 2020 market whose questionId happens to equal our
   * conditionId). We validate the returned conditionId and fall back to a full events
   * search if there's a mismatch. Results are cached in-process to avoid repeating
   * the expensive events search on every batch settlement.
   */
  async getMarket(conditionId: string): Promise<PolymarketMarket> {
    const lower = conditionId.toLowerCase();
    const cached = this._marketCache.get(lower);
    if (cached) return cached;

    // Try the fast /markets path first.
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { condition_id: conditionId },
    });
    if (res.data?.length) {
      const market = normalizeMarket(res.data[0]);
      if (market.conditionId?.toLowerCase() === lower) {
        this._marketCache.set(lower, market);
        return market;
      }
      // Wrong market returned — fall through to events search.
      console.warn(
        `[PolymarketClient] getMarket(${conditionId.slice(0, 10)}…): ` +
        `/markets?condition_id= returned wrong market (got ${market.conditionId?.slice(0, 10)}…) ` +
        `— searching /events instead`,
      );
    }

    return await this._findMarketInEvents(conditionId);
  }

  /**
   * Search active events for a market whose conditionId matches exactly.
   * Used as fallback when /markets?condition_id= returns the wrong market.
   * The Gamma /events endpoint includes bestBid, bestAsk, lastTradePrice directly
   * on each market — more reliable than CLOB for group / neg-risk markets.
   */
  private async _findMarketInEvents(conditionId: string): Promise<PolymarketMarket> {
    const lower = conditionId.toLowerCase();
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const res = await axios.get(`${GAMMA_API}/events`, {
        params: { active: true, closed: false, limit, offset },
      });
      const events: any[] = res.data ?? [];
      if (!events.length) break;

      for (const event of events) {
        for (const m of event.markets ?? []) {
          if (m.conditionId?.toLowerCase() === lower) {
            const market = normalizeMarket(m);
            this._marketCache.set(lower, market);
            console.log(
              `[PolymarketClient] getMarket(${conditionId.slice(0, 10)}…): ` +
              `found in /events (event="${event.title ?? event.slug}", offset=${offset}) ` +
              `bestBid=${market.bestBid} bestAsk=${market.bestAsk} lastTrade=${market.lastTradePrice}`,
            );
            return market;
          }
        }
      }

      if (events.length < limit) break; // last page
    }
    throw new Error(`Market not found in /markets or /events: ${conditionId}`);
  }

  /**
   * Get the current mid-price for a token (YES or NO token ID).
   *
   * Primary:  GET /midpoint — requires active resting orders on both sides.
   * Fallback: GET /last-trade-price — most recent matched trade; available
   *           even when no resting orders exist (illiquid / thin markets).
   *
   * Polymarket CLOB signals "no orderbook" in two ways depending on conditions:
   *   • HTTP 404 with body { error: "No orderbook exists for the requested token id" }
   *   • HTTP 200 with body { mid: "0.5" }  ← sentinel / default value
   * Both are treated as "no real price" and fall through to last-trade-price.
   */
  async getMidPrice(tokenId: string): Promise<number> {
    try {
      const res = await axios.get(`${CLOB_API}/midpoint`, {
        params: { token_id: tokenId },
      });
      const mid = parseFloat(res.data.mid ?? "0");
      // Reject the sentinel: CLOB returns exactly 0.5 when there are no resting orders.
      // A real mid is almost never exactly 0.5 (would require a perfectly symmetric book).
      if (mid > 0 && mid < 1 && mid !== 0.5) {
        console.log(`[PolymarketClient] getMidPrice token=${tokenId.slice(0, 8)}…: /midpoint → ${mid}`);
        return mid;
      }
      console.log(`[PolymarketClient] getMidPrice token=${tokenId.slice(0, 8)}…: /midpoint returned sentinel ${mid}, trying /last-trade-price`);
    } catch (err: any) {
      // 404 = "No orderbook exists" — fall through. Any other error: re-throw.
      if (err?.response?.status !== 404) throw err;
      console.log(`[PolymarketClient] getMidPrice token=${tokenId.slice(0, 8)}…: /midpoint 404, trying /last-trade-price`);
    }

    // /midpoint returned sentinel (0.5) or 404 — use the last matched trade price instead.
    const fallback = await axios.get(`${CLOB_API}/last-trade-price`, {
      params: { token_id: tokenId },
    });
    const price = parseFloat(fallback.data.price ?? "0");
    console.log(`[PolymarketClient] getMidPrice token=${tokenId.slice(0, 8)}…: /last-trade-price → ${price}`);
    if (price > 0) return price;
    throw new Error(`No usable price for token ${tokenId} (mid was sentinel, no last-trade-price)`);
  }

  /** Get the order book for a token */
  async getOrderBook(tokenId: string): Promise<{ bids: PriceLevel[]; asks: PriceLevel[] }> {
    const res = await axios.get(`${CLOB_API}/book`, {
      params: { token_id: tokenId },
    });
    return {
      bids: res.data.bids?.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })) ?? [],
      asks: res.data.asks?.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })) ?? [],
    };
  }

  /** Get the current best ask (cheapest YES tokens) for a market. */
  async getBestAsk(tokenId: string): Promise<number> {
    const book = await this.getOrderBook(tokenId);
    if (!book.asks.length) throw new Error(`No asks for token ${tokenId}`);
    return book.asks.sort((a, b) => a.price - b.price)[0].price;
  }

  // ─── Order execution (requires auth + EIP-712 signing) ─────────────────────

  /**
   * Place a market-like buy order for YES tokens on Polymarket's CLOB.
   * Uses a FOK (fill-or-kill) order at mid + 1% slippage so it fills immediately.
   *
   * Polymarket CLOB does not have a true "MARKET" order type. FOK with an
   * aggressive limit achieves the same effect in normal liquidity conditions.
   *
   * @param tokenId    YES (or NO) token ID from market.tokens[].token_id
   * @param usdcAmount USDC to spend (bigint, 6 decimals — e.g. 1_000_000n = $1)
   * @returns orderId and the limit price used (as a float in [0, 1])
   */
  async placeMarketBuy(
    tokenId:    string,
    usdcAmount: bigint,
  ): Promise<{ orderId: string; limitPrice: number }> {
    this._requireSigner();
    const mid = await this.getMidPrice(tokenId);
    // Accept up to 1% above mid — ensures fill without excess slippage
    const limitPrice = parseFloat(Math.min(0.999, mid * 1.01).toFixed(4));

    // makerAmount = USDC to spend (must be multiple of 10000 — 0.01 USDC precision)
    // takerAmount = tokens to receive (must be multiple of 10 — 0.00001 token precision)
    const makerAmount = (usdcAmount / 10000n) * 10000n;
    const takerAmountRaw = BigInt(Math.round(Number(makerAmount) / limitPrice));
    const takerAmount   = (takerAmountRaw / 10n) * 10n;

    const { body, orderId } = await this._buildSignedOrder(
      tokenId, makerAmount, takerAmount, SIDE_BUY, limitPrice, "FOK",
    );

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });

    return { orderId: (res.data.orderID ?? res.data.orderId ?? orderId) as string, limitPrice };
  }

  /**
   * Place a market-like sell order for YES tokens on Polymarket's CLOB.
   * Uses a FOK (fill-or-kill) order at mid - 1% slippage so it fills immediately.
   *
   * @param tokenId   YES token ID from market.tokens[].token_id
   * @param yesAmount Number of YES tokens to sell (bigint, 6 decimals)
   * @returns orderId and the limit price used (as a float in [0, 1])
   */
  async placeMarketSell(
    tokenId:   string,
    yesAmount: bigint,
  ): Promise<{ orderId: string; limitPrice: number }> {
    this._requireSigner();
    const mid = await this.getMidPrice(tokenId);
    // Accept up to 1% below mid — ensures fill without excess slippage
    const limitPrice = parseFloat(Math.max(0.001, mid * 0.99).toFixed(4));

    // For SELL: makerAmount = tokens to sell (must be multiple of 10 — 0.00001 token precision)
    //           takerAmount = USDC to receive (must be multiple of 10000 — 0.01 USDC precision)
    const makerAmount = (yesAmount / 10n) * 10n;
    const takerAmountRaw = BigInt(Math.round(Number(makerAmount) * limitPrice));
    const takerAmount   = (takerAmountRaw / 10000n) * 10000n;

    const { body, orderId } = await this._buildSignedOrder(
      tokenId, makerAmount, takerAmount, SIDE_SELL, limitPrice, "FOK",
    );

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });

    return { orderId: (res.data.orderID ?? res.data.orderId ?? orderId) as string, limitPrice };
  }

  /**
   * Place a limit buy order on Polymarket's CLOB.
   *
   * @param tokenId    YES token ID
   * @param usdcAmount USDC to spend (bigint, 6 decimals)
   * @param limitPrice Price in [0,1] as a float (e.g. 0.65)
   * @returns orderId and the limit price used
   */
  async placeLimitBuy(
    tokenId:    string,
    usdcAmount: bigint,
    limitPrice: number,
  ): Promise<{ orderId: string; limitPrice: number }> {
    this._requireSigner();

    const makerAmount = (usdcAmount / 10000n) * 10000n;
    const takerAmountRaw = BigInt(Math.round(Number(makerAmount) / limitPrice));
    const takerAmount   = (takerAmountRaw / 10n) * 10n;

    const { body, orderId } = await this._buildSignedOrder(
      tokenId, makerAmount, takerAmount, SIDE_BUY, limitPrice, "GTC",
    );

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });

    return { orderId: (res.data.orderID ?? res.data.orderId ?? orderId) as string, limitPrice };
  }

  // ─── Settlement: buy YES tokens via CLOB before calling vault.settleBatch ───

  /**
   * Buy YES tokens from Polymarket CLOB for batch settlement (v7.3 relayer-intermediary).
   *
   * Places a FOK (fill-or-kill) market buy for `usdcToSpend` USDC.
   * Then polls the maker address's on-chain ERC-1155 balance until it reaches
   * `yesNeeded`, retrying up to 3 times if the first FOK doesn't deliver enough.
   *
   * The YES tokens must land in the maker address (= account.address in EOA mode,
   * or proxyWallet if set) — which must be the same address that calls settleBatch.
   *
   * @param tokenId     YES token ID (decimal string)
   * @param yesNeeded   Amount of YES tokens vault will pull (bigint, 6-dec)
   * @param usdcToSpend USDC amount to spend (= netBuyAmount from clearing, bigint, 6-dec)
   * @param ctfAddress  ConditionalTokens ERC-1155 contract address
   * @throws            If YES balance is still insufficient after 30s
   */
  async buyYesForSettlement(
    tokenId:    string,
    yesNeeded:  bigint,
    usdcToSpend: bigint,
    ctfAddress: string,
  ): Promise<void> {
    this._requireSigner();
    const makerAddress = this.account!.address;

    // ERC-1155 balanceOf ABI
    const ERC1155_BALANCE_OF = [{
      name: "balanceOf",
      type: "function",
      inputs:  [{ name: "account", type: "address" }, { name: "id", type: "uint256" }],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
    }] as const;

    const client = createPublicClient({
      chain:     polygon,
      transport: http(this.rpcUrl),
    });

    // Helper: read YES balance of maker address
    const getBalance = () => client.readContract({
      address:      ctfAddress as `0x${string}`,
      abi:          ERC1155_BALANCE_OF,
      functionName: "balanceOf",
      args:         [makerAddress, BigInt(tokenId)],
    }) as Promise<bigint>;

    // Check existing balance before buying
    const preBuyBalance = await getBalance();
    if (preBuyBalance >= yesNeeded) {
      console.log(`[PolymarketClient] Relayer already has ${preBuyBalance} YES — no CLOB buy needed`);
      return;
    }

    const deficit = yesNeeded - preBuyBalance;
    console.log(`[PolymarketClient] Need ${yesNeeded} YES, have ${preBuyBalance}, deficit=${deficit}`);

    // Build a FOK BUY order for exactly 'deficit' YES tokens (rounded up to CLOB token precision).
    // CLOB precision requirements:
    //   makerAmount (USDC):  must be a multiple of 10000 (= 0.01 USDC)
    //   takerAmount (token): must be a multiple of 10    (= 0.00001 token)
    // We ask for ceil(deficit / 10) * 10 tokens and pay ceil(takerAmount * limitPrice / 10000) * 10000 USDC.
    // This may slightly exceed usdcToSpend (by at most 9999 ≈ $0.01 — relayer fronts the difference).
    // The protocol invariant (clearing_price ≥ CLOB ask) guarantees the order fills.
    const mid = await this.getMidPrice(tokenId);
    const limitPrice = parseFloat(Math.min(0.999, mid * 1.01).toFixed(4));

    const TOKEN_PREC = 10n;
    const USDC_PREC  = 10000n;
    // Round UP deficit to nearest token precision
    const takerAmount = deficit % TOKEN_PREC === 0n
      ? deficit
      : deficit + (TOKEN_PREC - deficit % TOKEN_PREC);
    // Round UP makerAmount to nearest USDC precision
    const makerAmountRaw = BigInt(Math.ceil(Number(takerAmount) * limitPrice));
    const makerAmount    = makerAmountRaw % USDC_PREC === 0n
      ? makerAmountRaw
      : makerAmountRaw + (USDC_PREC - makerAmountRaw % USDC_PREC);

    console.log(`[PolymarketClient] Placing FOK buy: ${usdcToSpend} USDC available, ordering ${takerAmount} YES tokens (${makerAmount} USDC) for YES token ${tokenId.slice(0, 10)}…`);

    const { body, orderId } = await this._buildSignedOrder(
      tokenId, makerAmount, takerAmount, SIDE_BUY, limitPrice, "FOK",
    );
    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });
    console.log(`[PolymarketClient] FOK order placed: orderId=${(res.data.orderID ?? res.data.orderId ?? orderId)}, limitPrice=${limitPrice}`);

    // Poll for YES tokens to arrive (Polygon block time ~2s, allow up to 30s)
    const POLL_MS = 2500;
    const MAX_POLLS = 12; // 30s total
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const balance = await getBalance();
      console.log(`[PolymarketClient] YES balance check ${i + 1}/${MAX_POLLS}: ${balance} (need ${yesNeeded})`);
      if (balance >= yesNeeded) {
        console.log(`[PolymarketClient] YES tokens received! balance=${balance}`);
        return;
      }
    }

    // Last chance: read balance one more time
    const finalBalance = await getBalance();
    if (finalBalance >= yesNeeded) return;

    throw new Error(
      `[PolymarketClient] Timeout: YES balance ${finalBalance} < needed ${yesNeeded} after 30s. ` +
      `orderId=${orderId}. Batch settlement aborted.`,
    );
  }

  // ─── Internal: EIP-712 order building + signing ─────────────────────────────

  /**
   * Resolve the correct EIP-712 domain for a given token.
   * Most live Polymarket markets (EPL, elections, crypto) are "negRisk" markets
   * that use a different exchange contract with a different EIP-712 verifyingContract.
   * Cached per-session to avoid redundant API calls.
   */
  private async _getDomainForToken(
    tokenId: string,
  ): Promise<typeof POLYMARKET_DOMAIN | typeof NEG_RISK_DOMAIN> {
    let isNegRisk = this._negRiskCache.get(tokenId);
    if (isNegRisk === undefined) {
      try {
        const res = await axios.get(`${CLOB_API}/neg-risk`, {
          params: { token_id: tokenId },
        });
        isNegRisk = res.data?.neg_risk === true;
      } catch {
        isNegRisk = false;
      }
      this._negRiskCache.set(tokenId, isNegRisk);
      console.log(
        `[PolymarketClient] token ${tokenId.slice(0, 10)}… is negRisk=${isNegRisk} ` +
        `→ exchange=${isNegRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE}`,
      );
    }
    return isNegRisk ? NEG_RISK_DOMAIN : POLYMARKET_DOMAIN;
  }

  /**
   * Build and EIP-712 sign a Polymarket order.
   *
   * Automatically detects whether the token is a negRisk market and selects
   * the correct EIP-712 verifyingContract (CTFExchange vs NegRiskExchange).
   * Uses ClobClient-compatible JSON body format: salt as Number, owner+deferExec fields.
   *
   * Returns the JSON-stringified body ready to POST to /order, and the locally
   * computed order ID (salt-based) for logging before the response arrives.
   */
  private async _buildSignedOrder(
    tokenId:     string,
    makerAmount: bigint,
    takerAmount: bigint,
    side:        0 | 1,
    limitPrice:  number,
    orderType:   "FOK" | "GTC" | "GTD",
  ): Promise<{ body: string; orderId: string }> {
    const account = this.account!;
    // Use current timestamp as salt — unique per order, no pre-image concerns
    const salt = BigInt(Date.now());

    // signatureType=0 (EOA) requires maker == signer.
    // The relayer trades directly — maker = signer = EOA.
    const makerAddress = account.address;

    // Resolve the correct EIP-712 domain for this token's exchange contract.
    const domain = await this._getDomainForToken(tokenId);

    const orderMessage = {
      salt,
      maker:         makerAddress,
      signer:        account.address,
      taker:         TAKER_ZERO,
      tokenId:       BigInt(tokenId),
      makerAmount,
      takerAmount,
      expiration:    0n,
      nonce:         0n,
      feeRateBps:    0n,
      side:          side as number,
      signatureType: SIG_TYPE_EOA as number,
    };

    const signature = await account.signTypedData({
      domain,
      types:       ORDER_TYPES,
      primaryType: "Order",
      message:     orderMessage,
    });

    const sideStr = side === SIDE_BUY ? "BUY" : "SELL";

    // Body format must match ClobClient's orderToJson exactly:
    //   salt: Number (parseInt, not string)
    //   owner: apiKey at top level
    //   deferExec: false at top level
    const payload = {
      order: {
        salt:          Number(salt),
        maker:         makerAddress,
        signer:        account.address,
        taker:         TAKER_ZERO,
        tokenId,
        makerAmount:   makerAmount.toString(),
        takerAmount:   takerAmount.toString(),
        side:          sideStr,
        expiration:    "0",
        nonce:         "0",
        feeRateBps:    "0",
        signatureType: SIG_TYPE_EOA,
        signature,
      },
      owner:     this.apiKey,
      orderType,
      deferExec: false,
    };

    return { body: JSON.stringify(payload), orderId: `local-${salt}` };
  }

  private _requireSigner(): void {
    if (!this.account) {
      throw new Error(
        "PolymarketClient: signerPrivateKey is required for order placement. " +
        "Set POLYMARKET_SIGNER_KEY (or RELAYER_PRIVATE_KEY as fallback) in .env",
      );
    }
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Generate Polymarket CLOB API authentication headers.
   * Matches the @polymarket/clob-client createL2Headers format exactly:
   *   POLY_ADDRESS    — signer's EOA address
   *   POLY_SIGNATURE  — URL-safe base64 HMAC-SHA256 over (ts + method + path + body)
   *   POLY_TIMESTAMP  — unix seconds
   *   POLY_API_KEY    — API key from deriveApiKey
   *   POLY_PASSPHRASE — passphrase from deriveApiKey
   */
  private _authHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      "POLY_API_KEY":    this.apiKey,
      "POLY_SIGNATURE":  this._sign(timestamp, method, path, body),
      "POLY_TIMESTAMP":  timestamp,
      "POLY_PASSPHRASE": this.apiPassphrase,
      "Content-Type":    "application/json",
    };
    // POLY_ADDRESS is required by the CLOB API — the signer's EOA address
    if (this.account) {
      headers["POLY_ADDRESS"] = this.account.address;
    }
    // Builder attribution headers (optional) — credits volume to Predacy's builder profile.
    // Same HMAC format as CLOB auth but with POLY_BUILDER_* header names.
    if (this.builderKey && this.builderSecret && this.builderPassphrase) {
      headers["POLY_BUILDER_API_KEY"]    = this.builderKey;
      headers["POLY_BUILDER_SIGNATURE"]  = this._sign(timestamp, method, path, body, this.builderSecret);
      headers["POLY_BUILDER_TIMESTAMP"]  = timestamp;
      headers["POLY_BUILDER_PASSPHRASE"] = this.builderPassphrase;
    }
    return headers;
  }

  /**
   * Fetch resting signed maker orders for CTFExchange.fillOrders (v7.2 vault-as-taker).
   *
   * Strategy: scan recent CTFExchange.fillOrders transactions on Polygon mainnet.
   * Signed maker orders appear in the calldata of each fill. We extract them and
   * check remaining fill capacity via getOrderStatus. Partially-filled GTC orders
   * can be reused — CTFExchange tracks fills by EIP-712 order hash.
   *
   * For NET BUY batches: side="SELL" — look for makers selling YES for USDC.
   * For NET SELL batches: side="BUY" — look for makers buying YES with USDC.
   *
   * Uses data-api.polymarket.com/trades (market-scoped) to get recent txHashes, then
   * eth_getTransactionByHash to decode signed orders from calldata. No eth_getLogs needed
   * — avoids all block-range limits on free Alchemy tier.
   *
   * On testnet (chainId != 137) returns empty arrays (vault uses MockCTFExchange no-op).
   *
   * @param tokenId     YES token ID (large uint256 decimal string)
   * @param side        "SELL" for net-buy batches, "BUY" for net-sell batches
   * @param totalAmount Amount to cover (USDC 6-dec for SELL side; YES units for BUY side)
   * @param chainId     Relayer chain ID — scanning only happens on mainnet (137)
   * @param marketId    Condition ID (bytes32 hex) — used to scope data API query
   */
  async fetchRestingOrders(
    tokenId:     string,
    side:        "BUY" | "SELL",
    totalAmount: bigint,
    chainId:     number = POLYGON_CHAIN_ID,
    marketId?:   string,
  ): Promise<{ orders: ClobOrderForChain[]; fillAmounts: bigint[] }> {
    // Testnet: no real CTFExchange — vault uses MockCTFExchange (no-op).
    if (chainId !== POLYGON_CHAIN_ID) {
      console.log("[PolymarketClient] Testnet mode — skipping on-chain order scan (no CTFExchange)");
      return { orders: [], fillAmounts: [] };
    }

    const sideNum    = side === "SELL" ? 1 : 0;
    const bigTokenId = BigInt(tokenId);
    const nowSec     = BigInt(Math.floor(Date.now() / 1000));

    // ── 1. Get recent trade txHashes from Polymarket data API (market-scoped) ──────
    // This replaces eth_getLogs: data API is market-specific so we never scan all
    // CTFExchange events.  CTFExchange is too active (thousands of events/block) for
    // free-tier getLogs on any public RPC.
    const params: Record<string, string | number> = { limit: 100 };
    if (marketId) params.market = marketId;

    const tradeRes = await axios.get("https://data-api.polymarket.com/trades", { params });
    const trades: Array<{ transactionHash: string; asset: string }> =
      Array.isArray(tradeRes.data) ? tradeRes.data : [];

    // Filter to trades for our specific YES token (asset field = decimal tokenId string).
    const relevantTxHashes = [
      ...new Set(
        trades
          .filter(t => t.asset === tokenId)
          .map(t => t.transactionHash as `0x${string}`),
      ),
    ];

    console.log(
      `[PolymarketClient] data-api: ${trades.length} trades total, ` +
      `${relevantTxHashes.length} unique txs for token ${tokenId.slice(0, 8)}…`,
    );

    if (relevantTxHashes.length === 0) {
      console.log("[PolymarketClient] No recent trades for this token — 0 orders");
      // Fall through to getOrderStatus block with empty candidateOrders;
      // covered=0 < totalAmount → throws "Insufficient CLOB liquidity".
    }

    // ── 2. Fetch transactions & decode calldata (eth_getTransactionByHash — no block range) ──
    // Uses this.rpcUrl (Alchemy) — getTransactionByHash costs 17 CUs, no block-range limit.
    // We skip non-CTFExchange txs (e.g. NegRiskExchange at 0xb768891e…) by checking tx.to.
    const client = createPublicClient({ chain: polygon, transport: http(this.rpcUrl) });

    const BATCH = 8;
    const candidateOrders: ClobOrderForChain[] = [];

    for (let i = 0; i < relevantTxHashes.length && candidateOrders.length < 40; i += BATCH) {
      const batch = relevantTxHashes.slice(i, i + BATCH);
      const txs   = await Promise.all(
        batch.map(h => client.getTransaction({ hash: h }).catch(() => null)),
      );
      for (const tx of txs) {
        if (!tx?.input || tx.input.length < 10) continue;
        // Skip NegRiskExchange and other non-CTFExchange contracts.
        if (tx.to?.toLowerCase() !== CTF_EXCHANGE.toLowerCase()) continue;
        try {
          const decoded = decodeFunctionData({ abi: FILL_ORDERS_ABI, data: tx.input });
          const rawOrders: any[] = decoded.functionName === "fillOrders"
            ? (decoded.args[0] as any[])
            : [decoded.args[0]];

          for (const o of rawOrders) {
            if (o.tokenId !== bigTokenId) continue;
            if (Number(o.side) !== sideNum) continue;
            // Skip expired orders (expiration=0 means no expiry / GTC).
            if (o.expiration !== 0n && o.expiration < nowSec) continue;
            candidateOrders.push({
              salt:          o.salt,
              maker:         o.maker,
              signer:        o.signer,
              taker:         o.taker,
              tokenId:       o.tokenId,
              makerAmount:   o.makerAmount,
              takerAmount:   o.takerAmount,
              expiration:    o.expiration,
              nonce:         o.nonce,
              feeRateBps:    o.feeRateBps,
              side:          Number(o.side),
              signatureType: Number(o.signatureType),
              signature:     o.signature,
            });
          }
        } catch { /* non-fillOrders selector or wrong ABI — skip */ }
      }
    }

    console.log(`[PolymarketClient] Decoded ${candidateOrders.length} candidate ${side} orders`);

    // 4. Check remaining fill capacity via getOrderStatus and accumulate.
    // fillAmounts is in makerAmount units:
    //   SELL orders (side=1): makerAmount = YES → fillAmount in YES
    //   BUY  orders (side=0): makerAmount = USDC → fillAmount in USDC
    // totalAmount units:
    //   SELL side: totalAmount = netBuyAmount (USDC) → convert to YES per order's price
    //   BUY  side: totalAmount = netSellYes   (YES)  → directly comparable to USDC fill
    // We track coverage in totalAmount's native units.
    const orders: ClobOrderForChain[] = [];
    const fillAmounts: bigint[] = [];
    let covered = 0n;

    // Batch the getOrderStatus calls for performance.
    const statusBatch = candidateOrders.slice(0, 20);
    const statuses = await Promise.all(statusBatch.map(order => {
      const orderHash = hashTypedData({
        domain:      POLYMARKET_DOMAIN,
        types:       ORDER_TYPES_FOR_HASH,
        primaryType: "Order",
        message: {
          salt:          order.salt,
          maker:         order.maker,
          signer:        order.signer,
          taker:         order.taker,
          tokenId:       order.tokenId,
          makerAmount:   order.makerAmount,
          takerAmount:   order.takerAmount,
          expiration:    order.expiration,
          nonce:         order.nonce,
          feeRateBps:    order.feeRateBps,
          side:          order.side,
          signatureType: order.signatureType,
        },
      });
      return client.readContract({
        address: CTF_EXCHANGE,
        abi:     ORDER_STATUS_ABI,
        functionName: "getOrderStatus",
        args: [orderHash as `0x${string}`],
      }).catch(() => [true, 0n] as [boolean, bigint]);
    }));

    for (let i = 0; i < statusBatch.length; i++) {
      if (covered >= totalAmount) break;
      const order = statusBatch[i];
      const [filledOrCancelled, remaining] = statuses[i] as [boolean, bigint];
      if (filledOrCancelled || remaining === 0n) continue;

      let fillAmount: bigint;
      if (sideNum === SIDE_SELL) {
        // SELL order: makerAmount=YES, takerAmount=USDC. totalAmount in USDC.
        // Convert remaining YES → USDC equivalent, then fill proportionally.
        const remainingUsdc = remaining * order.takerAmount / order.makerAmount;
        const usdcNeeded = totalAmount - covered;
        if (remainingUsdc <= usdcNeeded) {
          fillAmount = remaining; // take all remaining YES
          covered += remainingUsdc;
        } else {
          // Partial fill: convert USDC needed → YES units.
          fillAmount = usdcNeeded * order.makerAmount / order.takerAmount;
          covered += usdcNeeded;
        }
      } else {
        // BUY order: makerAmount=USDC, takerAmount=YES. totalAmount in YES.
        const remainingYes = remaining * order.takerAmount / order.makerAmount;
        const yesNeeded = totalAmount - covered;
        if (remainingYes <= yesNeeded) {
          fillAmount = remaining; // take all remaining USDC from maker
          covered += remainingYes;
        } else {
          fillAmount = yesNeeded * order.makerAmount / order.takerAmount;
          covered += yesNeeded;
        }
      }

      if (fillAmount === 0n) continue;
      orders.push(order);
      fillAmounts.push(fillAmount);
    }

    if (covered < totalAmount) {
      throw new Error(
        `Insufficient CLOB liquidity: need ${totalAmount} (${side}), covered ${covered} ` +
        `from ${candidateOrders.length} candidate orders (data-api last 100 trades)`,
      );
    }

    return { orders, fillAmounts };
  }

  /**
   * HMAC-SHA256 signature matching Polymarket's canonical format.
   *
   * Key:    apiSecret decoded from base64url → raw binary (Polymarket stores secrets as base64url)
   * Output: URL-safe base64 (+→-, /→_) — Polymarket's CLOB API requires this encoding
   * Msg:    timestamp + METHOD.upper() + path + body
   */
  private _sign(timestamp: string, method: string, path: string, body: string, secret?: string): string {
    const message = timestamp + method.toUpperCase() + path + body;
    const s = secret ?? this.apiSecret;
    // Decode base64url secret to binary before using as HMAC key
    const secretBinary = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const sig = createHmac("sha256", secretBinary).update(message).digest("base64");
    // Convert standard base64 → URL-safe base64 (Polymarket requires this)
    return sig.replace(/\+/g, "-").replace(/\//g, "_");
  }
}

export interface PriceLevel {
  price: number;
  size:  number;
}

/** On-chain order struct for CTFExchange.fillOrders — passed in settleBatch v7.2. */
export interface ClobOrderForChain {
  salt:          bigint;
  maker:         `0x${string}`;
  signer:        `0x${string}`;
  taker:         `0x${string}`;
  tokenId:       bigint;
  makerAmount:   bigint;
  takerAmount:   bigint;
  expiration:    bigint;
  nonce:         bigint;
  feeRateBps:    bigint;
  side:          number;
  signatureType: number;
  signature:     `0x${string}`;
}
