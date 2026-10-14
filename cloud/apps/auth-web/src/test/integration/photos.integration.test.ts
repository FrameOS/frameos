// The cloud's photo library end to end (docs/photos.md is the contract):
// the owner routes with a real session against a real Postgres and the
// filesystem object store, the share routes with no session at all, and the
// scan gate's consequences (422, the hit row, the suspension, every share
// link 404).
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import sharp from "sharp";
import {
  accounts,
  auditEvents,
  createDb,
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
import { POST as postScene } from "../../../app/api/photos/scene/route";
import { GET as getShared } from "../../../app/api/photos/shared/[token]/route";
import { GET as getSharedFile } from "../../../app/api/photos/shared/[token]/file/route";
import { GET as getSharedPhoto } from "../../../app/api/photos/shared/[token]/photo/route";
import { DELETE as deleteShare } from "../../../app/api/photos/shares/[token]/route";
import { GET as getShares, POST as postShares } from "../../../app/api/photos/shares/route";
import { GET as getStatus } from "../../../app/api/photos/status/route";
import { GET as getThumb } from "../../../app/api/photos/thumb/route";
import { POST as postUpload } from "../../../app/api/photos/upload/route";
import { objectStore } from "../../lib/object-store";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

// A tiny photo quota for this file (read once, when usage.ts loads), so the
// 507 is reachable with handmade images of a few hundred bytes.
vi.hoisted(() => {
  process.env.FRAMEOS_CLOUD_MAX_PHOTO_MB = "0.01";
});
const quotaBytes = Math.round(0.01 * 1024 * 1024);

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

// The filesystem store has no public alias; this switch gives it one, so the
// share file route's redirect can be exercised too.
const cdn = vi.hoisted(() => ({ base: undefined as string | undefined }));
vi.mock("../../lib/object-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/object-store")>();
  return {
    ...actual,
    objectStore: () => {
      const store = actual.objectStore();
      return {
        ...store,
        publicUrl: (key: string) => (cdn.base ? `${cdn.base}/${key}` : store.publicUrl(key)),
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
  vi.stubEnv("DISCORD_REPORTS_WEBHOOK_URL", "");
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

async function signIn() {
  userCounter += 1;
  const providerSubject = `photo-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Photo User ${userCounter}`,
    email: `photos-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
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
  return ((await response.json()) as { share: { path: string; token: string; url: string } }).share;
}

describe("photo library: status and listing", () => {
  it("needs a session", async () => {
    expect((await getStatus(get("/api/photos/status"))).status).toBe(401);
    expect((await getFiles(get("/api/photos/files?path="))).status).toBe(401);
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

    // Streamed without a CDN alias...
    const file = await getSharedFile(
      get(`/api/photos/shared/${album.token}/file?path=Sub%2Fa.png`),
      tokenParams(album.token),
    );
    expect(file.status).toBe(200);
    // The URL carries the token: a shared cache must not keep the bytes.
    expect(file.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes.get("Sub/a.png")!)).toBe(true);
    // ...redirected to the object's random key with one.
    cdn.base = "https://cdn.example";
    const redirected = await getSharedFile(
      get(`/api/photos/shared/${album.token}/file?path=Sub%2Fa.png`),
      tokenParams(album.token),
    );
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toMatch(/^https:\/\/cdn\.example\/photos\/[0-9a-f-]{36}\/[0-9a-f]{32}$/);
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
    share: { path: string; token: string; url: string };
  };

  it("builds a scene that plays the folder, with the folder's one share link", async () => {
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
    expect(body.scene.fields.map((field) => field.value)).toEqual(["600", "newest", "contain", "0"]);
    expect(body.scene.apps.photoAlbum.origin).toBe("repo/apps/image/photoAlbum");
    expect(Object.keys(body.scene.apps.photoAlbum.sources).sort()).toEqual(["app.ts", "config.json"]);

    // One link per folder: the one POST /shares hands out, made (and audited) once.
    const again = (await (
      await postScene(postJson("/api/photos/scene", { frame_id: 7, name: " Beach ", path: "Summer 2026" }))
    ).json()) as SceneAnswer;
    expect(again.share.token).toBe(body.share.token);
    expect((await share("Summer 2026")).token).toBe(body.share.token);
    expect(again.scene.name).toBe("Beach");
    expect(again.scene.settings.refreshInterval).toBe(3600);
    expect(again.scene.fields.map((field) => field.value)).toEqual(["3600", "random", "cover", "0"]);
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
      [{ name: 5 }, 400],
      [{ name: "x".repeat(257) }, 400],
      [{ path: "" }, 400],
      [{ path: "../etc" }, 400],
      [{ path: "Summer/a.png" }, 400],
      [{ path: "Nope" }, 404],
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
