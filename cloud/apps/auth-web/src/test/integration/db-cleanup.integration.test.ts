import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  emailVerificationTokens,
  frameDeviceScenes,
  frames,
  linkedClients,
  passwordResetTokens,
  sessions,
} from "@frameos-cloud/db";
import { resolveTestDatabaseUrl } from "./test-database-url";

// scripts/db-cleanup.sh is bash and psql, run nightly on production out of
// the live release. Nothing else exercises its SQL, and a table it forgets
// simply grows forever (password_reset_tokens and email_verification_tokens
// did, until 2026-09). This runs the real script against the test database
// and checks what it keeps as carefully as what it deletes: a cleanup that
// removes a live token is a worse bug than one that removes nothing.

const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const script = path.join(cloudDir, "scripts/db-cleanup.sh");

// The script drives psql; a machine without the client skips rather than
// fails (CI's ubuntu image ships it).
let hasPsql = true;
try {
  execFileSync("psql", ["--version"], { stdio: "ignore" });
} catch {
  hasPsql = false;
}

const db = createDb();
const day = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

async function account() {
  const [row] = await db
    .insert(accounts)
    .values({ displayName: "cleanup" })
    .returning({ id: accounts.id });
  return row!.id;
}

function runCleanup(env: Record<string, string> = {}) {
  return execFileSync("bash", [script], {
    cwd: cloudDir,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe.skipIf(!hasPsql)("scripts/db-cleanup.sh", () => {
  beforeEach(async () => {
    await db.delete(passwordResetTokens);
    await db.delete(emailVerificationTokens);
    await db.delete(sessions);
  });

  it("prunes spent and expired email tokens and keeps the live ones", async () => {
    const owner = await account();
    const now = Date.now();
    const tokens = [
      // Live: expires in an hour, unused.
      { expiresAt: new Date(now + 60 * 60 * 1000), tokenHash: "live", usedAt: null },
      // Expired an hour ago: within retention, kept so a replay is refused.
      { expiresAt: new Date(now - 60 * 60 * 1000), tokenHash: "fresh-expired", usedAt: null },
      // Used yesterday, still within retention.
      {
        expiresAt: new Date(now - 60 * 60 * 1000),
        tokenHash: "fresh-used",
        usedAt: new Date(now - day),
      },
      // Expired long ago.
      { expiresAt: new Date(now - 30 * day), tokenHash: "old-expired", usedAt: null },
      // Used long ago (a far-future expiry must not save it).
      {
        expiresAt: new Date(now + 365 * day),
        tokenHash: "old-used",
        usedAt: new Date(now - 30 * day),
      },
    ];
    await db
      .insert(passwordResetTokens)
      .values(tokens.map((token) => ({ ...token, accountId: owner })));
    await db
      .insert(emailVerificationTokens)
      .values(tokens.map((token) => ({ ...token, accountId: owner })));

    const output = runCleanup({ FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS: "7" });
    expect(output).toContain("Cleanup complete");

    const resets = await db
      .select({ hash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.accountId, owner));
    expect(resets.map((row) => row.hash).sort()).toEqual([
      "fresh-expired",
      "fresh-used",
      "live",
    ]);
    const verifications = await db
      .select({ hash: emailVerificationTokens.tokenHash })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.accountId, owner));
    expect(verifications.map((row) => row.hash).sort()).toEqual([
      "fresh-expired",
      "fresh-used",
      "live",
    ]);
  });

  it("drops a frame's unclaimed scene report once it is old, and keeps every verdict", async () => {
    const owner = await account();
    const frameIds: Record<string, string> = {};
    for (const [label, status, ageDays] of [
      ["stale-ready", "ready", 45],
      ["fresh-ready", "ready", 2],
      ["old-imported", "imported", 400],
      ["old-dismissed", "dismissed", 400],
    ] as const) {
      const [client] = await db
        .insert(linkedClients)
        .values({
          accountId: owner,
          clientKind: "frame",
          publicDisplayName: label,
          tokenReference: `cleanup-device-scenes-${label}-${Date.now()}`,
        })
        .returning();
      const [frame] = await db
        .insert(frames)
        .values({
          accountId: owner,
          linkedClientId: client!.id,
          name: label,
          publicKey: `cleanup-device-scenes-${label}-${Date.now()}`,
        })
        .returning();
      frameIds[label] = frame!.id;
      await db.insert(frameDeviceScenes).values({
        frameId: frame!.id,
        payload: status === "ready" ? Buffer.from("{}") : null,
        receivedAt: new Date(Date.now() - ageDays * day),
        status,
      });
    }

    runCleanup();

    const kept = await db.select().from(frameDeviceScenes);
    const keptFrames = new Set(kept.map((row) => row.frameId));
    // The hub asks the frame again on its next connect; the verdicts are what
    // stop the asking, so they outlive any retention.
    expect(keptFrames.has(frameIds["stale-ready"]!)).toBe(false);
    expect(keptFrames.has(frameIds["fresh-ready"]!)).toBe(true);
    expect(keptFrames.has(frameIds["old-imported"]!)).toBe(true);
    expect(keptFrames.has(frameIds["old-dismissed"]!)).toBe(true);
  });

  it("refuses a retention that would delete rows still in their window", async () => {
    expect(() => runCleanup({ FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS: "0" })).toThrow(
      /positive integer/,
    );
  });
});
