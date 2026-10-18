// Server-side PostHog events for the milestones worth a heads-up, next to
// "cloud user signed up" (signup-notifications.ts): a frame joins an account,
// a scene goes public in the store. Any Discord message is a PostHog webhook
// on these events, not this code. Both never throw; safe to call without
// awaiting.

import { getScenesBaseUrl } from "./env";
import { capturePostHogEvent } from "./posthog-capture";

export const frameAddedEvent = "cloud frame added";
export const scenePublishedEvent = "cloud scene published";

export type FrameAddedInput = {
  accountId: string;
  frameId: string;
  frameosVersion?: string | null | undefined;
  hardware?: unknown;
  name?: string | null | undefined;
  /** claim_token: a single-use code, active at once; confirm: the owner
   * confirmed a pending frame; device_flow: linked from a device's own
   * approval page. */
  via: "claim_token" | "confirm" | "device_flow";
};

export async function notifyFrameAdded(input: FrameAddedInput) {
  const hardware = (input.hardware ?? null) as {
    device?: unknown;
    platform?: unknown;
  } | null;
  await capturePostHogEvent(frameAddedEvent, input.accountId, {
    frame_id: input.frameId,
    frame_name: input.name ?? undefined,
    frameos_version: input.frameosVersion ?? undefined,
    device: typeof hardware?.device === "string" ? hardware.device : undefined,
    platform:
      typeof hardware?.platform === "string" ? hardware.platform : undefined,
    via: input.via,
  });
}

export type ScenePublishedInput = {
  accountId: string;
  name: string;
  sceneId: string;
  slug: string;
  version?: number | undefined;
  /** publish: a version uploaded as public (a backend's "Publish", a zip);
   * visibility: an existing scene switched to public. */
  via: "publish" | "visibility";
};

export async function notifyScenePublished(input: ScenePublishedInput) {
  await capturePostHogEvent(scenePublishedEvent, input.accountId, {
    scene_id: input.sceneId,
    scene_name: input.name,
    scene_url: new URL(`/s/${input.slug}`, getScenesBaseUrl()).toString(),
    version: input.version,
    via: input.via,
  });
}
