import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  auditEvents,
  clientBackups,
  createDb,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as deleteAccountBackup,
  GET as downloadAccountBackup,
} from "../../../app/api/account/backups/[backupId]/route";
import { POST as saveBackup } from "../../../app/api/backends/backups/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
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

function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

function request(
  path: string,
  method: "GET" | "DELETE",
  headers: Record<string, string> = {},
) {
  return new NextRequest(new URL(path, baseUrl), { headers, method });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `account-backup-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Account Backup Tester ${userCounter}`,
    email: `account-backup-${userCounter}@example.com`,
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

// Full device flow for the currently signed-in account, then one saved frame
// backup pushed with the resulting link token.
async function linkAndSaveBackup() {
  const startResponse = await startDevice(
    postJson("/api/device/start", {
      local_origin: "http://10.2.2.2:8989",
      public_display_name: "Backup Backend",
      scopes: ["backend:link", "backup:frames"],
    }),
  );
  const startPayload = await readJson(startResponse);

  const authorizeResponse = await authorizeDevice(
    postJson(
      "/api/device/authorize",
      { user_code: startPayload.user_code },
      { origin: baseUrl },
    ),
  );
  expect(authorizeResponse.status).toBe(200);

  const pollResponse = await pollDevice(
    postJson("/api/device/poll", { device_code: startPayload.device_code }),
  );
  expect(pollResponse.status).toBe(200);
  const { access_token: accessToken } = await readJson(pollResponse);

  const saveResponse = await saveBackup(
    postJson(
      "/api/backends/backups",
      {
        content_base64: Buffer.from('{"scenes": []}', "utf8").toString(
          "base64",
        ),
        content_type: "application/json",
        item_key: "frame-1",
        kind: "frames",
        name: "Kitchen frame",
      },
      { authorization: `Bearer ${accessToken}` },
    ),
  );
  expect(saveResponse.status).toBe(200);
  const saved = (await readJson(saveResponse)).backup as Record<
    string,
    unknown
  >;
  return saved.id as string;
}

function routeContext(backupId: string) {
  return { params: Promise.resolve({ backupId }) };
}

describe("account backup routes", () => {
  it("lets the signed-in owner download a backup as a file", async () => {
    await signIn();
    const backupId = await linkAndSaveBackup();

    const response = await downloadAccountBackup(
      request(`/api/account/backups/${backupId}`, "GET"),
      routeContext(backupId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="Kitchen_frame.json"',
    );
    expect(await response.text()).toBe('{"scenes": []}');
  });

  it("lets the signed-in owner delete a backup and records an audit event", async () => {
    const accountId = await signIn();
    const backupId = await linkAndSaveBackup();

    const response = await deleteAccountBackup(
      request(`/api/account/backups/${backupId}`, "DELETE", {
        origin: baseUrl,
      }),
      routeContext(backupId),
    );
    expect(response.status).toBe(200);

    const rows = await db.select().from(clientBackups);
    expect(rows).toHaveLength(0);

    const events = await db.select().from(auditEvents);
    const deleted = events.find(
      (event) => event.eventType === "backup.deleted",
    );
    expect(deleted?.accountId).toBe(accountId);
  });

  it("rejects deletes without a matching origin header", async () => {
    await signIn();
    const backupId = await linkAndSaveBackup();

    const response = await deleteAccountBackup(
      request(`/api/account/backups/${backupId}`, "DELETE"),
      routeContext(backupId),
    );
    expect(response.status).toBe(403);
  });

  it("hides backups from other accounts and from signed-out visitors", async () => {
    await signIn();
    const backupId = await linkAndSaveBackup();

    // A different signed-in account gets a 404, not someone else's data.
    await signIn();
    const otherAccountResponse = await downloadAccountBackup(
      request(`/api/account/backups/${backupId}`, "GET"),
      routeContext(backupId),
    );
    expect(otherAccountResponse.status).toBe(404);

    cookieJar.clear();
    const signedOutResponse = await downloadAccountBackup(
      request(`/api/account/backups/${backupId}`, "GET"),
      routeContext(backupId),
    );
    expect(signedOutResponse.status).toBe(401);
  });
});
