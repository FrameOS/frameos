import { passwordProviderIssuer } from "@frameos-cloud/db";
import { describe, expect, it } from "vitest";
import { pickSignInIdentity, type SignInIdentityRow } from "./sign-in-identity";

function row(overrides: Partial<SignInIdentityRow>): SignInIdentityRow {
  return {
    createdAt: new Date("2026-01-01T00:00:00Z"),
    emailSnapshot: "a@example.com",
    emailVerified: true,
    id: "00000000-0000-0000-0000-000000000001",
    providerIssuer: "https://accounts.google.com",
    providerSubject: "google-sub",
    ...overrides,
  };
}

describe("pickSignInIdentity", () => {
  it("prefers the password identity however the rows arrive", () => {
    const google = row({ createdAt: new Date("2025-01-01T00:00:00Z") });
    const password = row({
      id: "00000000-0000-0000-0000-000000000002",
      providerIssuer: passwordProviderIssuer,
      providerSubject: "a@example.com",
    });
    expect(pickSignInIdentity([google, password])?.id).toBe(password.id);
    expect(pickSignInIdentity([password, google])?.id).toBe(password.id);
  });

  it("falls back to the oldest verified identity, then the oldest of all", () => {
    const unverifiedOld = row({
      createdAt: new Date("2024-01-01T00:00:00Z"),
      emailVerified: false,
      id: "00000000-0000-0000-0000-000000000001",
    });
    const verifiedNew = row({
      createdAt: new Date("2025-01-01T00:00:00Z"),
      id: "00000000-0000-0000-0000-000000000002",
    });
    const verifiedNewer = row({
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: "00000000-0000-0000-0000-000000000003",
    });
    expect(
      pickSignInIdentity([verifiedNewer, unverifiedOld, verifiedNew])?.id,
    ).toBe(verifiedNew.id);
    expect(pickSignInIdentity([unverifiedOld])?.id).toBe(unverifiedOld.id);
    expect(pickSignInIdentity([])).toBeUndefined();
  });

  it("breaks a created_at tie on the id so two calls agree", () => {
    const b = row({ id: "b", emailVerified: false });
    const a = row({ id: "a", emailVerified: false });
    expect(pickSignInIdentity([b, a])?.id).toBe("a");
    expect(pickSignInIdentity([a, b])?.id).toBe("a");
  });
});
