import { describe, expect, it } from "vitest";
import {
  defaultSceneDescription,
  markdownToPlainText,
  socialDescription,
  socialDescriptionMaxLength,
  truncateForCard,
} from "./social-description";

describe("markdownToPlainText", () => {
  it("drops markdown syntax but keeps the words", () => {
    expect(
      markdownToPlainText(
        "# Visited map\n\nShows **countries** you've _visited_ on a [world map](https://example.com).\n\n- pick a colour\n- pick a font\n\n> tip: `settings`",
      ),
    ).toBe(
      "Visited map Shows countries you've visited on a world map. pick a colour pick a font tip: settings",
    );
  });

  it("removes images, code fences, html and horizontal rules", () => {
    expect(
      markdownToPlainText(
        "![preview](./image.jpg)\n\n```json\n{\"a\": 1}\n```\n\n---\n\nPlain <br> text ~~old~~ new",
      ),
    ).toBe("preview Plain text old new");
  });

  it("keeps snake_case identifiers and escaped characters", () => {
    expect(markdownToPlainText("Set api_key and \\*really\\* try")).toBe(
      "Set api_key and *really* try",
    );
  });
});

describe("truncateForCard", () => {
  it("leaves short text alone", () => {
    expect(truncateForCard("short")).toBe("short");
  });

  it("cuts on a word boundary with an ellipsis", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const out = truncateForCard(long);
    expect(out.length).toBeLessThanOrEqual(socialDescriptionMaxLength);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/ …$/);
    // Never ends on a half word.
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(long.charAt(out.length - 1)).toBe(" ");
  });

  it("does not leave trailing punctuation before the ellipsis", () => {
    expect(truncateForCard("one, two, three, four,", 12)).toBe("one, two…");
  });
});

describe("socialDescription", () => {
  it("uses the fallback for missing, empty or syntax-only descriptions", () => {
    expect(socialDescription(null, "fallback")).toBe("fallback");
    expect(socialDescription("", "fallback")).toBe("fallback");
    expect(socialDescription("---\n\n", "fallback")).toBe("fallback");
  });

  it("flattens a real description", () => {
    expect(socialDescription("**Monthly** calendar\nwith `.ics`", "x")).toBe(
      "Monthly calendar with .ics",
    );
  });
});

describe("defaultSceneDescription", () => {
  it("names the publisher", () => {
    expect(defaultSceneDescription("Marius")).toMatch(/^A FrameOS scene by Marius\./);
    expect(defaultSceneDescription(null)).toMatch(/^A FrameOS scene by a FrameOS user\./);
  });
});
