import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const BLOCKED_COUNTRIES = new Set([
  "AU", "BE", "BY", "BR", "BI", "CF", "CD", "CU", "DE", "ET", "FR", "GB", "IE", "IR", "IQ",
  "IT", "JP", "KP", "LB", "LY", "MM", "MT", "NI", "NL", "NZ", "PL", "RU", "SG", "SK", "SO",
  "SS", "SD", "SY", "TW", "TH", "UM", "US", "VE", "YE", "ZW",
]);

const BLOCKED_REGIONS: Record<string, Set<string>> = {
  CA: new Set(["AB", "BC", "ON", "QC"]),
  UA: new Set(["09", "14", "43"]),
};

function scalar(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function signV12GeoAssertion(
  country: string,
  region: string,
  timestamp: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(`${country}:${region}:${timestamp}`).digest("hex");
}

export function assertV12GeoEligible(
  headers: IncomingHttpHeaders,
  secret: string,
  now = Date.now(),
): { country: string; region: string } {
  if (secret.length < 32) throw new Error("V12 geo assertion secret is not configured");
  const country = scalar(headers, "x-predacy-country").toUpperCase();
  const region = scalar(headers, "x-predacy-region").toUpperCase();
  const timestamp = scalar(headers, "x-predacy-geo-timestamp");
  const signature = scalar(headers, "x-predacy-geo-signature").toLowerCase();
  if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z0-9-]{0,8}$/.test(region) || !/^\d{13}$/.test(timestamp) ||
      !/^[0-9a-f]{64}$/.test(signature)) throw new Error("Missing trusted geographic eligibility assertion");
  if (Math.abs(now - Number(timestamp)) > 5 * 60_000) throw new Error("Geographic eligibility assertion expired");
  const expected = signV12GeoAssertion(country, region, timestamp, secret);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("Invalid geographic eligibility assertion");
  }
  if (BLOCKED_COUNTRIES.has(country) || BLOCKED_REGIONS[country]?.has(region)) {
    throw new Error("Private trading is unavailable in this location");
  }
  return { country, region };
}
