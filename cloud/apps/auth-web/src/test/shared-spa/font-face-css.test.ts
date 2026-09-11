// @vitest-environment jsdom
//
// The editor turns every frame font into an @font-face rule. The name and
// weight come from the font file's metadata (uploaded fonts, scene font
// assets), and the rule used to interpolate them with JSON.stringify — a
// JavaScript escape, not a CSS one — and the weight raw (2026-09 review).
// fontFaceCss must yield exactly one rule whatever the metadata holds.

import { describe, expect, it } from "vitest";
import { cssFontWeight, cssString, fontFaceCss } from "../../../../../../frontend/src/utils/fontFaceCss";

const dataUrl = "data:font/ttf;base64,AAEAAAALAIAAAwAwT1MvMg==";

function parsedRules(css: string): CSSRuleList {
  const style = document.createElement("style");
  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
  const rules = style.sheet!.cssRules;
  style.remove();
  return rules;
}

describe("cssString", () => {
  it("leaves ordinary names readable", () => {
    expect(cssString("Roboto Mono")).toBe('"Roboto Mono"');
  });

  it("hex-escapes quotes, backslashes and control characters", () => {
    expect(cssString('a"b')).toBe('"a\\22 b"');
    expect(cssString("a\\b")).toBe('"a\\5c b"');
    expect(cssString("a\nb")).toBe('"a\\a b"');
  });
});

describe("cssFontWeight", () => {
  it("keeps a real weight and clamps or defaults the rest", () => {
    expect(cssFontWeight(700)).toBe(700);
    expect(cssFontWeight("300")).toBe(300);
    expect(cssFontWeight(0)).toBe(1);
    expect(cssFontWeight(5000)).toBe(1000);
    expect(cssFontWeight("400; } body { color: red")).toBe(400);
    expect(cssFontWeight(undefined)).toBe(400);
  });
});

describe("fontFaceCss", () => {
  it("builds one @font-face rule for a normal font", () => {
    const css = fontFaceCss({ name: "Ubuntu", weight: 700, italic: true }, dataUrl);
    const rules = parsedRules(css);
    expect(rules).toHaveLength(1);
    expect(css).toContain("font-weight: 700;");
    expect(css).toContain("font-style: italic;");
  });

  it("stays one rule when the metadata tries to close it", () => {
    const hostile = 'x"); } body { background: url("https://tracker.example/p.gif"); } @font-face { font-family: ("y';
    const css = fontFaceCss({ name: hostile, weight: "400; } body { color: red" as unknown as number, italic: false }, dataUrl);
    const rules = parsedRules(css);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.cssText.startsWith("@font-face")).toBe(true);
    // The name's quotes are escaped: the only `"` left delimit the family
    // (twice, font-family and local()) and the url — three strings.
    expect(css.match(/"/g)).toHaveLength(6);
    expect(css).toContain("font-weight: 400;");
  });
});
