import { sql } from "drizzle-orm";
import { createDb, rateLimitBuckets } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimitForTests } from "../../lib/rate-limit";

const db = createDb();

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  await db.delete(rateLimitBuckets);
});

describe("database-backed rate limiting", () => {
  it("stores buckets in Postgres and enforces the limit", async () => {
    const options = { limit: 2, windowMs: 60_000 };
    expect((await checkRateLimit("it:limit:key", options)).allowed).toBe(true);
    expect((await checkRateLimit("it:limit:key", options)).allowed).toBe(true);
    expect((await checkRateLimit("it:limit:key", options)).allowed).toBe(false);

    // The decision lives in the shared store, not this instance's memory:
    // clearing the in-memory buckets must not reset the limit.
    resetRateLimitForTests();
    expect((await checkRateLimit("it:limit:key", options)).allowed).toBe(false);

    const rows = await db.select().from(rateLimitBuckets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("it:limit:key");
  });

  it("restarts the window after reset_at passes", async () => {
    const options = { limit: 1, windowMs: 60_000 };
    expect((await checkRateLimit("it:window:key", options)).allowed).toBe(true);
    expect((await checkRateLimit("it:window:key", options)).allowed).toBe(false);

    // Expire the window server-side; the next attempt starts a fresh bucket.
    await db
      .update(rateLimitBuckets)
      .set({ resetAt: sql`now() - interval '1 second'` });
    expect((await checkRateLimit("it:window:key", options)).allowed).toBe(true);
  });
});
