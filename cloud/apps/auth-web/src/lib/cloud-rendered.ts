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

// A board with its own runtime (every ESP32-S3) whose owner set `render_mode`
// to "remote" (docs/server-rendering.md): the cloud runs its scenes and hands
// it the packed picture at every pull. The setting the plane keeps decides,
// never the device's word: a board set to remote over its USB console but not
// here is refused at the pull. The SQL in countCloudRenderedFramesForAccount
// reads the same key.
export function settingsRenderOnServer(settings: unknown): boolean {
  return (
    !!settings &&
    typeof settings === "object" &&
    !Array.isArray(settings) &&
    (settings as { render_mode?: unknown }).render_mode === "remote"
  );
}

// Every frame the cloud renders for: a virtual frame, a board without a
// runtime, or a board with one that was set to render on the server.
export function frameIsCloudRendered(frame: { hardware: unknown; settings: unknown }): boolean {
  return hardwareIsCloudRendered(frame.hardware) || settingsRenderOnServer(frame.settings);
}

// A hardware frame whose scenes run on the cloud (docs/server-rendering.md):
// its scene state and the scene it shows are the plane's
// (frame_server_renders), not what the device says. In remote mode the
// device runs no scene of its own, so the `active_scene` and `states` it
// reports in hello, `state` and the scene ack are stale; the plane writes
// frames.last_state itself when a render commits (server-render.ts), and the
// hub leaves the device's out. A virtual frame is not one of these: the hub's
// own virtual device is its runtime, and its report is the truth.
export function planeKeepsSceneState(frame: { hardware: unknown; settings: unknown }): boolean {
  if (!frameIsCloudRendered(frame)) {
    return false;
  }
  const platform =
    frame.hardware && typeof frame.hardware === "object"
      ? (frame.hardware as { platform?: unknown }).platform
      : undefined;
  return !(typeof platform === "string" && platform.toLowerCase().startsWith("virtual"));
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
