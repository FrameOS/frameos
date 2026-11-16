// An uploaded SVG turned into a scene icon (frontend/src/utils/svgToSceneIcon.ts):
// one filled path in the 24 box, drawn nonzero (docs/scene-icons.md), or a plain
// sentence saying why the file cannot be one.

import { describe, expect, it } from "vitest";
import { sceneIconPath } from "../../../../../../frontend/src/utils/sceneIcon";
import { sceneIconWindingNumber, svgToSceneIcon } from "../../../../../../frontend/src/utils/svgToSceneIcon";

function icon(svg: string): string {
  const result = svgToSceneIcon(svg);
  if (!result.ok) {
    throw new Error(result.error);
  }
  // Whatever it makes is an icon the runtime takes as it is.
  expect(sceneIconPath(result.icon)).toBe(result.icon);
  return result.icon;
}

function refusal(svg: string): string {
  const result = svgToSceneIcon(svg);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

const svg = (body: string, attributes = 'viewBox="0 0 24 24"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;

const filled = (path: string, x: number, y: number): boolean => sceneIconWindingNumber(path, x, y) !== 0;

describe("svgToSceneIcon", () => {
  it("passes a path in the 24 box through, its numbers written short", () => {
    expect(icon(svg('<path d="m12 2 l-10 20 h20 z"/>'))).toBe("M12 2L2 22H22Z");
    expect(icon(svg('<path d="M12.000 2.0L2.5 22H21.999z"/>'))).toBe("M12 2L2.5 22H22Z");
    expect(icon(svg('<path d="M-0.5 -0.5H1V1z"/>'))).toBe("M-.5-.5H1V1Z");
    expect(icon(svg('<path d="M0.5 0.5h-0.25v1z"/>'))).toBe("M.5 .5H.25V1.5Z");
  });

  it("reads a file as an editor saves it: declaration, doctype, comments, an editor's own elements", () => {
    const file =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      '<!-- Generator: an editor -->\n' +
      svg(
        '<sodipodi:namedview pagecolor="#fff"/><title>A triangle</title><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>' +
          '<path d="M12 2L2 22h20z" fill="url(#g)"/>',
        'viewBox="0 0 24 24" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"',
      );
    expect(icon(file)).toBe("M12 2L2 22H22Z");
  });

  it("maps the viewBox into the 24 box", () => {
    expect(icon(svg('<path d="M24 4L4 44h40z"/>', 'viewBox="0 0 48 48"'))).toBe("M12 2L2 22H22Z");
    expect(icon(svg('<path d="M24 4L4 44h40z"/>', 'width="48" height="48"'))).toBe("M12 2L2 22H22Z");
    expect(icon(svg('<path d="M110 110h10v10h-10z"/>', 'viewBox="100 100 20 20"'))).toBe("M12 12H24V24H12Z");
  });

  it("centers a box that is not square, and stretches it when told to", () => {
    expect(icon(svg('<path d="M0 0H48V24H0Z"/>', 'viewBox="0 0 48 24"'))).toBe("M0 6H24V18H0Z");
    expect(icon(svg('<path d="M0 0H48V24H0Z"/>', 'viewBox="0 0 48 24" preserveAspectRatio="xMinYMin meet"'))).toBe(
      "M0 0H24V12H0Z",
    );
    expect(icon(svg('<path d="M0 0H48V24H0Z"/>', 'viewBox="0 0 48 24" preserveAspectRatio="none"'))).toBe(
      "M0 0H24V24H0Z",
    );
  });

  it("turns rectangles, circles, ellipses and polygons into paths", () => {
    expect(icon(svg('<rect x="2" y="4" width="20" height="16"/>'))).toBe("M2 4H22V20H2Z");
    const rounded = icon(svg('<rect x="2" y="2" width="20" height="20" rx="4"/>'));
    expect(rounded).toMatch(/^M6 2H18A4 4 0 0 1 22 6/);
    expect(filled(rounded, 12, 12)).toBe(true);
    expect(filled(rounded, 2.5, 2.5)).toBe(false);
    expect(icon(svg('<circle cx="12" cy="12" r="10"/>'))).toBe("M22 12A10 10 0 0 1 2 12 10 10 0 0 1 22 12Z");
    const ellipse = icon(svg('<ellipse cx="12" cy="12" rx="10" ry="5"/>'));
    expect(ellipse).toBe("M22 12A10 5 0 0 1 2 12 10 5 0 0 1 22 12Z");
    expect(filled(ellipse, 12, 15)).toBe(true);
    expect(filled(ellipse, 12, 18)).toBe(false);
    expect(icon(svg('<polygon points="12,2 22,22 2,22"/>'))).toBe("M12 2L22 22H2Z");
    expect(icon(svg('<polyline points="2 2 22 2 22 22" fill="black"/>'))).toBe("M2 2H22V22");
  });

  it("merges every filled shape into one path", () => {
    expect(icon(svg('<path d="M2 2h8v8H2z"/><path d="M14 14h8v8h-8z"/>'))).toBe("M2 2H10V10H2ZM14 14H22V22H14Z");
  });

  it("leaves out what draws nothing: Material's empty box, hidden and see-through shapes", () => {
    const triangle = "M12 2L2 22H22Z";
    expect(icon(svg('<path d="M0 0h24v24H0z" fill="none"/><path d="M12 2L2 22h20z"/>'))).toBe(triangle);
    expect(icon(svg('<g display="none"><text>hi</text></g><path d="M12 2L2 22h20z"/>'))).toBe(triangle);
    expect(icon(svg('<rect width="24" height="24" opacity="0"/><path d="M12 2L2 22h20z"/>'))).toBe(triangle);
    expect(icon(svg('<rect width="24" height="24" style="fill-opacity:0"/><path d="M12 2L2 22h20z"/>'))).toBe(triangle);
    expect(icon(svg('<rect width="24" height="24" visibility="hidden"/><path d="M12 2L2 22h20z"/>'))).toBe(triangle);
  });

  it("refuses lines drawn with strokes, alone or beside filled shapes", () => {
    // Lucide and Feather: everything stroked, nothing filled.
    const lucide = refusal(
      svg(
        '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"',
      ),
    );
    expect(lucide).toMatch(/strokes/);
    expect(lucide).toMatch(/filled or solid version/);
    expect(refusal(svg('<line x1="2" y1="2" x2="22" y2="22" stroke="black"/>'))).toMatch(/strokes/);
    const mixed = refusal(svg('<path d="M12 2L2 22h20z"/><path d="M2 2L22 22" fill="none" stroke="black"/>'));
    expect(mixed).toMatch(/^Part of this SVG/);
  });

  it("follows the SVG's own stylesheet", () => {
    expect(
      refusal(
        svg(
          '<style>.a{fill:none;stroke:#000}.b{fill:#000}</style><path class="b" d="M12 2L2 22h20z"/><path class="a" d="M2 2L22 22"/>',
        ),
      ),
    ).toMatch(/^Part of this SVG/);
    expect(
      icon(svg('<style>/* boxes */ .box, .frame { fill: none }</style><path class="box" d="M0 0h24v24H0z"/><path d="M12 2L2 22h20z"/>')),
    ).toBe("M12 2L2 22H22Z");
    // A rule for the element wins over the fill the root hands down.
    expect(icon(svg("<style>path{fill:#333}</style><path d=\"M12 2L2 22h20z\"/>", 'viewBox="0 0 24 24" fill="none"'))).toBe(
      "M12 2L2 22H22Z",
    );
    // And style="" over the stylesheet.
    expect(
      icon(svg('<style>.x{fill:none}</style><path class="x" style="fill:red" d="M12 2L2 22h20z"/>')),
    ).toBe("M12 2L2 22H22Z");
  });

  it("applies transforms, nested", () => {
    expect(icon(svg('<g transform="translate(2 3)"><rect width="4" height="4"/></g>'))).toBe("M2 3H6V7H2Z");
    expect(icon(svg('<rect width="4" height="4" transform="scale(2)"/>'))).toBe("M0 0H8V8H0Z");
    expect(icon(svg('<rect x="2" y="2" width="4" height="4" transform="rotate(90 12 12)"/>'))).toBe("M22 2V6H18V2Z");
    expect(icon(svg('<rect width="4" height="4" transform="matrix(1,0,0,1,5,5)"/>'))).toBe("M5 5H9V9H5Z");
    expect(
      icon(svg('<g transform="translate(10 0)"><g transform="scale(2)"><rect width="2" height="2"/></g></g>')),
    ).toBe("M10 0H14V4H10Z");
    expect(icon(svg('<g transform="translate(24 0) scale(-1 1)"><rect width="4" height="4"/></g>'))).toMatch(/^M24 0/);
    expect(refusal(svg('<rect width="4" height="4" transform="spin(3)"/>'))).toMatch(/transform/);
  });

  it("keeps arcs through a turn or an even scale, and makes curves of them through a skew", () => {
    const turned = icon(svg('<g transform="rotate(30 12 12)"><ellipse cx="12" cy="12" rx="8" ry="4"/></g>'));
    expect(turned).toMatch(/A8 4 30 0 1/);
    expect(filled(turned, 12, 12)).toBe(true);
    const skewed = icon(svg('<g transform="skewX(20)"><circle cx="8" cy="12" r="6"/></g>'));
    expect(skewed).not.toMatch(/A/);
    expect(skewed).toMatch(/C/);
    // The skewed circle's middle moved right by tan(20°) × 12.
    expect(filled(skewed, 8 + Math.tan((20 * Math.PI) / 180) * 12, 12)).toBe(true);
    expect(filled(skewed, 1, 12)).toBe(false);
    const stretched = icon(svg('<circle cx="24" cy="12" r="10"/>', 'viewBox="0 0 48 24" preserveAspectRatio="none"'));
    expect(stretched).toMatch(/C/);
    expect(filled(stretched, 12, 12)).toBe(true);
  });

  it("keeps an evenodd hole as a hole under the nonzero rule", () => {
    // Two circles drawn the same way round: nonzero fills the middle, evenodd does not.
    const ring = "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0zM7 12a5 5 0 1 0 10 0a5 5 0 1 0-10 0z";
    expect(filled(ring, 12, 12)).toBe(true);
    const evenOdd = icon(svg(`<path fill-rule="evenodd" d="${ring}"/>`));
    expect(filled(evenOdd, 12, 12)).toBe(false);
    expect(filled(evenOdd, 12, 4)).toBe(true);
    expect(filled(evenOdd, 1, 1)).toBe(false);
    // From the stylesheet too, and three deep: a dot in the hole stays.
    const target = icon(
      svg(
        `<style>.e{fill-rule:evenodd}</style><path class="e" d="${ring}M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0z"/>`,
      ),
    );
    expect(filled(target, 12, 12)).toBe(true);
    expect(filled(target, 12, 8.5)).toBe(false);
    expect(filled(target, 12, 4)).toBe(true);
    // Without the rule the middle stays filled, as nonzero drew it.
    expect(filled(icon(svg(`<path d="${ring}"/>`)), 12, 12)).toBe(true);
  });

  it("adds up overlapping shapes drawn opposite ways round instead of cutting a hole", () => {
    const first = "M2 2h12v12H2z";
    const second = "M10 10v12h12V10z";
    // As one path written as it is, the overlap would be a hole.
    expect(filled(first + second, 12, 12)).toBe(false);
    const merged = icon(svg(`<path d="${first}"/><path d="${second}"/>`));
    expect(filled(merged, 12, 12)).toBe(true);
    expect(filled(merged, 4, 4)).toBe(true);
    expect(filled(merged, 20, 20)).toBe(true);
    expect(filled(merged, 20, 4)).toBe(false);
  });

  it("refuses what cannot be one filled path, saying why", () => {
    expect(refusal(svg('<text x="2" y="20">Hi</text>'))).toMatch(/text/);
    expect(refusal(svg('<defs><path id="p" d="M0 0h4v4z"/></defs><use href="#p"/>'))).toMatch(/<use>/);
    expect(refusal(svg('<image href="a.png" width="24" height="24"/>'))).toMatch(/picture/);
    expect(refusal(svg('<svg viewBox="0 0 2 2"><rect width="2" height="2"/></svg>'))).toMatch(/another <svg>/);
    expect(refusal(svg('<path d="M0 0 X 4"/>'))).toMatch(/cannot be read/);
    expect(refusal(svg('<rect width="50%" height="50%"/>'))).toMatch(/percent/);
    expect(refusal('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h4v4z"/></svg>')).toMatch(/size is unknown/);
    expect(refusal(svg("", 'viewBox="0 0 0 24"'))).toMatch(/viewBox/);
    expect(refusal(svg(""))).toMatch(/no filled shape/);
    expect(refusal(svg('<path d="M0 0h0.001z"/>'))).toMatch(/no filled shape/);
  });

  it("refuses what is not an SVG", () => {
    for (const text of ["", "   ", "hello", "<html><body></body></html>", '<svg viewBox="0 0 24 24"><path d="M0 0h4v4z">', "<svg"]) {
      expect(refusal(text)).toMatch(/not an SVG/);
    }
  });

  it("writes fewer decimals when the path would be too long, and refuses one too long even then", () => {
    // 2 decimals: 26 characters a box, 1040 in all; 1 decimal: 21, 840.
    const boxes = '<rect x="1.234" y="4.567" width="1.111" height="1.111"/>'.repeat(40);
    expect(icon(svg(boxes))).toBe("M1.2 4.6H2.3V5.7H1.2Z".repeat(40));
    const many = Array.from({ length: 300 }, (_, i) => `<rect x="${i % 20}" y="${Math.floor(i / 20)}" width="1" height="1"/>`).join("");
    const error = refusal(svg(many));
    expect(error).toMatch(/characters/);
    expect(error).toMatch(/1024/);
  });
});
