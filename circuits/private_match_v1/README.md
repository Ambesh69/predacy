# Private match v1 (research prototype)

This Noir circuit proves that one private buy and one private sell concern the
same market and outcome token, that the match respects both limits, and that
cash/shares are allocated without a matching subsidy. Buyer cost is rounded up
to the smallest collateral unit; the buyer's effective cost must still obey
their limit. Payout recipients are included in the original order commitments,
so the matcher cannot replace them in the settlement notes.

Only eight 128-bit values are public: the order-tree root, two order nullifiers,
and the settlement-note root. Market, outcome token, side, price, size, limits,
fill, recipients, and salts are private witness inputs. The tests cover a valid
match, a forged output root, and a redirected recipient.

Run `nargo test` and `nargo compile` from this directory with the repository's
Noir 1.0 beta toolchain. The generated `target/private_match_v1.json` exposes
the public ABI for inspection. Limit-violation tests reject an over-limit buy
and an under-limit sell.

**No real trading is implemented here.** A production protocol still needs:

- A private collateral and position ledger whose input notes are proven to
  exist and are nullified exactly once. This circuit currently binds to order
  commitments, not funded asset notes.
- Encrypted note delivery and recovery so only the intended recipient can
  discover and spend their outputs; a matcher must not learn spending secrets.
- A price-discovery/liquidity mechanism and a settlement coordinator that can
  produce proofs without gaining the ability to redirect or freeze funds.
- Resolution data, dispute rules, redemption, withdrawals, fee accounting,
  audits, and end-to-end adversarial tests on a private execution network.

The current Polygon vault, Polymarket Deposit Wallet, and Railway PostgreSQL
journal remain separate from this prototype. Mainnet trading stays disabled.
