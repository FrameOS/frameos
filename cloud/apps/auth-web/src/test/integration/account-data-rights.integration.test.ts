import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountIdentities,
  accounts,
  auditEvents,
  createDb,
  createPasswordAccount,
  frames,
  linkedClients,
  sessions,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as deleteAccount } from "../../../app/api/account/delete/route";
import { GET as exportAccount } from "../../../app/api/account/export/route";
import { hashPassword } from "../../lib/passwords";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

// Self-serve export (GDPR arts. 15/20) and deletion (art. 17). Both used to
// require emailing a superadmin, which is a right with a queue in front of
// it. These tests hold the two properties that make them safe to hand to the
// user directly: the export must not carry credentials, and the delete must
// actually take everything with it.

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

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

async function signInGoogleAccount() {
  userCounter += 1;
  const providerSubject = `data-rights-google-${userCounter}`;
  const email = `data-rights-google-${userCounter}@example.com`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Data Rights Tester ${userCounter}`,
    email,
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
  return { accountId, email };
}

async function signInPasswordAccount(password: string) {
  userCounter += 1;
  const email = `data-rights-password-${userCounter}@example.com`;
  const { accountId } = await createPasswordAccount(db, {
    displayName: "Password Tester",
    email,
    passwordHash: await hashPassword(password),
  });
  const token = await createSession(db, {
    accountId,
    providerIssuer: "frameos-cloud",
    providerSubject: email,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId, email };
}

// A frame plus a store scene, so the cascade has something to take with it.
async function seedContent(accountId: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      publicDisplayName: "Kitchen frame",
      tokenReference: `fc_link_ref_${accountId}`,
    })
    .returning({ id: linkedClients.id });
  await db.insert(frames).values({
    accountId,
    linkedClientId: client!.id,
    name: "Kitchen frame",
    publicKey: "base64publickey",
    status: "active",
  });
  await db.insert(storeScenes).values({
    accountId,
    name: "Sunrise clock",
    slug: `sunrise-clock-${accountId}`,
  });
}

describe("account data export", () => {
  it("includes the account's own data", async () => {
    const { accountId, email } = await signInGoogleAccount();
    await seedContent(accountId);

    const response = await exportAccount();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");

    const data = (await response.json()) as {
      account: { id: string; primaryEmail: string };
      frames: { name: string }[];
      identities: unknown[];
      scenes: unknown[];
    };
    expect(data.account.id).toBe(accountId);
    expect(data.account.primaryEmail).toBe(email);
    expect(data.frames).toHaveLength(1);
    expect(data.frames[0]?.name).toBe("Kitchen frame");
    expect(data.scenes).toHaveLength(1);
    expect(data.identities).toHaveLength(1);
  });

  it("carries no credentials at all", async () => {
    // The export lands in a Downloads folder and gets emailed around. If it
    // contained a password hash, a session token, a scene share token or an
    // encrypted backend credential, "I exported my data" would become "I
    // leaked my account". Assert on the whole serialized document rather
    // than field by field, so a newly selected column cannot sneak one in.
    const { accountId } = await signInPasswordAccount("correct horse battery");
    await seedContent(accountId);

    const serialized = await (await exportAccount()).text();

    for (const forbidden of [
      "passwordHash",
      "password_hash",
      "tokenHash",
      "token_hash",
      "shareToken",
      "share_token",
      "tokenReference",
      "encryptedRefreshToken",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("refuses to export for a signed-out visitor", async () => {
    cookieJar.clear();

    expect((await exportAccount()).status).toBe(401);
  });

  it("records the export in the audit trail", async () => {
    const { accountId } = await signInGoogleAccount();

    await exportAccount();

    const events = await db
      .select({ eventType: auditEvents.eventType })
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountId));
    expect(events.map((event) => event.eventType)).toContain(
      "account.data_exported",
    );
  });
});

describe("self-serve account deletion", () => {
  it("deletes the account and everything that hangs off it", async () => {
    const { accountId } = await signInPasswordAccount("correct horse battery");
    await seedContent(accountId);

    const response = await deleteAccount(
      postJson("/api/account/delete", { password: "correct horse battery" }),
    );
    expect(response.status).toBe(200);

    expect(
      await db.select().from(accounts).where(eq(accounts.id, accountId)),
    ).toHaveLength(0);
    // Every one of these cascades from accounts.id; a missing ON DELETE
    // CASCADE would leave orphaned personal data behind after an erasure
    // request, which is the whole thing art. 17 is about.
    expect(
      await db.select().from(frames).where(eq(frames.accountId, accountId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(storeScenes)
        .where(eq(storeScenes.accountId, accountId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(accountIdentities)
        .where(eq(accountIdentities.accountId, accountId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(sessions).where(eq(sessions.accountId, accountId)),
    ).toHaveLength(0);
  });

  it("keeps the security trail, de-identified", async () => {
    // audit_events.account_id is ON DELETE SET NULL: a security log the
    // subject can erase is not a security log, and a de-identified one is no
    // longer their personal data. The privacy policy says this out loud.
    await signInPasswordAccount("correct horse battery");

    await deleteAccount(
      postJson("/api/account/delete", { password: "correct horse battery" }),
    );

    const remaining = await db
      .select({
        accountId: auditEvents.accountId,
        eventType: auditEvents.eventType,
      })
      .from(auditEvents);
    expect(remaining.map((event) => event.eventType)).toContain(
      "account.self_deleted",
    );
    expect(remaining.every((event) => event.accountId === null)).toBe(true);
  });

  it("rejects a wrong password without deleting anything", async () => {
    const { accountId } = await signInPasswordAccount("correct horse battery");

    const response = await deleteAccount(
      postJson("/api/account/delete", { password: "wrong" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_password");
    expect(
      await db.select().from(accounts).where(eq(accounts.id, accountId)),
    ).toHaveLength(1);
  });

  it("lets a Google-only account confirm with its email instead", async () => {
    const { accountId, email } = await signInGoogleAccount();

    const wrong = await deleteAccount(
      postJson("/api/account/delete", { confirmEmail: "someone@else.test" }),
    );
    expect(wrong.status).toBe(400);
    expect(
      await db.select().from(accounts).where(eq(accounts.id, accountId)),
    ).toHaveLength(1);

    const right = await deleteAccount(
      postJson("/api/account/delete", { confirmEmail: email.toUpperCase() }),
    );
    expect(right.status).toBe(200);
    expect(
      await db.select().from(accounts).where(eq(accounts.id, accountId)),
    ).toHaveLength(0);
  });

  it("refuses to delete a superadmin, so the panel keeps a way in", async () => {
    const { accountId } = await signInPasswordAccount("correct horse battery");
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, accountId));

    const response = await deleteAccount(
      postJson("/api/account/delete", { password: "correct horse battery" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "superadmin_cannot_self_delete",
    );
    expect(
      await db.select().from(accounts).where(eq(accounts.id, accountId)),
    ).toHaveLength(1);
  });

  it("requires a same-origin request", async () => {
    await signInPasswordAccount("correct horse battery");

    const response = await deleteAccount(
      new NextRequest(new URL("/api/account/delete", baseUrl), {
        body: JSON.stringify({ password: "correct horse battery" }),
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
  });
});
