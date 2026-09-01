import { describe, expect, it } from "vitest";

import { escapeControlCharsInStrings, parseToolArguments } from "./tool-args";

// Raw control characters are the whole subject here, and invisible in source,
// so build them rather than typing them.
const RAW_NEWLINE = String.fromCharCode(10);
const RAW_TAB = String.fromCharCode(9);
const RAW_SOH = String.fromCharCode(1);

describe("escapeControlCharsInStrings", () => {
  it("leaves valid JSON untouched", () => {
    const valid = JSON.stringify({ code: 'a\nb\t"c"\\d', nested: [1, { x: null }] });
    expect(escapeControlCharsInStrings(valid)).toBe(valid);
  });

  it("escapes raw newlines and tabs inside strings", () => {
    expect(escapeControlCharsInStrings(`{"code":"line1${RAW_NEWLINE}line2${RAW_TAB}end"}`)).toBe(
      '{"code":"line1\\nline2\\tend"}',
    );
  });

  it("leaves whitespace between tokens alone", () => {
    const pretty = `{${RAW_NEWLINE}  "a": 1${RAW_NEWLINE}}`;
    expect(escapeControlCharsInStrings(pretty)).toBe(pretty);
  });

  it("does not treat an escaped quote as closing the string", () => {
    expect(escapeControlCharsInStrings(`{"a":"say \\"hi\\"${RAW_NEWLINE}bye"}`)).toBe(
      '{"a":"say \\"hi\\"\\nbye"}',
    );
  });

  it("does not treat an escaped backslash as escaping the next quote", () => {
    // The string is `path\` and the second quote closes it, so the newline
    // after it sits between tokens and must survive as-is.
    const raw = `{"a":"path\\\\"${RAW_NEWLINE}}`;
    expect(escapeControlCharsInStrings(raw)).toBe(raw);
  });

  it("escapes other control characters as \\u", () => {
    expect(escapeControlCharsInStrings(`{"a":"x${RAW_SOH}y"}`)).toBe('{"a":"x\\u0001y"}');
  });
});

describe("parseToolArguments", () => {
  it("parses well-formed arguments", () => {
    expect(parseToolArguments("create_scenes", '{"title":"x","scenes":[{"id":"a"}]}')).toEqual({
      args: { scenes: [{ id: "a" }], title: "x" },
      repaired: false,
    });
  });

  it("treats empty arguments as no arguments", () => {
    expect(parseToolArguments("save_scene", "")).toEqual({ args: {}, repaired: false });
    expect(parseToolArguments("save_scene", "{}")).toEqual({ args: {}, repaired: false });
    expect(parseToolArguments("save_scene", undefined)).toEqual({ args: {}, repaired: false });
  });

  // The failure that made a delivered calendar scene come back as "the scene
  // payload has no nodes": raw newlines in the JS source the model wrote.
  it("repairs raw newlines inside a JS source string", () => {
    const raw = `{"title":"Calendar","scenes":[{"id":"a","code":"const x = 1;${RAW_NEWLINE}render(x);"}]}`;
    expect(parseToolArguments("create_scenes", raw)).toEqual({
      args: {
        scenes: [{ code: "const x = 1;\nrender(x);", id: "a" }],
        title: "Calendar",
      },
      repaired: true,
    });
  });

  it("reports truncated arguments instead of returning an empty object", () => {
    const raw = '{"title":"x","scenes":[{"id":"a"';
    const parsed = parseToolArguments("create_scenes", raw);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("The create_scenes call did not run");
      expect(parsed.error).toContain("not valid JSON");
      // It must not read as a verdict on the content, or the model tells the
      // user the editor rejected the scene it sent.
      expect(parsed.error).toContain("nothing was validated");
      expect(parsed.length).toBe(raw.length);
      expect(parsed.detail).toBeTruthy();
    }
  });

  it("rejects arguments that are valid JSON but not an object", () => {
    const parsed = parseToolArguments("create_scenes", "[1,2,3]");
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.detail).toContain("not an object");
    }
  });
});
