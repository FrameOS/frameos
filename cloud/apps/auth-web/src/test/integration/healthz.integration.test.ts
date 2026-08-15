import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@frameos-cloud/db";
import { GET as healthz } from "../../../app/healthz/route";

// /healthz is what the uptime monitor and the post-deploy check now curl.
// They used to hit /login, which the App Router renders happily with a dead
// database — so the failure most worth paging on was the one the monitor
// could not see. That only holds if this route really does 503 when Postgres
// is unreachable, which is what these two tests pin down.

const db = createDb();

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /healthz", () => {
  it("returns 200 and reports the database when Postgres answers", async () => {
    const response = await healthz();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const body = (await response.json()) as {
      checks: { database: { latencyMs: number; ok: boolean } };
      status: string;
    };
    expect(body.status).toBe("ok");
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 when there is no database configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("DATABASE_URL", "");

    const response = await healthz();

    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("degraded");
  });

  it("returns 503 when Postgres is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A port nothing listens on: the connection fails fast rather than
    // hanging, which is also what the route's own timeout is there for.
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://frameos_cloud@127.0.0.1:1/frameos_cloud_missing",
    );

    const response = await healthz();

    expect(response.status).toBe(503);
  });
});
