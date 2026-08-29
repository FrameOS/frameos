// The cloud's walker of the verb contract (docs/cloud-frames-contract.json →
// cloud-frames-contract.gen.ts). The Linux runtime (frameos/cloud/contract.nim)
// and the ESP32 firmware (fos_cloud_contract.c) walk the same tables; the
// conformance corpus docs/cloud-frames-fixtures.json pins all three to one
// verdict per case, so a rule can no longer be declared three times and
// drift.
import { cloudFramesContract } from "./cloud-frames-contract.gen";

export type ContractProfile = (typeof cloudFramesContract.profiles)[number];
export type ContractSettingKey = keyof typeof cloudFramesContract.settings;

// The rule language, structurally (the generated table is `as const`; this is
// what the walker reads it as).
export interface ContractRule {
  type?: "bool" | "int" | "number" | "string" | "object" | "array" | "map" | "null";
  anyOf?: readonly ContractRule[];
  min?: number;
  max?: number;
  enum?: readonly (string | number)[];
  minLen?: number;
  maxLen?: number;
  format?: "iana_zone" | "html_hex_color" | "gpio_label";
  keys?: Readonly<Record<string, ContractRule>>;
  required?: readonly string[];
  minKeys?: number;
  open?: boolean;
  items?: ContractRule;
  maxItems?: number;
  values?: ContractRule;
  maxEntries?: number;
  keyMinLen?: number;
  keyMaxLen?: number;
}

interface ProfileSpec {
  since: string | null;
  restart?: boolean;
  rule?: ContractRule;
}

interface SettingSpec {
  rule: ContractRule;
  companion?: string;
  extraChecks?: readonly string[];
  profiles: Partial<Record<ContractProfile, ProfileSpec>>;
}

const settings = cloudFramesContract.settings as Readonly<Record<string, SettingSpec>>;

export const contractProfiles: readonly ContractProfile[] = cloudFramesContract.profiles;

// ------------------------------------------------------------- formats

const ianaZone = new RegExp(cloudFramesContract.formats.iana_zone);
const htmlHexColor = new RegExp(cloudFramesContract.formats.html_hex_color);

