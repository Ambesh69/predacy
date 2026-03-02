import type { Order, TransferAuth } from "./types.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface OrderStore {
  save(batchId: string, key: string, order: Order): Promise<void>;
  load(batchId: string): Promise<Map<string, Order>>;
  count(batchId: string): Promise<number>;
  delete(batchId: string): Promise<void>;
}

// ── Serialization helpers ─────────────────────────────────────────────────────
// bigint fields (amount, limitPrice, transferAuth.validAfter, transferAuth.validBefore)
// cannot be JSON.stringify'd directly — convert to strings.

function serializeAuth(auth: TransferAuth): object {
  return {
    from:        auth.from,
    validAfter:  auth.validAfter.toString(),
    validBefore: auth.validBefore.toString(),
    nonce:       auth.nonce,
    v:           auth.v,
    r:           auth.r,
    s:           auth.s,
  };
}

function deserializeAuth(raw: any): TransferAuth {
  return {
    from:        (raw.from ?? ("0x" + "0".repeat(40))) as `0x${string}`,
    validAfter:  BigInt(raw.validAfter),
    validBefore: BigInt(raw.validBefore),
    nonce:       raw.nonce       as `0x${string}`,
    v:           raw.v           as number,
    r:           raw.r           as `0x${string}`,
    s:           raw.s           as `0x${string}`,
  };
}

function serialize(order: Order): string {
  return JSON.stringify({
    ...order,
    amount:      order.amount.toString(),
    limitPrice:  order.limitPrice.toString(),
    transferAuth: order.transferAuth ? serializeAuth(order.transferAuth) : undefined,
  });
}

function deserialize(raw: string): Order {
  const o = JSON.parse(raw);
  return {
    ...o,
    amount:      BigInt(o.amount),
    limitPrice:  BigInt(o.limitPrice),
    transferAuth: o.transferAuth ? deserializeAuth(o.transferAuth) : undefined,
  };
}

// ── In-memory store (dev / fallback when REDIS_URL is not set) ────────────────

export class InMemoryOrderStore implements OrderStore {
  private store = new Map<string, Map<string, Order>>();

  async save(batchId: string, key: string, order: Order): Promise<void> {
    if (!this.store.has(batchId)) this.store.set(batchId, new Map());
    this.store.get(batchId)!.set(key, order);
  }

  async load(batchId: string): Promise<Map<string, Order>> {
    return this.store.get(batchId) ?? new Map();
  }

  async count(batchId: string): Promise<number> {
    return this.store.get(batchId)?.size ?? 0;
  }

  async delete(batchId: string): Promise<void> {
    this.store.delete(batchId);
  }
}

// ── Redis store (production — survives relayer restarts) ──────────────────────

export class RedisOrderStore implements OrderStore {
  private redis: any = null;
  private ready: Promise<void>;

  constructor(redisUrl: string) {
    this.ready = this._connect(redisUrl);
  }

  private async _connect(url: string): Promise<void> {
    // Dynamic import keeps ioredis optional — falls back to in-memory if not installed
    const { default: Redis } = await import("ioredis");
    this.redis = new Redis(url, { maxRetriesPerRequest: 3 });
    this.redis.on("error", (e: Error) => console.error("[Redis] Error:", e.message));
    await new Promise<void>((resolve) => this.redis.once("ready", resolve));
    console.log("[Redis] Connected:", url.replace(/:[^:@]*@/, ":***@"));
  }

  private async client() {
    await this.ready;
    return this.redis;
  }

  private key(batchId: string) {
    return `predacy:orders:${batchId}`;
  }

  async save(batchId: string, key: string, order: Order): Promise<void> {
    const r = await this.client();
    await r.hset(this.key(batchId), key, serialize(order));
    await r.expire(this.key(batchId), 604_800); // 7-day TTL — survives extended outages/OOM loops
  }

  async load(batchId: string): Promise<Map<string, Order>> {
    const r   = await this.client();
    const raw = (await r.hgetall(this.key(batchId))) as Record<string, string> | null;
    const map = new Map<string, Order>();
    if (!raw) return map;
    for (const [key, json] of Object.entries(raw)) {
      map.set(key, deserialize(json));
    }
    return map;
  }

  async count(batchId: string): Promise<number> {
    const r = await this.client();
    return r.hlen(this.key(batchId));
  }

  async delete(batchId: string): Promise<void> {
    const r = await this.client();
    await r.del(this.key(batchId));
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createOrderStore(redisUrl?: string): OrderStore {
  if (redisUrl) {
    console.log("[OrderStore] Using Redis for order persistence");
    return new RedisOrderStore(redisUrl);
  }
  console.log("[OrderStore] Using in-memory store (set REDIS_URL for persistence across restarts)");
  return new InMemoryOrderStore();
}
