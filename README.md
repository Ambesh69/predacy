# Predacy

Private sealed-bid batch auction layer on top of [Polymarket](https://polymarket.com).

Users submit encrypted commitments to a prediction market. Orders batch-clear at a uniform price, net positions route to Polymarket, and payouts are claimed with a zero-knowledge proof — without ever linking the trader's identity to their position on-chain.

---

## How it works

```
Alice                  Ephemeral wallet           BatchVault (Polygon)
  │                          │                           │
  ├─ fund ephemeral ─────────►                           │
  │  (via Railgun, private)  │                           │
  │                          ├─ commitOrderFor() ───────►│  sealed commitment stored
  │                          │                           │
  │              ...batch window closes...               │
  │                                                      │
  │                    Relayer                           │
  │                      │                               │
  │                      ├─ lockFunds() ────────────────►│  USDC pulled, tokens split
  │                      ├─ sell excess on CLOB          │
  │                      ├─ buy gap on CLOB              │
  │                      ├─ settleBatch(proof) ─────────►│  ZK batch proof verified
  │                      │                               │  Merkle root stored
  │                      │                               │
  │◄─ claimWithProof() ──┤                               │  relayer claims on Alice's behalf
  │  (ZK claim proof)    │                               │  Alice's address never on-chain
```

Key properties:
- **Sealed bids** — orders are commitment hashes; amounts and prices stay hidden until settlement
- **Batch uniform-price clearing** — no frontrunning; all matched orders clear at the same price
- **ZK privacy** — claim proofs use Noir/UltraHonk; the relayer submits the claim tx so the trader's wallet never appears in any on-chain calldata
- **Railgun integration** — funding the ephemeral wallet via Railgun breaks the on-chain link between the trader and their deposit

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
| Privacy | [Railgun](https://railgun.org) (private USDC transfer to ephemeral wallet) |
| Order book | Polymarket CLOB API (gap fills between phases) |

---

## Deployed contracts (Polygon mainnet)

| Contract | Address |
|---|---|
| BatchVault v10 | `0x8fD2B227E98F401F55B4252d34905C96eEEAEA1a` |
| HonkVerifier (batch) | `0xFd32E90a67247dF2878bEeD5599aaFc3430fC993` |
| PublicInputAdapter | `0x8f6829E931E278d47Ec160847C1037864AfB1cC7` |
| ClaimHonkVerifier (active in BatchVault; fork-tested with a fresh proof) | `0xA50409A331E3CA9Db7fDfB96028BAeFF3AF48bBd` |
| ProxyWalletFactory | `0x7608A95420c107503837dE35E25bf360bEe82f38` |
| WrappedCTFFactory | `0x8Ff83784f6209D4455D83C9e28b515255dbEA955` |

---

Mainnet order intake is disabled in this checkout pending a tested bridge from
the vault's USDC.e to Polymarket pUSD, plus Deposit Wallet/CTF Exchange V2
order handling. See [the launch gate](docs/launch-readiness.md).

---

## Settlement architecture (two-phase, zero relayer capital)

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

## Privacy model

| On-chain action | Trader visible? |
|---|---|
| `commitOrderFor` calldata | No — ephemeral signer |
| `settleBatch` calldata | No — no trader field |
| Claim tx | No — relayer submits |
| `PositionClaimed` event | No — recipient address only |
| USDC transfer to ephemeral | No (mainnet) — Railgun private transfer |

---

## Commitment scheme

```
commitment = keccak256(abi.encode(marketId, side, amount, limitPrice, salt))
nullifier  = keccak256(abi.encode(commitment, batchId, salt))
```

`side` is a `uint8`: `0 = YES_BUY`, `1 = YES_SELL`, `2 = NO_BUY`, `3 = NO_SELL`.

The trader address is **never** part of the commitment — the relayer associates trader ↔ commitment off-chain in Redis.
