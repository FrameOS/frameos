import { describe, expect, it } from "vitest";
import { googleAuthTimeClaims, googleAuthenticatedAt } from "./google-auth-time";

describe("googleAuthenticatedAt", () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);

  it("changes nothing while the operator has not asked for auth_time", () => {
    expect(googleAuthenticatedAt(undefined, false, now)).toBeUndefined();
    expect(googleAuthenticatedAt(now / 1000 - 86_400, false, now)).toBeUndefined();
  });

  it("dates the session at Google's last sign-in, never later than now", () => {
    const signedInAt = now / 1000 - 3 * 86_400;
    expect(googleAuthenticatedAt(signedInAt, true, now)?.getTime()).toBe(signedInAt * 1000);
    // Google's clock a minute ahead of ours: now.
    expect(googleAuthenticatedAt(now / 1000 + 60, true, now)?.getTime()).toBe(now);
  });

  it("proves nothing recent when the token has no auth_time worth believing", () => {
    for (const value of [undefined, null, "1700000000", 0, -5, Number.NaN, now / 1000 + 3600]) {
      expect(googleAuthenticatedAt(value, true, now)?.getTime(), String(value)).toBe(0);
    }
  });

  it("asks for the claim the way Google documents it", () => {
    expect(JSON.parse(googleAuthTimeClaims)).toEqual({
      id_token: { auth_time: { essential: true } },
    });
  });
});
