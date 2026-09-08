import { describe, expect, it } from "vitest";
import {
  serviceKeysChangeDetail,
  serviceKeysChangeSummary,
} from "../../../../../../frontend/src/scenes/frame/frameLogic";
import type { FrameType } from "../../../../../../frontend/src/types";

function frame(fields: Partial<FrameType>): Partial<FrameType> {
  return fields;
}

// The backend fingerprints the settings groups frame.json would ship, on the
// frame and on every deploy baseline. A key added in Settings after the
// deploy, a rotated key, or a store scene's newly granted group therefore
// count as an undeployed change — nothing else in the frame diff ever saw
// global settings.
describe("serviceKeysChangeSummary", () => {
  it("names added, changed and removed groups", () => {
    expect(
      serviceKeysChangeSummary(
        frame({ settings_fingerprints: { unsplash: "u1", github: "g1" } }),
        frame({ settings_fingerprints: { unsplash: "u2", openAI: "o1" } }),
      ),
    ).toBe("OpenAI added, Unsplash changed, GitHub removed");
  });

  it("is silent when nothing shipped differently", () => {
    const same = { unsplash: "u1" };
    expect(serviceKeysChangeSummary(frame({ settings_fingerprints: same }), frame({ settings_fingerprints: { ...same } }))).toBeNull();
  });

  it("says nothing for a baseline recorded before the field existed", () => {
    expect(serviceKeysChangeSummary(frame({}), frame({ settings_fingerprints: { unsplash: "u1" } }))).toBeNull();
    expect(serviceKeysChangeSummary(frame({ settings_fingerprints: {} }), frame({}))).toBeNull();
  });

  it("is a fast-deploy change detail", () => {
    expect(
      serviceKeysChangeDetail(
        frame({ settings_fingerprints: {} }),
        frame({ settings_fingerprints: { openAI: "o1" } }),
      ),
    ).toEqual({ label: "Service keys: OpenAI added", requiresFullDeploy: false });
  });
});
