// Which account-level service settings the cloud persists (the
// account_settings table), and with which fields. Derived from the preview
// settings groups so the two lists cannot drift: what the wasm preview can
// consume is exactly what an account may store — frameOS{apiKey},
// github{api_key}, homeAssistant{url,accessToken}, immich{url,apiKey},
// openAI{apiKey}, unsplash{accessKey}. Everything else the shared settings
// form knows (SSH keys, build environment, deploy defaults, PostHog, ...) is
// backend-only and never reaches the database here.

import { and, eq } from "drizzle-orm";
import { accountSettings, type createDb } from "@frameos-cloud/db";
import { reportError } from "./log";
import { previewSettingsGroups } from "./preview-settings";
import { decryptSecret, encryptSecret } from "./secrets";
import { isMaskedSettingValue, maskSettingValue } from "./setting-mask";

export { isMaskedSettingValue, maskSettingValue } from "./setting-mask";

// ---------------------------------------------------------------------------
// Secrets at rest.
//
// Most of what an account stores here is a third-party credential, and a
// database dump (or a backup, or a careless query in a debugging session)
// must not be a list of live OpenAI and Home Assistant keys. So every secret
// field is sealed with the deployment's encryption key (secrets.ts, the same
// AES-GCM the TOTP secrets use) before it is written, and opened only for
// the two consumers that need the bytes: the device pull
// (/api/frames/{id}/service-settings) and the AI credential resolver. Every
// other reader — GET /api/settings, the settings page, the export — gets a
// masked hint (setting-mask.ts).
//
// The sealed form lives INSIDE the existing jsonb value under a marker, so a
// legacy plaintext row (written before this shipped) is distinguishable and
// is re-sealed the first time it is read (storedAccountSettings). No
// migration could do that: the key is not in Postgres.
// ---------------------------------------------------------------------------

// Which storable fields are NOT secrets: server URLs and model tuning. Every
// other storable field is a credential and is sealed. Listing the exceptions
// rather than the secrets means a new key added to a group is sealed unless
// somebody says otherwise (a test pins the resulting list).
const plainAccountSettingsFields: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["homeAssistant", new Set(["url"])],
    ["immich", new Set(["url"])],
    ["openAI", new Set(["chatModel", "chatReasoningEffort"])],
  ]);

export function isSecretSettingField(group: string, field: string): boolean {
  const allowed = storableAccountSettingsFields.get(group);
  if (!allowed?.has(field)) {
    return false;
  }
  return !plainAccountSettingsFields.get(group)?.has(field);
}

const sealedPrefix = "enc:";

export function isSealedSettingValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(sealedPrefix);
}

// Empty means "not configured" and stays empty: sealing it would turn the
// absence of a key into ciphertext that every reader has to open to learn
// it means nothing.
export function sealSettingValue(secret: string): string {
  return secret === "" ? "" : `${sealedPrefix}${encryptSecret(secret)}`;
}

// Sealed → plaintext; anything else passes through unchanged (a legacy row).
// Throws when a sealed value cannot be opened (a rotated key): callers decide
// whether that is a missing credential or a failure.
export function openSettingValue(value: string): string {
  return isSealedSettingValue(value)
    ? decryptSecret(value.slice(sealedPrefix.length))
    : value;
}

// Everything stored for the account, as the merged {group: value} object
// GET /api/settings answers with and the account settings page renders.
//
// Secret fields come back MASKED unless `reveal` is set; reveal is for the
// server-side consumers that hand the bytes to something that needs them
// (the device pull, the AI key resolver) and for a signed-in browser's wasm
// preview, never for an API token (app/api/settings/route.ts decides that).
// A legacy plaintext secret found on the way is re-sealed in place, best
// effort — the read must succeed either way.
export async function storedAccountSettings(
  db: ReturnType<typeof createDb>,
  accountId: string,
  options: { reveal?: boolean } = {},
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const opened = openStoredGroup(row.key, row.value, accountId);
    result[row.key] = options.reveal ? opened.revealed : opened.masked;
    if (opened.reseal) {
      try {
        await db
          .update(accountSettings)
          .set({ updatedAt: new Date(), value: opened.reseal })
          .where(
            and(
              eq(accountSettings.accountId, accountId),
              eq(accountSettings.key, row.key),
            ),
          );
      } catch (error) {
        reportError("settings.legacy_secret_reseal_failed", error, {
          accountId,
          key: row.key,
        });
      }
    }
  }
  return result;
}

