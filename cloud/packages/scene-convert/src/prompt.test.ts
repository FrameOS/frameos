import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appMappings, buildConvertInstructions, codeNodeMappings, deliverConversionTool } from "./prompt";

// docs/nim-to-js-conversion.md is where the mapping tables are maintained;
// the prompt carries the same rows. This is the check that keeps them equal.
const doc = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "..", "docs", "nim-to-js-conversion.md"), "utf8");

describe("the mapping tables", () => {
  for (const row of [...codeNodeMappings, ...appMappings]) {
    it(`docs/nim-to-js-conversion.md lists: ${row.nim.slice(0, 60)}`, () => {
      expect(doc).toContain(`| ${row.nim} | ${row.js} |`);
    });
  }

  it("has the same number of rows in the doc and the prompt", () => {
    const rows = doc.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Nim |"));
    expect(rows).toHaveLength(codeNodeMappings.length + appMappings.length);
  });
});

describe("buildConvertInstructions", () => {
  it("carries both tables, the sandboxes and the render rule", () => {
    const text = buildConvertInstructions();
    for (const row of [...codeNodeMappings, ...appMappings]) {
      expect(text).toContain(row.nim);
    }
    expect(text).toContain("frameos.setState");
    expect(text).toContain("reserved");
    expect(text).toContain('category "render"');
    expect(text).toContain(deliverConversionTool.name);
    expect(text).not.toContain("Ambient type declarations");
  });

  it("appends the type declarations when given", () => {
    const text = buildConvertInstructions({ typeDeclarations: "declare const frameos: { svg(s: string): unknown };" });
    expect(text).toContain("## Ambient type declarations");
    expect(text).toContain("declare const frameos");
  });
});

describe("deliverConversionTool", () => {
  it("is a single tool with files | codeJS | unsupported", () => {
    const properties = deliverConversionTool.parameters.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["codeJS", "files", "notes", "unsupported"]);
    expect(deliverConversionTool.parameters.required).toEqual(["notes"]);
  });
});
