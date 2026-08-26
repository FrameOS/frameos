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

// The account's SSH keys (the `ssh_keys` settings group): public halves
// only — the cloud never logs in to a frame, it only writes the keys into
// the SD cards it personalizes, so a private key posted by the shared
// settings form is dropped, never stored. Its own shape (a list, not a
// string map), so it is validated apart from the service groups below.
export const maxAccountSshKeys = 20;
export const maxAccountSshKeyLength = 4096;
const sshPublicKeyLine =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9@._+-]{1,64})?$/;

export interface StoredSshKey {
  id: string;
  name: string;
  public: string;
  use_for_new_frames: boolean;
}

export function filterAccountSshKeys(
  value: unknown,
): { error?: undefined; keys: StoredSshKey[] } | { error: string; keys?: undefined } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_settings" };
  }
  const raw = (value as { keys?: unknown }).keys;
  if (raw === undefined) {
    return { keys: [] };
  }
  if (!Array.isArray(raw) || raw.length > maxAccountSshKeys) {
    return { error: "invalid_settings" };
  }
  const keys: StoredSshKey[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "invalid_settings" };
    }
    const { id, name, public: publicKey, use_for_new_frames } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id)) {
      return { error: "invalid_settings" };
    }
    if (name !== undefined && typeof name !== "string") {
      return { error: "invalid_settings" };
    }
    // The shared form starts a key as an empty entry and fills it in; an
    // entry without a public key is not a key yet and is not stored.
    if (typeof publicKey !== "string" || publicKey.trim() === "") {
      continue;
    }
    const line = publicKey.trim().replace(/\s+/g, " ");
    if (line.length > maxAccountSshKeyLength || !sshPublicKeyLine.test(line)) {
      return { error: "invalid_ssh_key" };
    }
    seen.add(id);
    keys.push({
      id,
      name: (typeof name === "string" ? name : "").slice(0, 120),
      public: line,
      use_for_new_frames: use_for_new_frames === true,
    });
  }
  return { keys };
}

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
      // The account's own OpenAI key + model tuning for AI chat in the
      // workspace. Storable but deliberately NOT in previewSettingsGroups
      // (the wasm preview has no use for them) and NOT device-deliverable
      // (frame-service-settings.ts) — they must never reach a frame.
      if (key === "openAI") {
        fields.add("backendApiKey");
        fields.add("chatModel");
        fields.add("chatReasoningEffort");
      }
      return [key, fields];
    }),
);

export type FilteredAccountSettings = Record<
  string,
  Record<string, string> | { keys: StoredSshKey[] }
>;

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
    if (group === "ssh_keys") {
      const filtered = filterAccountSshKeys(value);
      if (filtered.error) {
        return { error: filtered.error };
      }
      settings.ssh_keys = { keys: filtered.keys };
      continue;
    }
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
