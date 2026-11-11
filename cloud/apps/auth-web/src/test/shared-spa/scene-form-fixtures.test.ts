// What a scene's settings form draws (the implicit refresh interval, the
// public fields, showIf) is read by the SPA here and by the iOS app's port
// (ios/FrameOSKit/Sources/FrameOSKit/Contracts/SceneFields.swift). Both
// replay docs/scene-form-fixtures.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sceneStateFields } from "../../../../../../frontend/src/utils/refreshInterval";
import { visiblePublicStateFields } from "../../../../../../frontend/src/utils/showIf";

type Case = {
  name: string;
  scene: Record<string, unknown>;
  values: Record<string, unknown>[];
  expect: {
    fields: { name: string; label: string | null; type: string; value: unknown; access: string | null; role: string | null }[];
    visible: string[];
  };
};

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../docs/scene-form-fixtures.json"), "utf8"),
) as { cases: Case[] };

describe("docs/scene-form-fixtures.json", () => {
  for (const kase of fixtures.cases) {
    it(kase.name, () => {
      const fields = sceneStateFields(kase.scene as Parameters<typeof sceneStateFields>[0]);
      expect(
        fields.map((f) => ({
          name: f.name,
          label: f.label ?? null,
          type: f.type,
          value: f.value ?? null,
          access: f.access ?? null,
          role: f.role ?? null,
        })),
      ).toEqual(kase.expect.fields);
      expect(visiblePublicStateFields(fields, ...kase.values).map((f) => f.name)).toEqual(
        kase.expect.visible,
      );
    });
  }
});
