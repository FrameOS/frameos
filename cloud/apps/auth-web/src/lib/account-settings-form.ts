// What the account settings page (app/account/settings) edits, as data the
// server page and the client components share. No React, no database: the
// page reads the stored settings server-side and hands the components the
// shapes built here; the components post to /api/settings and rebuild the
// same shapes from its response.
//
// The group and field names are the storable ones (account-settings.ts —
// AccountSettingsForm.test.tsx checks they stay a subset). The wire contract
// is the backend's: GET /api/settings is the merged {group: {field: value}}
// object, POST replaces every posted group WHOLESALE, so a group is always
// sent with all of its fields and an empty string clears a key.

export interface ServiceFieldSpec {
  name: string;
  label: string;
  /** Rendered as a password input: the value is an API key or token. */
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  /** Behind the group's "Show model settings" disclosure. */
  advanced?: boolean;
  options?: { value: string; label: string }[];
}

export interface ServiceGroupSpec {
  /** The settings group — the key in the /api/settings object. */
  key: string;
  /** Anchor the scene editors link to (#settings-openai). */
  id: string;
  title: string;
  intro?: string;
  /** Text after `intro`, linked. */
  introLink?: { href: string; label: string; after: string };
  fields: ServiceFieldSpec[];
}

export const serviceSettingsGroups: readonly ServiceGroupSpec[] = [
  {
    key: "frameOS",
    id: "settings-gallery",
    title: "FrameOS Gallery",
    introLink: {
      href: "https://gallery.frameos.net/",
      label: "Premium AI slop",
      after: " to get you started.",
    },
    fields: [
      {
        name: "apiKey",
        label: "API key",
        secret: true,
        hint: "Just use 2024 for now. We might add custom accounts in the future.",
      },
    ],
  },
  {
    key: "openAI",
    id: "settings-openai",
    title: "OpenAI",
    intro:
      "The key for frames is used by the OpenAI apps on your frames. The AI chat key powers scene chat in the workspace; it stays on your account and is never sent to a frame.",
    fields: [
      { name: "apiKey", label: "API key for frames", secret: true },
      { name: "backendApiKey", label: "API key for AI chat", secret: true },
      {
        name: "chatModel",
        label: "Chat model",
        placeholder: "gpt-5.6-terra",
        hint: "The OpenAI model the workspace chat runs on. Leave empty for the default.",
        advanced: true,
      },
      {
        name: "chatReasoningEffort",
        label: "Reasoning effort",
        hint: "How much the model thinks before answering. Higher is slower and costs more; it mostly pays off on complex scene builds. Ignored by models without reasoning.",
        advanced: true,
        options: [
          { value: "", label: "Default (low)" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
    ],
  },
  {
    key: "homeAssistant",
    id: "settings-home-assistant",
    title: "Home Assistant",
    fields: [
      { name: "url", label: "Server URL", placeholder: "http://homeassistant.local:8123" },
      {
        name: "accessToken",
        label: "Access token (Profile → Long-lived access tokens)",
        secret: true,
      },
    ],
  },
  {
    key: "github",
    id: "settings-github",
    title: "GitHub",
    fields: [{ name: "api_key", label: "API key", secret: true }],
  },
  {
    key: "immich",
    id: "settings-immich",
    title: "Immich",
    fields: [
      { name: "url", label: "Server URL", placeholder: "https://immich.example.com" },
      { name: "apiKey", label: "API key (Account settings → API keys)", secret: true },
    ],
  },
  {
    key: "unsplash",
    id: "settings-unsplash",
    title: "Unsplash API",
    fields: [{ name: "accessKey", label: "Access key", secret: true }],
  },
];

/** {group: {field: value}} — every group with every field, '' when unset. */
export type ServiceSettingsValues = Record<string, Record<string, string>>;

export function serviceSettingsFrom(
  stored: Record<string, unknown> | undefined,
): ServiceSettingsValues {
  const values: ServiceSettingsValues = {};
  for (const group of serviceSettingsGroups) {
    const raw = stored?.[group.key];
    const source =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    values[group.key] = Object.fromEntries(
      group.fields.map((field) => {
        const value = source[field.name];
        return [field.name, typeof value === "string" ? value : ""];
      }),
    );
  }
  return values;
}

export interface SshKeyEntry {
  id: string;
  name: string;
  public: string;
  use_for_new_frames: boolean;
}

/** The `ssh_keys` group as the page shows it; anything malformed is skipped. */
export function sshKeysFrom(
  stored: Record<string, unknown> | undefined,
): SshKeyEntry[] {
  const group = stored?.ssh_keys;
  const raw =
    group && typeof group === "object" && !Array.isArray(group)
      ? (group as { keys?: unknown }).keys
      : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const keys: SshKeyEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const { id, name, public: publicKey, use_for_new_frames } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof publicKey !== "string" || !publicKey) {
      continue;
    }
    keys.push({
      id,
      name: typeof name === "string" ? name : "",
      public: publicKey,
      use_for_new_frames: use_for_new_frames === true,
    });
  }
  return keys;
}

/** "ed25519 · …3kQd · you@laptop" — enough to tell two keys apart in a list. */
export function describeSshPublicKey(line: string): string {
  const [type, base64, ...rest] = line.trim().split(/\s+/);
  if (!type || !base64) {
    return "no public key";
  }
  const kind = type
    .replace(/^ssh-|^sk-ssh-|@openssh\.com$/g, "")
    .replace("ecdsa-sha2-", "ecdsa ");
  const tail = base64.replace(/=+$/, "").slice(-8);
  const comment = rest.join(" ");
  return comment ? `${kind} · …${tail} · ${comment}` : `${kind} · …${tail}`;
}

/** What to tell the user when /api/settings refuses a save. */
export function describeSettingsError(
  status: number,
  error: string | undefined,
): string {
  switch (error) {
    case "invalid_ssh_key":
      return "That is not an OpenSSH public key. It looks like: ssh-ed25519 AAAA… you@laptop";
    case "invalid_settings":
      return "That could not be saved as it is. Check the values and try again.";
    case "settings_value_too_large":
      return "One of the values is too long to be a key or a URL.";
    case "login_required":
      return "Your session expired. Reload the page and sign in again.";
    default:
      return status === 429
        ? "Too many attempts. Wait a few minutes and try again."
        : "Something went wrong. Try again in a moment.";
  }
}
