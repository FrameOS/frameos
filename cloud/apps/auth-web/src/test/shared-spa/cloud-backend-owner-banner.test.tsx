// @vitest-environment jsdom
//
// The frame page's banner for a cloud frame a self-hosted backend holds
// (frontend/src/scenes/workspace/CloudBackendOwnerBanner.tsx): who controls
// the frame, and how to hand it back. The reading of `owning_backend` is
// pinned in cloud-backend-owner.test.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { CloudBackendOwnerBanner } from "../../../../../../frontend/src/scenes/workspace/CloudBackendOwnerBanner";
import type { FrameType } from "../../../../../../frontend/src/types";

type CloudTestWindow = Window & { FRAMEOS_APP_CONFIG?: { cloudMode: boolean } };
const testWindow = window as CloudTestWindow;

const frame = (owning_backend: string | null): FrameType =>
  ({ id: "9994a1e1-9988-4ca5-8c86-26dd763049ee", name: "E1002", owning_backend }) as unknown as FrameType;

describe("the banner on a cloud frame a self-hosted backend holds", () => {
  beforeEach(() => {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    initKea();
  });
  afterEach(() => {
    delete testWindow.FRAMEOS_APP_CONFIG;
  });

  it("says who controls the frame and how to hand it back", () => {
    const html = renderToStaticMarkup(<CloudBackendOwnerBanner frame={frame("http://10.4.0.47:8991")} />);
    expect(html).toContain("A self-hosted backend at 10.4.0.47:8991 controls this frame");
    expect(html).toContain("set backend &quot;&quot;\nset api_key &quot;&quot;\nset frame_id 0\nrestart");
    expect(html).toContain("choose Hand back to the cloud");
    expect(html).toContain("Connect over USB");
    const unreadable = renderToStaticMarkup(<CloudBackendOwnerBanner frame={frame("unknown")} />);
    expect(unreadable).toContain("A self-hosted backend controls this frame");
  });

  it("shows nothing without a backend, or outside the cloud", () => {
    expect(renderToStaticMarkup(<CloudBackendOwnerBanner frame={frame(null)} />)).toBe("");
    delete testWindow.FRAMEOS_APP_CONFIG;
    expect(renderToStaticMarkup(<CloudBackendOwnerBanner frame={frame("http://10.4.0.47:8991")} />)).toBe("");
  });
});
