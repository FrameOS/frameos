import { afterEach, describe, expect, it, vi } from "vitest";
import { secureToken } from "../../../../../../frontend/src/utils/secureToken";

// frontend/src/utils/secureToken.ts makes what a frame is reached with (its
// access key, its admin password, the agent's shared secret, a virtual
// frame's view token) and upload ids. It read Math.random where the browser
// had no crypto.getRandomValues; a key made that way can be worked out.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("secureToken", () => {
  it("is base64url text of the bytes asked for, from crypto.getRandomValues alone", () => {
    const random = vi.spyOn(Math, "random");
    const fill = vi.spyOn(globalThis.crypto, "getRandomValues");
    const token = secureToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secureToken(18)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(secureToken(20)).toMatch(/^[A-Za-z0-9_-]{27}$/);
    expect(secureToken(32)).not.toBe(token);
    expect(fill).toHaveBeenCalledTimes(4);
    expect(random).not.toHaveBeenCalled();
  });

  it("encodes the bytes it was given", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).set([0xfb, 0xff, 0xbe]);
      return array;
    });
    // 0xfbffbe is "+/++" in base64: "-_--" in the URL alphabet.
    expect(secureToken(3)).toBe("-_--");
  });

  it("throws where there is no secure generator, and never falls back to Math.random", () => {
    const random = vi.spyOn(Math, "random");
    vi.stubGlobal("crypto", undefined);
    expect(() => secureToken(16)).toThrow(/secure random/);
    vi.stubGlobal("crypto", {});
    expect(() => secureToken(16)).toThrow(/secure random/);
    expect(random).not.toHaveBeenCalled();
  });
});
