// A boolean node field's checkbox compared its value with `== 'true'`, so a
// real `true` default (app configs, imported and AI-built scenes) rendered
// unchecked while the frame ran it as on, and the user needed two clicks to
// get the box to agree with the runtime (2026-09 review). booleanFieldValue
// mirrors the frame's reading: valueFromJsonByType + parseBoolish in
// frameos/src/frameos/values.nim.

import { describe, expect, it } from "vitest";
import { booleanFieldValue } from "../../../../../../frontend/src/utils/booleanField";

describe("booleanFieldValue", () => {
  it("takes real booleans as they are", () => {
    expect(booleanFieldValue(true)).toBe(true);
    expect(booleanFieldValue(false)).toBe(false);
  });

  it("reads the strings parseBoolish accepts, in any case", () => {
    for (const value of ["true", "TRUE", "True", "1", "yes", "Y", " true "]) {
      expect(booleanFieldValue(value)).toBe(true);
    }
    for (const value of ["false", "0", "no", "", "on", "truthy"]) {
      expect(booleanFieldValue(value)).toBe(false);
    }
  });

  it("is false for every other JSON kind, as on the frame", () => {
    for (const value of [1, 0, null, undefined, {}, []]) {
      expect(booleanFieldValue(value)).toBe(false);
    }
  });
});
