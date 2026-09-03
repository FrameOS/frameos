// The helpers every browser flash flow shares (frontend/src/scenes/workspace/
// embeddedFlashShared.tsx). Lives here (auth-web's vitest) because frontend/
// has no test runner; same cross-package arrangement as the other shared-spa
// suites. esptool-js drives real USB hardware and only resolves from
// frontend/'s own node_modules, so the loader wrapper (esptoolLoader.ts) is
// mocked by source path.
import { describe, expect, it, vi } from "vitest";

const esptool = vi.hoisted(() => ({ loadError: null as Error | null }));

vi.mock("../../../../../../frontend/src/scenes/workspace/esptoolLoader", () => ({
  loadEsptool: () =>
    esptool.loadError ? Promise.reject(esptool.loadError) : Promise.resolve({ ESPLoader: class {}, Transport: class {} }),
}));

import {
  STALE_BUNDLE_FLASH_ERROR,
  loadEsptoolForFlash,
} from "../../../../../../frontend/src/scenes/workspace/embeddedFlashShared";

describe("loadEsptoolForFlash", () => {
  it("says to reload the page when the on-demand esptool chunk is gone", async () => {
    // esptool-js is fetched on the first flash, often long after the page
    // loaded; after a FrameOS upgrade that hashed chunk no longer exists. The
    // browser's "Failed to fetch dynamically imported module" names neither
    // the cause nor the fix, so the flasher says both.
    esptool.loadError = new TypeError("Failed to fetch dynamically imported module: /assets/esptool-abc123.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEsptoolForFlash()).rejects.toThrow(STALE_BUNDLE_FLASH_ERROR);
    esptool.loadError = null;
  });

  it("hands back the loaded module otherwise", async () => {
    await expect(loadEsptoolForFlash()).resolves.toHaveProperty("ESPLoader");
  });
});
