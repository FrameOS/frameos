// Frames the cloud renders for (cloud/docs/accounting-todo.md §0.2): the
// paid entitlement `cloud_rendered_frames`, enforced as N frames AND a
// minimum refresh interval, because renders per day is the cost. Its own
// file, free of the plan and ledger imports of usage.ts, because the frame
// hub reads the floor too (it paces a virtual frame's renders).
import { logWarn } from "./log";

// Virtual frames (no hardware: the hub is the device, virtual-frames.ts) and
// the boards below the capability line — no PSRAM, so no on-device renderer:
// ESP32-C3 and the Pico family (embedded_firmware.py: localRenderSupported
// false). Serving one means the control plane renders every frame for it.
// The SQL in countCloudRenderedFramesForAccount mirrors this list; keep both
// in step.
export const cloudRenderedPlatformPrefixes = ["virtual", "esp32-c3", "pico"] as const;

export function hardwareIsCloudRendered(hardware: unknown): boolean {
  if (!hardware || typeof hardware !== "object") {
    return false;
  }
  const record = hardware as { localRenderSupported?: unknown; platform?: unknown };
  if (record.localRenderSupported === false) {
    return true;
  }
  const platform = typeof record.platform === "string" ? record.platform.toLowerCase() : "";
  return cloudRenderedPlatformPrefixes.some((prefix) => platform.startsWith(prefix));
}

// The refresh-interval floor for a cloud-rendered frame (§0.2: 5 minutes).
// Displayed nowhere as a headline number — the plan sells "N frames" — but
// enforced on every settings push to such a frame and by the hub's render
// tick. The hub reads the same variable from its own environment.
export const cloudRenderedMinIntervalSeconds = (() => {
  const raw = process.env.FRAMEOS_CLOUD_RENDERED_MIN_INTERVAL_SECONDS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (raw && (!Number.isInteger(parsed) || parsed < 1)) {
    logWarn("usage.invalid_limit_env", {
      fallback: 300,
      name: "FRAMEOS_CLOUD_RENDERED_MIN_INTERVAL_SECONDS",
      value: raw,
    });
  }
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 300;
})();
