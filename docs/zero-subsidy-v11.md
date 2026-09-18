# Zero-subsidy settlement v11

Status: experimental vault, per-order proof, conversion bridge, durable-order
journal module, and SDK execution primitives implemented on
`codex/zero-subsidy-settlement`. None is wired to production trading. This
document does not authorize mainnet trading. The deployed v10 vault cannot be
upgraded in place.

The required launch privacy is **all trade details hidden on-chain**. This
prototype does not meet it: escrow and allocations are public, and Polymarket's
own matched trades settle on public Polygon exchange contracts. Funding through
Railgun or using an omnibus Deposit Wallet could hide an individual's link to
an aggregate trade, but cannot hide the aggregate exchange execution itself.
The production PostgreSQL service and relayer reference variable exist, but
neither resolves this incompatibility nor activates the v11 code.

## Accounting contract

Each committed order has one signed maximum buy price or minimum sell price.
The batch outcome records, per order, filled shares, actual net USDC spent or
received, and a refund in the original deposited asset. Partial fills are
allowed. A buyer's deposit equals all-in USDC spent plus USDC refunded; a
seller's deposited shares equal shares sold plus shares refunded. Buy cost
includes CLOB fees and cannot exceed filled shares times the signed limit.
Seller proceeds are net of fees and cannot fall below that limit.

For each asset, sum of claimable payouts and refunds must equal the real batch
escrow, plus CTF split/merge effects, plus assets actually received from the
CLOB, minus assets actually spent or sent to the CLOB. All arithmetic is in
base units with exact integer equality; dust belongs to a specific user's
refund, not to the operator. The model lives in
`contracts/src/SettlementAccounting.sol` and
`relayer/src/settlementAccounting.ts`. `BatchVaultV11` applies the Solidity
validator to measured asset balances and requires an allocation proof for
every escrowed order. The operator still controls the routed Deposit Wallet;
on-chain balance equality establishes solvency at finalization, not the
provenance of each CLOB fill.

The proof component is `circuits/allocation_v11`: one proof per order
binds the public allocation to a committed, hidden limit and salt. Its
generated verifier is kept in `contracts/v11-verifier`, which uses a separate
non-IR, size-optimized Foundry profile. The v11 vault verifies each proof and
checks whole-batch conservation on chain, including outstanding claims from
previous batches. A real generated proof has been tested through escrow,
finalization, and claim. The USDC.e/pUSD conversion primitive in
`contracts/src/PolymarketCollateralBridge.sol` is tested on a Polygon fork and
called by the experimental vault, but no production vault calls it.

Current limitations: batches are serial and capped at four orders; claims are
owner-authorized direct transfers, so settlement is not private. The allocation
struct's public `limitPrice` is required to be zero because only the hidden
limit in the proof is authoritative. The PostgreSQL order journal, fee-aware
FAK signing, read-only trade reconciliation, receipt gate, and Deposit Wallet
withdrawal helpers are isolated modules. There is no orchestrated live CLOB
runner, complete ambiguous-response recovery, returned-asset accounting
workflow, frontend approval/proof integration, v11 deployment, or production
PostgreSQL service. The official Deposit Wallet SDK primitives are not invoked
from the production route. That SDK requires Node 24, now pinned in the relayer
package and Nixpacks configuration; the actual Railway build must still be
validated before migration.

## Required on-chain sequence

1. Commit and escrow each order against a new vault. Bind each deposit and
   refund recipient to a commitment so an operator cannot substitute orders.
   USDC.e buy authorization must remain valid through escrow, or the new vault
   must use a different explicit user approval flow. Never treat an unfunded
   commitment as spendable collateral.
2. Close the batch and publish a deterministic allocation proposal. Before
   any outbound transfer, check signed limits and reserve the whole refund
   liability. Use actual executable quotes only to size orders, never as proof
   of a future fill. Do not mark a batch irrevocably locked merely because a
   quote exists.
