import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountApiTokens,
  accountSettings,
  auditEvents,
  createDb,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as getSettings,
  POST as postSettings,
} from "../../../app/api/settings/route";
import {
  isSealedSettingValue,
  maxAccountSettingValueLength,
} from "../../lib/account-settings";
import { mintApiToken } from "../../lib/api-tokens";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());
const requestHeaders = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(Object.fromEntries(requestHeaders)),
}));

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  requestHeaders.clear();
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
});

function getRequest(query = "") {
  return new NextRequest(new URL(`/api/settings${query}`, baseUrl), {
    method: "GET",
  });
}

// Swap the cookie for a personal API token (full or read-only) so the token
// is the only credential on later requests.
async function useApiToken(accountId: string, access: "full" | "read_only") {
  const minted = mintApiToken(access);
  await db.insert(accountApiTokens).values({
    access,
    accountId,
    name: access,
    tokenHash: minted.tokenHash,
    tokenHint: minted.hint,
  });
  cookieJar.clear();
  requestHeaders.set("authorization", `Bearer ${minted.token}`);
}

function postRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = { origin: baseUrl },
) {
  return new NextRequest(new URL("/api/settings", baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `settings-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Settings User ${userCounter}`,
    email: `settings-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    providerIssuer: issuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

describe("account settings API", () => {
  it("requires a session for GET and POST, and an app origin for POST", async () => {
    const anonymousGet = await getSettings(getRequest());
    expect(anonymousGet.status).toBe(401);

    // CSRF first, exactly like the other mutating routes: a cross-site POST
    // is refused before the session is even consulted.
    await signIn();
    const badOrigin = await postSettings(
      postRequest(
        { openAI: { apiKey: "sk" } },
        { origin: "https://evil.example" },
      ),
    );
    expect(badOrigin.status).toBe(403);

    cookieJar.clear();
    const anonymousPost = await postSettings(
      postRequest({ openAI: { apiKey: "sk" } }),
    );
    expect(anonymousPost.status).toBe(401);
  });

  it("persists the storable groups, filters the rest, and echoes the merge", async () => {
    const accountId = await signIn();

    // What the shared SPA's Save actually sends: the WHOLE settings form,
    // backend-only groups and fields included.
    const response = await postSettings(
      postRequest({
        buildEnvironment: { provider: "docker" },
        defaults: { timezone: "UTC" },
        frameOS: { apiKey: "2024" },
        homeAssistant: {
          accessToken: "ha-token",
          syncEnabled: true,
          url: "http://ha.local:8123",
        },
        openAI: { apiKey: "sk-frames", backendApiKey: "sk-backend" },
        posthog: { backendApiKey: "phc" },
        ssh_keys: { keys: [] },
      }),
    );
    expect(response.status).toBe(200);
    const saved = (await response.json()) as Record<string, unknown>;
    // The POST answers with the same merged {group: value} object GET serves
    // (the backend contract settingsLogic resets its form from) — with every
    // secret MASKED: the tail when the key is long enough to spare it, and
    // bullets alone otherwise. URLs are not secrets.
    expect(saved).toEqual({
      frameOS: { apiKey: "••••••••" },
      homeAssistant: { accessToken: "••••••••", url: "http://ha.local:8123" },
      // backendApiKey is the account's own AI-chat key: storable, but never
      // device-deliverable (frame-service-settings.ts).
      openAI: { apiKey: "••••••••ames", backendApiKey: "••••••••kend" },
      // The account's SSH public keys (SD card builder): the one stored
      // group that is not a service key — an empty list is a valid save.
      ssh_keys: { keys: [] },
    });

    const roundTrip = await getSettings(getRequest());
    expect(roundTrip.status).toBe(200);
    expect(await roundTrip.json()).toEqual(saved);

    // A browser session may ask for the real values (the wasm preview runs
    // the scene in the browser and needs them).
    const revealed = await getSettings(getRequest("?reveal=1"));
    expect(await revealed.json()).toEqual({
      frameOS: { apiKey: "2024" },
      homeAssistant: { accessToken: "ha-token", url: "http://ha.local:8123" },
      openAI: { apiKey: "sk-frames", backendApiKey: "sk-backend" },
      ssh_keys: { keys: [] },
    });

    // One row per group, none for the filtered scaffolding — and no key in
    // the clear anywhere in the table: every secret is sealed, the URL is
    // not.
    const rows = await db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(rows.map((row) => row.key).sort()).toEqual([
      "frameOS",
      "homeAssistant",
      "openAI",
      "ssh_keys",
    ]);
    const stored = JSON.stringify(rows.map((row) => row.value));
    for (const secret of ["2024", "ha-token", "sk-frames", "sk-backend"]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).toContain("http://ha.local:8123");
    const openAiRow = rows.find((row) => row.key === "openAI")?.value as {
      apiKey: string;
      backendApiKey: string;
    };
    expect(isSealedSettingValue(openAiRow.apiKey)).toBe(true);
    expect(isSealedSettingValue(openAiRow.backendApiKey)).toBe(true);

    // The audit trail records WHICH groups changed, never the key values.
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountId));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("account.settings_updated");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("sk-frames");
    expect(
      ((events[0]?.metadata as { keys: string[] }).keys ?? []).sort(),
    ).toEqual(["frameOS", "homeAssistant", "openAI", "ssh_keys"]);
  });

  it("replaces each posted group wholesale (the backend's POST semantics)", async () => {
    await signIn();
    await postSettings(
      postRequest({
        homeAssistant: { accessToken: "token", url: "http://ha.local:8123" },
        unsplash: { accessKey: "u-key" },
      }),
    );

    // Posting homeAssistant WITHOUT accessToken drops the token; the
    // untouched unsplash group survives.
    const response = await postSettings(
      postRequest({ homeAssistant: { url: "http://other.local" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      homeAssistant: { url: "http://other.local" },
      unsplash: { accessKey: "••••••••" },
    });
  });

  it("keeps a stored key when its mask is posted back, and drops a mask with nothing behind it", async () => {
    await signIn();
    await postSettings(
      postRequest({
        openAI: { apiKey: "sk-1234567890abcdef", chatModel: "gpt-5.5" },
      }),
    );

    // What every settings form does: it got the mask from GET and posts the
    // whole group back — the mask for the untouched key, a real value for
    // the changed one, and a mask for a key that was never set.
    const response = await postSettings(
      postRequest({
        openAI: {
          apiKey: "••••••••cdef",
          backendApiKey: "••••••••",
          chatModel: "gpt-5.6",
        },
        unsplash: { accessKey: "u-1234567890" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      openAI: { apiKey: "••••••••cdef", chatModel: "gpt-5.6" },
      unsplash: { accessKey: "••••••••7890" },
    });
    expect(await (await getSettings(getRequest("?reveal=1"))).json()).toEqual({
      openAI: { apiKey: "sk-1234567890abcdef", chatModel: "gpt-5.6" },
      unsplash: { accessKey: "u-1234567890" },
    });

    // Typing over the mask replaces the key; clearing the field removes it.
    await postSettings(
      postRequest({ openAI: { apiKey: "sk-replaced-0000", chatModel: "" } }),
    );
    expect(await (await getSettings(getRequest("?reveal=1"))).json()).toEqual({
      openAI: { apiKey: "sk-replaced-0000", chatModel: "" },
      unsplash: { accessKey: "u-1234567890" },
    });
    await postSettings(postRequest({ openAI: { apiKey: "" } }));
    expect(await (await getSettings(getRequest("?reveal=1"))).json()).toEqual({
      openAI: { apiKey: "" },
      unsplash: { accessKey: "u-1234567890" },
    });
  });

  it("never reveals a stored key to an API token, whatever it asks for", async () => {
    const accountId = await signIn();
    await postSettings(
      postRequest({ unsplash: { accessKey: "u-1234567890" } }),
    );

    for (const access of ["full", "read_only"] as const) {
      await useApiToken(accountId, access);
      const plain = await getSettings(getRequest());
      expect(plain.status).toBe(200);
      expect(await plain.json()).toEqual({ unsplash: { accessKey: "••••••••7890" } });
      const asked = await getSettings(getRequest("?reveal=1"));
      expect(asked.status).toBe(200);
      expect(await asked.json()).toEqual({ unsplash: { accessKey: "••••••••7890" } });
    }

    // A full token may still rotate a key (and keep one by posting its
    // mask) — it just never reads one.
    await useApiToken(accountId, "full");
    const rotated = await postSettings(
      postRequest({ unsplash: { accessKey: "u-rotated-000" } }, { origin: baseUrl }),
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ unsplash: { accessKey: "••••••••-000" } });
  });

  it("re-seals a plaintext row from before sealing shipped on its first read", async () => {
    const accountId = await signIn();
    await db.insert(accountSettings).values({
      accountId,
      key: "openAI",
      value: { apiKey: "sk-legacy-plaintext", chatModel: "gpt-5.5" },
    });

    const response = await getSettings(getRequest());
    expect(await response.json()).toEqual({
      openAI: { apiKey: "••••••••text", chatModel: "gpt-5.5" },
    });

    const [row] = await db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    const value = row?.value as { apiKey: string; chatModel: string };
    expect(isSealedSettingValue(value.apiKey)).toBe(true);
    expect(value.chatModel).toBe("gpt-5.5");
    expect(JSON.stringify(row?.value)).not.toContain("sk-legacy-plaintext");
    // …and it still opens to the same key.
    expect(await (await getSettings(getRequest("?reveal=1"))).json()).toEqual({
      openAI: { apiKey: "sk-legacy-plaintext", chatModel: "gpt-5.5" },
    });
  });

  it("treats a payload with no storable groups as a no-op, not an error", async () => {
    const accountId = await signIn();
    await postSettings(postRequest({ github: { api_key: "gh" } }));

    // The SPA's personal-favourites save posts {personal: ...} on its own.
    const response = await postSettings(
      postRequest({ personal: { favouriteTemplateIds: ["a"] } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ github: { api_key: "••••••••" } });

    // No second audit event for the no-op.
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountId));
    expect(events).toHaveLength(1);
  });

  it("refuses bad values whole instead of half-applying", async () => {
    await signIn();
    const nonString = await postSettings(
      postRequest({ github: { api_key: 42 }, unsplash: { accessKey: "ok" } }),
    );
    expect(nonString.status).toBe(400);
    expect(((await nonString.json()) as { error: string }).error).toBe(
      "invalid_settings",
    );

    const oversized = await postSettings(
      postRequest({
        github: { api_key: "x".repeat(maxAccountSettingValueLength + 1) },
      }),
    );
    expect(oversized.status).toBe(400);
    expect(((await oversized.json()) as { error: string }).error).toBe(
      "settings_value_too_large",
    );

    // Nothing (not even the valid unsplash group) was stored.
    expect(await (await getSettings(getRequest())).json()).toEqual({});
  });

  it("keeps accounts isolated", async () => {
    await signIn();
    await postSettings(postRequest({ openAI: { apiKey: "sk-first" } }));

    await signIn(); // a different account
    expect(await (await getSettings(getRequest())).json()).toEqual({});
  });
});
