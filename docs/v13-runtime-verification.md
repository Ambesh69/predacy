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
