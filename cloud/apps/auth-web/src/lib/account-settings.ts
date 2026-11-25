// Which account-level settings the cloud persists (the account_settings
// table), and with which fields (docs/service-keys.md "Keys on the control
// plane"). Any SERVICE is storable: the default key of a service is the
// group named after it (openAI{apiKey}, …, or any id an app gives a service
// the registry does not know), and every further key lives in the one
// `serviceCredentials` group. A registered service stores its registry
// fields (repo/services.json) plus the plane's own extras (openAI's chat
// model and backend key); an unregistered one any field. Everything else the
// shared settings form knows (build environment, deploy defaults, PostHog,
// ...) is backend-only and never reaches the database here; SSH keys keep
// their own shape.

import { and, eq, sql } from "drizzle-orm";
import { accountSettings, type createDb } from "@frameos-cloud/db";
import { reportError } from "./log";
import {
  CREDENTIAL_ID_PATTERN,
  isServiceId,
  registeredService,
  SERVICE_CREDENTIALS_GROUP,
  SERVICE_FIELD_PATTERN,
  serviceFieldSecrecy,
} from "../../../../../frontend/src/utils/serviceKeys";
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

// The plane's own fields inside a service's group: storable on the account,
// never sent to a frame (deliverableServiceValues keeps a registered
// service's registry fields alone). The account's OpenAI key and model
// tuning for the workspace's AI chat.
const planeServiceFields: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["openAI", new Set(["backendApiKey", "chatModel", "chatReasoningEffort"])],
]);

// Which of the plane's own fields are NOT secrets: model tuning. A field the
// registry describes says so itself (serviceFieldSecrecy); every other
// storable field is a credential and is sealed, so a new key added to a group
// is sealed unless somebody says otherwise (a test pins the resulting list).
const plainPlaneServiceFields: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["openAI", new Set(["chatModel", "chatReasoningEffort"])],
]);

/** Whether `group.field` is something an account stores: a service's field
 * (a registered one's registry fields and the plane's own, any field of an
 * unregistered one). */
// A name Object.prototype already has (toString, constructor, …) is never a
// group or a field here: such a key would read as something truthy from any
// plain object that lacks it (the trap allowedFrameSettings in frames.ts
// documents).
function isPrototypeName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

/** A group an account may keep a service's default key in. */
export function isStorableServiceGroup(group: string): boolean {
  return isServiceId(group) && !isPrototypeName(group);
}

export function isStorableServiceField(group: string, field: string): boolean {
  if (!isStorableServiceGroup(group) || !SERVICE_FIELD_PATTERN.test(field) || isPrototypeName(field)) {
    return false;
  }
  const registered = registeredService(group);
  if (!registered) {
    return true;
  }
  return (
    registered.fields.some((known) => known.name === field) ||
    planeServiceFields.get(group)?.has(field) === true
  );
}

export function isSecretSettingField(group: string, field: string): boolean {
  if (!isStorableServiceField(group, field)) {
    return false;
  }
  return serviceFieldSecrecy(group, field) ?? !plainPlaneServiceFields.get(group)?.has(field);
}

// A named key's values: a registered service's registry fields, any field
// of an unregistered one — never the plane's own (a named key is for frames).
function isCredentialField(service: string, field: string): boolean {
  if (!isStorableServiceField(service, field)) {
    return false;
  }
  return registeredService(service) ? planeServiceFields.get(service)?.has(field) !== true : true;
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

/**
 * The account's service keys with their secrets opened: every service group
 * narrowed to {field: string}, and `serviceCredentials` (the named keys) as
 * stored. For the consumers the keys are for: a frame's service-settings
 * pull, the hub rendering a virtual frame (which is that frame's device), a
 * server render, the voice chat's show_image. buildServiceSettingsPayload
 * filters it again against what a device may receive and what each scene
 * was bound to.
 */
export async function revealedServiceSettings(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<Record<string, unknown>> {
  const revealed = await storedAccountSettings(db, accountId, { reveal: true });
  const stored: Record<string, unknown> = {};
  for (const [group, value] of Object.entries(revealed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if (group === SERVICE_CREDENTIALS_GROUP) {
      stored[group] = value;
      continue;
    }
    if (!isStorableServiceGroup(group)) {
      continue;
    }
    const fields: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof fieldValue === "string") {
        fields[field] = fieldValue;
      }
    }
    stored[group] = fields;
  }
  return stored;
}

// The one-off sweep behind scripts/reseal-account-settings.ts: every row that
// still holds a legacy plaintext secret, re-sealed — what the read above does
// lazily, for the rows nobody reads (an account that never opens its
// settings again keeps its plaintext key until then). Returns the rows it
// found; writes only with `apply`. A row someone saved since it was read is
// left to that save, which seals on its own.
export async function resealLegacyAccountSettings(
  db: ReturnType<typeof createDb>,
  options: { apply: boolean },
): Promise<{ accountId: string; key: string }[]> {
  const rows = await db.select().from(accountSettings);
  const found: { accountId: string; key: string }[] = [];
  for (const row of rows) {
    const opened = openStoredGroup(row.key, row.value, row.accountId);
    if (!opened.reseal) {
      continue;
    }
    found.push({ accountId: row.accountId, key: row.key });
    if (options.apply) {
      await db
        .update(accountSettings)
        .set({ updatedAt: new Date(), value: opened.reseal })
        .where(
          and(
            eq(accountSettings.id, row.id),
            sql`${accountSettings.value} = ${JSON.stringify(row.value)}::jsonb`,
          ),
        );
    }
  }
  return found;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { masked: value, revealed: value };
  }
  if (group === SERVICE_CREDENTIALS_GROUP) {
    return openStoredCredentials(value as Record<string, unknown>, accountId);
  }
  if (!isStorableServiceGroup(group)) {
    return { masked: value, revealed: value };
  }
  return openStoredFields(group, value as Record<string, unknown>, accountId);
}

