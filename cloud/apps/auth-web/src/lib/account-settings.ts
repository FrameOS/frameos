// Which account-level service settings the cloud persists (the
// account_settings table), and with which fields. Derived from the preview
// settings groups so the two lists cannot drift: what the wasm preview can
// consume is exactly what an account may store — frameOS{apiKey},
// github{api_key}, homeAssistant{url,accessToken}, immich{url,apiKey},
// openAI{apiKey}, unsplash{accessKey}. Everything else the shared settings
// form knows (SSH keys, build environment, deploy defaults, PostHog, ...) is
// backend-only and never reaches the database here.

import { previewSettingsGroups } from "./preview-settings";

// Generous for API tokens and URLs; anything longer is not a credential.
export const maxAccountSettingValueLength = 4096;

// group -> allowed field names. A Map (not a plain object) so prototype keys
// like "toString" or "__proto__" can never resolve to something truthy — the
// same trap allowedFrameSettings (frames.ts) documents.
export const storableAccountSettingsFields: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map(
  Object.values(previewSettingsGroups)
    .map((group): [string, Set<string>] => [
      group.key,
      new Set(group.fields.map((field) => field.path[1])),
    ])
    .map(([key, fields]) => {
      // The account's own OpenAI key for AI chat in the workspace. Storable
      // but deliberately NOT in previewSettingsGroups (the wasm preview has
      // no use for it) and NOT device-deliverable
      // (frame-service-settings.ts) — it must never reach a frame.
      if (key === "openAI") {
        fields.add("backendApiKey");
      }
      return [key, fields];
    }),
);

export type FilteredAccountSettings = Record<string, Record<string, string>>;

// Reduce a settings POST body to what the account may store.
//
// Unknown GROUPS are filtered, not refused: the shared settings form submits
// its whole form object — backend-only groups (defaults, ssh_keys,
// buildEnvironment, posthog, personal, ...) included — so refusing the
// payload over them would break Save on the cloud outright. Unknown FIELDS
// inside a storable group are filtered for the same reason. Actual bad data
// in a storable field (a non-string, an oversized value) is refused whole —
// a partial apply would leave the form and the database disagreeing about
// what was saved.
export function filterAccountSettings(payload: Record<string, unknown>):
  | { error?: undefined; settings: FilteredAccountSettings }
  | { error: string; settings?: undefined } {
  const settings: FilteredAccountSettings = {};
  for (const [group, value] of Object.entries(payload)) {
    const allowedFields = storableAccountSettingsFields.get(group);
    if (!allowedFields) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "invalid_settings" };
    }
    const filtered: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (!allowedFields.has(field)) {
        continue;
      }
      if (typeof fieldValue !== "string") {
        return { error: "invalid_settings" };
      }
      if (fieldValue.length > maxAccountSettingValueLength) {
        return { error: "settings_value_too_large" };
      }
      filtered[field] = fieldValue;
    }
    // Present means "replace this group wholesale" (the backend's POST
    // /api/settings semantics) — an empty object clears the group's fields.
    settings[group] = filtered;
  }
  return { settings };
}
