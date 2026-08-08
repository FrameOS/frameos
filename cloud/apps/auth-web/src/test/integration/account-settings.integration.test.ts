import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
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
import { maxAccountSettingValueLength } from "../../lib/account-settings";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
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

function getRequest() {
  return new NextRequest(new URL("/api/settings", baseUrl), { method: "GET" });
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
    // (the backend contract settingsLogic resets its form from).
    expect(saved).toEqual({
      frameOS: { apiKey: "2024" },
      homeAssistant: { accessToken: "ha-token", url: "http://ha.local:8123" },
      openAI: { apiKey: "sk-frames" },
    });

    const roundTrip = await getSettings(getRequest());
    expect(roundTrip.status).toBe(200);
    expect(await roundTrip.json()).toEqual(saved);

    // One row per group, none for the filtered scaffolding.
    const rows = await db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(rows.map((row) => row.key).sort()).toEqual([
      "frameOS",
      "homeAssistant",
      "openAI",
    ]);

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
    ).toEqual(["frameOS", "homeAssistant", "openAI"]);
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
      unsplash: { accessKey: "u-key" },
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
    expect(await response.json()).toEqual({ github: { api_key: "gh" } });

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
