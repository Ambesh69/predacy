# Private prediction-market research

Date: 2026-09-23. Status: design investigation and an offline leakage model,
not a new deployed protocol, security proof, independent audit, or launch approval.
The user has authorized exploring all mechanisms, including LP inventory and
batching, while retaining a simple fund-and-trade experience. No LP funding,
paid engagement, or new mainnet deployment is authorized by this research.

## Recommendation

Investigate **shielded trading against independently funded inventory**, with
Polymarket as an optional inventory venue rather than the executor of each
customer order. Couple it with private computation, a single multi-market note
ledger, private sells/redemption, and explicit controls on observable outputs.

This separates two operations that v13 currently couples: a customer's change
in ownership and an external inventory trade. It does not make external trades
secret or grant free, unlimited access to Polymarket's liquidity.

The most interesting hypothesis is to reserve execution capacity *before*
learning a user's chosen market. That could prevent another customer's orders
from being inferred through changing availability. This is an original design
proposal for investigation here, not a claim that the mechanism is unprecedented.
The construction and its economic feasibility are unproven.

## What the research establishes

Polymarket V2's exchange emits side, outcome token, maker/taker addresses, fill
amounts, and fees. Its collateral adapter supports public split, merge, and
redemption operations. We cannot make those events private from a separate app.
Acquiring inventory before user orders is nevertheless a different interface
from routing every user order to that exchange.
[Exchange source](https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/mixins/Events.sol),
[adapter source](https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/adapters/CtfCollateralAdapter.sol).

