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

  it("plays video on a Pi, cloud-managed or not, and never on an ESP32", () => {
    const player = { id: "video-player", name: "Video player", needs: ["video"] } as unknown as TemplateType;
    expect(templateCompatibilityForFrame("embedded", player, {}).supported).toBe(false);
    expect(templateCompatibilityForFrame("embedded", player, {}).reason).toContain("Raspberry Pi");
    expect(templateCompatibilityForFrame("rpios", player, {}, { managed_by: "cloud" }).supported).toBe(true);
    expect(templateCompatibilityForFrame("rpios", player, {}).supported).toBe(true);
    const local = {
      id: "local-player",
      name: "Local player",
      scenes: [{ id: "p", name: "P", nodes: [], edges: [], apps: { a: { sources: { "app.tsx": "frameos.video('v', { src })" } } } }],
    } as unknown as TemplateType;
    expect(templateCompatibilityForFrame("embedded", local, {}).supported).toBe(false);
  });

  it("stays installable on a self-hosted Pi, and other needs do not rule a scene out here", () => {
    expect(templateCompatibilityForFrame("rpios", chromium, {}).supported).toBe(true);
    expect(templateCompatibilityForFrame("embedded", clock, {}).supported).toBe(true);
  });
});
