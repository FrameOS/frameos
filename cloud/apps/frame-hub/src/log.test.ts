import { describe, expect, it } from "vitest";
import { errorField } from "./log";

describe("errorField", () => {
  it("is the message of a plain error, and the text of anything else", () => {
    expect(errorField(new Error("boom"))).toBe("boom");
    expect(errorField("boom")).toBe("boom");
  });

  it("says why a fetch failed", () => {
    // All undici puts in the message: the reason is in `cause`.
    const cause = Object.assign(new Error("invalid content-length header"), { code: "UND_ERR_INVALID_ARG" });
    expect(errorField(new TypeError("fetch failed", { cause }))).toBe("fetch failed: invalid content-length header");
  });

  it("names the code of a cause that has no message", () => {
    // A dual-stack connect that timed out on both families.
    const cause = Object.assign(new AggregateError([], ""), { code: "ETIMEDOUT" });
    expect(errorField(new TypeError("fetch failed", { cause }))).toBe("fetch failed: ETIMEDOUT");
  });

  it("does not follow a chain forever", () => {
    const error = new Error("first");
    error.cause = error;
    expect(errorField(error).split(": ").length).toBeLessThanOrEqual(4);
  });
});
