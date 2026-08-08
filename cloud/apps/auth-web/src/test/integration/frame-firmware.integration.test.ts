// Device-authed OTA routes + the notify_update_available queue verb, end to
// end against a real enrollment (docs/cloud-frames.md "Signed OTA"; provider
// half of cloud/docs/cloud-workspace-gaps.md item 6).
//
// The bearer here is the frame's ENROLLMENT access token — the same
// linked-client credential the management WebSocket authenticates with — so
// these tests enroll a real frame through the claim-token flow and speak as
// the device. GitHub is the only thing mocked.
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createDb, frameCommands, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mintClaimToken } from "../../../app/api/frames/claim-tokens/route";
import { POST as enrollFrame } from "../../../app/api/frames/enroll/route";
import { POST as sendCommand } from "../../../app/api/frames/[frameId]/command/route";
import { POST as confirmFrame } from "../../../app/api/frames/[frameId]/confirm/route";
import { POST as revokeFrameRoute } from "../../../app/api/frames/[frameId]/revoke/route";
import { GET as getFirmwareManifest } from "../../../app/api/frames/[frameId]/firmware/manifest/route";
import { GET as getFirmwareDownload } from "../../../app/api/frames/[frameId]/firmware/download/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

// A `.dev-firmware/` directory at the cloud workspace root (the local
// signed-OTA test rig) would otherwise outrank every mocked release below and
// answer these routes with whatever image happens to sit there.
vi.mock("../../lib/firmware-release", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  devFirmwareOverride: () => Promise.resolve(undefined),
}));

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

const fetchMock = vi.fn<typeof fetch>();

const firmwareBytes = new Uint8Array(64).fill(0xa5);
const minisigText =
  "untrusted comment: signature from FrameOS firmware key\n" +
  "RWQfakeSignatureBase64\n" +
  "trusted comment: frameos frameos-2026.8.1-esp32-s3-generic.bin\n" +
  "RWQfakeGlobalSignature\n";

// OTA serves the bare app image (`…-app.bin`), never the merged flash image
// a USB flasher writes — see otaAssets in src/lib/firmware-release.ts. The
// merged asset is in the fixture precisely because it must be ignored here.
function releasePayload(options: { signed?: boolean } = {}) {
  const signed = options.signed !== false;
  return {
    assets: [
      {
        browser_download_url:
          "https://github.com/FrameOS/frameos/releases/download/v2026.8.1/frameos-2026.8.1-esp32-s3-generic.bin",
        name: "frameos-2026.8.1-esp32-s3-generic.bin",
        size: 4096,
      },
      {
        browser_download_url:
          "https://github.com/FrameOS/frameos/releases/download/v2026.8.1/frameos-2026.8.1-esp32-s3-generic.bin.minisig",
        name: "frameos-2026.8.1-esp32-s3-generic.bin.minisig",
        size: minisigText.length,
      },
      {
        browser_download_url:
          "https://github.com/FrameOS/frameos/releases/download/v2026.8.1/frameos-2026.8.1-esp32-s3-generic-app.bin",
        name: "frameos-2026.8.1-esp32-s3-generic-app.bin",
        size: firmwareBytes.length,
      },
      ...(signed
        ? [
            {
              browser_download_url:
                "https://github.com/FrameOS/frameos/releases/download/v2026.8.1/frameos-2026.8.1-esp32-s3-generic-app.bin.minisig",
              name: "frameos-2026.8.1-esp32-s3-generic-app.bin.minisig",
              size: minisigText.length,
            },
          ]
        : []),
    ],
    tag_name: "v2026.8.1",
  };
}

