// patch_scene and edit_app_source merge the same way on both control planes:
// this file and the backend's test_ai_chat.py replay
// docs/ai-scene-patch-fixtures.json (docs/ai-chat.md).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyScenePatch, applySourceEdits } from "./tools";

type Fixture = {
  name: string;
  kind: "patch" | "edit";
  args: Record<string, unknown>;
  expected: { issues: string[]; changes?: string[]; summary?: string; scene: Record<string, unknown> | null };
};

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../../docs/ai-scene-patch-fixtures.json"), "utf8"),
) as { base: Record<string, unknown>; cases: Fixture[] };

describe("docs/ai-scene-patch-fixtures.json", () => {
  for (const fixture of corpus.cases) {
    it(fixture.name, () => {
      if (fixture.kind === "patch") {
        const result = applyScenePatch(corpus.base, fixture.args);
        expect(result.issues).toEqual(fixture.expected.issues);
        expect(result.changes).toEqual(fixture.expected.changes);
        if (fixture.expected.scene) {
          expect(result.scene).toEqual(fixture.expected.scene);
        }
      } else {
        const result = applySourceEdits(corpus.base, fixture.args);
        expect(result.issues).toEqual(fixture.expected.issues);
        expect(result.summary).toEqual(fixture.expected.summary);
        if (fixture.expected.scene) {
          expect(result.scene).toEqual(fixture.expected.scene);
        }
      }
    });
  }
});
