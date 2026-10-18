// The config.json form in the app editor writes the file back after every
// edit, so the writer must keep the file looking like its author left it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatAppConfigJson,
  formatAppConfigLike,
  moveItem,
  newConfigField,
  parseAppConfigSource,
  renameFieldReferences,
  renamedField,
  withConfigKey,
  type AppConfigEntry,
} from "../../../../../../frontend/src/utils/appConfigForm";

const repoRoot = resolve(__dirname, "../../../../../..");

describe("formatAppConfigJson", () => {
  it("writes a prettier-formatted repo config.json back unchanged", () => {
    const source = readFileSync(
      resolve(repoRoot, "repo/apps/image/unsplash/config.json"),
      "utf8",
    );
    const { config } = parseAppConfigSource(source);
    expect(formatAppConfigJson(config!)).toBe(source);
  });

  it("breaks what does not fit in 120 columns, one item per line", () => {
    const text = formatAppConfigJson({
      name: "Long",
      fields: [{ name: "a", label: "x".repeat(130), type: "string" }],
    });
    expect(text).toBe(
      `{\n  "name": "Long",\n  "fields": [\n    {\n      "name": "a",\n      "label": "${"x".repeat(130)}",\n      "type": "string"\n    }\n  ]\n}\n`,
    );
  });
});

describe("formatAppConfigLike", () => {
  it("keeps a plain JSON.stringify file in that style", () => {
    const previous = `${JSON.stringify({ name: "A", fields: [] }, null, 4)}\n`;
    expect(formatAppConfigLike(previous, { name: "B", fields: [] })).toBe(
      `${JSON.stringify({ name: "B", fields: [] }, null, 4)}\n`,
    );
  });

  it("uses the repo style for anything else", () => {
    const previous = '{ "name": "A" }';
    expect(formatAppConfigLike(previous, { name: "B" })).toBe(
      '{\n  "name": "B"\n}\n',
    );
  });
});

describe("parseAppConfigSource", () => {
  it("reports what is not one JSON object", () => {
    expect(parseAppConfigSource("[]").config).toBeNull();
    expect(parseAppConfigSource("{").error).toBeTruthy();
    expect(parseAppConfigSource("").config).toEqual({});
  });
});

describe("withConfigKey", () => {
  it("puts a new key where the repo's apps have it", () => {
    const next = withConfigKey(
      { name: "A", fields: [] },
      "description",
      "Hi",
    );
    expect(Object.keys(next)).toEqual(["name", "description", "fields"]);
  });

  it("drops an emptied description but keeps an emptied settings list", () => {
    expect(withConfigKey({ name: "A", description: "x" }, "description", "")).toEqual({
      name: "A",
    });
    // Saving falls back to the old list when the key is missing.
    expect(withConfigKey({ name: "A", settings: ["openAI"] }, "settings", [])).toEqual({
      name: "A",
      settings: [],
    });
  });

  it("keeps keys it does not know", () => {
    expect(withConfigKey({ name: "A", future: 1 }, "name", "B")).toEqual({
      name: "B",
      future: 1,
    });
  });
});

describe("field edits", () => {
  it("names a new field after the ones it has", () => {
    const entries: AppConfigEntry[] = [
      { name: "field", label: "Field", type: "string" },
      { markdown: "Hello" },
    ];
    expect(newConfigField(entries)).toEqual({
      name: "field2",
      label: "Field2",
      type: "string",
      value: "",
    });
  });

  it("carries a generated label along with a rename, and keeps a written one", () => {
    expect(
      renamedField({ name: "city", label: "City", type: "string" }, "homeCity"),
    ).toMatchObject({ label: "Home city", name: "homeCity" });
    expect(
      renamedField({ name: "city", label: "Where", type: "string" }, "homeCity"),
    ).toMatchObject({ label: "Where", name: "homeCity" });
  });

  it("points show-if conditions and repeat ranges at the new name", () => {
    const entries: AppConfigEntry[] = [
      { name: "count", label: "Count", type: "integer" },
      {
        name: "color",
        label: "Color {i}",
        type: "color",
        seq: [["i", 1, "count"]],
        showIf: [{ and: [{ field: "count", operator: "gt", value: 0 }] }],
      },
      { markdown: "Note", showIf: [{ field: "count", operator: "notEmpty" }] },
    ];
    const renamed = renameFieldReferences(entries, "count", "total");
    expect(renamed[1]).toMatchObject({
      seq: [["i", 1, "total"]],
      showIf: [{ and: [{ field: "total", operator: "gt", value: 0 }] }],
    });
    expect(renamed[2]).toMatchObject({
      showIf: [{ field: "total", operator: "notEmpty" }],
    });
  });

  it("moves within bounds only", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });
});
