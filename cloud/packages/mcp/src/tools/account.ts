import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
        "Account-level service settings that scenes and the AI use: openAI (apiKey, backendApiKey, chatModel, chatReasoningEffort), unsplash.accessKey, homeAssistant (url, accessToken), immich (url, apiKey), github.api_key, frameOS.apiKey, ssh_keys. Secrets are masked unless reveal=true.",
      inputSchema: {
        reveal: z
          .boolean()
          .optional()
          .describe("Return secret values in the clear (default false)."),
      },
    },
    async ({ reveal }) =>
      run(async () => {
        const settings = await ctx.client.json<Record<string, unknown>>(
          "GET",
          "/api/settings",
        );
        return text(reveal ? settings : maskSettings(settings));
      }),
  );

  server.registerTool(
    "account_settings_update",
    {
      annotations: { destructiveHint: false, idempotentHint: true },
      description:
        "Set account-level service settings. Pass only the groups and fields to change, e.g. {\"openAI\": {\"apiKey\": \"sk-…\"}} or {\"unsplash\": {\"accessKey\": \"…\"}}; other fields in a group are preserved. Cloud-managed frames re-pull the keys automatically.",
      inputSchema: {
        settings: z
          .record(z.string(), z.record(z.string(), z.string()))
          .describe("{group: {field: value}} — string values only; an empty string clears a field."),
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
        "List the account's personal API tokens (name, hint, access, last use, expiry). Secrets are never returned; new tokens are created in the browser at /account/developer.",
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
