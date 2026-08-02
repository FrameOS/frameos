import { describe, expect, it } from "vitest";
import {
  parseStoreBrowseFilters,
  parseStorePage,
  storeBrowseHref,
  storeHasFilters,
} from "./store-filters";

describe("parseStoreBrowseFilters", () => {
  it("keeps the filters a listing understands", () => {
    expect(
      parseStoreBrowseFilters({
        category: " Photos ",
        q: "  clock  ",
        tag: " WEATHER ",
        version: " 2026.10.0 ",
      }),
    ).toEqual({
      category: "photos",
      query: "clock",
      tag: "weather",
      version: "2026.10.0",
    });
  });

  it("drops filters it cannot honour instead of failing", () => {
    expect(
      parseStoreBrowseFilters({
        category: "not-a-category",
        version: "nightly",
      }),
    ).toEqual({ category: "", query: "", tag: "", version: "" });
  });
});

describe("parseStorePage", () => {
  it("clamps to a sane range", () => {
    expect(parseStorePage(undefined)).toBe(1);
    expect(parseStorePage("0")).toBe(1);
    expect(parseStorePage("-3")).toBe(1);
    expect(parseStorePage("nope")).toBe(1);
    expect(parseStorePage("7")).toBe(7);
    expect(parseStorePage("99999")).toBe(200);
  });
});

describe("storeBrowseHref", () => {
  it("round-trips every filter, and drops page 1", () => {
    const filters = {
      category: "photos",
      query: "clock",
      tag: "weather",
      version: "2026.10.0",
    };
    expect(storeBrowseHref(filters)).toBe(
      "/?q=clock&tag=weather&category=photos&version=2026.10.0",
    );
    expect(storeBrowseHref(filters, 3)).toContain("page=3");
    expect(
      parseStoreBrowseFilters(
        Object.fromEntries(new URL(storeBrowseHref(filters), "http://x").searchParams),
      ),
    ).toEqual(filters);
  });

  it("returns the bare store front when nothing is filtered", () => {
    const empty = { category: "", query: "", tag: "", version: "" };
    expect(storeBrowseHref(empty)).toBe("/");
    expect(storeHasFilters(empty)).toBe(false);
    expect(storeHasFilters({ ...empty, version: "2026.9.0" })).toBe(true);
  });
});
