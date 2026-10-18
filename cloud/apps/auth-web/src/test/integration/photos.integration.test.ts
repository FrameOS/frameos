// The cloud's photo library end to end (docs/photos.md is the contract):
// the owner routes with a real session against a real Postgres and the
// filesystem object store, the share routes with no session at all, and the
// scan gate's consequences (422, the hit row, the suspension, every share
// link 404).
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import sharp from "sharp";
import {
  accountIdentities,
  accounts,
  auditEvents,
  createDb,
  frames,
  linkedClients,
  photoBlockedHashes,
  photoEntries,
  photoScanHits,
  photoShares,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postColors } from "../../../app/api/photos/colors/route";
import { GET as getFile } from "../../../app/api/photos/file/route";
import { GET as getFiles } from "../../../app/api/photos/files/route";
import { POST as postDelete } from "../../../app/api/photos/delete/route";
import { POST as postFolders } from "../../../app/api/photos/folders/route";
import { POST as postMove } from "../../../app/api/photos/move/route";
import { POST as postRename } from "../../../app/api/photos/rename/route";
import { POST as postResize } from "../../../app/api/photos/resize/route";
import { POST as postScene } from "../../../app/api/photos/scene/route";
import { GET as getShared } from "../../../app/api/photos/shared/[token]/route";
import { GET as getSharedFile } from "../../../app/api/photos/shared/[token]/file/route";
import { GET as getSharedPhoto } from "../../../app/api/photos/shared/[token]/photo/route";
import { DELETE as deleteShare } from "../../../app/api/photos/shares/[token]/route";
import { GET as getShares, POST as postShares } from "../../../app/api/photos/shares/route";
import { GET as getStatus } from "../../../app/api/photos/status/route";
import { GET as getThumb } from "../../../app/api/photos/thumb/route";
import { POST as postUpload } from "../../../app/api/photos/upload/route";
import { GET as getMetadata, POST as postMetadata } from "../../../app/api/photos/metadata/route";
import { objectStore } from "../../lib/object-store";
import { readPhotoMetadataBytes, removePhotoMetadataBytes } from "../../lib/photos/metadata";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";
import { hashSecret } from "../../lib/secrets";

// A tiny photo quota for this file (read once, when usage.ts loads), so the
// 507 is reachable with handmade images of a few hundred bytes.
vi.hoisted(() => {
  process.env.FRAMEOS_CLOUD_MAX_PHOTO_MB = "0.01";
  process.env.FRAMEOS_CLOUD_MAX_UNVERIFIED_PHOTO_MB = "0.005";
});
const quotaBytes = Math.round(0.01 * 1024 * 1024);
const unverifiedQuotaBytes = Math.round(0.005 * 1024 * 1024);

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

// The filesystem store has no bucket endpoint and no public alias; this
// switch gives it both, so the share file route's redirect can be exercised
// too (and shown to never use the alias).
const cdn = vi.hoisted(() => ({ base: undefined as string | undefined }));
vi.mock("../../lib/object-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/object-store")>();
  return {
    ...actual,
    objectStore: () => {
      const store = actual.objectStore();
      return {
        ...store,
        publicUrl: (key: string) => (cdn.base ? `${cdn.base}/public/${key}` : store.publicUrl(key)),
        signedUrl: async (key: string, expiresInSeconds: number) =>
          cdn.base
            ? `${cdn.base}/signed/${key}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=test`
            : store.signedUrl(key, expiresInSeconds),
      };
    },
  };
});

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
  cdn.base = undefined;
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "");
  vi.stubEnv(
    "FRAMEOS_PHOTO_UPLOAD_DIR",
    mkdtempSync(join(tmpdir(), "frameos-cloud-test-photo-uploads-")),
  );
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
  vi.unstubAllEnvs();
});

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

