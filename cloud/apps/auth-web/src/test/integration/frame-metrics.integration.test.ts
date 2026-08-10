// Metrics history for the cloud workspace (cloud/docs/cloud-workspace-gaps.md
// item 9): the hub retains device metrics samples in frame_metrics via
// storeFrameMetrics; GET /metrics and GET /metrics/recent serve them in the
// MetricsType shape the shared SPA's metricsLogic loads.
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createDb,
  frameMetrics,
  frames,
  linkedClients,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getFrameMetrics } from "../../../app/api/frames/[frameId]/metrics/route";
import { GET as getFrameMetricsRecent } from "../../../app/api/frames/[frameId]/metrics/recent/route";
import {
  maxMetricsPerFrame,
  maxMetricsSampleBytes,
  storeFrameLogs,
  storeFrameMetrics,
} from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
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

function getRequest(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

const metricsParams = (frameId: string) => ({
  params: Promise.resolve({ frameId }),
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `metrics-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Metrics User ${userCounter}`,
    email: `metrics-${userCounter}@example.com`,
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

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function activeFrame() {
  const accountId = await signIn();
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Metrics frame",
      tokenReference: hashSecret(`fc_link_metrics_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Metrics frame",
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return { accountId, frame: frame! };
}

describe("GET /api/frames/{id}/metrics", () => {
  it("serves retained samples chronologically in the SPA's MetricsType shape", async () => {
    const { frame } = await activeFrame();
    const first = new Date("2026-08-01T10:00:00.000Z");
    const second = new Date("2026-08-01T10:01:00.000Z");
    const firstId = await storeFrameMetrics(
      db,
      frame.id,
      { intervalMs: 60000, load: [0.5, 0.4, 0.3] },
      first,
    );
    const secondId = await storeFrameMetrics(
      db,
      frame.id,
      { load: [0.7, 0.5, 0.4], memoryUsage: { total: 100, used: 40 } },
      second,
    );
    expect(firstId).not.toBeNull();
    expect(secondId).toBeGreaterThan(firstId!);

    const response = await getFrameMetrics(
      getRequest(`/api/frames/${frame.id}/metrics`),
      metricsParams(frame.id),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.metrics).toEqual([
      {
        frame_id: frame.id,
        id: String(firstId),
        metrics: { intervalMs: 60000, load: [0.5, 0.4, 0.3] },
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      {
        frame_id: frame.id,
        id: String(secondId),
        metrics: { load: [0.7, 0.5, 0.4], memoryUsage: { total: 100, used: 40 } },
        timestamp: "2026-08-01T10:01:00.000Z",
      },
    ]);
  });

  it("requires a session and hides other accounts' frames", async () => {
    const { frame } = await activeFrame();
    cookieJar.clear();
    const anonymous = await getFrameMetrics(
      getRequest(`/api/frames/${frame.id}/metrics`),
      metricsParams(frame.id),
    );
    expect(anonymous.status).toBe(401);

    // A different signed-in account sees a 404, not an empty history.
    await signIn();
    const foreign = await getFrameMetrics(
      getRequest(`/api/frames/${frame.id}/metrics`),
      metricsParams(frame.id),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("GET /api/frames/{id}/metrics/recent", () => {
  it("returns samples at or after ?since=, chronologically", async () => {
    const { frame } = await activeFrame();
    const stamps = [
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:01:00.000Z",
      "2026-08-01T10:02:00.000Z",
    ];
    for (const [index, stamp] of stamps.entries()) {
      await storeFrameMetrics(db, frame.id, { seq: index }, new Date(stamp));
    }

    const response = await getFrameMetricsRecent(
      getRequest(
        `/api/frames/${frame.id}/metrics/recent?since=${encodeURIComponent(stamps[1]!)}`,
      ),
      metricsParams(frame.id),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    // Inclusive of the boundary sample — the SPA dedupes on timestamp.
    expect(
      payload.metrics.map((row: { metrics: { seq: number } }) => row.metrics.seq),
    ).toEqual([1, 2]);
    expect(payload.metrics[0].timestamp).toBe(stamps[1]);
  });

  it("serves the whole history when since is absent or unparsable", async () => {
    const { frame } = await activeFrame();
    await storeFrameMetrics(db, frame.id, { seq: 0 }, new Date());
    for (const query of ["", "?since=not-a-date"]) {
      const response = await getFrameMetricsRecent(
        getRequest(`/api/frames/${frame.id}/metrics/recent${query}`),
        metricsParams(frame.id),
      );
      expect((await response.json()).metrics).toHaveLength(1);
    }
  });
});

describe("reboot markers", () => {
  it("derives them from the device's bootup log lines", async () => {
    const { frame } = await activeFrame();
    await storeFrameLogs(db, frame.id, [
      {
        payload: { event: "render", message: "rendering" },
        timestamp: new Date("2026-08-01T09:59:00.000Z"),
      },
      {
        payload: {
          event: "bootup",
          reboot: {
            bootId: "boot-2",
            exitCode: "0",
            previousBootId: "boot-1",
            reason: "Rebooting device after boot config changes",
            serviceResult: "success",
            source: "backend",
          },
        },
        timestamp: new Date("2026-08-01T10:00:00.000Z"),
      },
      // The ESP32 ships a bare bootup line: still a marker, just no detail.
      {
        payload: { event: "bootup", source: "esp32", version: "2026.8.12" },
        timestamp: new Date("2026-08-01T11:00:00.000Z"),
      },
    ]);

    const response = await getFrameMetrics(
      getRequest(`/api/frames/${frame.id}/metrics`),
      metricsParams(frame.id),
    );
    const payload = await response.json();
    expect(payload.reboots).toHaveLength(2);
    expect(payload.reboots[0]).toMatchObject({
      boot_id: "boot-2",
      exit_code: "0",
      // service_result "success" means the last run exited cleanly, so the
      // reboot was initiated — the backend's derivation, mirrored.
      kind: "initiated",
      previous_boot_id: "boot-1",
      service_result: "success",
      source: "backend",
      timestamp: "2026-08-01T10:00:00.000Z",
    });
    expect(payload.reboots[1]).toEqual({
      log_id: expect.any(String),
      timestamp: "2026-08-01T11:00:00.000Z",
    });
  });

  it("names the kind an OOM kill even when the device did not", async () => {
    const { frame } = await activeFrame();
    await storeFrameLogs(db, frame.id, [
      {
        payload: { event: "bootup", reboot: { service_result: "oom-kill" } },
        timestamp: new Date("2026-08-01T10:00:00.000Z"),
      },
    ]);

    const response = await getFrameMetrics(
      getRequest(`/api/frames/${frame.id}/metrics`),
      metricsParams(frame.id),
    );
    expect((await response.json()).reboots[0]).toMatchObject({
      kind: "oom",
      service_result: "oom-kill",
    });
  });

  it("limits /metrics/recent markers to the ?since= window", async () => {
    const { frame } = await activeFrame();
    await storeFrameLogs(db, frame.id, [
      {
        payload: { event: "bootup" },
        timestamp: new Date("2026-08-01T09:00:00.000Z"),
      },
      {
        payload: { event: "bootup" },
        timestamp: new Date("2026-08-01T11:00:00.000Z"),
      },
    ]);

    const response = await getFrameMetricsRecent(
      getRequest(
        `/api/frames/${frame.id}/metrics/recent?since=${encodeURIComponent(
          "2026-08-01T10:00:00.000Z",
        )}`,
      ),
      metricsParams(frame.id),
    );
    const payload = await response.json();
    expect(payload.reboots.map((row: { timestamp: string }) => row.timestamp)).toEqual([
      "2026-08-01T11:00:00.000Z",
    ]);
  });
});

describe("storeFrameMetrics", () => {
  it("prunes past the per-frame retention cap in the same transaction", async () => {
    const { frame } = await activeFrame();
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    // Seed the retention window in bulk; the interesting inserts — the ones
    // that must prune — go through storeFrameMetrics itself.
    await db.insert(frameMetrics).values(
      Array.from({ length: maxMetricsPerFrame }, (_, index) => ({
        frameId: frame.id,
        payload: { seq: index },
        sizeBytes: 16,
        timestamp: new Date(base + index * 1000),
      })),
    );
    const extra = 5;
    for (let index = 0; index < extra; index += 1) {
      await storeFrameMetrics(
        db,
        frame.id,
        { seq: maxMetricsPerFrame + index },
        new Date(base + (maxMetricsPerFrame + index) * 1000),
      );
    }
    const rows = await db
      .select({ payload: frameMetrics.payload })
      .from(frameMetrics)
      .where(eq(frameMetrics.frameId, frame.id))
      .orderBy(frameMetrics.id);
    expect(rows).toHaveLength(maxMetricsPerFrame);
    // The oldest samples are the ones pruned.
    expect((rows[0]!.payload as { seq: number }).seq).toBe(extra);
    expect((rows.at(-1)!.payload as { seq: number }).seq).toBe(
      maxMetricsPerFrame + extra - 1,
    );
  });

  it("rejects oversized samples instead of truncating them", async () => {
    const { frame } = await activeFrame();
    const oversized = { blob: "x".repeat(maxMetricsSampleBytes) };
    expect(await storeFrameMetrics(db, frame.id, oversized, new Date())).toBe(
      null,
    );
    expect(
      await db
        .select()
        .from(frameMetrics)
        .where(eq(frameMetrics.frameId, frame.id)),
    ).toHaveLength(0);
  });

  it("does not count one frame's samples against another's cap", async () => {
    const { frame } = await activeFrame();
    const { frame: other } = await activeFrame();
    await storeFrameMetrics(db, other.id, { seq: -1 }, new Date());
    for (let index = 0; index < 3; index += 1) {
      await storeFrameMetrics(db, frame.id, { seq: index }, new Date());
    }
    expect(
      await db
        .select()
        .from(frameMetrics)
        .where(eq(frameMetrics.frameId, other.id)),
    ).toHaveLength(1);
  });
});
