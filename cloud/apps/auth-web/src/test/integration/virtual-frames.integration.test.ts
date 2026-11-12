// Virtual frames on the account side (docs/cloud-frames.md "Virtual
// frames"): creating one inside the plan's limits, its own settings, and the
// view link anyone holding it may read. The device half — what renders the
// picture — is the frame hub's suite.
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  auditEvents,
  billingPlans,
  createDb,
  frames,
  linkedClients,
  subscriptions,
  upsertAccountFromIdentity,
  virtualFrames,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getFrameVirtual, POST as postFrameVirtual } from "../../../app/api/frames/[frameId]/virtual/route";
import { GET as getFrame } from "../../../app/api/frames/[frameId]/route";
import { POST as postSettings } from "../../../app/api/frames/[frameId]/settings/route";
import { POST as createVirtual } from "../../../app/api/frames/virtual/route";
import { GET as getViewImage } from "../../../app/v/[token]/image/route";
import { GET as getViewPage } from "../../../app/v/[token]/route";
import { GET as getViewStatus } from "../../../app/v/[token]/status/route";
import { linkedClientScopes } from "../../lib/backend-auth";
import { frameImageAssetPath, revokeFrame, storeFrameAssetFile } from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { encodePng } from "../../lib/scene-render";
import { createSession, sessionCookieName } from "../../lib/session";
import { accountUsage } from "../../lib/usage";
import { resetVirtualViewStampsForTests } from "../../lib/virtual-frame-view";

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
  resetVirtualViewStampsForTests();
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

