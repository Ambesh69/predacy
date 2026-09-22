import { describe, expect, it } from "vitest";
import { assertV12GeoEligible, signV12GeoAssertion } from "./v12GeoEligibility.js";

const secret = "predacy-test-geo-secret-that-is-long-enough";
const now = 1_800_000_000_000;

function headers(country: string, region = "", timestamp = String(now)) {
  return {
    "x-predacy-country": country,
    "x-predacy-region": region,
    "x-predacy-geo-timestamp": timestamp,
    "x-predacy-geo-signature": signV12GeoAssertion(country, region, timestamp, secret),
  };
}

describe("v12 geographic eligibility", () => {
  it("accepts a current signed eligible location", () => {
    expect(assertV12GeoEligible(headers("IN", "KA"), secret, now)).toEqual({ country: "IN", region: "KA" });
  });

  it("rejects blocked countries and regions", () => {
    expect(() => assertV12GeoEligible(headers("US"), secret, now)).toThrow(/unavailable/);
    expect(() => assertV12GeoEligible(headers("CA", "ON"), secret, now)).toThrow(/unavailable/);
  });

  it("rejects forged and stale assertions", () => {
    const forged = headers("IN", "KA");
    forged["x-predacy-country"] = "US";
    expect(() => assertV12GeoEligible(forged, secret, now)).toThrow(/Invalid/);
    expect(() => assertV12GeoEligible(headers("IN", "KA", String(now - 600_000)), secret, now)).toThrow(/expired/);
  });
});
