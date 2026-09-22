# Predacy Private V13 Requirements

V13 must preserve Polymarket aggregate liquidity without publishing an
individual order's market, side, size, limit, fill, or originating wallet.
Polymarket's aggregate hedge remains public by construction.

## Required protocol shape

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
7. Every order has a proof-authorized timeout refund independent of the relayer.
   Recovery cannot replay an ambiguous Polymarket fill.
8. Mainnet remains closed until a live restart-recovery exercise and an
   independent circuit, contract, relayer, and key-management review complete.

The public aggregate market, direction, amount, and fill cannot be hidden while
using Polymarket's Polygon settlement. Product language must distinguish that
aggregate visibility from individual order privacy.