async function signIn() {
  userCounter += 1;
  const providerSubject = `virtual-frames-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Virtual Frames User ${userCounter}`,
    email: `virtual-frames-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

// A paid plan the way "Sync plans" writes one: the stop's limits as
// entitlements on a billing_plans row, and the account's subscription to it.
async function subscribe(accountId: string, virtualFrameCount: number, frameCount = 40) {
  const code = `private-${virtualFrameCount}`;
  await db
    .insert(billingPlans)
    .values({
      code,
      entitlements: { cloud_rendered_frames: virtualFrameCount, frames: frameCount },
      marginBasisPoints: 3000,
      name: "Private",
      priceMicros: BigInt(virtualFrameCount) * 1_000_000n,
    })
    .onConflictDoNothing();
  await db.insert(subscriptions).values({ accountId, planCode: code });
}

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), { headers, method: "GET" });
}

const frameParams = (frameId: string) => ({ params: Promise.resolve({ frameId }) });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

type VirtualDetails = {
  height: number;
  image_url: string;
  interval_seconds: number;
  min_interval_seconds: number;
  view_url: string;
  width: number;
};

async function createOne(body: Record<string, unknown> = {}) {
  const response = await createVirtual(post("/api/frames/virtual", body));
  const json = (await response.json()) as {
    error?: string;
    frame?: { connected: boolean; hardware: Record<string, unknown>; id: string; name: string; status: string };
    max_cloud_rendered_frames?: number;
    virtual?: VirtualDetails;
  };
  return { json, status: response.status };
}

function tokenOf(details: VirtualDetails) {
  return details.view_url.split("/v/")[1]!;
}

describe("creating a virtual frame", () => {
  it("is not part of the free plan", async () => {
    await signIn();
    const { json, status } = await createOne({ name: "Lobby" });
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: "cloud_rendered_frame_quota_exceeded", max_cloud_rendered_frames: 0 });
    expect(await db.select().from(frames)).toHaveLength(0);
    expect(await db.select().from(linkedClients)).toHaveLength(0);
  });

  it("needs a session and a size the renderer can draw", async () => {
    expect((await createOne()).status).toBe(401);
    const accountId = await signIn();
    await subscribe(accountId, 2);
    expect((await createOne({ width: 8 })).json.error).toBe("invalid_size");
    expect((await createOne({ height: 4096, width: 4096 })).json.error).toBe("size_too_large");
    expect((await createOne({ name: "x".repeat(2000) })).json.error).toBe("invalid_name");
    expect(await db.select().from(frames)).toHaveLength(0);
  });

  it("makes an active frame with a view link, up to the plan's number", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 2);

    const first = await createOne({ height: 1080, name: "Lobby", timezone: "Europe/Tallinn", width: 1920 });
    expect(first.status).toBe(201);
    expect(first.json.frame).toMatchObject({ name: "Lobby", status: "active" });
    expect(first.json.frame!.hardware).toMatchObject({ device: "virtual", height: 1080, platform: "virtual", width: 1920 });
    expect(first.json.virtual).toMatchObject({ height: 1080, interval_seconds: 300, min_interval_seconds: 300, width: 1920 });
    expect(first.json.virtual!.view_url).toMatch(/^http:\/\/localhost:3000\/v\/vf_[A-Za-z0-9_-]{32}$/);
    expect(first.json.virtual!.image_url).toBe(`${first.json.virtual!.view_url}/image`);

    const [frame] = await db.select().from(frames).where(eq(frames.id, first.json.frame!.id));
    expect(frame!.settings).toEqual({ timezone: "Europe/Tallinn" });
    // A link like any frame's, with the grant its owner's switches act on —
    // and no credential anybody holds.
    const [link] = await db.select().from(linkedClients).where(eq(linkedClients.id, frame!.linkedClientId));
    expect(link!.clientKind).toBe("frame");
    expect(linkedClientScopes(link!).sort()).toEqual(["frame:managed", "settings:services", "telemetry:logs"]);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "frame.virtual_created"));
    expect(audit?.metadata).toMatchObject({ height: 1080, name: "Lobby", width: 1920 });
    // The link is nowhere in the audit trail.
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain("vf_");

    // The usage page counts it where the plan card sells it.
    const usage = await accountUsage(db, accountId);
    expect(usage.cloud_rendered_frames).toMatchObject({ count: 1, max_count: 2 });
    // Not one of the frames the account owns: that number is for hardware.
    expect(usage.frames.count).toBe(0);

    expect((await createOne()).status).toBe(201);
    const third = await createOne();
    expect(third.status).toBe(403);
    expect(third.json).toMatchObject({ error: "cloud_rendered_frame_quota_exceeded", max_cloud_rendered_frames: 2 });
    expect(await db.select().from(virtualFrames)).toHaveLength(2);
  });

  it("has a pool of its own, apart from the frames the account owns", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 2);
    const { frames: frameUsage } = await accountUsage(db, accountId);
    // Hardware up to the plan's last frame.
    for (let index = 0; index < frameUsage.max_count; index += 1) {
      const [link] = await db
        .insert(linkedClients)
        .values({
          accountId,
          clientKind: "frame",
          providerClientMetadata: { requestedScopes: ["frame:managed"] },
          publicDisplayName: `Frame ${index}`,
          tokenReference: `hardware-${index}`,
        })
        .returning();
      await db.insert(frames).values({
        accountId,
        hardware: { platform: "rpios" },
        linkedClientId: link!.id,
        name: `Frame ${index}`,
        publicKey: "x",
        status: "active",
      });
    }
    // Full of hardware, and the plan's virtual frames are still there.
    expect((await createOne()).status).toBe(201);
    expect((await createOne()).status).toBe(201);
    const usage = await accountUsage(db, accountId);
    expect(usage.frames).toMatchObject({ count: frameUsage.max_count, max_count: frameUsage.max_count });
    expect(usage.cloud_rendered_frames).toMatchObject({ count: 2, max_count: 2 });
  });

  it("never hands out more than the plan has, however the requests arrive", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 2);
    const answers = await Promise.all(Array.from({ length: 6 }, () => createOne()));
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 201, 403, 403, 403, 403]);
    expect(await db.select().from(virtualFrames)).toHaveLength(2);
  });
});

describe("a virtual frame's settings", () => {
  it("changes its size, replaces its link, and is the owner's alone", async () => {
    const accountId = await signIn();
    await subscribe(accountId, 2);
    const created = await createOne({ name: "Lobby" });
    const frameId = created.json.frame!.id;

    const read = await getFrameVirtual(get(`/api/frames/${frameId}/virtual`), frameParams(frameId));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(((await read.json()) as { virtual: VirtualDetails }).virtual).toEqual(created.json.virtual);

    const resized = await postFrameVirtual(
      post(`/api/frames/${frameId}/virtual`, { height: 600, width: 1024 }),
      frameParams(frameId),
    );
    expect(((await resized.json()) as { virtual: VirtualDetails }).virtual).toMatchObject({ height: 600, width: 1024 });
    const [frame] = await db.select().from(frames).where(eq(frames.id, frameId));
    expect(frame!.hardware).toMatchObject({ height: 600, platform: "virtual", width: 1024 });

    expect(
      (await postFrameVirtual(post(`/api/frames/${frameId}/virtual`, { width: 99_999 }), frameParams(frameId))).status,
    ).toBe(400);
    expect(
      (await postFrameVirtual(post(`/api/frames/${frameId}/virtual`, { view_token: "vf_mine" }), frameParams(frameId)))
        .status,
    ).toBe(400);

    const oldToken = tokenOf(created.json.virtual!);
    const reset = await postFrameVirtual(post(`/api/frames/${frameId}/virtual`, { reset_link: true }), frameParams(frameId));
    const newToken = tokenOf(((await reset.json()) as { virtual: VirtualDetails }).virtual);
    expect(newToken).not.toBe(oldToken);
    // The old link is dead with that request.
    expect((await getViewStatus(get(`/v/${oldToken}/status`), tokenParams(oldToken))).status).toBe(404);
    expect((await getViewStatus(get(`/v/${newToken}/status`), tokenParams(newToken))).status).toBe(200);

    // The cloud renders for it, so its interval has the plan's floor.
    const fast = await postSettings(post(`/api/frames/${frameId}/settings`, { settings: { interval: 60 } }), frameParams(frameId));
    expect(fast.status).toBe(400);
    expect(await fast.json()).toMatchObject({ error: "interval_below_plan_floor", min_interval: 300 });

    // Somebody else's session sees no such frame.
    await signIn();
    expect((await getFrameVirtual(get(`/api/frames/${frameId}/virtual`), frameParams(frameId))).status).toBe(404);
    expect(
      (await postFrameVirtual(post(`/api/frames/${frameId}/virtual`, { reset_link: true }), frameParams(frameId))).status,
    ).toBe(404);
  });

  it("answers not_virtual for hardware, whatever it says about itself", async () => {
    const accountId = await signIn();
    const [link] = await db
      .insert(linkedClients)
      .values({
        accountId,
        clientKind: "frame",
        providerClientMetadata: { requestedScopes: ["frame:managed"] },
        publicDisplayName: "Pretender",
        tokenReference: "pretender",
      })
      .returning();
    const [frame] = await db
      .insert(frames)
      .values({
        accountId,
        hardware: { platform: "virtual" },
        linkedClientId: link!.id,
        name: "Pretender",
        publicKey: "x",
        status: "active",
      })
      .returning();
    const response = await getFrameVirtual(get(`/api/frames/${frame!.id}/virtual`), frameParams(frame!.id));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_virtual" });
    // The frame itself is there as ever.
    expect((await getFrame(get(`/api/frames/${frame!.id}`), frameParams(frame!.id))).status).toBe(200);
  });
});

describe("the view link", () => {
  async function drawn() {
    const accountId = await signIn();
    await subscribe(accountId, 2);
    const created = await createOne({ height: 16, name: "Lobby <b>", width: 32 });
    const frameId = created.json.frame!.id;
    const token = tokenOf(created.json.virtual!);
    return { accountId, frameId, token };
  }

  // What the hub does after a render.
  async function draw(frameId: string, shade: number) {
    const png = encodePng(new Uint8Array(32 * 16 * 4).fill(shade), 32, 16);
    await storeFrameAssetFile(db, frameId, { content: png, contentType: "image/png", path: frameImageAssetPath, thumb: false });
    await db
      .update(virtualFrames)
      .set({ imageVersion: `version-${shade}`, renderedAt: new Date() })
      .where(eq(virtualFrames.frameId, frameId));
    return png;
  }

  it("shows the picture to whoever holds it, with no session at all", async () => {
    const { frameId, token } = await drawn();
    cookieJar.clear();

    // Before the first render: a page that says so, no picture, and the look
    // itself is what asks the hub for one.
    const empty = await getViewPage(get(`/v/${token}`), tokenParams(token));
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(empty.headers.get("referrer-policy")).toBe("no-referrer");
    const emptyHtml = await empty.text();
    expect(emptyHtml).toContain("has not drawn anything yet");
    expect(emptyHtml).toContain("<title>Lobby &lt;b&gt;</title>");
    expect((await getViewImage(get(`/v/${token}/image`), tokenParams(token))).status).toBe(404);
    const [stamped] = await db.select().from(virtualFrames).where(eq(virtualFrames.frameId, frameId));
    expect(stamped!.viewedAt).not.toBeNull();

    const png = await draw(frameId, 200);
    const status = await getViewStatus(get(`/v/${token}/status`), tokenParams(token));
    expect(await status.json()).toMatchObject({ height: 16, interval_seconds: 300, version: "version-200", width: 32 });

    const image = await getViewImage(get(`/v/${token}/image`), tokenParams(token));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("etag")).toBe('"version-200"');
    expect(image.headers.get("cache-control")).toBe("private, no-cache");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);

    // Unchanged: a browser that has it is told so, without the bytes.
    const again = await getViewImage(
      get(`/v/${token}/image`, { "if-none-match": '"version-200"' }),
      tokenParams(token),
    );
    expect(again.status).toBe(304);
    await draw(frameId, 10);
    const changed = await getViewImage(
      get(`/v/${token}/image`, { "if-none-match": '"version-200"' }),
      tokenParams(token),
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).toBe('"version-10"');

    const page = await (await getViewPage(get(`/v/${token}`), tokenParams(token))).text();
    expect(page).toContain(`src="/v/${token}/image?v=version-10"`);
  });

  it("says nothing to a link that is wrong, replaced or whose frame is gone", async () => {
    const { frameId, token } = await drawn();
    await draw(frameId, 50);
    for (const bad of ["vf_0123456789abcdef0123456789abcdef", "nope", `${token}x`]) {
      expect((await getViewImage(get(`/v/${bad}/image`), tokenParams(bad))).status, bad).toBe(404);
      expect((await getViewStatus(get(`/v/${bad}/status`), tokenParams(bad))).status, bad).toBe(404);
      const page = await getViewPage(get(`/v/${bad}`), tokenParams(bad));
      expect(page.status, bad).toBe(404);
      expect(await page.text()).toBe("This link does not show a frame any more.");
    }

    const [frame] = await db.select().from(frames).where(eq(frames.id, frameId));
    await revokeFrame(db, frame!);
    expect((await getViewImage(get(`/v/${token}/image`), tokenParams(token))).status).toBe(404);
    expect((await getViewPage(get(`/v/${token}`), tokenParams(token))).status).toBe(404);
  });
});
