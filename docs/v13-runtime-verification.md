# V13 runtime verification

Verified on 2026-09-23 IST. This is an engineering verification record, not an
independent security audit or evidence of a live v13 trade.

## Production evidence

Code commit: `b3590890f60865d0ec00e99aca375a246198480c`.
Railway deployment: `4580252c-228d-41ac-a4d5-04742415d5a3`, status `SUCCESS`.
The following results came from that deployment's pre-deploy container:

- PostgreSQL recovery: six abrupt process exits; encrypted witnesses recovered;
  duplicate action count zero; exact simulated allocations preserved.
- Queue concurrency: two workers and three orders produced one two-order batch
  and one pending order. The test used an isolated temporary PostgreSQL schema.
- Mainnet preflight: configured bytecode and pool roles matched; pool paused;
  zero unresolved v13 journal actions; no active batch requiring recovery.
- Order, route, settlement, and cancellation proofs: fresh proofs accepted by
  all four deployed Polygon verifiers; modified public inputs rejected.
- Redis connected and startup found no legacy batches needing recovery.

The database rehearsal simulates blockchain actions and CLOB fills. The verifier
checks use real proofs and read-only `eth_call`; they do not spend POL or trade.

Local verification: 147 relayer/browser-flow tests passed, five opt-in tests
skipped; eight ShieldedPoolV2 contract tests passed; relayer TypeScript and
frontend production builds passed.

## Follow-up fork and browser verification

The local Polygon fork rehearsal passed at source block `94275137` using the
deployed pool, real v13/withdrawal verifiers, real USDC.e/pUSD bridge contracts,
and the real Conditional Tokens contract. It creates only a synthetic fork-local
market and balances, and simulates the CLOB fill. No mainnet transaction or real
order is submitted.

Verified paths:

- Two deposits and real order-lock proofs, followed by a real route proof.
- Settlement rejected before assets return; partial-fill assets returned through
  the real bridges; exact private refund and position allocations accepted.
- Both users withdraw refunds and positions while paused; replayed withdrawals
  revert; liabilities and the Deposit Wallet return to zero.
- A zero-fill routed batch returns all collateral and both users withdraw full
  refunds, ending with zero liabilities.
- Both users independently cancel unrouted orders while paused and withdraw
  their refunds with real proofs, ending with zero liabilities.

The follow-up application suite passes 163 tests with five opt-in tests skipped.
New coverage includes confirmed cancellation/withdrawal recovery after lost
browser receipts, reconstruction of missing output notes, invalid allocation
receipt rejection, confirmed-event pagination, wallet-isolated storage, Web Locks
write serialization, and non-destructive backup import. Legacy encrypted storage
remains readable by its original wallet and is preserved during migration.

Reproduce with `npm run rehearse:fork:v13` from `relayer`, after compiling the
Foundry artifacts. Anvil and a read-only Polygon `RPC_URL` are required. This
contract integration rehearsal does not replace the live v13 CLOB exercise or
the [independent review](security-review-v13.md).

## Fixed failures

- Bundled v13 circuit artifacts inside Railway's deploy root.
- Initialized the route prover's required 2^21 CRS instead of the smaller default.
- Allowed recovery of routed batches while new intake is disabled.
- Avoided demanding the original collateral balance after a CLOB order had
  already been submitted; recovery follows the durable execution evidence.
- Reconfirmed recorded route/settlement transactions and rejected treating
  cancelled nullifiers as a successful settlement.
- Made queue claiming and encrypted batch-witness storage one SQL transaction.
- Persisted browser recovery secrets before any deposit or order-lock broadcast.
- Restored exits for confirmed deposits and cancelled orders while intake is paused.
- Configured Vercel's v13 pool, deployment block, and Deposit Wallet; kept the
  frontend trading gate false.

## Still required for launch

1. A user-operated v13 mainnet exercise with actual fills, asset returns,
   allocation receipts, withdrawals, and restart reconciliation. Earlier v11
   fills do not establish this version's live behavior.
2. Independent review of circuits, contracts, execution recovery, key management,
   and browser note backup/recovery. This internal work does not satisfy that gate.
3. Privacy validation and a compatible product claim. Current exact-amount public
   funding, same-wallet authorization/withdrawal, two-order batches, and relayer
   witness access do not meet a promise to hide every individual's trade details.
4. Product coverage beyond the current private-buy path, including private sells
   and redemption or clearly defined public exits. Public position withdrawal is
   not an end-to-end private sell/redemption flow.

The previously authorized v13 deployment is complete. None of these software
checks required another deployment transaction or additional deployment POL.
