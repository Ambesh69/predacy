import { describe, expect, it } from "vitest";
import { isAdminAuthorized } from "./adminAuth.js";

describe("admin authentication", () => {
  it("requires a configured token and an exact bearer value", () => {
    expect(isAdminAuthorized("Bearer secret", undefined)).toBe(false);
    expect(isAdminAuthorized(undefined, "secret")).toBe(false);
    expect(isAdminAuthorized("secret", "secret")).toBe(false);
    expect(isAdminAuthorized("Bearer wrong", "secret")).toBe(false);
    expect(isAdminAuthorized("Bearer secret", "secret")).toBe(true);
  });
});
