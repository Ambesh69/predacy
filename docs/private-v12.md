# Predacy Private V12

## Privacy boundary

V12 hides balances, amounts, limits, allocations, and note ownership inside a
shielded note pool. It does not hide each locked order's outcome asset:
`lockBuyOrder` publishes that asset, and `startBuyBatch` publicly enumerates the
two commitments routed into the Polymarket hedge. V12 therefore does not meet
the product's individual trade-detail privacy requirement.

The relayer must not learn note secrets or withdrawal ownership. A relayer may
learn decrypted orders while constructing a batch until encrypted matching is
moved into an independently attested execution environment or MPC network.

## On-chain invariants

1. Every deposited note is bound to the deposited asset and amount.
2. A withdrawal proves membership in a known note root.
3. A note nullifier can be spent exactly once.
4. The withdrawal recipient and amount are bound into the proof transcript.
5. Pausing blocks new deposits and withdrawals without changing existing notes.
6. Settlement may add notes only when a proof conserves every pooled asset.
7. Public aggregate execution cannot create an unbacked private liability.
8. A rejected or timed-out route cannot be cancelled until all routed collateral
   is back in the pool.
9. Every inserted commitment emits its exact leaf index so a wallet can rebuild
   Merkle witnesses from Polygon without trusting a private indexer.
10. A user can proof-cancel a locked order into its full-refund note without the
    relayer. This escape hatch reveals the cancelled deposit amount.

## Current foundation

`ShieldedPoolV1` implements collateral and Polymarket outcome-token deposits, an
incremental commitment tree, per-asset liability accounting, known-root tracking,
proof-gated withdrawals, nullifier replay protection, and guardian pause control.
`shielded_withdraw_v1` proves note ownership, membership, asset and amount binding,
and recipient authorization without revealing the source commitment.
`shielded_transfer_v1` privately splits or transfers a note into new notes of the
same hidden asset while proving exact value conservation. Its on-chain call does
not reveal the asset or either output amount.
`shielded_order_v1` consumes a private collateral note into a buy-order
commitment. It binds the hidden deposit and limit to one outcome token and to the
private keys that will receive refund and position notes. The contract records
only the commitment, outcome asset, and nullifier; it does not store the order
amount or limit.
`shielded_buy_batch_v1` opens two locked buy orders inside one proof, enforces
each hidden limit, proves aggregate deposits, spend, and acquired shares, and
derives the exact private refund and position notes. Membership is proven once
at order authorization, keeping the recurring settlement proof substantially
smaller than a circuit containing multiple Merkle paths.

`ShieldedPoolV1.startBuyBatch` verifies a zero-fill version of that proof before
routing the exact aggregate deposit. `settleBuyBatch` verifies the final fills,
checks that returned USDC.e and outcome-token balances back every resulting
private note, consumes the locked orders, and inserts only the private refund and
position commitments. Individual deposits, limits, fills, refunds, position
sizes, and note owners are not emitted or stored on-chain.

`ShieldedPolymarketAdapter` is the only outbound collateral path. It wraps the
pool's USDC.e into pUSD at one dedicated Polymarket Deposit Wallet. The v12 runner
can reuse the existing Deposit Wallet funding, order, reconciliation, and
withdrawal components to submit the aggregate CLOB order, return outcome tokens
directly to the pool, and return residual pUSD to the adapter for unwrapping.
Recovery can move collateral only back to the pool.

The relayer witness builder generates both route and settlement proofs from the
same private order data and checks Noir's 20 public inputs byte-for-byte against
the Solidity layout. The generated batch verifier has also accepted a fresh EVM
proof in Foundry. All four verifiers use a size-optimized isolated build and fit
Polygon's EIP-170 runtime limit.

The v12 runner journals route, Deposit Wallet withdrawal, pUSD unwrapping,
outcome return, and settlement as separate one-shot actions. Private witnesses
are AES-256-GCM encrypted at rest with batch-bound authenticated data. A restart
can resume confirmed work but cannot automatically replay an ambiguous chain
send. Aggregate fills are allocated deterministically across at most two hidden
orders while preserving exact totals and every private limit.

`V12PolygonDriver` binds that runner to Polygon and the Polymarket SDK. Before
routing it verifies the deployed pool, adapter, verifier, roles, Deposit Wallet,
collateral, CTF, market token, tick, exchange variant, and fee envelope. It
requires an isolated Deposit Wallet, uses a durable one-shot aggregate FAK order,
reconciles terminal order/trade receipts with wallet balances, and refuses an
explicit rejection unless the wallet proves an exact zero fill. The operator
entrypoint is `npm run run:v12 -- --execute <order-set-hash>`; it loads the
private request only from the encrypted PostgreSQL witness vault.

The frontend private-note vault encrypts note secrets, ownership keys, amounts,
leaf metadata, order receipt tokens, output secrets, and local position state
with AES-GCM. Ciphertext is bound to the wallet address and the positions panel
can export or restore one validated full-vault backup; plaintext note material
is never written to browser storage.

The frontend also contains browser-only Noir/Barretenberg order and withdrawal
provers. It reconstructs 20-level Merkle paths from `NoteInserted` logs and
checks every generated public input against the exact pool call before returning
a proof. Market and event pages can deposit, authorize, queue, display, cancel,
and withdraw v12 notes. The UI remains disabled unless explicit v12 deployment
addresses and the private feature flag are present.

