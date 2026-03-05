import axios from "axios";
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { PolymarketMarket } from "./types.js";

const CLOB_API  = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/**
 * Polymarket CTFExchange on Polygon mainnet.
 * All orders are signed against this contract's EIP-712 domain.
 */
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
const POLYGON_CHAIN_ID = 137;

/**
 * EIP-712 domain for Polymarket CTF Exchange.
 * Fixed to Polygon mainnet — Polymarket CLOB only operates on mainnet.
 */
const POLYMARKET_DOMAIN = {
  name:              "CTF Exchange",
  version:           "1",
  chainId:           POLYGON_CHAIN_ID,
  verifyingContract: CTF_EXCHANGE,
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

// Gamma API returns some fields as JSON-encoded strings — parse them.
function normalizeMarket(m: any): PolymarketMarket {
  const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    ...m,
    tokens:        parse(m.tokens)        ?? [],
    outcomes:      parse(m.outcomes)      ?? [],
    outcomePrices: parse(m.outcomePrices) ?? [],
    clobTokenIds:  parse(m.clobTokenIds)  ?? [],
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

  constructor(
    apiKey:        string,
    apiSecret:     string,
    apiPassphrase: string,
    signerPrivateKey?: `0x${string}`,
  ) {
    this.apiKey        = apiKey;
    this.apiSecret     = apiSecret;
    this.apiPassphrase = apiPassphrase;
    this.account       = signerPrivateKey ? privateKeyToAccount(signerPrivateKey) : null;
  }

  // ─── Market data (no auth required) ────────────────────────────────────────

  /** Fetch active markets from Polymarket Gamma API */
  async getMarkets(limit = 20, offset = 0): Promise<PolymarketMarket[]> {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { limit, offset, active: true, closed: false },
    });
    return (res.data ?? []).map(normalizeMarket);
  }

  /** Get a single market by condition ID */
  async getMarket(conditionId: string): Promise<PolymarketMarket> {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { condition_id: conditionId },
    });
    if (!res.data?.length) throw new Error(`Market not found: ${conditionId}`);
    return normalizeMarket(res.data[0]);
  }

  /**
   * Get the current mid-price for a token (YES or NO token ID).
   *
   * Primary:  GET /midpoint — requires an active resting orderbook.
   * Fallback: GET /last-trade-price — returns the most-recent matched trade price
   *           even when no resting orders exist (illiquid / thin markets).
   *           Returns 404 → throws only when BOTH sources fail or return 0.
   */
  async getMidPrice(tokenId: string): Promise<number> {
    try {
      const res = await axios.get(`${CLOB_API}/midpoint`, {
        params: { token_id: tokenId },
      });
      return parseFloat(res.data.mid);
    } catch (err: any) {
      // /midpoint returns 404 "No orderbook exists" for markets with no resting orders.
      // Fall back to /last-trade-price, which is available as long as ≥1 trade has occurred.
      if (err?.response?.status === 404) {
        const fallback = await axios.get(`${CLOB_API}/last-trade-price`, {
          params: { token_id: tokenId },
        });
        const price = parseFloat(fallback.data.price ?? "0");
        if (price > 0) return price;
        throw new Error(`No mid-price or last-trade-price available for token ${tokenId}`);
      }
      throw err;
    }
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

    // makerAmount = USDC to spend; takerAmount = tokens to receive
    const makerAmount = usdcAmount;
    const takerAmount = BigInt(Math.round(Number(usdcAmount) / limitPrice));

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

    // For SELL: makerAmount = tokens to sell; takerAmount = USDC to receive
    const makerAmount = yesAmount;
    const takerAmount = BigInt(Math.round(Number(yesAmount) * limitPrice));

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

    const makerAmount = usdcAmount;
    const takerAmount = BigInt(Math.round(Number(usdcAmount) / limitPrice));

    const { body, orderId } = await this._buildSignedOrder(
      tokenId, makerAmount, takerAmount, SIDE_BUY, limitPrice, "GTC",
    );

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });

    return { orderId: (res.data.orderID ?? res.data.orderId ?? orderId) as string, limitPrice };
  }

  // ─── Internal: EIP-712 order building + signing ─────────────────────────────

  /**
   * Build and EIP-712 sign a Polymarket order.
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

    const orderMessage = {
      salt,
      maker:         account.address,
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
      domain:      POLYMARKET_DOMAIN,
      types:       ORDER_TYPES,
      primaryType: "Order",
      message:     orderMessage,
    });

    const sideStr = side === SIDE_BUY ? "BUY" : "SELL";

    const body = JSON.stringify({
      order: {
        salt:          salt.toString(),
        maker:         account.address,
        signer:        account.address,
        taker:         TAKER_ZERO,
        tokenId,
        makerAmount:   makerAmount.toString(),
        takerAmount:   takerAmount.toString(),
        expiration:    "0",
        nonce:         "0",
        feeRateBps:    "0",
        side:          sideStr,
        signatureType: SIG_TYPE_EOA,
        signature,
      },
      orderType,
    });

    return { body, orderId: `local-${salt}` };
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
   * Signature = base64( HMAC-SHA256( apiSecret, timestamp + method + path + body ) )
   */
  private _authHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      "POLY-API-KEY":    this.apiKey,
      "POLY-SIGNATURE":  this._sign(timestamp, method, path, body),
      "POLY-TIMESTAMP":  timestamp,
      "POLY-PASSPHRASE": this.apiPassphrase,
      "Content-Type":    "application/json",
    };
  }

  /**
   * HMAC-SHA256 signature: base64( HMAC-SHA256( apiSecret, msg ) )
   * where msg = timestamp + method.toUpperCase() + path + body
   */
  private _sign(timestamp: string, method: string, path: string, body: string): string {
    const message = timestamp + method.toUpperCase() + path + body;
    return createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("base64");
  }
}

export interface PriceLevel {
  price: number;
  size:  number;
}
