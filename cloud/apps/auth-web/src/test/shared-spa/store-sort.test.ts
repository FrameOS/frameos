// The order of a store shelf (frontend/src/utils/storeSort.ts, applied by
// storeShelvesOf): the index's own order by default (featured first, then
// installs), by last change, or by name.
import { describe, expect, it } from "vitest";
import {
  latestStoreAdditions,
  sortStoreTemplates,
  storeSortOf,
} from "../../../../../../frontend/src/utils/storeSort";
import type { TemplateType } from "../../../../../../frontend/src/types";

const templates: TemplateType[] = [
  { name: "Weather", category: "art", updated: "2026-10-01T00:00:00.000Z", downloads: 40 },
  { name: "birds", category: "art", updated: "2026-10-12T00:00:00.000Z", downloads: 12 },
  { name: "Clock", category: "art", downloads: 3 },
  { name: "Agenda", category: "art", updated: "2026-09-20T00:00:00.000Z" },
];
const names = (list: TemplateType[]): string[] => list.map((template) => template.name);

describe("store sort", () => {
  it("keeps the index order for popular", () => {
    expect(sortStoreTemplates(templates, "popular")).toBe(templates);
  });

  it("latest is by last change, newest first, undated last", () => {
    expect(names(sortStoreTemplates(templates, "latest"))).toEqual(["birds", "Weather", "Agenda", "Clock"]);
  });

  it("name ignores case", () => {
    expect(names(sortStoreTemplates(templates, "name"))).toEqual(["Agenda", "birds", "Clock", "Weather"]);
  });

  it("an unknown sort is popular", () => {
    expect(storeSortOf("name")).toBe("name");
    expect(storeSortOf("downloads")).toBe("popular");
    expect(storeSortOf(undefined)).toBe("popular");
  });
});

describe("the store's latest additions", () => {
  it("are newest first by when they were added, not by their last change", () => {
    const added: TemplateType[] = [
      // An old scene with a new version: last changed today, added long ago.
      { created: "2026-01-05T00:00:00.000Z", name: "Old, just updated", updated: "2026-10-27T00:00:00.000Z" },
      { created: "2026-10-20T00:00:00.000Z", name: "New this week", updated: "2026-10-20T00:00:00.000Z" },
      { created: "2026-09-01T00:00:00.000Z", name: "September", updated: "2026-10-01T00:00:00.000Z" },
    ];
    expect(names(latestStoreAdditions(added))).toEqual(["New this week", "September", "Old, just updated"]);
  });

  it("fall back to the last change for an index cached without the date added, undated last", () => {
    expect(names(latestStoreAdditions(templates))).toEqual(["birds", "Weather", "Agenda", "Clock"]);
  });
});
