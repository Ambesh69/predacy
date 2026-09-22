# Predacy Private V13

V13 preserves Polymarket aggregate liquidity and uses proofs instead of
publishing individual order witnesses in batch settlement. This is not a
guarantee that all trade details or wallet linkage remain private: funding,
withdrawal, timing, and small-batch inference remain visible risks.
Polymarket's aggregate hedge remains public by construction.

## Implemented protocol shape

1. A collateral note is spent into a generic private order-note commitment.
   Lock calldata and events contain no outcome token or market identifier.
2. Order notes enter an append-only accumulator shared across markets and
   epochs. Source commitments are omitted from routing proofs, although the
   relayer knows which notes it selected and can disclose that association.
3. A batch proof consumes order notes by unique nullifiers, proves accumulator
   membership, common aggregate market/outcome, hidden limits, and exact value
   conservation. The originating commitments are not public inputs.
4. The contract exposes only aggregate position token, collateral, acquired
   shares, and batch nullifiers. It inserts private refund and position notes.
5. The current browser deposits the exact order amount immediately before
   authorizing the order, from the same wallet. Fixed-denomination prefunding,
   time separation, and anonymous transaction submission are not implemented.
6. The contract permits fresh withdrawal recipients, but the current browser
   withdraws to the connected wallet. Public withdrawals disclose asset,
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
limit. The frontend and relayer production builds pass. V13 is deployed paused
and its intake gate defaults disabled.

## Polygon deployment

The deployment completed at blocks `94272870` through `94272950`. Actual gas
spend was `6.994017334609227 POL`, below the authorized `10.2 POL` ceiling.

| Component | Address | Transaction |
|---|---|---|
| Order verifier | `0x871A551420e197AB1E892B5D66aE78812CB1e983` | `0xfa00ed1a67b1e396d28ad5b422e2c5f26ffb5d9ee6f188219278f8d0a6634555` |
| Route verifier | `0xFC3bdDd42A2EB878E27ABDB34e7b2b6E59c989da` | `0xe9301afb1b7d1be5b7e4d295bea14be63be403e8736727718f3c7c48ab468265` |
| Settlement verifier | `0xC69555017793eA0AEA855dabd6c965964D7Ce49B` | `0x21abbaa15d5a936ec27500b7228ff0c2f606062096e6fb2e3b1e9e11ae46f113` |
| Cancellation verifier | `0xDeaddC734D0A027A2575eBd6dB98b0Ed17f1236C` | `0x0bdb22313d67854e949de32fc6e7963ad1f79ae7629bacd2161dfbc1adf62f14` |
| Polymarket adapter | `0x67ac865146f2EF2d7f0c9C08e75ED6E641a2390a` | `0x26d84e2ddb3e56fa5fd870c7c2ae1a578b6527a192642b2140298f948112ea38` |
| ShieldedPoolV2 | `0x66AA268ab8183AdE8081879D030f54Ab6D2b0A1b` | `0xb1dfc10f4304a71a26a489136ce14eeedf91e114da8bd868f0a128b889bc1c45` |
| Adapter binding | Pool above | `0xfaf65fcedd0f464c13b0cb34c122eb1f8d889f7e79a3c3f34c87b1cc681ee4c3` |

Railway production commit `5c0823b` passed `predeploy:production`, including
the v13 bytecode/role/pause checks, signer separation, PostgreSQL connectivity,
and unresolved-journal check. All three v13 launch variables remain `false`.

## Privacy boundary

V13 does not enumerate individual order witnesses or source commitments in
public batch settlement. A generic order commitment and later secret-derived
nullifier are public; their cryptographic relation is hidden without the
secret. Public metadata can still reveal the association. In particular, two
orders provide a very small anonymity set, and a participant who knows its own
amounts can subtract them from aggregate totals to learn the other amounts.
An observer can also correlate exact deposits, transaction senders, and timing.
Do not describe this version as hiding every individual's trade details.

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

`npm run preflight:proofs:v13` generates fresh proofs for all four deployed v13
verifiers and uses read-only Polygon calls to check acceptance and tampered-input
rejection. It spends no POL and executes no trade. The route circuit requires
an explicitly initialized 2^21 CRS; the library default is too small.

`npm run rehearse:recovery:v13` exercises six abrupt process exits, encrypted
witness recovery, exactly-once action recording, and concurrent queue assembly
against PostgreSQL in a temporary isolated schema. Chain actions and CLOB fills
are simulated. This is database recovery evidence, not a live-fill pilot.
Both checks run in the Railway pre-deploy gate.

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