// `serviceCredentials`: each named key's values opened by the rule of its
// service, the rest of the entry (service, name) as it is.
function openStoredCredentials(
  value: Record<string, unknown>,
  accountId: string,
): { masked: unknown; revealed: unknown; reseal?: Record<string, unknown> } {
  const masked: Record<string, unknown> = {};
  const revealed: Record<string, unknown> = {};
  let reseal: Record<string, unknown> | undefined;
  for (const [id, entry] of Object.entries(value)) {
    const record =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : undefined;
    const values = record?.values;
    if (
      !record ||
      typeof record.service !== "string" ||
      !values ||
      typeof values !== "object" ||
      Array.isArray(values)
    ) {
      masked[id] = entry;
      revealed[id] = entry;
      continue;
    }
    const opened = openStoredFields(record.service, values as Record<string, unknown>, accountId);
    masked[id] = { ...record, values: opened.masked };
    revealed[id] = { ...record, values: opened.revealed };
    if (opened.reseal) {
      reseal ??= { ...value };
      reseal[id] = { ...record, values: opened.reseal };
    }
  }
  return { masked, revealed, ...(reseal ? { reseal } : {}) };
}

function openStoredFields(
  group: string,
  value: Record<string, unknown>,
  accountId: string,
): { masked: unknown; revealed: unknown; reseal?: Record<string, unknown> } {
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
    if (group === SERVICE_CREDENTIALS_GROUP) {
      const credentials: Record<string, StoredServiceCredential> = {};
      const storedCredentials = stored[group] ?? {};
      for (const [id, credential] of Object.entries(value as Record<string, StoredServiceCredential>)) {
        const current = storedCredentials[id];
        const currentValues =
          current && typeof current === "object" && !Array.isArray(current) &&
          (current as Record<string, unknown>).service === credential.service
            ? (current as Record<string, unknown>).values
            : undefined;
        credentials[id] = {
          ...credential,
          values: sealFields(
            credential.service,
            credential.values,
            currentValues && typeof currentValues === "object" && !Array.isArray(currentValues)
              ? (currentValues as Record<string, unknown>)
              : {},
          ),
        };
      }
      sealed[group] = credentials;
      continue;
    }
    if (group === "ssh_keys" || !isStorableServiceGroup(group)) {
      sealed[group] = value;
      continue;
    }
    sealed[group] = sealFields(group, value as Record<string, string>, stored[group] ?? {});
  }
  return sealed;
}

// One group's (or one named key's) fields for writing: secrets sealed, a
// posted mask resolved to what `current` holds for that field (or dropped).
function sealFields(
  group: string,
  value: Record<string, string>,
  current: Record<string, unknown>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!isSecretSettingField(group, field)) {
      fields[field] = fieldValue;
      continue;
    }
    if (isMaskedSettingValue(fieldValue)) {
      const kept = current[field];
      if (typeof kept === "string" && kept !== "") {
        fields[field] = isSealedSettingValue(kept) ? kept : sealSettingValue(kept);
      }
      continue;
    }
    fields[field] = sealSettingValue(fieldValue);
  }
  return fields;
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

