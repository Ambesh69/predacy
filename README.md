# Predacy

Private sealed-bid batch auction layer on top of [Polymarket](https://polymarket.com).

**Launch status:** Mainnet intake is closed. V13 is deployed on Polygon in a
paused state and its Railway chain/database preflight passes. It replaces v12's
publicly linkable per-market order commitments with generic order notes,
secret-derived nullifiers, and private refund/position allocations. An
independent security review, v13 live recovery pilot, and privacy/product
validation are still required before intake opens. See
[the v13 architecture and launch gate](docs/private-v13.md).

V13 retains Polymarket for aggregate execution. Proofs omit individual order
witnesses and source commitments from public batch settlement. This does not
guarantee anonymity: public funding, withdrawal amounts, timing, and two-order
batches permit inference. The aggregate Polymarket hedge remains public, and
the relayer sees decrypted order witnesses while grouping and proving a batch.

---

## V13 flow

```
Trader                    ShieldedPoolV2                 Relayer / Polymarket
  │                              │                                │
  ├─ deposit private note ──────►│                                │
  ├─ lock generic order proof ─►│                                │
  ├─ send encrypted witness ────────────────────────────────────►│
  │                              │◄─ route two-order ZK proof ───┤
  │                              ├─ aggregate collateral ───────►│
  │                              │          CLOB fill             │
  │                              │◄─ returned assets + proof ────┤
  │◄─ private refund/position notes                              │
```

Key properties:
- **Generic order notes** — commitments reveal no market or outcome token.
- **Unlinkable routing** — routed nullifiers do not reveal their source commitments.
- **Private allocation** — refunds and positions are inserted as shielded notes.
- **Zero subsidy** — per-batch surplus preservation prevents one batch from consuming another user's assets.
- **Recoverable execution** — PostgreSQL journals every irreversible action and serializes mainnet batches across workers.

---

## Directory structure

```
Predacy/
├── contracts/       Solidity (Foundry) — BatchVault, verifiers, proxy wallets
├── circuits/        Noir ZK circuits — batch_clearing + claim
├── relayer/         Node.js + TypeScript — HTTP API, batch processor, ZK prover
└── frontend/        Next.js 15 — trading UI
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Contracts | Solidity 0.8.33, Foundry (`via_ir`, optimizer 200) |
| ZK circuits | [Noir](https://noir-lang.org) — UltraHonk / Barretenberg (`@aztec/bb.js`) |
| Relayer | Node.js + TypeScript + [viem](https://viem.sh), deployed on Railway |
| Frontend | Next.js 15, wagmi/viem, Tailwind v3 |
| Chain | Polygon mainnet |
| Privacy | Noir/UltraHonk shielded notes (individual details hidden on-chain; witnesses visible to the relayer) |
| Order book | Polymarket CLOB API (gap fills between phases) |

---

## Legacy deployed contracts (Polygon mainnet)

These addresses belong to the retired v10 flow. V13 is deployed separately;
its production configuration must not use these legacy addresses.

| Contract | Address |
|---|---|
| BatchVault v10 | `0x8fD2B227E98F401F55B4252d34905C96eEEAEA1a` |
| HonkVerifier (batch) | `0xFd32E90a67247dF2878bEeD5599aaFc3430fC993` |
| PublicInputAdapter | `0x8f6829E931E278d47Ec160847C1037864AfB1cC7` |
| ClaimHonkVerifier (active in BatchVault; fork-tested with a fresh proof) | `0xA50409A331E3CA9Db7fDfB96028BAeFF3AF48bBd` |
| ProxyWalletFactory | `0x7608A95420c107503837dE35E25bf360bEe82f38` |
| WrappedCTFFactory | `0x8Ff83784f6209D4455D83C9e28b515255dbEA955` |

---

V13 mainnet order intake is disabled. Deployments start paused and the relayer
and frontend gates default closed. See [the v13 runbook](docs/private-v13.md)
and [the launch gate](docs/launch-readiness.md).

---

## Legacy v10 settlement architecture

This section documents the old two-phase flow for historical context. It is not
the v13 production path.

**Phase 1 — `lockFunds()`**
- Pulls USDC from each buyer's ephemeral wallet via EIP-3009 deferred transfer
- Calls `CTF.splitPosition` (balanced demand) or `CTF.mergePositions` (excess sellers)
- Routes surplus tokens / USDC to the relayer for CLOB gap-fills

**Between phases**
- Relayer sells excess YES/NO tokens on the Polymarket CLOB
- Relayer buys gap tokens to cover unfilled orders

**Phase 2 — `settleBatch(batchId, proof)`**
- Verifies the UltraHonk ZK batch-clearing proof on-chain
- Pulls gap tokens + USDC proceeds back from the relayer
- Stores the Merkle root of all commitments for claim verification

**Claim — `claimWithProof()`**
- Relayer generates a per-order ZK proof (claim circuit)
- Submits `claimWithProof` on behalf of the trader; payout goes to the recipient address
- Nullifier prevents double-claiming

---

## Running locally

### Contracts

```bash
cd contracts
forge build
forge test
```

### Relayer

```bash
cd relayer
cp .env.example .env   # fill in VAULT_ADDRESS, RELAYER_PRIVATE_KEY, RPC_URL, etc.
npm start
```

Required env vars:

| Variable | Description |
|---|---|
| `VAULT_ADDRESS` | BatchVault contract address |
| `RELAYER_PRIVATE_KEY` | Relayer hot wallet private key |
| `RPC_URL` | Polygon mainnet RPC (authenticated dRPC recommended) |
| `ADAPTER_ADDRESS` | PublicInputAdapter address |
| `CLAIM_VERIFIER` | ClaimHonkVerifier address |
| `REDIS_URL` | Redis connection string (order storage, 7-day TTL) |
| `USE_REAL_ZK` | `true` for mainnet (HonkVerifier); `false` for mock mode |

### Frontend

```bash
cd frontend
cp .env.local.example .env.local   # fill in NEXT_PUBLIC_RELAYER_URL, etc.
npm run dev
```

---

## Legacy privacy model (not a launch guarantee)

| On-chain action | Trader visible? |
|---|---|
| `commitOrderFor` calldata | No — ephemeral signer |
| `settleBatch` calldata | No — no trader field |
| Claim tx | No — relayer submits |
| `PositionClaimed` event | No — recipient address only |
| USDC transfer to ephemeral | No (mainnet) — Railgun private transfer |

The table describes the intended wallet-link protection only. The v10
`lockFunds` calldata reveals every order's market, side, amount, limit, and
salt; a direct transfer to an ephemeral wallet is linkable. Polymarket fills
are public. Do not describe this flow as hiding all trade details.

---

## Commitment scheme

```
commitment = keccak256(abi.encode(marketId, side, amount, limitPrice, salt))
nullifier  = keccak256(abi.encode(commitment, batchId, salt))
```

`side` is a `uint8`: `0 = YES_BUY`, `1 = YES_SELL`, `2 = NO_BUY`, `3 = NO_SELL`.

The trader address is **never** part of the commitment — the relayer associates trader ↔ commitment off-chain in Redis.
