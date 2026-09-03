import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { clientBackups, createDb, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as deleteBackup,
  GET as getBackup,
} from "../../../app/api/backends/backups/[backupId]/route";
import {
  GET as listBackups,
  POST as saveBackup,
} from "../../../app/api/backends/backups/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { maxBackupBytes } from "../../lib/backups";
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

function getJson(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), { headers });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `backup-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Backup Tester ${userCounter}`,
    email: `backup-${userCounter}@example.com`,
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

// Full device flow. When reuseSession is true the currently signed-in account
// approves, so two links can share one owning account (the reinstall case).
async function linkClient(scopes: string[], reuseSession = false) {
  const startResponse = await startDevice(
    postJson("/api/device/start", {
      local_origin: "http://10.2.2.2:8989",
      public_display_name: "Backup Backend",
      scopes,
    }),
  );
  const startPayload = await readJson(startResponse);

  const accountId = reuseSession ? undefined : await signIn();
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
  return { accessToken: accessToken as string, accountId };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function contentBase64(text: string) {
  return Buffer.from(text, "utf8").toString("base64");
}

const backupScopes = [
  "backend:link",
  "backup:frames",
  "backup:scenes",
];

describe("config backups", () => {
  it("saves, lists, fetches, replaces, and deletes a backup", async () => {
    const { accessToken } = await linkClient(backupScopes);

    const saveResponse = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: contentBase64('{"scenes": []}'),
          content_type: "application/json",
          item_key: "frame-1",
          kind: "frames",
          name: "Kitchen frame",
        },
        bearer(accessToken),
      ),
    );
    expect(saveResponse.status).toBe(200);
    const saved = (await readJson(saveResponse)).backup as Record<
      string,
      unknown
    >;
    expect(saved.kind).toBe("frames");
    expect(saved.item_key).toBe("frame-1");
    expect(saved.size_bytes).toBe('{"scenes": []}'.length);

    const listResponse = await listBackups(
      getJson("/api/backends/backups", bearer(accessToken)),
    );
    expect(listResponse.status).toBe(200);
    const listed = (await readJson(listResponse)).backups as Array<
      Record<string, unknown>
    >;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.id);
    // Listing is metadata only.
    expect(listed[0]?.content_base64).toBeUndefined();

    const fetchResponse = await getBackup(
      getJson(`/api/backends/backups/${saved.id}`, bearer(accessToken)),
      { params: Promise.resolve({ backupId: saved.id as string }) },
    );
    expect(fetchResponse.status).toBe(200);
    const fetched = (await readJson(fetchResponse)).backup as Record<
      string,
      unknown
    >;
    expect(fetched.content_base64).toBe(contentBase64('{"scenes": []}'));

    // Same (kind, item_key) replaces in place and keeps the id.
    const replaceResponse = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: contentBase64('{"scenes": ["updated"]}'),
          item_key: "frame-1",
          kind: "frames",
        },
        bearer(accessToken),
      ),
    );
    expect(replaceResponse.status).toBe(200);
    const replaced = (await readJson(replaceResponse)).backup as Record<
      string,
      unknown
    >;
    expect(replaced.id).toBe(saved.id);
    expect(replaced.sha256).not.toBe(saved.sha256);

    const deleteResponse = await deleteBackup(
      getJson(`/api/backends/backups/${saved.id}`, bearer(accessToken)),
      { params: Promise.resolve({ backupId: saved.id as string }) },
    );
    expect(deleteResponse.status).toBe(200);
    const rows = await db.select().from(clientBackups);
    expect(rows).toHaveLength(0);
  });

  it("enforces the backup scopes per kind", async () => {
    const { accessToken } = await linkClient(["backend:link", "backup:frames"]);

    // Saving a template backup needs backup:scenes.
    const templateSave = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: contentBase64("zip-bytes"),
          item_key: "template-1",
          kind: "templates",
        },
        bearer(accessToken),
      ),
    );
    expect(templateSave.status).toBe(403);

    const frameSave = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: contentBase64("{}"),
          item_key: "frame-1",
          kind: "frames",
        },
        bearer(accessToken),
      ),
    );
    expect(frameSave.status).toBe(200);

    // A client with no backup scopes at all cannot even list.
    const { accessToken: unscopedToken } = await linkClient(["backend:link"]);
    const listResponse = await listBackups(
      getJson("/api/backends/backups", bearer(unscopedToken)),
    );
    expect(listResponse.status).toBe(403);
  });

  it("keeps backups when the account relinks a new install", async () => {
    const { accessToken: oldToken } = await linkClient(backupScopes);
    const saveResponse = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: contentBase64('{"scenes": []}'),
          item_key: "frame-7",
          kind: "frames",
        },
        bearer(oldToken),
      ),
    );
    expect(saveResponse.status).toBe(200);

    // Same account approves a second (reinstalled) backend; the new link sees
    // the old install's backups — the "Restore from FrameOS Cloud" case.
    const { accessToken: newToken } = await linkClient(backupScopes, true);
    const listResponse = await listBackups(
      getJson("/api/backends/backups", bearer(newToken)),
    );
    expect(listResponse.status).toBe(200);
    const listed = (await readJson(listResponse)).backups as Array<
      Record<string, unknown>
    >;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.item_key).toBe("frame-7");
  });

  it("stores only an allowlisted content_type, else octet-stream", async () => {
    const { accessToken } = await linkClient(backupScopes);
    const save = (contentType: unknown, itemKey: string) =>
      saveBackup(
        postJson(
          "/api/backends/backups",
          {
            content_base64: contentBase64("{}"),
            content_type: contentType,
            item_key: itemKey,
            kind: "frames",
          },
          bearer(accessToken),
        ),
      );
    const zip = await save("application/zip", "zip");
    expect(zip.status).toBe(200);
    expect(((await readJson(zip)).backup as { content_type: string }).content_type).toBe(
      "application/zip",
    );
    // The type is replayed as a download header, so anything the browser
    // might render inline is stored as an opaque stream instead.
    const html = await save("text/html; charset=utf-8", "html");
    expect(html.status).toBe(200);
    expect(((await readJson(html)).backup as { content_type: string }).content_type).toBe(
      "application/octet-stream",
    );
    const none = await save(undefined, "none");
    expect(((await readJson(none)).backup as { content_type: string }).content_type).toBe(
      "application/octet-stream",
    );
  });

  it("rejects invalid kinds, junk content, and oversized blobs", async () => {
    const { accessToken } = await linkClient(backupScopes);

    const badKind = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: contentBase64("{}"),
          item_key: "x",
          kind: "assets",
        },
        bearer(accessToken),
      ),
    );
    expect(badKind.status).toBe(400);

    const badContent = await saveBackup(
      postJson(
        "/api/backends/backups",
        { content_base64: "not!!base64??", item_key: "x", kind: "frames" },
        bearer(accessToken),
      ),
    );
    expect(badContent.status).toBe(400);

    const oversized = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: Buffer.alloc(maxBackupBytes + 1).toString("base64"),
          item_key: "x",
          kind: "frames",
        },
        bearer(accessToken),
      ),
    );
    expect(oversized.status).toBe(413);
  });

  it("rejects requests without a valid link token", async () => {
    const listResponse = await listBackups(
      getJson("/api/backends/backups", bearer("fc_link_bogus")),
    );
    expect(listResponse.status).toBe(401);
  });
});