// Bounds that stop a body from carrying a novel: services an account keeps
// keys for, fields in one, named keys in all.
export const maxAccountServiceGroups = 100;
export const maxServiceFields = 32;
export const maxServiceCredentials = 100;
const maxCredentialNameLength = 120;

export interface StoredServiceCredential {
  service: string;
  name: string;
  values: Record<string, string>;
}

export type FilteredAccountSettings = Record<
  string,
  | Record<string, string>
  | { keys: StoredSshKey[] }
  | Record<string, StoredServiceCredential>
>;

// One service's fields from a body: storable ones only, each a bounded
// string; anything else in a storable field is refused whole.
function filterServiceFields(
  group: string,
  value: Record<string, unknown>,
  allowed: (group: string, field: string) => boolean,
): { error?: undefined; fields: Record<string, string> } | { error: string; fields?: undefined } {
  const fields: Record<string, string> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!allowed(group, field)) {
      continue;
    }
    if (typeof fieldValue !== "string") {
      return { error: "invalid_settings" };
    }
    if (fieldValue.length > maxAccountSettingValueLength) {
      return { error: "settings_value_too_large" };
    }
    fields[field] = fieldValue;
  }
  if (Object.keys(fields).length > maxServiceFields) {
    return { error: "invalid_settings" };
  }
  return { fields };
}

// The `serviceCredentials` group from a body: id → {service, name, values},
// ids as the SPA makes them (k_…), a name, a service id, its values.
export function filterServiceCredentials(
  value: unknown,
):
  | { error?: undefined; credentials: Record<string, StoredServiceCredential> }
  | { error: string; credentials?: undefined } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_settings" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxServiceCredentials) {
    return { error: "invalid_settings" };
  }
  const credentials: Record<string, StoredServiceCredential> = {};
  for (const [id, entry] of entries) {
    if (!CREDENTIAL_ID_PATTERN.test(id) || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "invalid_settings" };
    }
    const { name, service, values } = entry as Record<string, unknown>;
    if (
      typeof service !== "string" ||
      !isStorableServiceGroup(service) ||
      (name !== undefined && typeof name !== "string")
    ) {
      return { error: "invalid_settings" };
    }
    if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values))) {
      return { error: "invalid_settings" };
    }
    const filtered = filterServiceFields(service, (values ?? {}) as Record<string, unknown>, isCredentialField);
    if (filtered.fields === undefined) {
      return { error: filtered.error };
    }
    credentials[id] = {
      name: (typeof name === "string" && name.trim() ? name.trim() : id).slice(0, maxCredentialNameLength),
      service,
      values: filtered.fields,
    };
  }
  return { credentials };
}

// Reduce a settings POST body to what the account may store.
//
// Groups that are no service are filtered, not refused: the shared settings
// form submits its whole form object — backend-only groups (defaults,
// buildEnvironment, posthog, personal, ...) included — so refusing the
// payload over them would break Save on the cloud outright. Fields a
// registered service does not have are filtered for the same reason. Actual
// bad data in a storable field (a non-string, an oversized value) is refused
// whole — a partial apply would leave the form and the database disagreeing
// about what was saved. A group named like a service but not an object is
// only an error for a registered service: anything else may be some form's
// own bookkeeping.
export function filterAccountSettings(payload: Record<string, unknown>):
  | { error?: undefined; settings: FilteredAccountSettings }
  | { error: string; settings?: undefined } {
  const settings: FilteredAccountSettings = {};
  let serviceGroups = 0;
  for (const [group, value] of Object.entries(payload)) {
    if (group === "ssh_keys") {
      const filtered = filterAccountSshKeys(value);
      if (filtered.keys === undefined) {
        return { error: filtered.error };
      }
      settings.ssh_keys = { keys: filtered.keys };
      continue;
    }
    if (group === SERVICE_CREDENTIALS_GROUP) {
      const filtered = filterServiceCredentials(value);
      if (filtered.credentials === undefined) {
        return { error: filtered.error };
      }
      settings[group] = filtered.credentials;
      continue;
    }
    if (!isStorableServiceGroup(group)) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (registeredService(group)) {
        return { error: "invalid_settings" };
      }
      continue;
    }
    const filtered = filterServiceFields(group, value as Record<string, unknown>, isStorableServiceField);
    if (filtered.fields === undefined) {
      return { error: filtered.error };
    }
    // Present means "replace this group wholesale" (the backend's POST
    // /api/settings semantics) — an empty object clears the group's fields.
    settings[group] = filtered.fields;
    serviceGroups += 1;
    if (serviceGroups > maxAccountServiceGroups) {
      return { error: "invalid_settings" };
    }
  }
  return { settings };
}
