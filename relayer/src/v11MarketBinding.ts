import { getAddress, type Address } from "viem";

// Polygon V2 addresses from the pinned @polymarket/client production configuration.
const STANDARD_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

export interface V11MarketBinding {
  feeInfo: { rate: number; exponent: number };
  negRisk: boolean;
  tickSize: number;
  tokens: Array<{ tokenId: string | bigint; outcome: string }>;
}

/** Bind an escrow to the current CLOB market before routing any funds. */
export function assertV11MarketBinding(
  market: V11MarketBinding,
  expected: { yesTokenId: bigint; noTokenId: bigint; tokenId: bigint;
    priceTick: bigint; exchange: Address },
): void {
  const ids = new Set(market.tokens.map((token) => token.tokenId.toString()));
  if (ids.size !== 2 || !ids.has(expected.yesTokenId.toString()) ||
      !ids.has(expected.noTokenId.toString()) || !ids.has(expected.tokenId.toString())) {
    throw new Error("V11 escrow tokens differ from the current CLOB market");
  }
  const yes = market.tokens.find((token) => token.outcome.toLowerCase() === "yes");
  const no = market.tokens.find((token) => token.outcome.toLowerCase() === "no");
  if (yes?.tokenId.toString() !== expected.yesTokenId.toString() ||
      no?.tokenId.toString() !== expected.noTokenId.toString()) {
    throw new Error("V11 YES/NO tokens are reversed or not binary outcomes");
  }
  const tick = market.tickSize * 1_000_000;
  if (!Number.isSafeInteger(tick) || BigInt(tick) !== expected.priceTick) {
    throw new Error("V11 order tick differs from the current CLOB market");
  }
  if (!Number.isFinite(market.feeInfo.rate) || market.feeInfo.rate < 0 ||
      market.feeInfo.rate > 0.07 ||
      (market.feeInfo.rate > 0 && market.feeInfo.exponent !== 1)) {
    throw new Error("V11 market fee exceeds the signed order fee envelope");
  }
  const exchange = market.negRisk ? NEG_RISK_EXCHANGE : STANDARD_EXCHANGE;
  if (getAddress(expected.exchange) !== getAddress(exchange)) {
    throw new Error("V11 exchange differs from the current CLOB market");
  }
}
