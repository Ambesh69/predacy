# V13 independent review package

Prepared 2026-09-23. Status: ready for scoping; no external reviewer has been
engaged and no independent approval has been obtained.

## Engagement scope

Review the protocol design before quoting a production-launch audit. The
requested product promises more privacy and functionality than v13 provides.
An implementation audit cannot turn those missing properties into guarantees.

Repository: `Ambesh69/predacy`. Use the exact reviewed commit, compiler versions,
lockfiles, circuit bytecode hashes, and deployed runtime hashes in the final
report. Previously verified production baseline: `cf34a9a11de988bf6dae784ddac48838f593d6f6`.
The new fork rehearsal and browser exit recovery should be included in the
reviewed revision, not assumed covered by that baseline.

In-scope contracts:

- `contracts/src/ShieldedPoolV2.sol`
- `contracts/src/ShieldedPolymarketAdapter.sol`
- `contracts/src/PolymarketCollateralBridge.sol`
- `contracts/v13-verifiers/{order,route,settlement,cancel}`
- Reused withdrawal and transfer verifiers and their Noir circuits.

In-scope proof and application code:

- `circuits/shielded_{order,route,settlement,cancel}_v13/src/main.nr`
- `relayer/src/v13*.ts` and `relayer/scripts/v13*.ts`
- `relayer/src/v12PolygonDriver.ts`, `v11OrderExecution.ts`, `v11OrderJournal.ts`,
  `v11OrderReconciliation.ts`, and Deposit Wallet funding/withdrawal helpers.
- `frontend/lib/private*.ts`, wallet vault backups, and both market-page clients.
- Intake authentication, location eligibility, key separation, encrypted
  PostgreSQL storage, deployment configuration, and incident recovery.

## Required threat models

1. An outside chain observer correlating deposits, transaction senders, routing,
   withdrawals, timing, and external order-book fills.
2. A participant knowing its own allocation and observing batch totals.
3. A relayer reading witnesses, censoring users, allocating unfairly, crashing
   between write-ahead and broadcast, or losing signing credentials.
4. Multiple workers, chain reorgs, replaced transactions, provider timeouts,
   stale order-book evidence, cancellation races, and partial CLOB fills.
5. A browser losing storage or connectivity, importing an older backup,
   changing wallets, or using multiple tabs/devices.

## Known launch blockers

The pool's immutable batch size is two. A participant can subtract its known
spend and shares from public totals to recover the other participant's amounts.
Larger batches alone cannot provide protection against all-but-one collusion.
Zero-knowledge witness hiding does not remove these arithmetic disclosures.

The browser currently deposits the exact order amount and authorizes from the
same wallet. Public withdrawals expose asset, amount, and recipient. The
relayer decrypts the complete order witnesses. Fixed-denomination funding,
independent timing, and private submission are not implemented and must not be
advertised as implemented.

The deployed pool and adapter have a buy execution path only. End-to-end private
sells and redemption require a new proof/contract design and deployment. Public
withdrawal followed by a sale is not an implementation of private selling.

If aggregate market, direction, amount, and fill must also be secret, the present
public Polymarket execution path does not meet the requirement. The reviewer
must explicitly state the achievable privacy model; a vague "private" label is
not an acceptance criterion.

The remediation changes browser storage to wallet-specific keys, serializes
writes with Web Locks, and merges backups instead of replacing newer records.
Review migration, multi-wallet isolation, cross-tab writes, reorg handling, and
recovery-data preservation before launch. A backup from before a deposit cannot
reconstruct that deposit's missing random secret.

## Security acceptance criteria

- Conservation of each user's assets under adversarial amounts, prices, rounding,
  token behavior, and partial fills; no cross-user or relayer subsidy.
- Proof constraints bind every relevant asset, secret, nullifier, output,
  aggregate, recipient, and domain. Replays and redirected outputs fail.
- Each external transaction/order either has sufficient durable evidence for
  idempotent recovery or stops for reconciliation. Unknown results never cause
  an automatic repeat trade.
- Deposits, routed funds, private outputs, cancellations, and withdrawals remain
  exactly reconciled through reorgs and process/browser failures.
- Unrouted cancellation and permitted exits remain available during an outage
  or pause; cancellation cannot strand another participant's order.
- The privacy claim survives the listed observer and participant attacks under
  clearly stated assumptions. Residual leakage is explicitly reported.
- Findings include severity, reproducible tests, affected code, and remediation;
  critical/high findings are fixed and independently retested before launch.

## Reproduction

Run from the repository root:

```sh
npm --prefix relayer ci
npm --prefix frontend ci
npm --prefix relayer test
npm --prefix relayer run build
npm --prefix frontend run build
forge test --root contracts --match-path test/ShieldedPoolV2.t.sol
npm --prefix relayer run rehearse:fork:v13
```

The fork script needs Anvil, compiled Foundry artifacts, and `RPC_URL` for
read-only Polygon state. It spawns a loopback-only Anvil process, impersonates
roles only there, uses synthetic collateral and a synthetic CTF market, and
never signs or broadcasts a mainnet transaction. Its CLOB fill is simulated.
Do not mistake its transaction receipts for live-mainnet execution evidence.

The production PostgreSQL rehearsal and fresh-verifier checks are described in
`v13-runtime-verification.md`. Database recovery and contract integration are
separate tests; neither establishes a successful live v13 CLOB fill.

Never provide reviewers private keys, API secrets, database credentials, note
secrets, decrypted witnesses, or complete deployment environments. Provide
redacted configuration and narrowly scoped access only after explicit approval.

## Reviewer shortlist

Fit assessments below are preliminary; availability, cost, independence, exact
Noir/Barretenberg version support, and scope must be confirmed by a proposal.

- **zkSecurity:** first scoping candidate for the privacy threat model and ZK
  protocol review. Its stated services include circuits and cryptographic
  protocol audits. [Services and audit request](https://zksecurity.xyz/).
- **Veridise:** candidate for circuit constraint review and formal-methods
  support alongside contract/application review.
  [ZK audit scope](https://veridise.com/audits/zk/).
- **Trail of Bits:** candidate for a broader cryptography and application
  security engagement. [Cryptography services](https://trailofbits.com/services/cryptography/)
  and [contact](https://trailofbits.com/contact/).

No requests have been submitted, files shared, services purchased, or dates
promised. Obtain a design-review proposal first, then commission an audit of a
frozen implementation revision that actually meets the agreed product scope.