function mockGitHub(release: unknown = releasePayload()) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(Response.json(release));
    }
    if (url.startsWith("https://github.com/")) {
      if (url.endsWith(".minisig")) {
        return Promise.resolve(new Response(minisigText));
      }
      return Promise.resolve(
        new Response(firmwareBytes.slice(), {
          headers: { "content-length": String(firmwareBytes.length) },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  vi.stubGlobal("fetch", fetchMock);
  mockGitHub();
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

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
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

function getRequest(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), { headers, method: "GET" });
}

const routeParams = (frameId: string) => ({
  params: Promise.resolve({ frameId }),
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `firmware-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Firmware User ${userCounter}`,
    email: `firmware-${userCounter}@example.com`,
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

function devicePublicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function enrolledFrame() {
  const accountId = await signIn();
  const mintResponse = await mintClaimToken(
    postJson("/api/frames/claim-tokens", { name: "OTA frame" }, { origin: baseUrl }),
  );
  expect(mintResponse.status).toBe(200);
  const { claim_token } = (await mintResponse.json()) as { claim_token: string };
  const response = await enrollFrame(
    postJson("/api/frames/enroll", {
      claim_token,
      frameos_version: "2026.8.0",
      hardware: { height: 480, platform: "esp32-s3", width: 800 },
      public_key: devicePublicKey(),
    }),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    access_token: string;
    frame_id: string;
  };
  return { accountId, ...payload };
}

const manifestPath = (frameId: string, platform = "esp32-s3-generic") =>
  `/api/frames/${frameId}/firmware/manifest?platform=${platform}`;
const downloadPath = (frameId: string, platform = "esp32-s3-generic") =>
  `/api/frames/${frameId}/firmware/download?platform=${platform}`;

describe("device-authed firmware manifest + download", () => {
  it("resolves the enrollment bearer to its frame and serves the signed manifest", async () => {
    const { access_token, frame_id } = await enrolledFrame();

    const response = await getFirmwareManifest(
      getRequest(manifestPath(frame_id), {
        authorization: `Bearer ${access_token}`,
      }),
      routeParams(frame_id),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      platform: "esp32-s3-generic",
      version: "2026.8.1",
      size: firmwareBytes.length,
      minisig: minisigText,
      downloadUrl: downloadPath(frame_id),
    });
  });

  it("401s a missing or garbage bearer without touching GitHub", async () => {
    const { frame_id } = await enrolledFrame();
    fetchMock.mockClear();

    const missing = await getFirmwareManifest(
      getRequest(manifestPath(frame_id)),
      routeParams(frame_id),
    );
    expect(missing.status).toBe(401);

    const garbage = await getFirmwareManifest(
      getRequest(manifestPath(frame_id), {
        authorization: "Bearer fc_link_not_a_real_token",
      }),
      routeParams(frame_id),
    );
    expect(garbage.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a real token used against another frame's id", async () => {
    const { access_token } = await enrolledFrame();
    const other = await enrolledFrame();
    fetchMock.mockClear();

    const response = await getFirmwareManifest(
      getRequest(manifestPath(other.frame_id), {
        authorization: `Bearer ${access_token}`,
      }),
      routeParams(other.frame_id),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "frame_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s a revoked frame's bearer", async () => {
    const { access_token, frame_id } = await enrolledFrame();
    const revoke = await revokeFrameRoute(
      postJson(`/api/frames/${frame_id}/revoke`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    expect(revoke.status).toBe(200);

    const response = await getFirmwareManifest(
      getRequest(manifestPath(frame_id), {
        authorization: `Bearer ${access_token}`,
      }),
      routeParams(frame_id),
    );
    expect(response.status).toBe(401);
  });

  it("409s unsigned_release when the release carries the .bin but no .minisig", async () => {
    const { access_token, frame_id } = await enrolledFrame();
    mockGitHub(releasePayload({ signed: false }));

    const manifest = await getFirmwareManifest(
      getRequest(manifestPath(frame_id), {
        authorization: `Bearer ${access_token}`,
      }),
      routeParams(frame_id),
    );
    expect(manifest.status).toBe(409);
    await expect(manifest.json()).resolves.toEqual({
      error: "unsigned_release",
      platform: "esp32-s3-generic",
      release: "v2026.8.1",
    });

    // The download refuses too: the device must never be offered an image it
    // cannot verify.
    const download = await getFirmwareDownload(
      getRequest(downloadPath(frame_id), {
        authorization: `Bearer ${access_token}`,
      }),
      routeParams(frame_id),
    );
    expect(download.status).toBe(409);
  });

  it("streams the download for the frame's own bearer", async () => {
    const { access_token, frame_id } = await enrolledFrame();

    const response = await getFirmwareDownload(
      getRequest(downloadPath(frame_id), {
        authorization: `Bearer ${access_token}`,
      }),
      routeParams(frame_id),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-frameos-release")).toBe("v2026.8.1");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(firmwareBytes);
  });
});

describe("the notify_update_available queue verb", () => {
  it("enqueues durably with the long advisory TTL, superseding earlier ones", async () => {
    const { frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );

    const first = await sendCommand(
      postJson(
        `/api/frames/${frame_id}/command`,
        { type: "notify_update_available" },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as { command_id: string };

    const second = await sendCommand(
      postJson(
        `/api/frames/${frame_id}/command`,
        { type: "notify_update_available" },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(second.status).toBe(200);

    const rows = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((row) => row.id === firstPayload.command_id);
    const secondRow = rows.find((row) => row.id !== firstPayload.command_id);
    // Repeat clicks supersede: one pending notification at a time.
    expect(firstRow?.status).toBe("expired");
    expect(firstRow?.error).toBe("superseded");
    expect(secondRow?.status).toBe("pending");
    // Advisory TTL: hours, not the 5-minute action window — a battery frame
    // asleep past 5 minutes must still hear about the update.
    const ttlMs =
      (secondRow?.expiresAt?.getTime() ?? 0) -
      (secondRow?.createdAt?.getTime() ?? 0);
    expect(ttlMs).toBeGreaterThan(12 * 60 * 60 * 1000);
  });
});