3. Send only the explicitly journaled asset amount to the operator's Deposit
   Wallet. Wrap USDC.e into pUSD through CollateralOnramp for buys; transfer
   conditional tokens for sells. Confirm each Polygon receipt and Deposit
   Wallet balance before creating a CLOB order. The exchange must be the
   current V2 address for the market's risk type.
4. Persist the exact signed order before submission. Submit one fee-buffered,
   tick-aligned FAK order through the official client. The current 0.02
   USDC/share buffer assumes Polymarket's published maximum 0.07 taker fee
   parameter, two-decimal share precision, and no additional fee; revalidate
   that envelope before trading. A timeout is quarantined, never blindly
   retried. Reconcile order status, trade history, confirmed Polygon receipts,
   and on-chain balance deltas before deciding any recovery action. Store
   actual filled shares and net pUSD, including fees.
5. Return all purchased tokens and unspent pUSD to the new vault, unwrapping
   pUSD proceeds to USDC.e as needed. The experimental vault measures actual
   balances and verifies each committed order's allocation proof, then checks
   exact whole-batch conservation. Before production, ensure the durable
   journal reconciles those balances with the CLOB fill and Polygon receipts.
6. Permit each order to claim its shares or net USDC plus its original-asset
   refund exactly once. The experimental direct claim path uses the escrowed
   owner and a single claimed flag. A future private claim path needs a
   separate, owner-bound authorization secret and shared nullifier; the
   relayer must not be able to redirect a claim using a salt it knows. A claim
   must never be computed from a nominal clearing price after a real CLOB fill.

## Recovery and trust boundary

A batch with no outbound transfer can expire and refund its escrow. After an
outbound transfer, an automatic timeout refund is unsafe: those assets may be
in a Deposit Wallet, in a pending exchange order, or already filled. Recovery
must reconcile and return the exact assets before finalization. The operator
temporarily controls outbound assets, so a zero-subsidy model does **not** by
itself eliminate custody risk. This needs an explicit threat-model review and
operator controls before taking public funds. A ledger stored only in a Redis
cache is insufficient for exactly-once CLOB execution; use durable storage
with backups and an auditable operator recovery procedure.
The v11 journal module requires `V11_DATABASE_URL`; it has not been connected
to production, and its live PostgreSQL integration test needs
`TEST_V11_DATABASE_URL`. Accepted or ambiguous CLOB submissions must be
resolved before a new order is allowed to consume the same routed assets.

Existing v10 batches and claims stay on v10. Do not point old proofs at v11,
change v10 verifier addresses, or sweep its balances. New market orders may
move only after a new vault, circuit, relayer, frontend configuration, and
fresh claim test are deployed together.

## Opening criteria

- Unit and fuzz tests for all four sides, partial fills, rounding, fees,
  negative-risk markets, invalid signatures, duplicate fills, and every
  conservation failure.
- Polygon fork tests using real USDC.e, pUSD Onramp/Offramp, Deposit Wallet,
  and V2 exchange addresses, including receipt and balance-delta checks.
- Mainnet pilot transactions with limited funds: buy YES/NO, sell YES/NO,
  partial/no fill, refund, claim, restart/recovery, and position exit.
- Independent review of vault, proof/public inputs, commitment/refund binding,
  and operator custody model. Production monitoring and an emergency stop.
- Resolve the full on-chain trade-detail privacy requirement. Current v11 and
  direct Polymarket CLOB execution cannot satisfy it.

Until these pass, keep `tradingEnabled: false` on mainnet.

## Local verification

Build the isolated verifier artifact before the vault integration test:

```sh
cd contracts/v11-verifier && forge build --offline
cd ../.. && cd circuits/allocation_v11 && nargo test
cd ../.. && cd contracts && forge test --offline --ffi
cd ../relayer && npm run build && npm test
```

The real proof tests require a native Barretenberg binary and its local cache;
they may need execution outside a restricted sandbox. The Polygon conversion
fork test runs separately with a Polygon RPC URL.
