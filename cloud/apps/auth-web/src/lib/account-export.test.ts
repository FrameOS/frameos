import { describe, expect, it } from "vitest";
import { maskSettingValue } from "./account-export";

// account_settings values are third-party credentials more often than not;
// the export lists the keys and shows a hint, never a pasteable value.
describe("maskSettingValue", () => {
  it("keeps only the last four characters of a long string", () => {
    expect(maskSettingValue("sk-proj-abcdefghijklmnop")).toBe("••••mnop");
  });

  it("hides short strings entirely", () => {
    expect(maskSettingValue("hunter2")).toBe("••••");
    expect(maskSettingValue("")).toBe("••••");
  });

  it("masks inside objects and arrays, leaves scalars alone", () => {
    expect(
      maskSettingValue({
        enabled: true,
        keys: ["0123456789abcdef", "short"],
        nested: { token: "abcdefghijkl", port: 8123, off: null },
      }),
    ).toEqual({
      enabled: true,
      keys: ["••••cdef", "••••"],
      nested: { token: "••••ijkl", port: 8123, off: null },
    });
  });
});
