# Predacy Private V13

V13 preserves Polymarket aggregate liquidity without publishing an
individual order's market, side, size, limit, fill, or originating wallet.
Polymarket's aggregate hedge remains public by construction.

## Implemented protocol shape

1. A collateral note is spent into a generic private order-note commitment.
   Lock calldata and events contain no outcome token or market identifier.
2. Order notes enter an append-only accumulator shared across markets and
   epochs. The relayer cannot select two freshly locked notes and publicly link
   them to one hedge.
3. A batch proof consumes order notes by unique nullifiers, proves accumulator
   membership, common aggregate market/outcome, hidden limits, and exact value
   conservation. The originating commitments are not public inputs.
4. The contract exposes only aggregate position token, collateral, acquired
   shares, and batch nullifiers. It inserts private refund and position notes.
5. Funding uses fixed denomination notes and is separated in time from order
   authorization. Direct wallet deposits are described as public funding, not
   sender anonymity.
6. Withdrawals may target fresh recipients; public withdrawals disclose asset,
   amount, and recipient but not the source note.
7. Every unrouted order has a proof-authorized refund independent of the
   relayer. Recovery cannot replay an ambiguous Polymarket fill.
8. Mainnet remains closed until a live restart-recovery exercise and an
   independent circuit, contract, relayer, and key-management review complete.

The implementation is split across:

- `shielded_order_v13`: spends a collateral note into a generic order note.
- `shielded_route_v13`: proves two hidden order memberships at one current root
  and exposes only unlinkable order nullifiers plus aggregate execution data.
- `shielded_settlement_v13`: binds exact private allocations to the routed batch.
- `shielded_cancel_v13`: independently returns an unrouted order's full deposit.
- `ShieldedPoolV2`: enforces nullifier uniqueness, exact backing, paused intake,
  preserves pre-existing asset surplus, and keeps exits available while paused.
- The v13 relayer queue, event-derived Merkle indexer, encrypted witness vault,
  write-ahead journal, globally serialized Polygon runner, and browser
  order/cancellation provers.

All four Noir circuits compile and have positive and negative tests. All four
generated Honk verifier runtimes compile below Polygon's 24,576-byte EIP-170
limit. The frontend and relayer production builds pass. No v13 contract has been
deployed and the v13 intake gate defaults disabled.

## Privacy boundary

V13 hides each constituent order's market, outcome token, amount, limit, fill,
refund, resulting position note, and source commitment from public batch
linkage. A generic order commitment and later secret-derived nullifier are
public, but an observer cannot link them without the secret.

This is on-chain observer privacy, not operator-oblivious execution. The relayer
decrypts order witnesses in process memory to group orders and generate proofs.
Moving that trust boundary requires an independently attested TEE, threshold MPC,
or another oblivious matching design. PostgreSQL encryption at rest does not
solve process-memory visibility.

The public aggregate market, direction, amount, and fill cannot be hidden while
using Polymarket's Polygon settlement. Product language must distinguish that
aggregate visibility from individual order privacy.

## Launch gates

Mainnet intake requires all three variables:

- `V13_PRIVATE_TRADING_ENABLED=true`
- `V13_ACCEPT_PUBLIC_AGGREGATE_EXECUTION=true`
- `V13_TRUST_RELAYER_WITH_WITNESSES=true`

`npm run preflight:v13` checks deployed bytecode, every pool role and verifier,
pause/active state, signer separation, and unresolved PostgreSQL actions. The
deployment script always creates the pool paused. Enabling these flags is not a
substitute for the independent review and recovery pilot required above.

## Deployment order

The measured five-script deployment uses `32,892,461` gas. At a 280 gwei
`maxFeePerGas` and a 10% reserve, the required ceiling is
`10.130877988 POL`. Recompute this immediately before deployment; the measured
gas is encoded and unit-tested in `relayer/src/v13DeploymentBudget.ts`, but the
network fee is not stable. Never start unless the deployer can fund the entire
sequence, including the reserve. Run `npm run preflight:deploy:v13` with an
explicit `V13_DEPLOYMENT_BUDGET_POL` and `V13_MAX_GAS_PRICE_WEI` immediately
before any broadcast.

1. Deploy the order, route, settlement, and cancellation verifiers with each
   verifier project's `mainnet` Foundry profile. That profile links the existing
   shared transcript library whose executable bytecode was checked against the
   generated v13 libraries.
2. Set the six verifier addresses, separate relayer/guardian/Deposit Wallet
   roles, and `V13_MAX_GAS_PRICE_WEI`, then run
   `DeployShieldedV13Mainnet.s.sol`. It creates and binds a paused pool/adapter.
3. Configure Railway with `V13_POOL_ADDRESS`, `V13_ADAPTER_ADDRESS`,
   `V13_DEPLOYMENT_BLOCK`, all six verifier addresses, `V13_GUARDIAN`,
   `V13_DEPOSIT_WALLET`, `V13_EXCHANGE_ADDRESS`, separate signer and relayer
   keys, `V13_DATABASE_URL`, and a random 32-byte `V13_JOURNAL_KEY`.
4. Run `npm run preflight:v13` while intake is disabled and the pool is paused.
   Resolve every mismatch or unresolved journal action before continuing.
5. Complete the independent circuit/contract/relayer/key-management review and
   a restart-recovery exercise. Unpause and enable the three launch gates only
   after those checks pass. Configure the frontend's `NEXT_PUBLIC_V13_*`
   addresses and `NEXT_PUBLIC_PRIVATE_TRADING_ENABLED` last.
