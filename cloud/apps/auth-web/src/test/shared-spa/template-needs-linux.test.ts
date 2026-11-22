// A store listing carries no scenes, only what the store worked out at
// publish (`needs`, utils/sceneNeeds.ts). The Add scene drawer's Install has
// to read it: "Chromium screenshot" offered Install on an ESP32.
import { describe, expect, it } from "vitest";
import { templateCompatibilityForFrame } from "../../../../../../frontend/src/utils/embeddedCompatibility";
import type { TemplateType } from "../../../../../../frontend/src/types";

const chromium = { id: "chromium-screenshot", name: "Chromium screenshot", needs: ["linux"] } as unknown as TemplateType;
const clock = { id: "clock", name: "Clock", needs: ["fast"] } as unknown as TemplateType;

describe("a store scene that needs a Linux frame", () => {
  it("is not installable on an ESP32", () => {
    const result = templateCompatibilityForFrame("embedded", chromium, {});
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("Raspberry Pi");
  });

  it("is not installable on a cloud-managed frame", () => {
    expect(templateCompatibilityForFrame("rpios", chromium, {}, { managed_by: "cloud" }).supported).toBe(false);
  });

  it("stays installable on a self-hosted Pi, and other needs do not rule a scene out here", () => {
    expect(templateCompatibilityForFrame("rpios", chromium, {}).supported).toBe(true);
    expect(templateCompatibilityForFrame("embedded", clock, {}).supported).toBe(true);
  });
});