The relayer's v12 intake checks that each submitted commitment is already locked
for the configured pool and outcome. Private execution witnesses are encrypted
in PostgreSQL, and exactly two compatible orders are atomically promoted to the
resumable runner. A single queued order is never executed as an identical public
aggregate. This provides on-chain privacy, not operator privacy: the relayer can
decrypt individual order amounts and limits. Each browser generates a random
receipt bearer secret; only its hash enters the encrypted queue, and the fill is
returned through that authenticated receipt rather than a public order endpoint.

Executable batches wait for the next fixed execution epoch (60 seconds by
default), and every public aggregate contains exactly two compatible private
orders. The epoch is sealed into the encrypted batch witness. This reduces direct
lock-to-hedge timing correlation; it does not hide the aggregate hedge amount or
make the relayer oblivious to its two constituent orders.

V12 intake has an independent `V12_PRIVATE_TRADING_ENABLED` gate. Disabling it
rejects new orders without disabling recovery. At startup the relayer scans the
encrypted PostgreSQL queue for batched orders without complete receipts and
resumes their one-shot runner. `/v12/status/:batchId` reconstructs completed or
pending state from PostgreSQL after in-memory job state is lost.

Each generated EVM verifier lives in an isolated Foundry project because Noir's
generated verifier symbols collide when multiple generated verifiers share one
Solidity compilation unit.

The contracts are intentionally deployed paused by the v12 deployment script.
The owner briefly enabled production intake and unpaused the pool on September
23, 2026 before an independent security review or live recovery exercise was
complete. No notes or batches were created; intake was disabled and the empty
pool was paused after the public per-order asset link was confirmed.
Private order intake requires a current HMAC-signed Vercel location assertion
and rejects Polymarket's blocked countries and regions.

Operational checks:

```bash
cd relayer
npm run rehearse:recovery:v12
npm run preflight:v12
```

The recovery rehearsal writes uniquely identified encrypted witness and action
rows, closes both PostgreSQL clients, reconnects, proves the broadcast action is
not claimable again, completes it, and removes the rehearsal rows. The preflight
is read-only apart from creating missing database tables. It verifies chain,
bytecode, every contract role/address, paused/active state, PostgreSQL recovery
state, and the Polymarket Deposit Wallet identity.

## Remaining execution path

1. Decide whether to migrate the Keccak tree to a separately reviewed,
   Noir/EVM-compatible Poseidon2 implementation. The current implementation is
   interoperable and proven end to end, but Keccak makes browser proofs heavier.
2. Register and fund a pool of isolated Polymarket Deposit Wallets before adding
   wallet rotation. Fixed epochs and fixed two-order batches are implemented;
   zero-subsidy amount padding requires equal-denomination order splitting rather
   than operator-funded cover orders.
3. Deploy the verifiers, pool, and adapter paused; run the live PostgreSQL
   rehearsal and read-only preflight; then perform a deliberately capped recovery
   batch before considering the intake gate.
4. Complete an independent circuit, contract, relayer, and key-management review
   before enabling production trading. An internal test pass is not independent
   review.

Before broadcasting, run `npm run preflight:deploy:v12` from `relayer` with
`PRIVATE_KEY` (or the configured v12/legacy relayer key), `RPC_URL`, and an
explicitly authorized `V12_DEPLOYMENT_BUDGET_POL`. The preflight detects the deployed transcript library
and verifier addresses, prices the measured remaining gas with a 10% margin, and
fails unless both the budget and deployer balance cover it.

All deployment scripts also fail before `startBroadcast` when either Polygon's
base fee or the effective transaction gas price exceeds
`V12_MAX_GAS_PRICE_WEI` (5 gwei by default). Pass the same value to Forge with
`--legacy --with-gas-price <wei> --gas-price <wei>`, and set
`FOUNDRY_PROFILE=mainnet` for every verifier broadcast so the existing transcript
library is reused. `--gas-price` alone does not cap Foundry's EIP-1559 broadcast.
Never override the cap without a new explicit POL budget.

The September 2026 attempt successfully deployed the withdrawal circuit's
reusable `ZKTranscriptLib` at `0x9a2abcf4ca811335cff4ed1b1d0d4d4034889350`.
All four verifier projects use its byte-for-byte identical library source and
the `mainnet` Foundry profile links them to this shared address. The withdrawal
verifier transaction itself was not broadcast. The remaining measured deployment
is 25,458,834 gas before the safety margin.

## Polygon mainnet deployment

The paused v12 contracts were deployed on September 23, 2026:

- Withdrawal verifier: `0x84E162dB396Cf2708aef3D3c06cbBBD84E6d6a98`
- Transfer verifier: `0x9948b33D6Bb716586d10BE56a088Fc4e1d6eE8F9`
- Order verifier: `0x72F1A32b381eA40Ce3E5AfB42d4a99C381819E4C`
- Buy-batch verifier: `0x4173143e37f4Cf9a4a8b8aa81BCFD9322a8d1660`
- Adapter: `0xb13c590614097d2833D4A1Bd404D4Ed10397D764`
- Pool: `0xfD533100FE8a38Fe7b3cBb49d441AF296bd24B35`

The pool deployed paused and was temporarily unpaused in transaction
`0xbac5c9f770859117286154258771d40cce9ef7a1b3483c05adf6debee294c214`.
Production private intake is disabled and the pool is paused. Railway requires
both the PostgreSQL recovery rehearsal and `preflight:v12` to pass before
starting a release.
