import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { confirmed } from "./confirm";
import { run, structured, text, uuid, type ToolContext } from "../result";

// Account-level tools: who am I, how much room is left, the service keys
// scenes use, and the API tokens themselves.

type UsagePayload = {
  account: Record<string, unknown>;
  auth: Record<string, unknown>;
  limits: Record<string, unknown>;
  usage: Record<string, unknown>;
};

const secretField = /(key|token|secret|password)/i;

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "••••";
  }
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

function maskSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [group, value] of Object.entries(settings)) {
    // The named keys (docs/service-keys.md): every value of each is masked
    // the way the cloud masks a credential it has no rule for.
    if (group === "serviceCredentials" && value && typeof value === "object" && !Array.isArray(value)) {
      masked[group] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([id, entry]) => {
          const values = (entry as { values?: unknown } | null)?.values;
          if (!entry || typeof entry !== "object" || !values || typeof values !== "object" || Array.isArray(values)) {
            return [id, entry];
          }
          return [
            id,
            {
              ...(entry as Record<string, unknown>),
              values: Object.fromEntries(
                Object.entries(values as Record<string, unknown>).map(([field, fieldValue]) => [
                  field,
                  typeof fieldValue === "string" && fieldValue && !fieldValue.startsWith("•") && field !== "url"
                    ? maskSecret(fieldValue)
                    : fieldValue,
                ]),
              ),
            },
          ];
        }),
      );
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const fields: Record<string, unknown> = {};
      for (const [field, fieldValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        fields[field] =
          typeof fieldValue === "string" &&
          fieldValue &&
          secretField.test(field)
            ? maskSecret(fieldValue)
            : fieldValue;
      }
      masked[group] = fields;
    } else {
      masked[group] = value;
    }
  }
  return masked;
}

export function registerAccountTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "account_info",
    {
      annotations: { readOnlyHint: true },
      description:
        "Who the current API token belongs to: account id, email, name, superadmin/verified-publisher flags, and whether this token is full or read-only.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const payload = await ctx.client.json<UsagePayload>(
          "GET",
          "/api/account/usage",
        );
        return structured({
          account: payload.account,
          auth: payload.auth,
          cloud_url: ctx.publicOrigin,
          store_url: ctx.storeOrigin,
        });
      }),
  );

  server.registerTool(
    "account_quota",
    {
      annotations: { readOnlyHint: true },
      description:
        "Usage against every account quota (frames, private scene bytes, backups, frame logs) plus the fixed limits the API enforces (scenes per frame, max zip size, scenes per day, AI chat caps, …). Call this before adding a frame or saving a scene when an earlier call was refused with a quota error.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const payload = await ctx.client.json<UsagePayload>(
          "GET",
          "/api/account/usage",
        );
        return structured({ limits: payload.limits, usage: payload.usage });
      }),
  );

  server.registerTool(
    "account_settings_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "Account-level service settings that scenes and the AI use: one group per service holding its default key (openAI: apiKey plus the AI's own backendApiKey, chatModel, chatReasoningEffort; unsplash.accessKey; homeAssistant url + accessToken; immich url + apiKey; github.api_key; frameOS.apiKey; or any other service a scene's apps name), serviceCredentials (the account's further named keys: id → {service, name, values}, which frame_scenes_set / frame_scene_install service_keys can pick per scene), and ssh_keys. Secrets are always masked (`••••••••cdef`): the cloud never reveals a stored key to an API token. account_settings_update can replace a service's default key.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        // The cloud masks secrets for tokens itself; masking again here is
        // belt and braces for a server that predates that.
        const settings = await ctx.client.json<Record<string, unknown>>(
          "GET",
          "/api/settings",
        );
        return text(maskSettings(settings));
      }),
  );

  server.registerTool(
    "account_settings_update",
    {
      annotations: { destructiveHint: false, idempotentHint: true },
      description:
        "Set account-level service settings: a service's default key. Pass only the groups and fields to change, e.g. {\"openAI\": {\"apiKey\": \"sk-…\"}} or {\"unsplash\": {\"accessKey\": \"…\"}}; any service a scene's apps name is a group; other fields in a group are preserved. Cloud-managed frames re-pull the keys automatically.",
      inputSchema: {
        settings: z
          .record(
            // A settings group is a service id (docs/service-keys.md): the
            // backend's settings_update takes the same pattern.
            z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
            z.record(z.string(), z.string()),
          )
          .describe(
            "{group: {field: value}} — a group is a service id (openAI, unsplash, homeAssistant, … or any other service a scene's apps name); string values only; an empty string clears a field.",
          ),
      },
    },
    async ({ settings }) =>
      run(async () => {
        // POST replaces each posted group wholesale, so merge over the
        // current values first: setting one key must not wipe its siblings.
        const current = await ctx.client.json<Record<string, unknown>>(
          "GET",
          "/api/settings",
        );
        const body: Record<string, Record<string, string>> = {};
        for (const [group, fields] of Object.entries(settings)) {
          const existing = current[group];
          const merged: Record<string, string> = {};
          if (existing && typeof existing === "object" && !Array.isArray(existing)) {
            for (const [key, value] of Object.entries(
              existing as Record<string, unknown>,
            )) {
              if (typeof value === "string") {
                merged[key] = value;
              }
            }
          }
          Object.assign(merged, fields);
          body[group] = merged;
        }
        const updated = await ctx.client.json<Record<string, unknown>>(
          "POST",
          "/api/settings",
          { body },
        );
        return text({
          settings: maskSettings(updated),
          status: "updated",
          updated_groups: Object.keys(body),
        });
      }),
  );

  server.registerTool(
    "api_tokens_list",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the account's personal API tokens (name, hint, access, last use, expiry). Secrets are never returned; new tokens are created in the browser on the frames workspace's Developer page (/account/developer).",
      inputSchema: {},
    },
    async () =>
      run(async () =>
        text(await ctx.client.json("GET", "/api/account/api-tokens")),
      ),
  );

  server.registerTool(
    "api_token_revoke",
    {
      annotations: { destructiveHint: true },
      description:
        "Revoke a personal API token by id. Revoking the token this session uses ends the session on the next call — do that if you believe it leaked.",
      inputSchema: {
        confirm: confirmed("revokes a credential"),
        token_id: uuid(),
      },
    },
    async ({ token_id }) =>
      run(async () =>
        text(
          await ctx.client.json(
            "DELETE",
            `/api/account/api-tokens/${token_id}`,
          ),
        ),
      ),
  );
}