There is constructive research on private prediction markets, not a blanket
impossibility result. Cummings, Pennock, and Vaughan study joint differential
privacy for wagering beliefs and a conditional limitation for dynamic markets.
Their wagering guarantee does not hide wager amounts. Frongillo and Waggoner
give a private dynamic-market construction using fees and adaptive liquidity
to bound market-maker loss. These results change the mechanism's economics;
they are not plug-in guarantees for exact Polymarket fills, hidden wallet
funding, or a whole blockchain application.
[2016 paper](https://www.jennwv.com/papers/privatemarkets.pdf),
[2018 construction](https://proceedings.neurips.cc/paper/8244-bounded-loss-private-prediction-markets.pdf).

## Prior art and gaps

| Approach | Useful evidence | Gap for Predacy |
| --- | --- | --- |
| Shielded programmable notes | Aztec documents notes, nullifiers, private ownership, and encrypted note delivery. | A note system alone does not hide public token bridges, application access patterns, or shared matching state. |
| ZK-MPC dark pools | Renegade documents private peer-to-peer crossing and proof settlement. | Its connected relayer can read that user's orders and balances; hosted use is not operator-blind unchanged. |
| FHE RFQ | Zama's July 2026 private-beta description documents confidential bidding and settlement. | Quoting makers learn size; the winner learns direction. Asset-hiding padding was future work in that announcement, not independently verified here. |
| Shielded batch swaps | Penumbra separates batch execution from private output claims. | Its specification describes V1 inputs as public and sealed-input swaps as a future upgrade. Batch totals/pair disclosure are not full-detail privacy. |
| Malicious-secure MPC | Cerberus specifies computation privacy with one honest computing party and identifiable abort. | A protocol paper is not evidence that this application is deployed; abort handling and output leakage remain separate problems. |
| TEE-controlled assets | Liquefaction studies private sharing of control over existing blockchain assets. | Hardware, attestation, side channels, and recovery become assumptions; public asset activity still exists. |
| Private solvency proofs | Provisions hides parts of reserve/liability evidence. | Bitcoin exchange solvency does not establish outcome-contingent backing, unencumbered inventory, or private prediction-market recovery. |

Primary references for the rows:
[Aztec state](https://docs.aztec.network/developers/docs/aztec-nr/framework-description/state_variables),
[Renegade relayers](https://help.renegade.fi/hc/en-us/articles/32530262853395-What-are-relayers-on-Renegade),
[Zama RFQ](https://www.zama.org/post/announcing-zama-confidential-rfq-private-beta),
[Penumbra specification](https://protocol.penumbra.zone/main/dex/swap.html),
[Cerberus paper](https://www.arcium.com/_astro/cerberus.DXoHIFmM.pdf),
[Liquefaction](https://arxiv.org/abs/2412.02634),
[Provisions](https://eprint.iacr.org/2015/1008.pdf).

Anonymous payment channels and mix networks are additional building blocks for
funding/submission, not complete exchange implementations. BOLT studies private
payment channels; Loopix studies cover traffic and mixing. Their guarantees
must not be transplanted to a browser/relayer integration without checking
the assumptions and the new metadata it exposes.
[BOLT](https://acmccs.github.io/papers/p473-greenA.pdf),
[Loopix](https://www.usenix.org/system/files/conference/usenixsecurity17/sec17-piotrowska.pdf).

## Candidate mechanism

The following is a proposed composition, not a feature claim about v13.

1. **Fund once into a common shielded ledger.** Hide the market, outcome, amount,
   owner, and order type inside notes, using reviewed primitives. A public
   ERC-1155 transfer for each user's action would defeat this design. Deposits
   and exits have a separately declared privacy boundary.
2. **LPs supply inventory and sell-side cash.** Customers do not manage a second
   reserve wallet. Ownership of fully backed positions moves inside the ledger.
   Use actual CTF backing initially; synthetic claims would add distinct oracle,
   capital, and settlement obligations and must not be called CTF custody.
3. **Publish a complete quote catalog on a fixed schedule.** Prices may reference
   public Polymarket data, with a stated spread, expiry, and capacity. The entire
   supported market catalog is committed, so a private lookup does not reveal
   which market was requested. A reference price is not guaranteed external
   execution at that price. Initial quotes must not react to private inventory.
4. **Pre-reserve market-oblivious execution tickets.** A ticket privately permits
   bounded quantities across a fixed market set until expiry. Back its worst-case
   obligations before admission, rather than revealing availability through
   customer-specific reactive hedging. Tickets need anti-replay, scarce-resource
   allocation, cancellation, and expiry rules. Sybil resistance cannot be assumed.
5. **Compute matches privately and prove state transitions.** Investigate
   malicious-secure threshold MPC with collaborative proving, versus FHE with
   an explicitly scoped decryption policy. A normal prover given all plaintext
   witnesses recreates v13's operator visibility. Do not invent a new cipher.
6. **Settle buys and sells as private note exchanges.** Buying moves collateral
   to the reserve and creates an outcome note. Selling consumes an outcome note
   and creates a collateral note at the authorized quote, backed by real cash.
   Circuit constraints must prevent subsidy, duplicate inventory use, unauthorized
   fees, stale quotes, overflow, and rounding-created liabilities.
7. **Redeem privately against a finalized resolution catalog.** A proof checks
   membership of the private condition/outcome in a public catalog root, consumes
   the position note, and produces its exact collateral entitlement. Outcome
   lookup, note types, calldata length, and public events must not identify the
   condition. Invalid/fractional outcomes need explicit payout arithmetic.
8. **Keep external activity separate.** Public acquisition, hedging, conversion,
   and underlying CTF redemption follow a separately funded policy. A fixed
   timestamp is insufficient if market, direction, or quantity follows customer
   flow. Any relaxation of independence needs a measured leakage budget, not
   a claim that batching made the activity invisible.

A generic transition format and fixed-size encrypted delivery should cover
buys, sells, cancellations, redemption, and dummy slots. One common ledger is
necessary to avoid leaking market selection through contract addresses. It is
not sufficient: gas, proof shape, nullifier counts, RPC lookups, IP addresses,
and note discovery can all create distinguishers.

## Privacy contract to prove

Compare two allowed executions with identical public boundary inputs, oracle
catalogs, public schedules, and explicitly permitted adversary outputs, but
different honest-user market, side, size, or fill. Define an adversary's complete
view, then prove computational indistinguishability or a quantified differential
privacy bound. Merely encrypting an order does not establish this property.

| Observer | Target | Information that still needs treatment |
| --- | --- | --- |
| Public chain observer | No user-linked trade details during internal trading. | Funding/exit values, public catalog, LP inventory deposits, public hedges, timing and transcript shape. |
| Relayer/prover | No single operator can decrypt complete orders. | MPC threshold, client compromise, network routing and recovery key access. |
| Trader or colluding traders | Learn own authorized fills, not infer another user's trade. | Singleton liquidity, exact aggregate disclosures, availability and quote probing. |
| LP/investor | No live per-user flow from reserve accounting. | Inventory deltas, final PnL, cashout and redemption can reveal net flow even when computation is encrypted. |
| Committee adversary | Confidentiality below the chosen collusion threshold. | Threshold corruption and denial of service cannot be renamed away as privacy. |

LP final outputs are a particularly hard boundary. Hiding live inventory then
disclosing exact final balances can reveal the same information later. A strong
claim must include the terminal state, not just an epoch. Pooling, batching, or
delaying LP reports is not by itself a proof against all-but-one collusion.

An emergency exit that reveals the market may be a worthwhile safety feature,
but then privacy under operator failure is not the same as normal-operation
privacy. Both guarantees must be explicit. Losing note data cannot be repaired
by publishing a new state root; clients need recoverable encrypted data and
independent witness access.

## Economics and lower bounds

For K binary markets, T independently exercisable tickets, and at most Q shares
per ticket in any supported market, a deliberately conservative complete-set
reserve is K*T*Q collateral units, giving that many YES/NO pairs across the
catalog. A separate sell cash buffer up to T*Q units covers a normalized
maximum price of one. This is an illustrative worst-case bound, not an optimized
portfolio proof; fees, pending hedges, payouts, correlated/negative-risk markets,
and withdrawal reservations must be accounted for separately.

This can be expensive. A notional-only ticket is insufficient near zero prices:
small cash can buy many shares. Bound quantity or impose an explicit price floor
when deriving capacity. Do not count user cash, reserved hedge collateral, and
redeemable position backing as the same freely reusable capital.

Finite reserves cannot guarantee arbitrary immediate one-sided demand at a fixed
quote forever. Delay, price changes, more capital, or rejection must occur. Those
outputs can themselves leak information. A ticket may make execution independent
of other users within its reserved capacity, but selling the tickets and handling
expiry still need a privacy argument. Public availability must not silently
become a measurement of hidden demand.

If Predacy also publishes its own demand-responsive prediction prices, examine
the differentially private market-making literature rather than pretending
exact prices carry no information. Define protected adjacency, per-user
contribution bounds, epsilon/delta, and composition across repeated trades.
Privacy noise changes economics; it must not change a user's signed fill or
promised redemption after the fact.

## Executable investigation

Run from the repo root:

```sh
npm --prefix relayer run research:privacy
```

The isolated model in `relayer/research/privateLiquidityModel.ts` has no wallet,
RPC, networking, encryption, circuit, or deployment code. Nine checks reproduce:

- Two-party subtraction and all-but-one collusion despite larger batches.
- Leakage from fixed-time but flow-dependent hedging.
- Equal modeled public metadata when the plan is independent of customer flow.
- Finite inventory exhaustion without a reactive public-trade fallback.
- Leakage from LP inventory disclosures and from capacity-probing responses.
- Cash backing for internal sells and explicit inventory quantity accounting.

Equal modeled metadata is an assumption-checking result, **not cryptographic
indistinguishability**, on-chain feasibility, or proof of a working private
market. The model omits ownership proofs, realistic pricing, redemption,
adversarial networking, committee operation, and external execution.

## Prioritized experiments and decision gates

1. Formalize the execution-ticket ideal functionality, including final LP
   outputs, deposits/exits, capacity probes, and collusion. Obtain a design
   review before authorizing another deployment.
2. Compare static inventory, pre-reserved tickets, and quantified private-market
   pricing under adversarial flows. Measure required capital, loss, spread,
   delay, rejection, and observer inference over many epochs including exits.
3. Benchmark a supported MPC/FHE stack for matching and witness generation;
   measure mobile proof/delivery costs using synthetic funds. Select from
   measurements and trust assumptions, not a vendor's headline.
4. Prototype a universal note transition supporting buy, sell, cancel, and
   redemption. Verify exact conservation for all payouts, witness availability,
   threshold failure, censorship escape, and replay/domain separation.
5. Integrate an inventory adapter on a local fork. No per-user routing fallback;
   test delayed CLOB settlement, partial hedges, oracle disagreement, reorgs,
   bridge pauses, and exhausted inventory without weakening the privacy promise.
6. Commission an independent protocol/circuit/application review of the frozen
   design. Only after remediation and explicit funding approval should a new
   deployment or user-operated live validation be considered.

No current candidate is established here as satisfying absolute privacy against
every observer with unlimited execution. The evidence supports a serious new
design investigation, not enabling v13 under a stronger label.

## Existing v13 work remains separate

This change fixes admission/pairing of orders whose nullifiers are already
spent, checks Merkle history and spend status at one block, validates the root,
and rejects an intra-read reorg. It scans public cancellation/routing history
instead of sending unpublished nullifiers to an RPC provider. Route history
currently requires the deployed direct-EOA-to-pool call pattern; unfamiliar
internal-call histories fail closed instead of being guessed. Spent entries are skipped rather than
deleted, so a reversed cancellation can be reconsidered. The PostgreSQL
rehearsal now includes concurrent workers around a cancelled queued order.

Cancellation after durable batch assembly is still a separate reconciliation
case: no automatic re-pairing is allowed while a route may have been submitted.
An ambiguous journal must not be cleared to force a retry. Live v13 fills,
independent review, and protocol support for private sells/redemption remain
uncompleted; the new research does not certify them.
