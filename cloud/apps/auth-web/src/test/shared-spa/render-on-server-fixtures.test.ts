// Where an ESP32's scenes run, as the settings read it: the SPA's helpers and
// the backend Power section's board rule, and the iOS app's port
// (ios/FrameOSKit/Sources/FrameOSKit/Contracts/RenderOnServer.swift). Both
// replay docs/render-on-server-fixtures.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { embeddedPowerProfileFor } from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/frameSettingsSurface";
import type { FrameType } from "../../../../../../frontend/src/types";
import {
  backendFrameRenderMode,
  cloudFrameRenderMode,
  frameCanRenderItself,
} from "../../../../../../frontend/src/utils/renderOnServer";

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../docs/render-on-server-fixtures.json"), "utf8"),
) as {
  canRenderItself: { hardware: unknown; expect: boolean }[];
  cloudRenderMode: { frame: Record<string, unknown>; expect: string }[];
  backendRenderMode: { frame: Record<string, unknown>; expect: string }[];
  backendBoards: { platform: string | null; powerProfile: string | null; offersRenderOnServer: boolean }[];
};

// devices.ts reaches components/Select.tsx (a bare JSX namespace auth-web's
// tsc does not have; see device-catalog-mirror in tsconfig.json), so it is
// loaded at run time, keeping this file inside the typecheck.
const devicesModule = join(__dirname, "../../../../../../frontend/src/devices.ts");
async function isThinClientEmbeddedPlatform(platform: string | null): Promise<boolean> {
  const devices = (await import(/* @vite-ignore */ devicesModule)) as {
    isThinClientEmbeddedPlatform: (platform?: string | null) => boolean;
  };
  return devices.isThinClientEmbeddedPlatform(platform);
}

describe("docs/render-on-server-fixtures.json", () => {
  it("canRenderItself", () => {
    for (const kase of fixtures.canRenderItself) {
      expect(frameCanRenderItself(kase.hardware as FrameType["hardware"] | null), JSON.stringify(kase.hardware)).toBe(
        kase.expect,
      );
    }
  });

  it("cloudRenderMode", () => {
    for (const kase of fixtures.cloudRenderMode) {
      expect(cloudFrameRenderMode(kase.frame as Parameters<typeof cloudFrameRenderMode>[0]), JSON.stringify(kase.frame)).toBe(
        kase.expect,
      );
    }
  });

  it("backendRenderMode", () => {
    for (const kase of fixtures.backendRenderMode) {
      expect(
        backendFrameRenderMode(kase.frame as Parameters<typeof backendFrameRenderMode>[0]),
        JSON.stringify(kase.frame),
      ).toBe(kase.expect);
    }
  });

  it("backendBoards", async () => {
    for (const kase of fixtures.backendBoards) {
      // frameSettingsContext.tsx: the Power section's profile, and its
      // "Render scenes" row (embeddedRenderOnServer).
      const profile = embeddedPowerProfileFor(kase.platform);
      expect(profile, String(kase.platform)).toBe(kase.powerProfile);
      expect(profile === "esp32" && !(await isThinClientEmbeddedPlatform(kase.platform)), String(kase.platform)).toBe(
        kase.offersRenderOnServer,
      );
    }
  });
});
