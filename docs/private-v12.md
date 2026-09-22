# Predacy Private V12

## Privacy boundary

V12 hides each user's balance, order, position, allocation, and claim inside a
shielded note pool. Polymarket only sees pooled execution wallets and aggregate
hedges. Those aggregate hedges remain public because Polymarket settles them on
Polygon; they must not be represented as fully private.

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
leaf metadata, and local position state with AES-GCM. Ciphertext is bound to the
wallet address and can be exported or restored as an encrypted backup; plaintext
note material is never written to browser storage.

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

Each generated EVM verifier lives in an isolated Foundry project because Noir's
generated verifier symbols collide when multiple generated verifiers share one
Solidity compilation unit.

The contracts are intentionally deployed paused by the v12 deployment script.
Passing tests are not an authorization to enable public trading: deployment,
live PostgreSQL restart recovery, an independent security review, and a capped
recovery exercise still remain. Private
order intake now requires a current HMAC-signed Vercel location assertion and
rejects Polymarket's blocked countries and regions.

## Remaining execution path

1. Replace Keccak Merkle hashing with a reviewed SNARK-friendly implementation
   and benchmark browser proving on target devices.
2. Use fixed epochs, padded batches, and rotated pooled
   execution wallets to reduce timing correlation.
3. Exercise PostgreSQL restart recovery and a deliberately capped live batch;
   the real Polygon USDC.e/pUSD rejection and partial-fill fork paths pass.
4. Complete an independent circuit, contract, relayer, and key-management review
   before enabling production trading.
