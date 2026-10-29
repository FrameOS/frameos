// A cloud ESP32 with a self-hosted backend set on it turns down the cloud's
// scenes, settings and schedule (`backend_managed`) and reports the backend
// as hardware.backend, which the cloud hands the SPA as `owning_backend`
// (docs/cloud-frames.md "While managed"). The banner that says so renders in
// cloud-backend-owner-banner.test.tsx.
import { describe, expect, it } from "vitest";
import type { FrameType } from "../../../../../../frontend/src/types";
import {
  frameHasOwningBackend,
  frameOwningBackendHost,
} from "../../../../../../frontend/src/utils/frameOwningBackend";
import { frameOwningBackend } from "../../lib/frame-backend-owner";
import { frameSummary } from "../../lib/frames";

const frame = (owning_backend: string | null): FrameType =>
  ({ id: "9994a1e1-9988-4ca5-8c86-26dd763049ee", name: "E1002", owning_backend }) as unknown as FrameType;

describe("a cloud frame a self-hosted backend holds", () => {
  it("reads the backend the device reported", () => {
    expect(frameOwningBackend({ backend: "http://10.4.0.47:8991", platform: "esp32-s3" })).toBe("http://10.4.0.47:8991");
    expect(frameOwningBackend({ backend: " ", platform: "esp32-s3" })).toBeNull();
    expect(frameOwningBackend({ backend: 1 })).toBeNull();
    expect(frameOwningBackend({ platform: "esp32-s3" })).toBeNull();
    expect(frameOwningBackend(null)).toBeNull();
    const row = { hardware: { backend: "http://10.4.0.47:8991" } } as unknown as Parameters<typeof frameSummary>[0];
    expect(frameSummary(row).owning_backend).toBe("http://10.4.0.47:8991");
  });

  it("names the backend's host, or none when the frame could not read it", () => {
    expect(frameOwningBackendHost(frame("http://10.4.0.47:8991"))).toBe("10.4.0.47:8991");
    expect(frameOwningBackendHost(frame("unknown"))).toBeNull();
    expect(frameHasOwningBackend(frame("unknown"))).toBe(true);
    expect(frameHasOwningBackend(frame(null))).toBe(false);
  });
});
