import { describe, expect, it } from "vitest";
import { rateLimitAddressKey } from "./rate-limit-key";

describe("rateLimitAddressKey", () => {
  it("counts every address of one IPv6 /64 as one", () => {
    const key = rateLimitAddressKey("2001:db8:12:3400:1:2:3:4");
    expect(key).toBe("2001:db8:12:3400::/64");
    for (const other of [
      "2001:db8:12:3400::",
      "2001:0db8:0012:3400:ffff:ffff:ffff:ffff",
      "2001:DB8:12:3400:abcd::1",
      "[2001:db8:12:3400::9]",
      "2001:db8:12:3400::9%eth0",
    ]) {
      expect(rateLimitAddressKey(other)).toBe(key);
    }
    // The neighbouring /64 is somebody else.
    expect(rateLimitAddressKey("2001:db8:12:3401::1")).toBe("2001:db8:12:3401::/64");
    expect(rateLimitAddressKey("::1")).toBe("0:0:0:0::/64");
  });

  it("keeps an IPv4 address its own key, mapped or not", () => {
    expect(rateLimitAddressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitAddressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitAddressKey("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(rateLimitAddressKey("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("returns what is not an IPv6 address as it came", () => {
    for (const value of ["untrusted", "local", "", "not:an:address", "1::2::3", "12345::1", "::ffff:1.2.3"]) {
      expect(rateLimitAddressKey(value)).toBe(value);
    }
  });
});
