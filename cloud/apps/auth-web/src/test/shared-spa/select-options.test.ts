// The select-field option helpers (frontend/src/utils/selectOptions.ts):
// every reader of `field.options` goes through them because scenes are
// hand-edited, imported and AI-written, so options arrive as strings,
// numbers, `{ value, label }` pairs or half-filled objects. Pins the
// canonical storage shape, the reference-preserving normalizer the save
// path relies on, and the `value | Label` textarea round-trip.

import { describe, expect, it } from "vitest";
import {
  normalizeFieldOptions,
  normalizeSelectOptions,
  selectFieldOptions,
  selectFieldValues,
  selectOptionsFromText,
  selectOptionsToText,
} from "../../../../../../frontend/src/utils/selectOptions";

describe("selectFieldOptions", () => {
  it("reads strings, numbers, booleans and labelled pairs, dropping garbage", () => {
    expect(
      selectFieldOptions([
        "a",
        2,
        true,
        { value: "b", label: "Bee" },
        { value: 3 },
        { label: "no value" },
        null,
        undefined,
        ["nested"],
        { value: { deep: true } },
      ]),
    ).toEqual([
      { value: "a", label: "a" },
      { value: "2", label: "2" },
      { value: "true", label: "true" },
      { value: "b", label: "Bee" },
      { value: "3", label: "3" },
    ]);
  });

  it("falls back to the value when a label is not a scalar", () => {
    expect(selectFieldOptions([{ value: "x", label: { nested: true } }, { value: "y", label: 7 }])).toEqual([
      { value: "x", label: "x" },
      { value: "y", label: "7" },
    ]);
  });

  it("returns nothing for a non-array", () => {
    expect(selectFieldOptions("a,b")).toEqual([]);
    expect(selectFieldOptions(undefined)).toEqual([]);
    expect(selectFieldValues(null)).toEqual([]);
  });

  it("selectFieldValues is just the values", () => {
    expect(selectFieldValues(["a", { value: "b", label: "Bee" }, 4])).toEqual(["a", "b", "4"]);
  });
});

describe("normalizeSelectOptions", () => {
  it("stores a plain string unless the option carries its own label", () => {
    expect(normalizeSelectOptions(["a", { value: "b", label: "Bee" }, { value: "c", label: "c" }, 4])).toEqual([
      "a",
      { value: "b", label: "Bee" },
      "c",
      "4",
    ]);
  });
});

describe("normalizeFieldOptions", () => {
  it("returns the same object when the options are already canonical", () => {
    const field = { name: "size", type: "select", options: ["s", { value: "m", label: "Medium" }] };
    expect(normalizeFieldOptions(field)).toBe(field);
  });

  it("returns a canonicalized copy otherwise, leaving the input alone", () => {
    const field = { name: "size", type: "select", options: [1, { value: "m", label: "m" }, { value: "l", label: "Large", extra: 1 }] };
    const normalized = normalizeFieldOptions(field);
    expect(normalized).not.toBe(field);
    expect(normalized.options).toEqual(["1", "m", { value: "l", label: "Large" }]);
    expect(field.options).toHaveLength(3);
    expect(field.options[0]).toBe(1);
  });

  it("leaves a field without options untouched", () => {
    const field = { name: "city", type: "string" };
    expect(normalizeFieldOptions(field)).toBe(field);
    expect(normalizeFieldOptions(null)).toBe(null);
    expect(normalizeFieldOptions(undefined)).toBe(undefined);
  });
});

describe("options textarea round-trip", () => {
  it("prints one option per line, `value | Label` when labelled", () => {
    expect(selectOptionsToText(["a", { value: "b", label: "Bee" }])).toBe("a\nb | Bee");
  });

  it("parses back to the canonical shape", () => {
    const text = selectOptionsToText(["a", { value: "b", label: "Bee" }]);
    expect(selectOptionsFromText(text)).toEqual(["a", { value: "b", label: "Bee" }]);
  });

  it("collapses a label equal to its value, and trims around the separator", () => {
    expect(selectOptionsFromText("b | b\n c |  Sea ")).toEqual(["b", { value: "c", label: "Sea" }]);
  });

  it("splits at the first unescaped `|` and writes the label's own `|` escaped", () => {
    // The first `|` is the separator, so the rest of the line is the label;
    // the canonical text form escapes the `|` the label holds.
    expect(selectOptionsFromText("x | y | z")).toEqual([{ value: "x", label: "y | z" }]);
    expect(selectOptionsToText(selectOptionsFromText("x | y | z"))).toBe("x | y \\| z");
  });
});

describe("selectOptionsToText / selectOptionsFromText escaping", () => {
  // The textarea's separator is `|`, so a value or label holding one had no
  // spelling: "a|b" came back as value "a", label "b" (2026-09 review).
  it("round-trips a literal | in values and labels", () => {
    const options = ["a|b", { value: "c", label: "Cee | Dee" }, { value: "x|y", label: "Ex" }];
    const text = selectOptionsToText(options);
    expect(text).toBe("a\\|b\nc | Cee \\| Dee\nx\\|y | Ex");
    expect(selectOptionsFromText(text)).toEqual(options);
  });

  it("round-trips backslashes, which are the escape character", () => {
    const options = ["C:\\path", { value: "back\\|slash", label: "Back" }];
    const text = selectOptionsToText(options);
    expect(text).toBe("C:\\\\path\nback\\\\\\|slash | Back");
    expect(selectOptionsFromText(text)).toEqual(options);
  });

  it("keeps reading the unescaped form people type by hand", () => {
    expect(selectOptionsFromText("one\ntwo | Two\n\\| alone")).toEqual([
      "one",
      { value: "two", label: "Two" },
      "| alone",
    ]);
  });
});
