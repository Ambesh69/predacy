import axios from "axios";
import type { PolymarketMarket } from "./types.js";

const CLOB_API = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/**
 * Polymarket CLOB REST API client.
 * Handles market data fetching and order execution.
 *
 * Polymarket's CLOB is an off-chain matching engine that settles on Polygon.
 * For order submission you need a Polymarket API key (L2 key derived from a wallet).
 *
 * Docs: https://docs.polymarket.com/
 */
export class PolymarketClient {
  private apiKey: string;
  private apiSecret: string;
  private apiPassphrase: string;

  constructor(apiKey: string, apiSecret: string, apiPassphrase: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassphrase = apiPassphrase;
  }

  // ─── Market data ────────────────────────────────────────────────────────

  /** Fetch active markets from Polymarket */
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

  // ─── Order execution ────────────────────────────────────────────────────

  /**
   * Place a market buy order for YES tokens on Polymarket's CLOB.
   * This is the net position execution step after batch clearing.
   *
   * @param tokenId   The YES token ID (from market.tokens[].token_id)
   * @param usdcAmount USDC to spend (6 decimals as a number, e.g. 1000000 = $1)
   * @returns Order ID from Polymarket
   */
  async placeMarketBuy(tokenId: string, usdcAmount: bigint): Promise<string> {
    const amountFloat = Number(usdcAmount) / 1e6;

    const body = {
      order: {
        tokenID: tokenId,
        side: "BUY",
        price: null, // market order
        size: amountFloat,
        orderType: "MARKET",
      },
    };

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", JSON.stringify(body)),
    });

    return res.data.orderId;
  }

  /**
   * Place a limit buy order on Polymarket's CLOB.
   *
   * @param tokenId     YES token ID
   * @param usdcAmount  USDC to spend (bigint, 6 decimals)
   * @param limitPrice  Price in [0,1] as a float (e.g. 0.65)
   */
  async placeLimitBuy(tokenId: string, usdcAmount: bigint, limitPrice: number): Promise<string> {
    const size = Number(usdcAmount) / 1e6 / limitPrice;

    const body = {
      order: {
        tokenID: tokenId,
        side: "BUY",
        price: limitPrice,
        size: size.toFixed(2),
        orderType: "GTC", // Good-till-cancelled
      },
    };

    const res = await axios.post(`${CLOB_API}/order`, body, {
      headers: this._authHeaders("POST", "/order", JSON.stringify(body)),
    });

    return res.data.orderId;
  }

  // ─── Price utilities ────────────────────────────────────────────────────

  /**
   * Get the current best ask (cheapest YES tokens) for a market.
   * Used to estimate how many YES tokens the net buy will receive.
   */
  async getBestAsk(tokenId: string): Promise<number> {
    const book = await this.getOrderBook(tokenId);
    if (!book.asks.length) throw new Error(`No asks for token ${tokenId}`);
    return book.asks.sort((a, b) => a.price - b.price)[0].price;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  /** Generate Polymarket CLOB API authentication headers */
  private _authHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Polymarket uses HMAC-SHA256 signature: timestamp + method + path + body
    // Full auth implementation: https://docs.polymarket.com/#authentication
    // For prototype, fill in with actual API credentials
    return {
      "POLY-API-KEY": this.apiKey,
      "POLY-SIGNATURE": this._sign(timestamp, method, path, body),
      "POLY-TIMESTAMP": timestamp,
      "POLY-PASSPHRASE": this.apiPassphrase,
      "Content-Type": "application/json",
    };
  }

  private _sign(timestamp: string, method: string, path: string, body: string): string {
    // TODO: implement HMAC-SHA256 signature using apiSecret
    // const message = timestamp + method + path + body;
    // return crypto.createHmac('sha256', this.apiSecret).update(message).digest('base64');
    return "placeholder-signature";
  }
}

export interface PriceLevel {
  price: number;
  size: number;
}