function matchesFormat(format: ContractRule["format"], value: string): boolean {
  switch (format) {
    case "iana_zone":
      return ianaZone.test(value);
    case "html_hex_color":
      return htmlHexColor.test(value);
    case "gpio_label": {
      // 1..32 characters after trimming, no ':' (the firmware's spec
      // separator) and no newline.
      const trimmed = value.trim();
      return trimmed.length >= 1 && trimmed.length <= 32 && !value.includes(":") && !value.includes("\n");
    }
    default:
      return true;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ------------------------------------------------------------- the walker

export function validateContractRule(rule: ContractRule, value: unknown): boolean {
  if (rule.anyOf) {
    return rule.anyOf.some((alternative) => validateContractRule(alternative, value));
  }
  switch (rule.type) {
    case "bool":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
      if (rule.min !== undefined && value < rule.min) return false;
      if (rule.max !== undefined && value > rule.max) return false;
      if (rule.enum && !rule.enum.includes(value)) return false;
      return true;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (rule.min !== undefined && value < rule.min) return false;
      if (rule.max !== undefined && value > rule.max) return false;
      return true;
    case "string":
      if (typeof value !== "string") return false;
      if (rule.minLen !== undefined && value.length < rule.minLen) return false;
      if (rule.maxLen !== undefined && value.length > rule.maxLen) return false;
      if (rule.enum && !rule.enum.includes(value)) return false;
      return matchesFormat(rule.format, value);
    case "object": {
      if (!isPlainRecord(value)) return false;
      const entries = Object.entries(value);
      if (rule.minKeys !== undefined && entries.length < rule.minKeys) return false;
      for (const [key, entry] of entries) {
        // Own keys only: a prototype key ("toString") is not a setting.
        const sub = rule.keys && Object.prototype.hasOwnProperty.call(rule.keys, key) ? rule.keys[key] : undefined;
        if (sub) {
          if (!validateContractRule(sub, entry)) return false;
        } else if (!rule.open) {
          return false;
        }
      }
      for (const required of rule.required ?? []) {
        if (!(required in value)) return false;
      }
      return true;
    }
    case "array":
      if (!Array.isArray(value)) return false;
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return false;
      return value.every((item) => validateContractRule(rule.items!, item));
    case "map": {
      if (!isPlainRecord(value)) return false;
      const entries = Object.entries(value);
      if (rule.maxEntries !== undefined && entries.length > rule.maxEntries) return false;
      return entries.every(
        ([key, entry]) =>
          (rule.keyMinLen === undefined || key.length >= rule.keyMinLen) &&
          (rule.keyMaxLen === undefined || key.length <= rule.keyMaxLen) &&
          validateContractRule(rule.values!, entry),
      );
    }
    default:
      return false;
  }
}

// The contract's `extraChecks`: cross-field rules the language does not
// express, implemented by hand in every walker and pinned by the fixtures.
function extraChecks(key: string, value: unknown): boolean {
  switch (key) {
    case "palette": {
      const palette = value as { colors?: unknown[]; colorNames?: unknown[] };
      return palette.colorNames === undefined || palette.colorNames.length === (palette.colors?.length ?? -1);
    }
    case "gpio_buttons": {
      const pins = new Set<number>();
      for (const button of value as { pin: number }[]) {
        if (pins.has(button.pin)) return false;
        pins.add(button.pin);
      }
      return true;
    }
    default:
      return true;
  }
}

function spec(key: string): SettingSpec | undefined {
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : undefined;
}

/** The rule `profile` applies to `key`, or undefined when the profile does not take the key. */
export function contractSettingRule(key: string, profile: ContractProfile): ContractRule | undefined {
  const setting = spec(key);
  const p = setting?.profiles[profile];
  if (!setting || !p) return undefined;
  return p.rule ?? setting.rule;
}

/**
 * The first firmware version of `profile` that knows `key`: null for every
 * version, undefined when the profile does not take the key at all.
 */
export function contractSettingSince(key: string, profile: ContractProfile): string | null | undefined {
  return spec(key)?.profiles[profile]?.since;
}

/** Applying `key` on `profile` restarts the runtime / reboots the chip. */
export function contractSettingRestarts(key: string, profile: ContractProfile): boolean {
  return Boolean(spec(key)?.profiles[profile]?.restart);
}

/** A key that only rides next to another one (the ESP32's tzdata slice next to `timezone`). */
export function contractSettingCompanion(key: string): string | undefined {
  return spec(key)?.companion;
}

/**
 * The keys `profile` takes, in contract order. Companion keys are left out
 * unless asked for: the cloud attaches those itself (frameSettingsDevicePayload),
 * a client never sends them.
 */
export function contractSettingKeys(profile: ContractProfile, options: { companions?: boolean } = {}): string[] {
  return Object.entries(settings)
    .filter(([, s]) => s.profiles[profile] && (options.companions || !s.companion))
    .map(([key]) => key);
}

/** The keys `profile` learned at exactly firmware version `since` (null = the base set). */
export function contractSettingKeysSince(profile: ContractProfile, since: string | null): string[] {
  return contractSettingKeys(profile).filter((key) => contractSettingSince(key, profile) === since);
}

/** Every key any profile takes (companions excluded). */
export function allContractSettingKeys(): string[] {
  return Object.entries(settings)
    .filter(([, s]) => !s.companion)
    .map(([key]) => key);
}

/**
 * Is `value` acceptable for `key`? With a profile, that profile's rule; without
 * one, any profile's — what a client-facing validator wants before it knows
 * which device the push is for.
 */
export function validateContractSetting(key: string, value: unknown, profile?: ContractProfile): boolean {
  const profiles = profile ? [profile] : contractProfiles;
  return profiles.some((p) => {
    const rule = contractSettingRule(key, p);
    return rule !== undefined && validateContractRule(rule, value) && extraChecks(key, value);
  });
}

/**
 * The whole-push verdict a device of `profile` gives a `set_settings` object:
 * null when every key is allowed and valid, otherwise the error token it acks
 * — one unknown key or one bad value refuses the whole push, so provider and
 * device never disagree about what got set.
 */
export function checkContractSettings(value: unknown, profile: ContractProfile): string | null {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) return "invalid_settings";
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!spec(key)?.profiles[profile]) return "setting_not_allowed";
  }
  for (const key of keys) {
    if (!validateContractSetting(key, value[key], profile)) return "invalid_settings";
    const companion = contractSettingCompanion(key);
    if (companion && !(companion in value)) return "invalid_settings";
  }
  return null;
}

export const contractVerbs = cloudFramesContract.verbs;

export function contractLimit(name: keyof typeof cloudFramesContract.limits, profile: ContractProfile): number {
  return cloudFramesContract.limits[name][profile];
}
