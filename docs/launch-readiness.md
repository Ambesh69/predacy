# Mainnet launch gate

Status: **closed for new mainnet orders**. The current vault uses Polygon USDC.e
and the relayer signs for the former CTF exchanges. Polymarket now documents
pUSD collateral and CTF Exchange V2. Do not remove the relayer's mainnet order
guard until the migration and the checks below are complete.

## Privacy decision

The product requirement is to hide market, side, size, and fill details on-chain,
not merely the link to a customer's main wallet. That requirement is incompatible
with direct Polymarket CLOB execution: matched orders settle through public
Polygon exchange contracts that transfer outcome tokens and pUSD. An omnibus
Deposit Wallet and confidential customer accounting could obscure which user
caused an aggregate trade, but the aggregate market, direction, and amount
would still be observable. The current v11 prototype also publishes each
escrow's market, side, deposit, owner, and final allocation; it is not a private
vault. Do not deploy it as the privacy solution or describe Railgun-funded
ephemeral accounts as hiding the exchange trades.

The production PostgreSQL service is provisioned and a `V11_DATABASE_URL`
reference is configured on the relayer without redeploying it. This does not
change the privacy boundary or enable v11 execution. A public launch requires
either a revised, explicitly narrower privacy promise (customer-to-trade
unlinkability with public aggregate trades) and a new private accounting design,
or a venue/settlement architecture that does not publish the trades on Polygon.

The product decision is now the second path: replace Polymarket execution to
keep trade details private. `circuits/private_match_v1` is a local Noir proof
prototype for one confidential buy/sell match. It is **not** connected to
funded notes or a private execution network. The active Polygon app and the
experimental v11 Deposit Wallet flow remain disabled. Aztec testnet is a
candidate evaluation environment; no private-market contracts have been
deployed there, and no mainnet opening is authorized by this decision alone.

The current vault also requires exact settlement at its batch clearing price:
it sends `gap * clearingPrice` to buy the missing shares and later demands
`excess * clearingPrice` from sales. Actual CLOB execution can cross at a
different price and incur fees. A wallet bridge alone cannot guarantee those
amounts; the protocol needs an explicit loss/reserve policy or a new settlement
design before live orders can be enabled. The current mainnet guard refuses
CLOB-dependent batches before `lockFunds` and will not replay a locked one.

The selected production policy is **zero relayer subsidy**. A replacement vault
must account for actual CLOB fills, fees, and unspent collateral, then prove
and distribute those results to users. Every order that cannot be executed
within its signed limit must remain claimable as its original collateral or
position. A batch must be recoverable after a relayer crash without replaying
a fill; no assumption that a quote will still be executable after `lockFunds`
can substitute for this. The active v10 vault does not provide that fallback.

References:

- https://docs.polymarket.com/concepts/pusd
- https://docs.polymarket.com/resources/contracts
- https://docs.polymarket.com/trading/wallets-auth

## Migration work

1. Keep the current vault's USDC.e accounting until its migration is designed
   and tested. pUSD does not provide the vault's EIP-3009 authorization flow.
   The trading bridge must wrap vault-supplied USDC.e through CollateralOnramp
   into pUSD before CLOB buys, and unwrap pUSD sell proceeds through
   CollateralOfframp before `settleBatch`. Confirm every on-chain transfer and
   wallet balance before advancing either phase.
2. Update the CLOB signer and exchange addresses using the current official
   client. The vault sends gap collateral and excess tokens to the relayer EOA.
   A Deposit Wallet order path also needs confirmed transfers between that
   wallet and the relayer before `settleBatch`; changing `signatureType` alone
   cannot work. Add a durable per-batch, per-leg order journal before enabling
   retries so a restart cannot submit duplicate fills. An EOA path needs
   confirmed Polymarket allowlisting.
3. Resolve CLOB price and fee shortfalls in the settlement design. Test both
   directions with real fills and assert that an underfunded batch cannot become
   `LOCKED`. A small fixed hot-wallet buffer is not a bound on market slippage.
4. The live vault's active verifier at `0xA504...` accepted a fresh proof from
   the current circuit in a Polygon fork test. Polygon PoS permits 32 KiB
   runtime code under PIP-30; the active verifier is 31,260 bytes. The unused
   recorded v2 verifier at `0xf5fda...` rejected that proof. Do not switch
   verifier addresses; an actual mainnet claim is still required.
5. Deploy a new vault only after tests cover its entire two-phase settlement
   path. Existing vault funds and claims require a separate migration plan.

## Production configuration

- Set `CHAIN_ID=137`, `USE_REAL_ZK=true`, `REDIS_URL`, `ADAPTER_ADDRESS`, CLOB
  credentials, and a long random `ADMIN_TOKEN` on the relayer host.
- Keep `ADMIN_TOKEN` off the frontend. `/api/relayer/admin/*` is blocked by the
  frontend proxy; use the relayer host directly for operator requests.
- Verify the relayer hot wallet's native gas balance, collateral balance,
  approvals, and CLOB account identity before taking a user order.
- Confirm the frontend and relayer point to the same vault and chain. The
  checked-in local `.env` files use Amoy and do not establish production state.
- Check `/health`: `tradingEnabled` must be true and `pausedMarkets` empty.

## Locked batch incident

1. Stop new orders for the affected market. The relayer now pauses it after a
   settlement failure while on-chain status is `LOCKED`, and persists the pause
   in Redis. Do not force-advance a locked batch.
2. Record its batch ID, on-chain `getBatch` status and gap/excess amounts,
   relayer collateral/token balances, CLOB order IDs, and last settlement error.
3. Reconcile every completed CLOB fill, wallet transfer, and on-chain balance.
   The current checkout blocks mainnet CLOB legs before `lockFunds`, and also
   refuses to replay them for an already-locked batch. Do not use automatic
   recovery for a CLOB-dependent locked batch until the Deposit Wallet bridge
   and durable order journal are implemented and tested.
4. For a batch that needs no CLOB leg, retry via the direct relayer endpoint
   using `POST /admin/recover-batch?batchId=N`
   with `Authorization: Bearer <ADMIN_TOKEN>`. On success, confirm `SETTLED`
   on-chain; the market pause clears only after every tracked paused batch
   settles. If it still fails, keep the
   market paused and reconcile assets; the deployed vault has no generic
   post-lock user refund path.

## Required live proof before opening orders

Use small funds and record transaction hashes and user-visible results for:

- Buy YES and buy NO on liquid markets, including an actual CLOB fill.
- Sell a held YES and NO position, then settle and claim proceeds.
- Claim an unfilled/refunded order and exit or redeem a winning position.
- Restart the relayer during a batch and recover a deliberately stalled
  `LOCKED` batch without duplicating a CLOB order.
- Verify a second wallet can see its order and claim across devices.

No public launch until all items pass on the deployed release, with a monitored
pilot cap and an operator available to handle paused markets.
