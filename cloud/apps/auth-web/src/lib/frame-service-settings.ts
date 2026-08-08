// The service API keys a cloud-managed frame is allowed to receive, and the
// exact bytes it fetches. Wire contract: docs/cloud-frames.md
// ("Service settings"); design: cloud/docs/cloud-frames.md.
//
// Keys travel over a device-authed HTTPS pull, never over the WebSocket
// command queue: frame_commands rows are never deleted, so a pushed secret
// would live in Postgres and every backup forever, would pass through the
// hub, and could be redelivered after the owner deleted it. The socket only
// carries a zero-payload `refresh_service_settings` nudge.

import { createHash } from "node:crypto";

// group -> the fields a DEVICE may receive. Deliberately its own list rather
// than a reuse of storableAccountSettingsFields: the account may one day
// store more of a group than a frame should ever see (the backend already
// strips Home Assistant's MQTT credentials and sync flags before writing
// frame.json — backend/app/models/frame.py). A test pins this as a subset.
export const deviceDeliverableFields: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["frameOS", new Set(["apiKey"])],
  ["github", new Set(["api_key"])],
  ["homeAssistant", new Set(["url", "accessToken"])],
  ["immich", new Set(["url", "apiKey"])],
  ["openAI", new Set(["apiKey"])],
  ["unsplash", new Set(["accessKey"])],
]);

export type ServiceSettingsPayload = {
  settings: Record<string, Record<string, string>>;
  groups: string[];
};

// Stable bytes for the ETag and the response: JSON.stringify with sorted keys
// at every level, so re-saving the same values in a different order does not
// invalidate every frame's cached copy.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function serviceSettingsEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

/**
 * Build what a frame receives, from the groups its scenes declare and the
 * account's stored settings.
 *
 * `groups` lists every group the scenes declare, whether or not the account
 * filled it in — that is what lets the UI say "this frame needs an Unsplash
 * key" and what tells the device which groups are cloud-owned. `settings`
 * carries only the groups that have a usable value.
 *
 * The six groups are cloud-owned on a managed frame: a group the scenes
 * declare but the account has not filled in is absent from `settings`, and
 * the device deletes its local copy rather than keeping a stale key.
 */
export function buildServiceSettingsPayload(
  declaredGroups: readonly string[],
  storedSettings: Record<string, Record<string, string>>,
): ServiceSettingsPayload {
  const groups = [...new Set(declaredGroups)]
    .filter((group) => deviceDeliverableFields.has(group))
    .sort();

  const settings: Record<string, Record<string, string>> = {};
  for (const group of groups) {
    const allowedFields = deviceDeliverableFields.get(group);
    const stored = storedSettings[group];
    if (!allowedFields || !stored) {
      continue;
    }
    const fields: Record<string, string> = {};
    for (const [field, value] of Object.entries(stored)) {
      // Empty strings are "not configured", not a credential worth shipping.
      if (allowedFields.has(field) && typeof value === "string" && value !== "") {
        fields[field] = value;
      }
    }
    if (Object.keys(fields).length > 0) {
      settings[group] = fields;
    }
  }

  return { settings, groups };
}

export function serviceSettingsResponseBody(payload: ServiceSettingsPayload): {
  body: string;
  etag: string;
} {
  const body = canonicalJson(payload);
  return { body, etag: serviceSettingsEtag(body) };
}
