import axios from "axios";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

export interface Market {
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];     // ["0.65", "0.35"] for YES/NO
  volume: string;              // Total USDC volume
  volumeNum: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  tokens: Array<{ token_id: string; outcome: string; price: string }>;
  image?: string;
  icon?: string;
  category?: string;
  tags?: string[];
}

/** Fetch active markets from Polymarket Gamma API */
export async function getMarkets(limit = 20): Promise<Market[]> {
  const res = await axios.get(`${GAMMA_API}/markets`, {
    params: { limit, active: true, closed: false, order: "volume", ascending: false },
  });
  return res.data ?? [];
}

/** Get a single market by condition ID */
export async function getMarket(conditionId: string): Promise<Market | null> {
  const res = await axios.get(`${GAMMA_API}/markets`, {
    params: { condition_id: conditionId },
  });
  return res.data?.[0] ?? null;
}

/** Get current mid-price for a token ID (returns 0-1 float) */
export async function getMidPrice(tokenId: string): Promise<number> {
  const res = await axios.get(`${CLOB_API}/midpoint`, {
    params: { token_id: tokenId },
  });
  return parseFloat(res.data?.mid ?? "0.5");
}

/** Raw orderbook entry from CLOB API */
interface OrderbookEntry {
  price: string;
  size: string;
}

/** Get orderbook depth (top N levels) */
export async function getOrderBook(tokenId: string): Promise<{
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}> {
  const res = await axios.get(`${CLOB_API}/book`, {
    params: { token_id: tokenId },
  });
  const bids: OrderbookEntry[] = res.data?.bids ?? [];
  const asks: OrderbookEntry[] = res.data?.asks ?? [];
  return {
    bids: bids.map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
    asks: asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
  };
}

// ── Mock data for development (when API isn't reachable) ──────────────────────

export const MOCK_MARKETS: Market[] = [
  {
    conditionId: "0x" + "a1b2c3d4".repeat(8),
    question: "Will the Fed cut rates in March 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.34", "0.66"],
    volume: "4821300",
    volumeNum: 4821300,
    active: true,
    closed: false,
    endDate: "2026-03-20T00:00:00Z",
    tokens: [
      { token_id: "0x" + "1".repeat(64), outcome: "Yes", price: "0.34" },
      { token_id: "0x" + "2".repeat(64), outcome: "No", price: "0.66" },
    ],
    category: "Politics",
    tags: ["Fed", "rates", "economics"],
  },
  {
    conditionId: "0x" + "e5f6a7b8".repeat(8),
    question: "Will ETH price exceed $5,000 by end of Q2 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.41", "0.59"],
    volume: "12440800",
    volumeNum: 12440800,
    active: true,
    closed: false,
    endDate: "2026-06-30T00:00:00Z",
    tokens: [
      { token_id: "0x" + "3".repeat(64), outcome: "Yes", price: "0.41" },
      { token_id: "0x" + "4".repeat(64), outcome: "No", price: "0.59" },
    ],
    category: "Crypto",
    tags: ["ETH", "Ethereum", "price"],
  },
  {
    conditionId: "0x" + "c9d0e1f2".repeat(8),
    question: "Will there be a US recession in 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.22", "0.78"],
    volume: "7391500",
    volumeNum: 7391500,
    active: true,
    closed: false,
    endDate: "2026-12-31T00:00:00Z",
    tokens: [
      { token_id: "0x" + "5".repeat(64), outcome: "Yes", price: "0.22" },
      { token_id: "0x" + "6".repeat(64), outcome: "No", price: "0.78" },
    ],
    category: "Economics",
    tags: ["recession", "US economy"],
  },
  {
    conditionId: "0x" + "12345678".repeat(8),
    question: "Will Bitcoin reach $150k in 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.58", "0.42"],
    volume: "31200000",
    volumeNum: 31200000,
    active: true,
    closed: false,
    endDate: "2026-12-31T00:00:00Z",
    tokens: [
      { token_id: "0x" + "7".repeat(64), outcome: "Yes", price: "0.58" },
      { token_id: "0x" + "8".repeat(64), outcome: "No", price: "0.42" },
    ],
    category: "Crypto",
    tags: ["BTC", "Bitcoin", "price"],
  },
];
