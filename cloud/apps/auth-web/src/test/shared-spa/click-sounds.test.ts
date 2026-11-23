// The frame settings offer "Tap and click sounds" only where a frame makes
// any (utils/clickSounds.ts): most frames have no buzzer and no speaker.
import { describe, expect, it } from "vitest";
import { clickSoundsOf, frameHasSounds } from "../../../../../../frontend/src/utils/clickSounds";

describe("tap and click sounds", () => {
  it("are offered on boards with a buzzer or a speaker, and nowhere else", () => {
    expect(frameHasSounds({ hardwarePreset: "seeed_reterminal_sticky" })).toBe(true);
    expect(frameHasSounds({ hardwarePreset: "waveshare_esp32_s3_photopainter" })).toBe(true);
    expect(frameHasSounds({ hardwarePreset: "seeed_sensecap_indicator_d1" })).toBe(false);
    expect(frameHasSounds({ hardwarePreset: "custom" })).toBe(false);
    expect(frameHasSounds({})).toBe(false);
    // A buzzer someone wired up, or one the frame reports.
    expect(frameHasSounds({ buzzerPin: 12 })).toBe(true);
    expect(frameHasSounds({ reportedBuzzerPin: 45 })).toBe(true);
    expect(frameHasSounds({ buzzerPin: -1, reportedBuzzerPin: 45 })).toBe(false);
    // What the frame says of itself wins.
    expect(frameHasSounds({ reportedSounds: false, hardwarePreset: "seeed_reterminal_e1001" })).toBe(false);
    expect(frameHasSounds({ reportedSounds: true })).toBe(true);
  });

  it("read anything unknown as normal", () => {
    expect(clickSoundsOf("silent")).toBe("silent");
    expect(clickSoundsOf("loud")).toBe("normal");
    expect(clickSoundsOf(undefined)).toBe("normal");
  });
});