/** A frame of the account, enough of one for a share link to point at. */
async function seedFrame(accountId: string, name: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: name,
      tokenReference: hashSecret(`fc_link_photos_${accountId}_${name}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({ accountId, linkedClientId: client!.id, name, publicKey: rawPublicKeyBase64(), status: "active" })
    .returning();
  return frame!;
}

const providerSubjects = new Map<string, string>();

/** Back to an account signIn() made earlier. */
async function signInAs(accountId: string) {
  const providerSubject = providerSubjects.get(accountId)!;
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
}

async function signIn({ emailVerified = true }: { emailVerified?: boolean } = {}) {
  userCounter += 1;
  const providerSubject = `photo-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Photo User ${userCounter}`,
    email: `photos-${userCounter}@example.com`,
    emailVerified,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  providerSubjects.set(accountId, providerSubject);
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function signOut() {
  cookieJar.clear();
}

// Handmade images: only the header is real, which is all the cloud reads.
// `salt` makes each one's bytes (and SHA-256) its own.
function png(width: number, height: number, salt = "") {
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
    size,
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.from(`png-body-${salt}`),
  ]);
}

/** A photo from the metadata corpus (docs/photo-metadata-fixtures.json). */
function metadataFixture(name: string) {
  return readFileSync(join(__dirname, "..", "..", "..", "..", "..", "..", "docs", "photo-metadata-fixtures", name));
}

/** An image sharp can read (the two above are headers only). */
function realPng(width: number, height: number) {
  return sharp({ create: { background: "#3366cc", channels: 3, height, width } }).png().toBuffer();
}

function jpeg(width: number, height: number, salt = "") {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255]),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda]),
    Buffer.from(`jpeg-body-${salt}`),
  ]);
}

function get(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

function postJson(path: string, body: unknown, origin: string | null = baseUrl) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    method: "POST",
  });
}

function postBytes(path: string, params: Record<string, string>, body: Buffer) {
  return new NextRequest(new URL(`${path}?${new URLSearchParams(params).toString()}`, baseUrl), {
    body: new Uint8Array(body),
    headers: { "content-type": "application/octet-stream", origin: baseUrl },
    method: "POST",
  });
}

let uploadCounter = 0;
async function upload(folder: string, filename: string, body: Buffer, uploadId?: string) {
  uploadCounter += 1;
  return postUpload(
    postBytes("/api/photos/upload", {
      complete: "1",
      filename,
      offset: "0",
      path: folder,
      upload_id: uploadId ?? `single-${uploadCounter}-upload`,
    }, body),
  );
}

async function listFolder(path: string) {
  const response = await getFiles(get(`/api/photos/files?path=${encodeURIComponent(path)}`));
  expect(response.status).toBe(200);
  return ((await response.json()) as { entries: Record<string, unknown>[] }).entries;
}

const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

async function share(path: string) {
  const response = await postShares(postJson("/api/photos/shares", { path }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { share: { frame_id: string | null; path: string; token: string; url: string } })
    .share;
}

describe("photo library: status and listing", () => {
  it("needs a session", async () => {
    expect((await getStatus(get("/api/photos/status"))).status).toBe(401);
    expect((await getFiles(get("/api/photos/files?path="))).status).toBe(401);
  });

  it("gives an account without a verified email the smaller quota, and the full one once verified", async () => {
    const accountId = await signIn({ emailVerified: false });
    const status = async () =>
      ((await (await getStatus(get("/api/photos/status"))).json()) as { quota_bytes: number }).quota_bytes;
    expect(await status()).toBe(unverifiedQuotaBytes);
    // The refusal uses the same number as the display.
    const filler = Buffer.concat([png(5, 5, "unverified"), Buffer.alloc(unverifiedQuotaBytes, 7)]);
    const refused = await upload("", "big.png", filler);
    expect(refused.status).toBe(507);
    expect(await refused.json()).toMatchObject({ error: "storage_quota_exceeded", max_bytes: unverifiedQuotaBytes });
    await db.update(accountIdentities).set({ emailVerified: true }).where(eq(accountIdentities.accountId, accountId));
    expect(await status()).toBe(quotaBytes);
  });

  it("describes the cloud library", async () => {
    await signIn();
    const response = await getStatus(get("/api/photos/status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepts: ["image/jpeg", "image/png", "image/gif", "image/webp"],
      free_bytes: null,
      location: null,
      max_upload_bytes: 250 * 1024 * 1024,
      message: null,
      problem: null,
      quota_bytes: quotaBytes,
      ready: true,
      scanning: ["hash_list"],
      used_bytes: 0,
    });
  });

  it("lists the scanners that are configured", async () => {
    await signIn();
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "key");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const body = (await (await getStatus(get("/api/photos/status"))).json()) as {
      scanning: string[];
    };
    expect(body.scanning).toEqual(["hash_list", "photodna"]);
  });

  it("refuses bad paths and unknown folders", async () => {
    await signIn();
    expect((await getFiles(get("/api/photos/files?path=..%2Fx"))).status).toBe(400);
    expect((await getFiles(get("/api/photos/files?path=.hidden"))).status).toBe(400);
    expect((await getFiles(get("/api/photos/files?path=nope"))).status).toBe(404);
    expect(await listFolder("")).toEqual([]);
  });
});

describe("photo library: uploads", () => {
  it("stores a file, creating its folders, and lists it with its size and cover", async () => {
    const accountId = await signIn();
    const bytes = png(1920, 1080, "beach");
    const response = await upload("Summer 2026/Beach", "beach.png", bytes);
    expect(response.status).toBe(200);
    const { entry } = (await response.json()) as { entry: Record<string, unknown> };
    expect(entry).toMatchObject({
      content_type: "image/png",
      height: 1080,
      kind: "file",
      name: "beach.png",
      path: "Summer 2026/Beach/beach.png",
      size: bytes.length,
      status: "ready",
      width: 1920,
    });

    const root = await listFolder("");
    expect(root).toEqual([
      expect.objectContaining({
        cover: "Summer 2026/Beach/beach.png",
        files: 1,
        items: 1,
        kind: "folder",
        path: "Summer 2026",
        size: bytes.length,
      }),
    ]);

    // Random object keys under the account, never the content hash.
    const [row] = await db
      .select()
      .from(photoEntries)
      .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.kind, "file")));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(row?.sha256).toBe(sha256);
    expect(row?.objectKey).toMatch(new RegExp(`^photos/${accountId}/[0-9a-f]{32}$`));
    expect(row?.objectKey).not.toContain(sha256);

    const file = await getFile(get("/api/photos/file?path=Summer%202026%2FBeach%2Fbeach.png"));
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toBe("sandbox");
    expect(file.headers.get("cache-control")).toMatch(/^private/);
    const download = await getFile(
      get("/api/photos/file?path=Summer%202026%2FBeach%2Fbeach.png&download=1"),
    );
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="beach.png"/);

    const status = (await (await getStatus(get("/api/photos/status"))).json()) as {
      used_bytes: number;
    };
    expect(status.used_bytes).toBe(bytes.length);
  });

  it("gives a taken name a (2) suffix", async () => {
    await signIn();
    expect((await upload("", "a.png", png(10, 10, "1"))).status).toBe(200);
    const second = await upload("", "a.png", png(10, 10, "2"));
    const third = await upload("", "a.png", png(10, 10, "3"));
    expect(((await second.json()) as { entry: { path: string } }).entry.path).toBe("a (2).png");
    expect(((await third.json()) as { entry: { path: string } }).entry.path).toBe("a (3).png");
  });

  it("assembles chunks, and answers a gap with 409", async () => {
    await signIn();
    const bytes = jpeg(4032, 3024, "chunked".repeat(20));
    const parts = [bytes.subarray(0, 40), bytes.subarray(40, 90), bytes.subarray(90)];
    const chunk = (uploadId: string, offset: number, part: Buffer, complete: boolean) =>
      postUpload(
        postBytes("/api/photos/upload", {
          complete: complete ? "1" : "0",
          filename: "big.jpg",
          offset: String(offset),
          path: "Chunks",
          upload_id: uploadId,
        }, part),
      );

    const first = await chunk("chunked-upload-1", 0, parts[0]!, false);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ pending: true, received: 40 });
    // The second chunk goes missing: the third does not start where the
    // server's bytes end.
    const gap = await chunk("chunked-upload-1", 90, parts[2]!, true);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ error: "chunk_gap", received: 40 });
    // An upload id the server never saw is a gap too.
    expect((await chunk("chunked-upload-x", 40, parts[1]!, false)).status).toBe(409);

    // The client restarts under a new id.
    expect((await chunk("chunked-upload-2", 0, parts[0]!, false)).status).toBe(200);
    expect(await (await chunk("chunked-upload-2", 40, parts[1]!, false)).json()).toEqual({
      pending: true,
      received: 90,
    });
    const done = await chunk("chunked-upload-2", 90, parts[2]!, true);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { entry: Record<string, unknown> }).entry).toMatchObject({
      content_type: "image/jpeg",
      height: 3024,
      path: "Chunks/big.jpg",
      size: bytes.length,
      width: 4032,
    });
    const file = await getFile(get("/api/photos/file?path=Chunks%2Fbig.jpg"));
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("stores a photo as sent, whole or in chunks, and reads what it carries", async () => {
    const accountId = await signIn();
    const phone = metadataFixture("exif-gps.jpg");
    const metadata = await readPhotoMetadataBytes(phone);
    expect(metadata.location).not.toBeNull();
    const pin = { latitude: metadata.location!.latitude, longitude: metadata.location!.longitude };

    const whole = await upload("Trip", "whole.jpg", phone);
    expect(whole.status).toBe(200);
    // Turned 6: the sides swap the way a browser shows it.
    expect(((await whole.json()) as { entry: Record<string, unknown> }).entry).toMatchObject({
      height: 24,
      location: pin,
      size: phone.length,
      width: 16,
    });
    const half = Math.floor(phone.length / 2);
    const chunk = (offset: number, part: Buffer, complete: boolean) =>
      postUpload(
        postBytes("/api/photos/upload", {
          complete: complete ? "1" : "0",
          filename: "chunked.jpg",
          offset: String(offset),
          path: "Trip",
          upload_id: "metadata-chunks",
        }, part),
      );
    expect((await chunk(0, phone.subarray(0, half), false)).status).toBe(200);
    const done = await chunk(half, phone.subarray(half), true);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { entry: Record<string, unknown> }).entry).toMatchObject({
      location: pin,
      size: phone.length,
    });

    // The bytes exactly as sent, and the metadata in the row.
    for (const name of ["whole.jpg", "chunked.jpg"]) {
      const file = await getFile(get(`/api/photos/file?path=Trip%2F${name}`));
      expect(Buffer.from(await file.arrayBuffer()).equals(phone)).toBe(true);
    }
    const digest = createHash("sha256").update(phone).digest("hex");
    const rows = await db
      .select({ metadata: photoEntries.metadata, sha256: photoEntries.sha256, size: photoEntries.sizeBytes })
      .from(photoEntries)
      .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.kind, "file")));
    expect(rows).toEqual([
      { metadata, sha256: digest, size: phone.length },
      { metadata, sha256: digest, size: phone.length },
    ]);
    // The chunks do not stay on the disk.
    const parked = join(process.env.FRAMEOS_PHOTO_UPLOAD_DIR ?? "", accountId.toLowerCase());
    expect(existsSync(parked) ? readdirSync(parked) : []).toEqual([]);

    // The listing pins both; the metadata route has the rest.
    expect((await listFolder("Trip")).map((entry) => entry.location)).toEqual([pin, pin]);
    const read = await getMetadata(get("/api/photos/metadata?path=Trip%2Fwhole.jpg"));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ metadata, path: "Trip/whole.jpg" });
    // Frames never get the location.
    const trip = await share("Trip");
    const shared = await getShared(get(`/api/photos/shared/${trip.token}`), tokenParams(trip.token));
    const listing = (await shared.json()) as { files: Record<string, unknown>[] };
    expect(listing.files).toHaveLength(2);
    for (const file of listing.files) {
      expect(file).not.toHaveProperty("location");
    }
  });

  it("removes a photo's location in place, or all its metadata, and keeps the rest of it", async () => {
    const accountId = await signIn();
    const phone = metadataFixture("exif-gps.jpg");
    await upload("Trip", "a.jpg", phone);
    await upload("Trip", "b.jpg", phone);
    expect((await postColors(postJson("/api/photos/colors", { colors: { whites: -10 }, path: "Trip/a.jpg" }))).status).toBe(200);
    const rowOf = async (path: string) => {
      const [row] = await db
        .select()
        .from(photoEntries)
        .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)));
      return row!;
    };
    const before = await rowOf("Trip/a.jpg");
    const remove = (paths: string[], removal: string) =>
      postMetadata(postJson("/api/photos/metadata", { paths, remove: removal }));

    const located = (await removePhotoMetadataBytes(phone, "location")).body as Buffer;
    const response = await remove(["Trip/a.jpg"], "location");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: 1,
      entries: [
        expect.objectContaining({
          colors: { whites: -10 },
          location: null,
          path: "Trip/a.jpg",
          size: phone.length,
        }),
      ],
    });
    const file = await getFile(get("/api/photos/file?path=Trip%2Fa.jpg"));
    expect(Buffer.from(await file.arrayBuffer()).equals(located)).toBe(true);
    const after = await rowOf("Trip/a.jpg");
    expect(after.objectKey).not.toBe(before.objectKey);
    expect(after.sha256).toBe(createHash("sha256").update(located).digest("hex"));
    expect(after.metadata).toEqual(await readPhotoMetadataBytes(located));
    expect([after.thumbObjectKey, after.createdAt, after.colors]).toEqual([
      before.thumbObjectKey,
      before.createdAt,
      before.colors,
    ]);
    // The old object is gone; the same request again changes nothing.
    expect(await objectStore().get(before.objectKey!)).toBeUndefined();
    expect(await (await remove(["Trip/a.jpg"], "location")).json()).toMatchObject({ changed: 0 });

    // Everything, from a selection, in request order.
    const everything = await remove(["Trip/b.jpg", "Trip/a.jpg"], "all");
    const body = (await everything.json()) as { changed: number; entries: { path: string }[] };
    expect(body.changed).toBe(2);
    expect(body.entries.map((entry) => entry.path)).toEqual(["Trip/b.jpg", "Trip/a.jpg"]);
    const stripped = (await removePhotoMetadataBytes(phone, "all")).body as Buffer;
    const bFile = await getFile(get("/api/photos/file?path=Trip%2Fb.jpg"));
    expect(Buffer.from(await bFile.arrayBuffer()).equals(stripped)).toBe(true);
    const read = (await (await getMetadata(get("/api/photos/metadata?path=Trip%2Fb.jpg"))).json()) as {
      metadata: { blocks: string[]; fields: unknown[]; location: unknown };
    };
    expect(read.metadata).toEqual({
      blocks: [],
      fields: [{ group: "Image", name: "Orientation", value: 6 }],
      location: null,
    });
  });

  it("checks every path before it changes any", async () => {
    await signIn();
    const phone = metadataFixture("exif-gps.jpg");
    await upload("Trip", "a.jpg", phone);
    await upload("Trip", "flat.png", await realPng(4, 3));
    const remove = (body: unknown, origin?: string | null) =>
      postMetadata(postJson("/api/photos/metadata", body, origin));

    const missing = await remove({ paths: ["Trip/a.jpg", "Trip/none.jpg"], remove: "location" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not_found");
    expect((await remove({ paths: ["Trip"], remove: "all" })).status).toBe(400);
    expect((await remove({ paths: [], remove: "all" })).status).toBe(400);
    expect((await remove({ paths: ["../a.jpg"], remove: "all" })).status).toBe(400);
    expect((await remove({ paths: ["Trip/a.jpg"], remove: "gps" })).status).toBe(400);
    expect((await remove({ paths: ["Trip/a.jpg"], remove: "all" }, null)).status).toBe(403);
    // Nothing changed.
    const file = await getFile(get("/api/photos/file?path=Trip%2Fa.jpg"));
    expect(Buffer.from(await file.arrayBuffer()).equals(phone)).toBe(true);
    // A photo with nothing to remove is left as it is.
    expect(await (await remove({ paths: ["Trip/flat.png"], remove: "all" })).json()).toMatchObject({ changed: 0 });

    expect((await getMetadata(get("/api/photos/metadata?path=Trip"))).status).toBe(400);
    expect((await getMetadata(get("/api/photos/metadata?path=Trip%2Fnone.jpg"))).status).toBe(404);
    expect((await getMetadata(get("/api/photos/metadata?path=..%2Fa.jpg"))).status).toBe(400);
  });

  it("reads the metadata of a photo stored before it existed: listed, or asked for", async () => {
    const accountId = await signIn();
    const phone = metadataFixture("exif-gps.jpg");
    await upload("Old", "a.jpg", phone);
    await upload("Old", "b.jpg", phone);
    const metadata = await readPhotoMetadataBytes(phone);
    const forget = () =>
      db
        .update(photoEntries)
        .set({ metadata: null })
        .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.kind, "file")));
    const stored = async () =>
      (
        await db
          .select({ metadata: photoEntries.metadata, path: photoEntries.path })
          .from(photoEntries)
          .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.kind, "file")))
      ).sort((x, y) => x.path.localeCompare(y.path));

    await forget();
    // Not read yet: no pin. The listing reads them once it has answered
    // (after(); called outside a request, before the handler returns).
    expect((await listFolder("Old")).map((entry) => entry.location)).toEqual([null, null]);
    expect(await stored()).toEqual([
      { metadata, path: "Old/a.jpg" },
      { metadata, path: "Old/b.jpg" },
    ]);
    expect((await listFolder("Old")).every((entry) => entry.location !== null)).toBe(true);

    // On demand, one photo.
    await forget();
    const read = await getMetadata(get("/api/photos/metadata?path=Old%2Fa.jpg"));
    expect(((await read.json()) as { metadata: unknown }).metadata).toEqual(metadata);
    expect((await stored())[0]).toEqual({ metadata, path: "Old/a.jpg" });
  });

  it("refuses what it will not store: types, sizes, names, the quota", async () => {
    const accountId = await signIn();
    const text = await upload("", "notes.jpg", Buffer.from("just some text, not an image at all"));
    expect(text.status).toBe(415);
    expect(await text.json()).toMatchObject({ error: "unsupported_type" });
    // BMP is playable on a frame but the cloud only stores what it can scan.
    const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(60, 1)]);
    expect((await upload("", "old.bmp", bmp)).status).toBe(415);

    const tooBigChunk = await upload("", "huge.png", Buffer.alloc(4 * 1024 * 1024 + 1, 1));
    expect(tooBigChunk.status).toBe(413);
    const pastLimit = await postUpload(
      postBytes("/api/photos/upload", {
        complete: "1",
        filename: "huge.png",
        offset: String(250 * 1024 * 1024),
        path: "",
        upload_id: "past-the-limit",
      }, png(1, 1)),
    );
    expect(pastLimit.status).toBe(413);

    expect((await upload("", ".hidden.png", png(1, 1))).status).toBe(400);
    expect((await upload("a/../b", "x.png", png(1, 1))).status).toBe(400);
    const badId = await postUpload(
      postBytes("/api/photos/upload", { filename: "x.png", path: "", upload_id: "bad" }, png(1, 1)),
    );
    expect(badId.status).toBe(400);

    // Fill the quota, then one more byte is a 507.
    const filler = Buffer.concat([png(5, 5, "filler"), Buffer.alloc(quotaBytes - 200, 7)]);
    expect((await upload("", "filler.png", filler)).status).toBe(200);
    const over = await upload("", "over.png", png(5, 5, "x".repeat(200)));
    expect(over.status).toBe(507);
    expect(await over.json()).toMatchObject({
      error: "storage_quota_exceeded",
      max_bytes: quotaBytes,
    });
    const rows = await db
      .select({ path: photoEntries.path })
      .from(photoEntries)
      .where(eq(photoEntries.accountId, accountId));
    expect(rows.map((row) => row.path)).toEqual(["filler.png"]);
  });

  it("checks the origin of a mutation", async () => {
    await signIn();
    const response = await postFolders(postJson("/api/photos/folders", { path: "x" }, null));
    expect(response.status).toBe(403);
  });
});

describe("photo library: thumbnails", () => {
  it("makes the thumbnail when it stores the photo", async () => {
    await signIn();
    const response = await upload("", "a.png", await realPng(640, 480));
    expect(response.status).toBe(200);
    const served = await getThumb(get("/api/photos/thumb?path=a.png&v=1"));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 512, 384]);
  });

  it("stores a photo it cannot read, without a thumbnail", async () => {
    await signIn();
    // A PNG header and no pixels: sniffed as a PNG, unreadable to sharp.
    expect((await upload("", "b.png", png(4000, 3000, "thumb"))).status).toBe(200);
    expect((await listFolder("")).map((entry) => entry.path)).toEqual(["b.png"]);
    expect((await getThumb(get("/api/photos/thumb?path=b.png"))).status).toBe(404);
    expect((await getThumb(get("/api/photos/thumb?path=missing.png"))).status).toBe(404);
  });
});

describe("photo library: folders, moves, renames, deletes", () => {
  it("creates folders with their parents, and 409s an existing path", async () => {
    await signIn();
    const created = await postFolders(postJson("/api/photos/folders", { path: "Albums/2026" }));
    expect(created.status).toBe(200);
    expect(((await created.json()) as { entry: Record<string, unknown> }).entry).toMatchObject({
      cover: null,
      files: 0,
      items: 0,
      kind: "folder",
      path: "Albums/2026",
    });
    expect((await listFolder("")).map((entry) => entry.path)).toEqual(["Albums"]);
    expect((await postFolders(postJson("/api/photos/folders", { path: "Albums/2026" }))).status).toBe(409);
    expect((await postFolders(postJson("/api/photos/folders", { path: "" }))).status).toBe(400);
    expect((await postFolders(postJson("/api/photos/folders", { path: "a/.b" }))).status).toBe(400);
  });

  it("moves files and folders, suffixing taken names, and share links follow", async () => {
    await signIn();
    await upload("Summer", "a.png", png(10, 10, "a"));
    await upload("Summer/Inner", "b.png", png(10, 10, "b"));
    await upload("", "loose.png", png(10, 10, "loose"));
    await postFolders(postJson("/api/photos/folders", { path: "Albums/2026/Summer" }));
    const summerShare = await share("Summer");
    const innerShare = await share("Summer/Inner");

    const moved = await postMove(
      postJson("/api/photos/move", { paths: ["Summer", "loose.png", "Summer/Inner/b.png"], to: "Albums/2026" }),
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({
      moved: [
        { from: "Summer", to: "Albums/2026/Summer (2)" },
        { from: "loose.png", to: "Albums/2026/loose.png" },
        { from: "Summer/Inner/b.png", to: "Albums/2026/Summer (2)/Inner/b.png" },
      ],
    });
    expect((await listFolder("Albums/2026/Summer (2)/Inner")).map((entry) => entry.path)).toEqual([
      "Albums/2026/Summer (2)/Inner/b.png",
    ]);
    const shares = (await (await getShares(get("/api/photos/shares"))).json()) as {
      shares: { path: string; token: string }[];
    };
    expect(shares.shares.map((row) => [row.token, row.path])).toEqual([
      [summerShare.token, "Albums/2026/Summer (2)"],
      [innerShare.token, "Albums/2026/Summer (2)/Inner"],
    ]);

    // Already there: left alone.
    const stay = await postMove(postJson("/api/photos/move", { paths: ["Albums/2026/loose.png"], to: "Albums/2026" }));
    expect(await stay.json()).toEqual({
      moved: [{ from: "Albums/2026/loose.png", to: "Albums/2026/loose.png" }],
    });
  });

  it("refuses a move into itself and a move with a missing path, changing nothing", async () => {
    await signIn();
    await upload("A/B", "x.png", png(10, 10, "x"));
    await upload("", "y.png", png(10, 10, "y"));
    expect((await postMove(postJson("/api/photos/move", { paths: ["A"], to: "A/B" }))).status).toBe(400);
    expect((await postMove(postJson("/api/photos/move", { paths: ["A"], to: "A" }))).status).toBe(400);
    const missing = await postMove(postJson("/api/photos/move", { paths: ["y.png", "nope.png"], to: "A" }));
    expect(missing.status).toBe(404);
    expect((await listFolder("")).map((entry) => entry.path)).toEqual(["A", "y.png"]);
    expect((await postMove(postJson("/api/photos/move", { paths: ["y.png"], to: "nowhere" }))).status).toBe(404);
    expect((await postMove(postJson("/api/photos/move", { paths: ["A"], to: "y.png" }))).status).toBe(400);
  });

  it("renames, 409s a taken name, and share links follow", async () => {
    await signIn();
    await upload("Trip", "a.png", png(10, 10, "a"));
    await upload("Trip", "b.png", png(10, 10, "b"));
    await postFolders(postJson("/api/photos/folders", { path: "Taken" }));
    const tripShare = await share("Trip");

    const renamed = await postRename(postJson("/api/photos/rename", { name: "Trip 2026", path: "Trip" }));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { entry: Record<string, unknown> }).entry).toMatchObject({
      files: 2,
      path: "Trip 2026",
    });
    const [row] = await db.select().from(photoShares).where(eq(photoShares.token, tripShare.token));
    expect(row?.path).toBe("Trip 2026");
    expect((await listFolder("Trip 2026")).map((entry) => entry.name)).toEqual(["a.png", "b.png"]);

    expect((await postRename(postJson("/api/photos/rename", { name: "Taken", path: "Trip 2026" }))).status).toBe(409);
    expect((await postRename(postJson("/api/photos/rename", { name: "b.png", path: "Trip 2026/a.png" }))).status).toBe(409);
    expect((await postRename(postJson("/api/photos/rename", { name: "x/y", path: "Trip 2026/a.png" }))).status).toBe(400);
    expect((await postRename(postJson("/api/photos/rename", { name: "z.png", path: "nope.png" }))).status).toBe(404);
  });

  it("deletes folders with their files, objects and share links", async () => {
    const accountId = await signIn();
    // A real image, for a thumbnail; the others have none.
    await upload("Old", "a.png", await realPng(100, 100));
    await upload("Old/Deep", "b.png", png(10, 10, "b"));
    await upload("", "keep.png", png(10, 10, "keep"));
    const oldShare = await share("Old/Deep");
    const keys = (
      await db.select().from(photoEntries).where(eq(photoEntries.accountId, accountId))
    )
      .filter((row) => row.path.startsWith("Old/"))
      .flatMap((row) => [row.objectKey, row.thumbObjectKey])
      .filter((key): key is string => Boolean(key));
    expect(keys).toHaveLength(3);

    const response = await postDelete(postJson("/api/photos/delete", { paths: ["Old", "missing.png"] }));
    expect(await response.json()).toEqual({ deleted: 1 });
    expect((await listFolder("")).map((entry) => entry.path)).toEqual(["keep.png"]);
    for (const key of keys) {
      expect(await objectStore().get(key)).toBeUndefined();
    }
    expect(await db.select().from(photoShares).where(eq(photoShares.accountId, accountId))).toEqual([]);
    signOut();
    expect((await getShared(get(`/api/photos/shared/${oldShare.token}`), tokenParams(oldShare.token))).status).toBe(404);

    const audit = await db
      .select({ eventType: auditEvents.eventType, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.accountId, accountId));
    expect(audit.map((event) => event.eventType)).toContain("photos.folder_deleted");
    expect(audit.map((event) => event.eventType)).toContain("photos.share_created");
  });
});

describe("photo library: color profiles", () => {
  const graded = { saturation: 20, tones: { shadows: { amount: 10, hue: 200 } }, whites: -30 };

  async function setColors(path: string, colors: unknown) {
    return postColors(postJson("/api/photos/colors", { colors, path }));
  }

  async function sharedListing(token: string) {
    const response = await getShared(get(`/api/photos/shared/${token}`), tokenParams(token));
    expect(response.status).toBe(200);
    return (await response.json()) as {
      files: { colors: unknown; path: string }[];
      updated_at: number;
    };
  }

  async function sharedPick(token: string, index: number) {
    const response = await getSharedPhoto(
      get(`/api/photos/shared/${token}/photo?order=sequential&index=${index}`),
      tokenParams(token),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { photo: Record<string, unknown> }).photo;
  }

  it("stores a profile, lists it, and sends it to frames with the photo", async () => {
    await signIn();
    await upload("Album", "a.png", png(10, 10, "a"));
    await upload("Album", "b.png", png(10, 10, "b"));
    const album = await share("Album");

    // Every file entry carries the key, folders do not.
    expect((await listFolder("Album")).map((entry) => entry.colors)).toEqual([null, null]);
    const [albumEntry] = await listFolder("");
    expect(albumEntry).toMatchObject({ kind: "folder", path: "Album" });
    expect(albumEntry).not.toHaveProperty("colors");

    const before = await sharedListing(album.token);
    expect(before.files.map((file) => file.colors)).toEqual([null, null]);
    const response = await setColors("Album/a.png", graded);
    expect(response.status).toBe(200);
    const { entry } = (await response.json()) as { entry: Record<string, unknown> };
    expect(entry).toMatchObject({ colors: graded, kind: "file", name: "a.png", path: "Album/a.png" });
    expect((await listFolder("Album")).map((item) => [item.name, item.colors])).toEqual([
      ["a.png", graded],
      ["b.png", null],
    ]);

    signOut();
    const listing = await sharedListing(album.token);
    expect(listing.files.map((file) => [file.path, file.colors])).toEqual([
      ["a.png", graded],
      ["b.png", null],
    ]);
    expect(listing.updated_at).toBeGreaterThanOrEqual(before.updated_at);
    expect(await sharedPick(album.token, 0)).toMatchObject({ colors: graded, path: "a.png" });
    expect(await sharedPick(album.token, 1)).toMatchObject({ colors: null, path: "b.png" });
  });

  it("keeps the profile through moves and renames, and drops it with the photo", async () => {
    const accountId = await signIn();
    await upload("Album", "a.png", png(10, 10, "a"));
    await postFolders(postJson("/api/photos/folders", { path: "Elsewhere" }));
    expect((await setColors("Album/a.png", graded)).status).toBe(200);

    const renamed = await postRename(postJson("/api/photos/rename", { name: "c.png", path: "Album/a.png" }));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { entry: Record<string, unknown> }).entry).toMatchObject({
      colors: graded,
      path: "Album/c.png",
    });
    const moved = await postMove(postJson("/api/photos/move", { paths: ["Album/c.png"], to: "Elsewhere" }));
    expect(moved.status).toBe(200);
    expect((await listFolder("Elsewhere")).map((entry) => [entry.path, entry.colors])).toEqual([
      ["Elsewhere/c.png", graded],
    ]);
    // A folder rename rewrites the paths below it; the profile stays with the photo.
    expect((await postRename(postJson("/api/photos/rename", { name: "Moved", path: "Elsewhere" }))).status).toBe(200);
    expect((await listFolder("Moved"))[0]).toMatchObject({ colors: graded, path: "Moved/c.png" });

    // A new photo at the old path starts without one.
    expect((await upload("Album", "a.png", png(10, 10, "a2"))).status).toBe(200);
    expect((await listFolder("Album"))[0]).toMatchObject({ colors: null, path: "Album/a.png" });

    expect((await postDelete(postJson("/api/photos/delete", { paths: ["Moved/c.png"] }))).status).toBe(200);
    const rows = await db
      .select({ colors: photoEntries.colors, path: photoEntries.path })
      .from(photoEntries)
      .where(eq(photoEntries.accountId, accountId));
    expect(rows.filter((row) => row.colors !== null)).toEqual([]);
  });

  it("removes the profile with null or an empty object", async () => {
    await signIn();
    await upload("", "a.png", png(10, 10, "a"));
    for (const empty of [null, {}]) {
      expect((await setColors("a.png", graded)).status).toBe(200);
      expect((await listFolder(""))[0]).toMatchObject({ colors: graded, path: "a.png" });
      const response = await setColors("a.png", empty);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { entry: Record<string, unknown> }).entry.colors).toBeNull();
      expect((await listFolder(""))[0]).toMatchObject({ colors: null, path: "a.png" });
    }
  });

  it("refuses folders, files a frame cannot play, blocked and missing files, and bad profiles", async () => {
    const accountId = await signIn();
    await upload("Album", "a.png", png(10, 10, "a"));
    // The cloud sniffs the bytes, not the name: a PNG can be stored as notes.txt.
    expect((await upload("", "notes.txt", png(10, 10, "txt"))).status).toBe(200);

    const attempt = async (path: string, colors: unknown) => {
      const response = await setColors(path, colors);
      return { body: (await response.json()) as Record<string, unknown>, status: response.status };
    };
    expect(await attempt("Album", graded)).toMatchObject({ status: 400 });
    expect(await attempt("notes.txt", graded)).toMatchObject({ status: 400 });
    expect(await attempt("Album/a.png", [graded])).toMatchObject({
      body: { error: "invalid_colors" },
      status: 400,
    });
    expect(await attempt("Album/a.png", "warm")).toMatchObject({ status: 400 });
    expect(await attempt("Album/a.png", 3)).toMatchObject({ status: 400 });
    expect(await attempt("Album/a.png", true)).toMatchObject({ status: 400 });
    expect(await attempt("Album/a.png", undefined)).toMatchObject({ status: 400 });
    expect(await attempt("", graded)).toMatchObject({ status: 400 });
    expect(await attempt("../a.png", graded)).toMatchObject({ status: 400 });
    expect(await attempt("Album/missing.png", graded)).toMatchObject({ status: 404 });
    expect(await attempt("Nope/a.png", graded)).toMatchObject({ status: 404 });

    // 64 KB as JSON is the limit; one byte more is a 413.
    const atLimit = { k: "a".repeat(64 * 1024 - 8) };
    expect((await setColors("Album/a.png", atLimit)).status).toBe(200);
    expect(await attempt("Album/a.png", { k: "a".repeat(64 * 1024 - 7) })).toMatchObject({
      body: { error: "colors_too_large", max_bytes: 64 * 1024 },
      status: 413,
    });
    // Far past it: the body itself is refused before it is parsed.
    expect((await setColors("Album/a.png", { k: "a".repeat(1024 * 1024) })).status).toBe(413);

    // A file a scan blocked is not there as far as the owner's edits go.
    await db
      .update(photoEntries)
      .set({ status: "blocked" })
      .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, "Album/a.png")));
    expect(await attempt("Album/a.png", graded)).toMatchObject({ status: 404 });

    // None of the refusals touched the stored profile.
    const [row] = await db
      .select({ colors: photoEntries.colors })
      .from(photoEntries)
      .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, "Album/a.png")));
    expect(row?.colors).toEqual(atLimit);

    // A mutation like any other: the origin is checked.
    const noOrigin = await postColors(
      postJson("/api/photos/colors", { colors: graded, path: "notes.txt" }, null),
    );
    expect(noOrigin.status).toBe(403);
  });

  it("keeps names ending in .frameos.json for profiles", async () => {
    await signIn();
    await upload("Album", "a.png", png(10, 10, "a"));
    for (const name of ["a.png.frameos.json", "X.FrameOS.JSON"]) {
      const renameFile = await postRename(postJson("/api/photos/rename", { name, path: "Album/a.png" }));
      expect(renameFile.status, name).toBe(400);
      const renameFolder = await postRename(postJson("/api/photos/rename", { name, path: "Album" }));
      expect(renameFolder.status, name).toBe(400);
      expect((await upload("Album", name, png(10, 10, name))).status, name).toBe(400);
      const folder = await postFolders(postJson("/api/photos/folders", { path: `Album/${name}` }));
      expect(folder.status, name).toBe(400);
    }
    expect((await listFolder("")).map((entry) => entry.path)).toEqual(["Album"]);
    expect((await listFolder("Album")).map((entry) => entry.path)).toEqual(["Album/a.png"]);
  });
});

describe("photo library: share links", () => {
  it("makes one link per folder, absolute, and only for existing folders", async () => {
    await signIn();
    await upload("Album", "a.png", png(10, 10, "a"));
    const first = await share("Album");
    expect(first.token).toMatch(/^pk_[A-Za-z0-9_-]{32,}$/);
    expect(first.url).toBe(`${baseUrl}/api/photos/shared/${first.token}`);
    expect((await share("Album")).token).toBe(first.token);
    expect((await postShares(postJson("/api/photos/shares", { path: "Album/a.png" }))).status).toBe(400);
    expect((await postShares(postJson("/api/photos/shares", { path: "Nope" }))).status).toBe(404);
    expect((await postShares(postJson("/api/photos/shares", { path: "" }))).status).toBe(400);

    const deleted = await deleteShare(
      new NextRequest(new URL(`/api/photos/shares/${first.token}`, baseUrl), {
        headers: { origin: baseUrl },
        method: "DELETE",
      }),
      tokenParams(first.token),
    );
    expect(await deleted.json()).toEqual({ deleted: true });
    signOut();
    expect((await getShared(get(`/api/photos/shared/${first.token}`), tokenParams(first.token))).status).toBe(404);
  });

  it("serves an album to anyone holding the token, with no session", async () => {
    await signIn();
    const bytes = new Map<string, Buffer>();
    for (const [folder, name] of [
      ["Album", "b 10.png"],
      ["Album", "b 2.png"],
      ["Album/Sub", "a.png"],
      ["Album", "c.png"],
    ] as const) {
      const body = png(30, 20, `${folder}/${name}`);
      bytes.set(`${folder}/${name}`.slice("Album/".length), body);
      expect((await upload(folder, name, body)).status).toBe(200);
    }
    await upload("Elsewhere", "secret.png", png(1, 1, "secret"));
    const album = await share("Album");
    signOut();

    const index = await getShared(get(`/api/photos/shared/${album.token}`), tokenParams(album.token));
    expect(index.status).toBe(200);
    const listing = (await index.json()) as {
      count: number;
      files: { name: string; path: string; url: string; width: number }[];
      name: string;
      updated_at: number;
    };
    expect(listing.name).toBe("Album");
    expect(listing.count).toBe(4);
    expect(listing.updated_at).toBeGreaterThan(0);
    expect(listing.files.map((file) => file.path)).toEqual(["b 2.png", "b 10.png", "c.png", "Sub/a.png"]);
    expect(listing.files[3]).toMatchObject({
      content_type: "image/png",
      height: 20,
      name: "a.png",
      url: `${baseUrl}/api/photos/shared/${album.token}/file?path=Sub%2Fa.png`,
      width: 30,
    });

    const pick = async (order: string, index: number) => {
      const response = await getSharedPhoto(
        get(`/api/photos/shared/${album.token}/photo?order=${order}&index=${index}`),
        tokenParams(album.token),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { count: number; index: number; photo: { path: string } | null };
    };
    expect(await pick("sequential", 5)).toMatchObject({ count: 4, index: 5, photo: { path: "b 10.png" } });
    const cycle = await Promise.all([0, 1, 2, 3].map((index) => pick("random", index)));
    expect(cycle.map((result) => result.photo?.path).sort()).toEqual(
      listing.files.map((file) => file.path).sort(),
    );
    expect((await pick("random", 2)).photo?.path).toBe(cycle[2]?.photo?.path);
    expect((await pick("newest", 0)).photo).not.toBeNull();
    expect(
      (await getSharedPhoto(get(`/api/photos/shared/${album.token}/photo?order=shuffle`), tokenParams(album.token))).status,
    ).toBe(400);
    // `shapes`: only the photos of those shapes count (every file here is 30x20, landscape).
    const landscape = await getSharedPhoto(
      get(`/api/photos/shared/${album.token}/photo?order=sequential&index=0&shapes=landscape,square`),
      tokenParams(album.token),
    );
    expect(await landscape.json()).toMatchObject({ count: 4, index: 0, photo: { path: "b 2.png" } });
    const portrait = await getSharedPhoto(
      get(`/api/photos/shared/${album.token}/photo?order=sequential&index=0&shapes=portrait`),
      tokenParams(album.token),
    );
    expect(await portrait.json()).toEqual({ count: 0, index: 0, photo: null });
    expect(
      (await getSharedPhoto(get(`/api/photos/shared/${album.token}/photo?shapes=round`), tokenParams(album.token))).status,
    ).toBe(400);

    // Streamed without a CDN alias...
    const file = await getSharedFile(
      get(`/api/photos/shared/${album.token}/file?path=Sub%2Fa.png`),
      tokenParams(album.token),
    );
    expect(file.status).toBe(200);
    // The URL carries the token: a shared cache must not keep the bytes.
    expect(file.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes.get("Sub/a.png")!)).toBe(true);
    // ...redirected to a short-lived presigned address of the object's
    // random key on a bucket, never to the public alias.
    cdn.base = "https://cdn.example";
    const redirected = await getSharedFile(
      get(`/api/photos/shared/${album.token}/file?path=Sub%2Fa.png`),
      tokenParams(album.token),
    );
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toMatch(
      /^https:\/\/cdn\.example\/signed\/photos\/[0-9a-f-]{36}\/[0-9a-f]{32}\?X-Amz-Expires=600&/,
    );
    expect(redirected.headers.get("cache-control")).toBe("no-store");

    // Nothing outside the shared folder, nothing made up.
    for (const path of ["..%2FElsewhere%2Fsecret.png", "missing.png", "Sub"]) {
      const outside = await getSharedFile(
        get(`/api/photos/shared/${album.token}/file?path=${path}`),
        tokenParams(album.token),
      );
      expect([400, 404], path).toContain(outside.status);
    }
    const unknown = `pk_${"x".repeat(32)}`;
    expect((await getShared(get(`/api/photos/shared/${unknown}`), tokenParams(unknown))).status).toBe(404);
    expect((await getShared(get("/api/photos/shared/nonsense"), tokenParams("nonsense"))).status).toBe(404);
  });

  it("answers an empty album with no photo", async () => {
    await signIn();
    await postFolders(postJson("/api/photos/folders", { path: "Empty" }));
    const empty = await share("Empty");
    signOut();
    const response = await getSharedPhoto(
      get(`/api/photos/shared/${empty.token}/photo?index=3`),
      tokenParams(empty.token),
    );
    expect(await response.json()).toEqual({ count: 0, index: 3, photo: null });
  });
});

describe("photo library: album scenes", () => {
  type SceneNode = { data: { config?: unknown; keyword: string } };
  type SceneAnswer = {
    scene: {
      apps: { photoAlbum: { origin: string; sources: Record<string, string> } };
      fields: { value: string }[];
      id: string;
      name: string;
      nodes: SceneNode[];
      settings: { refreshInterval: number };
    };
    share: { frame_id: string | null; path: string; token: string; url: string };
  };

  it("gives a frame its own link to the folder, kept across installs and deletable alone", async () => {
    const accountId = await signIn();
    const kitchen = await seedFrame(accountId, "Kitchen");
    const hall = await seedFrame(accountId, "Hall");
    const other = await seedFrame(await signIn(), "Theirs");
    await signInAs(accountId);
    await upload("Summer 2026", "a.png", png(10, 10, "per-frame"));

    const general = await share("Summer 2026");
    expect(general.frame_id).toBeNull();
    const forKitchen = (await (
      await postScene(postJson("/api/photos/scene", { frame_id: kitchen.id, path: "Summer 2026" }))
    ).json()) as SceneAnswer;
    expect(forKitchen.share.frame_id).toBe(kitchen.id);
    expect(forKitchen.share.token).not.toBe(general.token);
    const album = forKitchen.scene.nodes.find((node) => node.data.keyword === "photoAlbum");
    expect(album?.data.config).toEqual({ album: forKitchen.share.url, counterStateKey: "photoIndex" });
    // Every shape by default; `shapes` picks the scene's toggles.
    expect(forKitchen.scene.fields.map((field) => field.value)).toEqual(["3600", "random", "cover", "true", "true", "true", "0"]);
    const portraits = (await (
      await postScene(postJson("/api/photos/scene", { frame_id: kitchen.id, path: "Summer 2026", shapes: ["portrait"] }))
    ).json()) as SceneAnswer;
    expect(portraits.scene.fields.map((field) => field.value)).toEqual(["3600", "random", "cover", "false", "true", "false", "0"]);
    // The same frame again: the same link. POST /shares with the frame too.
    const again = (await (
      await postScene(postJson("/api/photos/scene", { frame_id: kitchen.id, path: "Summer 2026" }))
    ).json()) as SceneAnswer;
    expect(again.share.token).toBe(forKitchen.share.token);
    const viaShares = (await (
      await postShares(postJson("/api/photos/shares", { frame_id: kitchen.id, path: "Summer 2026" }))
    ).json()) as { share: { token: string } };
    expect(viaShares.share.token).toBe(forKitchen.share.token);
    const forHall = (await (
      await postShares(postJson("/api/photos/shares", { frame_id: hall.id, path: "Summer 2026" }))
    ).json()) as { share: { frame_id: string; token: string } };
    expect(forHall.share.frame_id).toBe(hall.id);
    expect(new Set([general.token, forKitchen.share.token, forHall.share.token]).size).toBe(3);

    // Another account's frame is not a target.
    expect((await postShares(postJson("/api/photos/shares", { frame_id: other.id, path: "Summer 2026" }))).status).toBe(404);
    expect((await postShares(postJson("/api/photos/shares", { frame_id: "x", path: "Summer 2026" }))).status).toBe(400);

    const listed = (await (await getShares(get("/api/photos/shares"))).json()) as {
      shares: { frame_id: string | null; token: string }[];
    };
    expect(listed.shares.map((row) => row.frame_id)).toEqual([null, kitchen.id, hall.id]);

    // Withdrawing the kitchen's link leaves the others playing.
    const gone = await deleteShare(
      new NextRequest(new URL(`/api/photos/shares/${forKitchen.share.token}`, baseUrl), {
        headers: { origin: baseUrl },
        method: "DELETE",
      }),
      tokenParams(forKitchen.share.token),
    );
    expect(gone.status).toBe(200);
    signOut();
    expect(
      (await getShared(get(`/api/photos/shared/${forKitchen.share.token}`), tokenParams(forKitchen.share.token))).status,
    ).toBe(404);
    expect(
      (await getShared(get(`/api/photos/shared/${forHall.share.token}`), tokenParams(forHall.share.token))).status,
    ).toBe(200);
  });

  it("makes a custom-named link new every time, and every link says when it was last read", async () => {
    const accountId = await signIn();
    await upload("Summer 2026", "a.png", png(10, 10, "custom"));
    const named = async (name: unknown) =>
      postShares(postJson("/api/photos/shares", { name, path: "Summer 2026" }));
    const grandma = ((await (await named(" Grandma ")).json()) as { share: SceneAnswer["share"] & { name: string } })
      .share;
    expect(grandma.name).toBe("Grandma");
    expect(grandma.frame_id).toBeNull();
    const again = ((await (await named("Grandma")).json()) as { share: { token: string } }).share;
    expect(again.token).not.toBe(grandma.token);
    const general = await share("Summer 2026");
    expect([grandma.token, again.token]).not.toContain(general.token);
    for (const bad of ["", "   ", "x".repeat(121), 7, true]) {
      expect((await named(bad)).status, JSON.stringify(bad)).toBe(400);
    }

    signOut();
    expect((await getShared(get(`/api/photos/shared/${grandma.token}`), tokenParams(grandma.token))).status).toBe(200);
    await signInAs(accountId);
    const listed = (await (await getShares(get("/api/photos/shares"))).json()) as {
      shares: { last_used_at: number | null; token: string }[];
    };
    const byToken = new Map(listed.shares.map((row) => [row.token, row.last_used_at]));
    expect(typeof byToken.get(grandma.token)).toBe("number");
    expect(byToken.get(again.token)).toBeNull();
    expect(byToken.get(general.token)).toBeNull();
  });

  it("builds a scene that plays the folder, with the folder's share link", async () => {
    const accountId = await signIn();
    await upload("Summer 2026", "a.png", png(10, 10, "scene"));
    const response = await postScene(
      postJson("/api/photos/scene", { fit: "contain", order: "newest", path: "Summer 2026", seconds: 600 }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as SceneAnswer;
    expect(body.share).toMatchObject({ path: "Summer 2026" });
    expect(body.share.url).toBe(`${baseUrl}/api/photos/shared/${body.share.token}`);
    const album = body.scene.nodes.find((node) => node.data.keyword === "photoAlbum");
    expect(album?.data.config).toEqual({ album: body.share.url, counterStateKey: "photoIndex" });
    expect(body.scene.name).toBe("Summer 2026");
    expect(body.scene.settings).toEqual({ backgroundColor: "#000000", execution: "interpreted", refreshInterval: 600 });
    expect(body.scene.fields.map((field) => field.value)).toEqual(["600", "newest", "contain", "true", "true", "true", "0"]);
    expect(body.scene.apps.photoAlbum.origin).toBe("repo/apps/image/photoAlbum");
    expect(Object.keys(body.scene.apps.photoAlbum.sources).sort()).toEqual(["app.test.ts", "app.ts", "config.json"]);

    // Without a frame, the folder's general link: the one POST /shares hands
    // out, made (and audited) once.
    expect(body.share.frame_id).toBeNull();
    const again = (await (
      await postScene(postJson("/api/photos/scene", { name: " Beach ", path: "Summer 2026" }))
    ).json()) as SceneAnswer;
    expect(again.share.token).toBe(body.share.token);
    expect((await share("Summer 2026")).token).toBe(body.share.token);
    expect(again.scene.name).toBe("Beach");
    expect(again.scene.settings.refreshInterval).toBe(3600);
    expect(again.scene.fields.map((field) => field.value)).toEqual(["3600", "random", "cover", "true", "true", "true", "0"]);
    expect(again.scene.id).not.toBe(body.scene.id);
    const audited = await db
      .select({ eventType: auditEvents.eventType })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, accountId), eq(auditEvents.eventType, "photos.share_created")));
    expect(audited).toHaveLength(1);

    // The link in the scene plays.
    signOut();
    const listing = await getShared(get(`/api/photos/shared/${body.share.token}`), tokenParams(body.share.token));
    expect(((await listing.json()) as { count: number }).count).toBe(1);
  });

  it("refuses bad options, files, missing folders and the root, sharing nothing", async () => {
    const accountId = await signIn();
    await upload("Summer", "a.png", png(10, 10, "scene-refusals"));
    const cases: [Record<string, unknown>, number][] = [
      [{ seconds: 0 }, 400],
      [{ seconds: -5 }, 400],
      [{ seconds: "60" }, 400],
      [{ seconds: true }, 400],
      [{ order: "upside-down" }, 400],
      [{ order: ["random"] }, 400],
      [{ fit: "stretch" }, 400],
      [{ shapes: [] }, 400],
      [{ shapes: ["round"] }, 400],
      [{ shapes: "landscape" }, 400],
      [{ shapes: ["landscape", "landscape"] }, 400],
      [{ name: 5 }, 400],
      [{ name: "x".repeat(257) }, 400],
      [{ path: "" }, 400],
      [{ path: "../etc" }, 400],
      [{ path: "Summer/a.png" }, 400],
      [{ path: "Nope" }, 404],
      [{ frame_id: 7 }, 400],
      [{ frame_id: "not-a-frame" }, 400],
      [{ frame_id: "00000000-0000-4000-8000-000000000000" }, 404],
    ];
    for (const [overrides, status] of cases) {
      const response = await postScene(postJson("/api/photos/scene", { path: "Summer", ...overrides }));
      expect(response.status, JSON.stringify(overrides)).toBe(status);
    }
    expect(await db.select().from(photoShares).where(eq(photoShares.accountId, accountId))).toEqual([]);
    expect((await postScene(postJson("/api/photos/scene", { path: "Summer" }, null))).status).toBe(403);
    signOut();
    expect((await postScene(postJson("/api/photos/scene", { path: "Summer" }))).status).toBe(401);
  });
});

describe("photo library: scanning", () => {
  it("refuses a listed hash, keeps the evidence and suspends the account's photos", async () => {
    const accountId = await signIn();
    await upload("Album", "fine.png", png(10, 10, "fine"));
    const albumShare = await share("Album");

    const bad = png(10, 10, "listed");
    const sha256 = createHash("sha256").update(bad).digest("hex");
    await db.insert(photoBlockedHashes).values({ reason: "test", sha256 });

    const refused = await upload("Album", "bad.png", bad);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "rejected" });

    // Nothing stored.
    const rows = await db.select().from(photoEntries).where(eq(photoEntries.sha256, sha256));
    expect(rows).toEqual([]);
    const [hit] = await db.select().from(photoScanHits);
    expect(hit).toMatchObject({
      accountEmail: expect.stringContaining("@example.com"),
      accountId,
      scanner: "hash_list",
      sha256,
    });
    const [account] = await db
      .select({ suspendedAt: accounts.photosSuspendedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(account?.suspendedAt).toBeInstanceOf(Date);

    // The library is not ready any more, and says why.
    const status = (await (await getStatus(get("/api/photos/status"))).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ problem: "suspended", ready: false });
    expect(typeof status.message).toBe("string");
    expect((await getFiles(get("/api/photos/files?path="))).status).toBe(503);
    expect((await upload("", "other.png", png(10, 10, "other"))).status).toBe(503);

    // Every share link is a 404.
    signOut();
    expect(
      (await getShared(get(`/api/photos/shared/${albumShare.token}`), tokenParams(albumShare.token))).status,
    ).toBe(404);
    expect(
      (
        await getSharedFile(
          get(`/api/photos/shared/${albumShare.token}/file?path=fine.png`),
          tokenParams(albumShare.token),
        )
      ).status,
    ).toBe(404);
  });

  it("fails closed when a configured scanner cannot be reached", async () => {
    const accountId = await signIn();
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "key");
    vi.stubEnv("PHOTODNA_ENDPOINT", "http://127.0.0.1:9/photodna");
    const response = await upload("", "a.png", png(10, 10, "a"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "scan_unavailable", scanner: "photodna" });
    expect(await db.select().from(photoEntries).where(eq(photoEntries.accountId, accountId))).toEqual([]);
    expect(await db.select().from(photoScanHits)).toEqual([]);
  });
});

describe("photo library: accounts are separate", () => {
  it("never shows one account's photos to another", async () => {
    await signIn();
    await upload("Private", "mine.png", png(10, 10, "mine"));
    const mine = await share("Private");

    await signIn();
    expect(await listFolder("")).toEqual([]);
    expect((await getFiles(get("/api/photos/files?path=Private"))).status).toBe(404);
    expect((await getFile(get("/api/photos/file?path=Private%2Fmine.png"))).status).toBe(404);
    expect((await getThumb(get("/api/photos/thumb?path=Private%2Fmine.png"))).status).toBe(404);
    expect(
      (await postRename(postJson("/api/photos/rename", { name: "x", path: "Private" }))).status,
    ).toBe(404);
    expect((await postDelete(postJson("/api/photos/delete", { paths: ["Private"] }))).status).toBe(200);
    expect(
      (
        await deleteShare(
          new NextRequest(new URL(`/api/photos/shares/${mine.token}`, baseUrl), {
            headers: { origin: baseUrl },
            method: "DELETE",
          }),
          tokenParams(mine.token),
        )
      ).status,
    ).toBe(404);
    expect(((await (await getShares(get("/api/photos/shares"))).json()) as { shares: unknown[] }).shares).toEqual([]);

    // The other account's delete touched nothing of the first one's.
    signOut();
    const index = await getShared(get(`/api/photos/shared/${mine.token}`), tokenParams(mine.token));
    expect(((await index.json()) as { count: number }).count).toBe(1);
  });
});

describe("POST /api/photos/resize", () => {
  async function resize(body: Record<string, unknown>) {
    return postResize(postJson("/api/photos/resize", body));
  }
  async function meta(path: string) {
    const served = await getFile(get(`/api/photos/file?path=${encodeURIComponent(path)}`));
    expect(served.status).toBe(200);
    const bytes = Buffer.from(await served.arrayBuffer());
    return { bytes, ...(await sharp(bytes).metadata()) };
  }

  it("replaces the bytes and keeps the entry", async () => {
    await signIn();
    const uploaded = (await (await upload("Album", "a.png", await realPng(400, 300))).json()).entry;
    expect([uploaded.width, uploaded.height]).toEqual([400, 300]);
    await postColors(postJson("/api/photos/colors", { colors: { whites: -10 }, path: "Album/a.png" }));
    const [before] = await db.select({ objectKey: photoEntries.objectKey, thumbObjectKey: photoEntries.thumbObjectKey }).from(photoEntries);

    const response = await resize({ height: 200, path: "Album/a.png", width: 200 });
    expect(response.status).toBe(200);
    const entry = (await response.json()).entry;
    expect(entry.path).toBe("Album/a.png");
    expect([entry.width, entry.height]).toEqual([200, 150]);
    expect(entry.colors).toEqual({ whites: -10 });
    expect(entry.mtime).toBe(uploaded.mtime);
    const file = await meta("Album/a.png");
    expect([file.format, file.width, file.height]).toEqual(["png", 200, 150]);
    expect(entry.size).toBe(file.bytes.length);
    // Old objects gone, new ones there.
    expect(await objectStore().head(before!.objectKey!)).toBeUndefined();
    expect(await objectStore().head(before!.thumbObjectKey!)).toBeUndefined();
    const [after] = await db.select({ objectKey: photoEntries.objectKey, thumbObjectKey: photoEntries.thumbObjectKey }).from(photoEntries);
    expect(await objectStore().head(after!.objectKey!)).toBe(file.bytes.length);
    expect(await objectStore().head(after!.thumbObjectKey!)).toBeGreaterThan(0);
    const thumb = await getThumb(get("/api/photos/thumb?path=Album%2Fa.png"));
    expect(thumb.status).toBe(200);
  });

  it("fits, formats, and never invents pixels unless asked", async () => {
    await signIn();
    await upload("Album", "a.png", await realPng(400, 300));
    let entry = (await (await resize({ height: 800, path: "Album/a.png", width: 800 })).json()).entry;
    expect([entry.width, entry.height]).toEqual([400, 300]);
    entry = (await (await resize({ height: 800, path: "Album/a.png", upscale: true, width: 800 })).json()).entry;
    expect([entry.width, entry.height]).toEqual([800, 600]);
    entry = (await (await resize({ fit: "cover", height: 100, path: "Album/a.png", width: 100 })).json()).entry;
    expect([entry.width, entry.height]).toEqual([100, 100]);

    await upload("Album", "b.png", await realPng(400, 300));
    entry = (await (await resize({ background: "#000000", fit: "contain", height: 100, path: "Album/b.png", width: 100 })).json()).entry;
    expect([entry.width, entry.height]).toEqual([100, 100]);
    const padded = await meta("Album/b.png");
    const { data } = await sharp(padded.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => data[(y * 100 + x) * 3]!;
    expect(pixel(50, 2)).toBeLessThan(20);
    expect(pixel(50, 50)).toBeGreaterThan(20);

    // A format change renames to a free name with the new extension.
    await upload("Album", "c.png", await realPng(40, 30));
    await upload("Album", "c.jpg", await realPng(40, 30));
    const response = await resize({ format: "jpeg", path: "Album/c.png", quality: 70, width: 20 });
    expect(response.status).toBe(200);
    entry = (await response.json()).entry;
    expect(entry.path).toBe("Album/c (2).jpg");
    expect(entry.content_type).toBe("image/jpeg");
    const converted = await meta("Album/c (2).jpg");
    expect([converted.format, converted.width, converted.height, converted.isProgressive]).toEqual(["jpeg", 20, 15, false]);
    entry = (await (await resize({ colors: 16, format: "png", path: "Album/c (2).jpg", width: 10 })).json()).entry;
    expect(entry.path).toBe("Album/c (2).png");
    entry = (await (await resize({ format: "webp", path: "Album/c (2).png", width: 10 })).json()).entry;
    expect(entry.path).toBe("Album/c (2).webp");
    expect((await meta("Album/c (2).webp")).format).toBe("webp");
  });

  it("refuses what the contract refuses", async () => {
    await signIn();
    await upload("Album", "a.png", await realPng(40, 30));
    await postFolders(postJson("/api/photos/folders", { path: "Empty" }));
    for (const [body, status] of [
      [{ path: "Album/a.png" }, 400],
      [{ path: "Album/a.png", width: 0 }, 400],
      [{ fit: "cover", path: "Album/a.png", width: 20 }, 400],
      [{ fit: "sideways", path: "Album/a.png", width: 20 }, 400],
      [{ format: "tiff", path: "Album/a.png", width: 20 }, 400],
      [{ path: "Album/a.png", quality: 0, width: 20 }, 400],
      [{ background: "red", path: "Album/a.png", width: 20 }, 400],
      [{ path: "Empty", width: 20 }, 404],
      [{ path: "Album/missing.png", width: 20 }, 404],
    ] as const) {
      const response = await resize(body);
      expect(response.status, JSON.stringify(body)).toBe(status);
    }
  });
});

describe("GET /api/photos/shared/{token}/photo?path=", () => {
  it("answers one named photo, and 404 for anything else", async () => {
    await signIn();
    await upload("Album/beach", "a.png", png(40, 30, "a"));
    await upload("Album", "b.png", png(40, 30, "b"));
    const shareResponse = await postShares(postJson("/api/photos/shares", { path: "Album" }));
    const { share } = (await shareResponse.json()) as { share: { token: string } };
    signOut();

    const response = await getSharedPhoto(
      get(`/api/photos/shared/${share.token}/photo?path=${encodeURIComponent("beach/a.png")}`),
      { params: Promise.resolve({ token: share.token }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { count: number; index: number; photo: { path: string; url: string } };
    expect([body.index, body.count, body.photo.path]).toEqual([0, 1, "beach/a.png"]);
    expect(body.photo.url).toContain("/file?path=beach%2Fa.png");
    for (const missing of ["beach/nope.png", "../b.png", "beach"]) {
      const refused = await getSharedPhoto(
        get(`/api/photos/shared/${share.token}/photo?path=${encodeURIComponent(missing)}`),
        { params: Promise.resolve({ token: share.token }) },
      );
      expect(refused.status, missing).toBe(404);
    }
  });
});