// One stored group, opened: the revealed and the masked view of it, plus the
// sealed rewrite to persist when it held legacy plaintext. Groups without
// secret fields (ssh_keys, anything unknown) pass through untouched. A
// sealed value that will not open is reported and treated as absent — the
// owner can save a new key; nothing else can be done with it.
function openStoredGroup(
  group: string,
  value: unknown,
  accountId: string,
): { masked: unknown; revealed: unknown; reseal?: Record<string, unknown> } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !storableAccountSettingsFields.has(group)
  ) {
    return { masked: value, revealed: value };
  }
  const masked: Record<string, unknown> = {};
  const revealed: Record<string, unknown> = {};
  let reseal: Record<string, unknown> | undefined;
  for (const [field, fieldValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof fieldValue !== "string" || !isSecretSettingField(group, field)) {
      masked[field] = fieldValue;
      revealed[field] = fieldValue;
      continue;
    }
    let secret: string;
    try {
      secret = openSettingValue(fieldValue);
    } catch (error) {
      reportError("settings.secret_open_failed", error, { accountId, field, group });
      secret = "";
    }
    masked[field] = maskSettingValue(secret);
    revealed[field] = secret;
    if (secret !== "" && !isSealedSettingValue(fieldValue)) {
      reseal ??= { ...(value as Record<string, unknown>) };
      reseal[field] = sealSettingValue(secret);
    }
  }
  return { masked, revealed, ...(reseal ? { reseal } : {}) };
}

// The raw sealed rows, for the write path: a masked value posted back means
// "keep what is stored", and what is stored is the sealed string itself —
// no need to open it just to seal it again.
async function storedRawGroups(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const rows = await db
    .select({ key: accountSettings.key, value: accountSettings.value })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const groups: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (row.value && typeof row.value === "object" && !Array.isArray(row.value)) {
      groups[row.key] = row.value as Record<string, unknown>;
    }
  }
  return groups;
}

// What POST /api/settings writes for a filtered payload. Secret fields are
// sealed; a secret posted as its own mask (the settings forms post the whole
// group back, mask included) keeps the stored value, or is dropped when
// nothing is stored — a mask is never a value. The legacy plaintext case is
// covered too: the stored value is re-sealed on its way back in.
export async function sealAccountSettingsForWrite(
  db: ReturnType<typeof createDb>,
  accountId: string,
  settings: FilteredAccountSettings,
): Promise<FilteredAccountSettings> {
  const stored = await storedRawGroups(db, accountId);
  const sealed: FilteredAccountSettings = {};
  for (const [group, value] of Object.entries(settings)) {
    if (group === "ssh_keys" || !storableAccountSettingsFields.has(group)) {
      sealed[group] = value;
      continue;
    }
    const fields: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(
      value as Record<string, string>,
    )) {
      if (!isSecretSettingField(group, field)) {
        fields[field] = fieldValue;
        continue;
      }
      if (isMaskedSettingValue(fieldValue)) {
        const current = stored[group]?.[field];
        if (typeof current === "string" && current !== "") {
          fields[field] = isSealedSettingValue(current)
            ? current
            : sealSettingValue(current);
        }
        continue;
      }
      fields[field] = sealSettingValue(fieldValue);
    }
    sealed[group] = fields;
  }
  return sealed;
}

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
      if (filtered.keys === undefined) {
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
