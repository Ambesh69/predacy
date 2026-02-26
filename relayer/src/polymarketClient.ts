import axios from "axios";
import { createHmac } from "node:crypto";
import type { PolymarketMarket } from "./types.js";

const CLOB_API  = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/**
 * Polymarket CLOB REST API client.
 *
 * Auth: Polymarket uses HMAC-SHA256 request signing (L2 API key scheme).
 * Signature = base64( HMAC-SHA256( apiSecret, timestamp + method + path + body ) )
 * Docs: https://docs.polymarket.com/#authentication
 *
 * To obtain API keys:
 *   1. Go to polymarket.com, connect your wallet
 *   2. Settings → API Keys → Generate new key
 *   3. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE in .env
 */
export class PolymarketClient {
  private apiKey:        string;
  private apiSecret:     string;
  private apiPassphrase: string;

  constructor(apiKey: string, apiSecret: string, apiPassphrase: string) {
    this.apiKey        = apiKey;
    this.apiSecret     = apiSecret;
    this.apiPassphrase = apiPassphrase;
  }

  // ─── Market data (no auth required) ────────────────────────────────────────

  /** Fetch active markets from Polymarket Gamma API */
  async getMarkets(limit = 20, offset = 0): Promise<PolymarketMarket[]> {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { limit, offset, active: true, closed: false },
    });
    return res.data;
  }

  /** Get a single market by condition ID */
  async getMarket(conditionId: string): Promise<PolymarketMarket> {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { condition_id: conditionId },
    });
    if (!res.data?.length) throw new Error(`Market not found: ${conditionId}`);
    return res.data[0];
  }

  /** Get the current mid-price for a token (YES or NO token ID) */
  async getMidPrice(tokenId: string): Promise<number> {
    const res = await axios.get(`${CLOB_API}/midpoint`, {
      params: { token_id: tokenId },
    });
    return parseFloat(res.data.mid);
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

  // ─── Order execution (requires auth) ───────────────────────────────────────

  /**
   * Place a market-like buy order for YES tokens on Polymarket's CLOB.
   * Uses a FOK (fill-or-kill) order at mid + 1% slippage so it fills immediately.
   *
   * Polymarket CLOB does not have a true "MARKET" order type.  FOK with an
   * aggressive limit achieves the same effect in normal liquidity conditions.
   *
   * @param tokenId    YES (or NO) token ID from market.tokens[].token_id
   * @param usdcAmount USDC to spend (bigint, 6 decimals — e.g. 1_000_000n = $1)
   * @returns orderId and the limit price used (as a float in [0, 1])
   */
  async placeMarketBuy(
    tokenId: string,
    usdcAmount: bigint,
  ): Promise<{ orderId: string; limitPrice: number }> {
    // Fetch current mid to size the order and set a realistic limit
    const mid = await this.getMidPrice(tokenId);

    // Accept up to 1% above mid — ensures fill without excess slippage
    const limitPrice = parseFloat(Math.min(0.999, mid * 1.01).toFixed(4));

    // Polymarket size = number of tokens, NOT USDC amount
    const usdcFloat = Number(usdcAmount) / 1e6;
    const tokenSize = parseFloat((usdcFloat / limitPrice).toFixed(2));

    const body = JSON.stringify({
      order: {
        tokenID:   tokenId,
        side:      "BUY",
        price:     limitPrice,
        size:      tokenSize,
        orderType: "FOK",
      },
    });

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });

    return { orderId: res.data.orderId as string, limitPrice };
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
    tokenId: string,
    usdcAmount: bigint,
    limitPrice: number,
  ): Promise<{ orderId: string; limitPrice: number }> {
    // size = tokens to receive at this price for the given USDC spend
    const tokenSize = parseFloat((Number(usdcAmount) / 1e6 / limitPrice).toFixed(2));
    const body = JSON.stringify({
      order: {
        tokenID:   tokenId,
        side:      "BUY",
        price:     limitPrice,
        size:      tokenSize,
        orderType: "GTC",
      },
    });

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", body),
    });

    return { orderId: res.data.orderId as string, limitPrice };
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Generate Polymarket CLOB API authentication headers.
   * Signature = base64( HMAC-SHA256( apiSecret, timestamp + method + path + body ) )
   */
  private _authHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      "POLY-API-KEY":     this.apiKey,
      "POLY-SIGNATURE":   this._sign(timestamp, method, path, body),
      "POLY-TIMESTAMP":   timestamp,
      "POLY-PASSPHRASE":  this.apiPassphrase,
      "Content-Type":     "application/json",
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
