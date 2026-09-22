import { getAddress, type Address } from "viem";

const POLYGON_ASSETS = {
  usdce: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  pusd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  ctf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  onramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  offramp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
} as const;

export type V11PolygonAssets = { [K in keyof typeof POLYGON_ASSETS]: Address };

/** The v11 bridge only supports the documented Polygon USDC.e -> pUSD route. */
export function assertV11PolygonAssets(actual: V11PolygonAssets): void {
  for (const key of Object.keys(POLYGON_ASSETS) as Array<keyof V11PolygonAssets>) {
    if (getAddress(actual[key]) !== getAddress(POLYGON_ASSETS[key])) {
      throw new Error(`V11 ${key} differs from the supported Polygon contract`);
    }
  }
}
