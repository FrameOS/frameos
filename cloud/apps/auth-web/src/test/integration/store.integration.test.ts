import { createHash } from "node:crypto";
import { strToU8, zipSync, zlibSync } from "fflate";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import {
  accounts,
  createDb,
  storeImages,
  storeSceneVersions,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { imageSetForVersion } from "../../lib/store-images";
import HomePage from "../../../app/store/page";
import MyScenesPage from "../../../app/my-scenes/page";
import { PATCH as adminPatchScene } from "../../../app/api/admin/scenes/[sceneId]/route";
import { generateMetadata as generateSceneMetadata } from "../../../app/s/[slug]/page";
import {
  DELETE as deleteScene,
  PATCH as patchScene,
} from "../../../app/api/account/scenes/[sceneId]/route";
import { PATCH as patchVersion } from "../../../app/api/account/scenes/[sceneId]/versions/[version]/route";
import { POST as addGalleryImage } from "../../../app/api/account/scenes/[sceneId]/images/route";
import { POST as forkScene } from "../../../app/api/account/scenes/[sceneId]/fork/route";
import { POST as uploadScene } from "../../../app/api/account/scenes/upload/route";
import { POST as publishScene } from "../../../app/api/store/publish/route";
import { GET as getRepositoryJson } from "../../../app/api/store/repository.json/route";
import { GET as downloadScene } from "../../../app/api/store/scenes/[sceneId]/download/route";
import { GET as getSceneImage } from "../../../app/api/store/scenes/[sceneId]/image/route";
import { GET as getGalleryImage } from "../../../app/api/store/scenes/[sceneId]/images/[imageId]/route";
import { GET as getScenesJson } from "../../../app/api/store/scenes/[sceneId]/scenes.json/route";
import { POST as previewProxy } from "../../../app/api/store/preview-proxy/route";
import { POST as editSceneContent } from "../../../app/api/account/scenes/[sceneId]/content/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

// The "My scenes" page renders client components (zip upload, row
// actions) that read the app router; renderToStaticMarkup has none mounted.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/my-scenes",
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
}));

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

function request(
  path: string,
  method: string,
  {
    body,
    headers = {},
  }: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  return new NextRequest(new URL(path, baseUrl), {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", ...headers },
    method,
  });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `store-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Store Tester ${userCounter}`,
    email: `store-${userCounter}@example.com`,
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

async function linkClient(scopes: string[]) {
  const startResponse = await startDevice(
    request("/api/device/start", "POST", {
      body: {
        local_origin: "http://10.2.2.2:8989",
        public_display_name: "Store Backend",
        scopes,
      },
    }),
  );
  const startPayload = await readJson(startResponse);

  const accountId = await signIn();
  const authorizeResponse = await authorizeDevice(
    request("/api/device/authorize", "POST", {
      body: { user_code: startPayload.user_code },
      headers: { origin: baseUrl },
    }),
  );
  expect(authorizeResponse.status).toBe(200);

  const pollResponse = await pollDevice(
    request("/api/device/poll", "POST", {
      body: { device_code: startPayload.device_code },
    }),
  );
  expect(pollResponse.status).toBe(200);
  const { access_token: accessToken } = await readJson(pollResponse);
  return { accessToken: accessToken as string, accountId };
}

// Every scene the store serves — scenes.json, the zip download, a frame
// push — carries its `origin` stamp (src/lib/scene-origin.ts): the scene's
// page, uuid and the version those bytes came from.
function stamped(
  scenes: Record<string, unknown>[],
  storeSceneId: string,
  version: number,
) {
  return scenes.map((scene) => ({
    ...scene,
    origin: {
      href: expect.stringMatching(/^http:\/\/localhost:3000\/s\/[a-z0-9-]+$/),
      sceneId: scene.id,
      storeSceneId,
      version: String(version),
    },
  }));
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function templateZip({
  frameosVersion,
  image = true,
  imageBytes,
  name = "Sunrise Clock",
  scenes = [{ id: "scene-1", nodes: [] }],
}: {
  frameosVersion?: string;
  image?: boolean;
  imageBytes?: Buffer;
  name?: string;
  scenes?: unknown[];
} = {}) {
  const files: Record<string, Uint8Array> = {
    [`${name}/template.json`]: strToU8(
      JSON.stringify({
        description: "A calm sunrise clock",
        frameosVersion,
        image: image ? "./image.jpg" : undefined,
        imageHeight: 480,
        imageWidth: 800,
        name,
        scenes: "./scenes.json",
      }),
    ),
    [`${name}/scenes.json`]: strToU8(JSON.stringify(scenes)),
  };
  if (image) {
    files[`${name}/image.jpg`] = imageBytes
      ? new Uint8Array(imageBytes)
      : new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9]);
  }
  return Buffer.from(zipSync(files));
}

// A structurally valid 8-bit RGBA PNG whose every alpha byte is zero — the
// exact artifact the live preview produced when a screenshot was captured
// before the first frame painted. Chunk CRCs stay zeroed: the transparency
// detector proves via the pixel data, not the checksums.
function transparentPng(width = 4, height = 4) {
  const raw = new Uint8Array(height * (1 + width * 4)); // filter 0, all zero
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) {
      out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    return Buffer.from(out);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// The same shape as transparentPng, with alpha set: publishing rejects a
// provably transparent preview, so a test that wants a real PNG needs one
// whose pixels are opaque.
function opaquePng(width = 4, height = 4) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 4 + 3] = 0xff; // alpha
    }
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) {
      out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    return Buffer.from(out);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function publishBody(overrides: Record<string, unknown> = {}) {
  return {
    content_base64: templateZip().toString("base64"),
    name: "Sunrise Clock",
    ...overrides,
  };
}

async function publish(
  accessToken: string,
  overrides: Record<string, unknown> = {},
) {
  return publishScene(
    request("/api/store/publish", "POST", {
      body: publishBody(overrides),
      headers: bearer(accessToken),
    }),
  );
}

function ctx(sceneId: string) {
  return { params: Promise.resolve({ sceneId }) };
}

const publishScopes = ["backend:link", "store:publish"];

function uploadRequest(content: Buffer, headers: Record<string, string> = {}) {
  const form = new FormData();
  const bytes = new Uint8Array(content.length);
  bytes.set(content);
  form.set("file", new Blob([bytes], { type: "application/zip" }), "scene.zip");
  return new NextRequest(new URL("/api/account/scenes/upload", baseUrl), {
    body: form,
    headers,
    method: "POST",
  });
}


/** Registers image bytes for the scene and returns their digest. */
async function registerImage(sceneId: string, bytes: Buffer): Promise<string> {
  const response = await addGalleryImage(
    request(`/api/account/scenes/${sceneId}/images`, "POST", {
      body: { content_base64: bytes.toString("base64") },
      headers: { origin: baseUrl },
    }),
    ctx(sceneId),
  );
  expect(response.status).toBe(200);
  return ((await readJson(response)).image as Record<string, unknown>).sha256 as string;
}

/** Publishes a version from the web editor with the given parts. */
async function saveVersion(sceneId: string, body: Record<string, unknown>) {
  return editSceneContent(
    request(`/api/account/scenes/${sceneId}/content`, "POST", {
      body,
      headers: { origin: baseUrl },
    }),
    ctx(sceneId),
  );
}

async function imageShas(sceneId: string, version: number | null = null): Promise<string[]> {
  return (await imageSetForVersion(db, sceneId, version)).map((image) => image.sha256);
}

async function zipImage(response: Response): Promise<Buffer | undefined> {
  const { unzipSync } = await import("fflate");
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const imagePath = Object.keys(files).find((name) => name.endsWith("image.jpg"));
  return imagePath ? Buffer.from(files[imagePath]!) : undefined;
}

describe("store publish and distribution", () => {
  it("lets a signed-in owner upload and version a scene ZIP", async () => {
    await signIn();

    const first = await uploadScene(
      uploadRequest(templateZip(), { origin: baseUrl }),
    );
    expect(first.status).toBe(200);
    const firstScene = (await readJson(first)).scene as Record<string, unknown>;
    expect(firstScene).toMatchObject({
      name: "Sunrise Clock",
      slug: "sunrise-clock",
      version: 1,
      visibility: "private",
    });

    const second = await uploadScene(
      uploadRequest(templateZip({ frameosVersion: "2026.7.3" }), {
        origin: baseUrl,
      }),
    );
    expect(second.status).toBe(200);
    expect((await readJson(second)).scene).toMatchObject({
      id: firstScene.id,
      version: 2,
      visibility: "private",
    });

    const missingOrigin = await uploadScene(uploadRequest(templateZip()));
    expect(missingOrigin.status).toBe(403);

    cookieJar.clear();
    const anonymous = await uploadScene(
      uploadRequest(templateZip(), { origin: baseUrl }),
    );
    expect(anonymous.status).toBe(401);
  });

  it("publishes, versions on republish, and serves the public repository", async () => {
    const { accessToken } = await linkClient(publishScopes);

    const first = await publish(accessToken, { visibility: "public" });
    expect(first.status).toBe(200);
    const firstScene = (await readJson(first)).scene as Record<string, unknown>;
    expect(firstScene.slug).toBe("sunrise-clock");
    expect(firstScene.version).toBe(1);
    expect(firstScene.visibility).toBe("public");
    expect(firstScene.url).toBe(`${baseUrl}/s/sunrise-clock`);

    // Same name, same account → version 2 of the same scene, and an
    // unspecified visibility does not flip it back to private.
    const second = await publish(accessToken);
    expect(second.status).toBe(200);
    const secondScene = (await readJson(second)).scene as Record<
      string,
      unknown
    >;
    expect(secondScene.id).toBe(firstScene.id);
    expect(secondScene.version).toBe(2);
    expect(secondScene.visibility).toBe("public");

    const repoResponse = await getRepositoryJson(
      request("/api/store/repository.json", "GET"),
    );
    expect(repoResponse.status).toBe(200);
    const repo = await readJson(repoResponse);
    const templates = repo.templates as Array<Record<string, unknown>>;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: "sunrise-clock",
      // ?v pins the preview to the published version so the CDN can cache
      // it immutably; a republish changes the URL.
      image: `./scenes/${firstScene.id}/image?v=2`,
      imageHeight: 480,
      imageWidth: 800,
      name: "Sunrise Clock",
      url: `${baseUrl}/s/sunrise-clock`,
      version: "2",
      zip: `./scenes/${firstScene.id}/download`,
    });

    // Anonymous download works for public scenes and bumps the counter.
    cookieJar.clear();
    const download = await downloadScene(
      request(`/api/store/scenes/${firstScene.id}/download`, "GET"),
      ctx(firstScene.id as string),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-scene-version")).toBe("2");
    expect(download.headers.get("content-type")).toBe("application/zip");

    const image = await getSceneImage(
      request(`/api/store/scenes/${firstScene.id}/image`, "GET"),
      ctx(firstScene.id as string),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");

    await vi.waitFor(async () => {
      const [row] = await db
        .select({ downloadCount: storeScenes.downloadCount })
        .from(storeScenes)
        .where(eq(storeScenes.id, firstScene.id as string));
      expect(row?.downloadCount).toBe(1);
    });
  });

  it("links every image when a scene is forked, copying nothing", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const source = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sourceId = source.id as string;
    const png = await registerImage(sourceId, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1]));
    const jpeg = await registerImage(sourceId, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 2, 2, 2, 2, 2, 2, 2, 2]));
    const [cover] = await imageShas(sourceId);
    expect((await saveVersion(sourceId, { images: [cover, png, jpeg] })).status).toBe(200);
    const [rowsBefore] = await db.select({ count: sql<number>`count(*)::int` }).from(storeImages);

    const response = await forkScene(
      request(`/api/account/scenes/${sourceId}/fork`, "POST", {
        body: { scenes: [{ id: "forked-scene", nodes: [] }] },
        headers: { origin: baseUrl },
      }),
      ctx(sourceId),
    );
    expect(response.status).toBe(200);
    const forked = (await readJson(response)).scene as Record<string, unknown>;
    expect(forked).toMatchObject({
      name: "Sunrise Clock (copy)",
      visibility: "private",
    });

    // The same three digests in the same order, and not one new image row.
    expect(await imageShas(forked.id as string)).toEqual([cover, png, jpeg]);
    const [rowsAfter] = await db.select({ count: sql<number>`count(*)::int` }).from(storeImages);
    expect(rowsAfter?.count).toBe(rowsBefore?.count);
  });
  it("offers the signed-in owner a 'My scenes' tab that lists their scenes", async () => {
    const { accessToken } = await linkClient(publishScopes);
    await publish(accessToken);

    const signedInMarkup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({}) }),
    );
    expect(signedInMarkup).toContain("My scenes");
    expect(signedInMarkup).toContain("Public scene store");
    // Private scenes are not on the store front itself any more.
    expect(signedInMarkup).not.toContain("Sunrise Clock");

    const myScenesMarkup = renderToStaticMarkup(
      await MyScenesPage({ searchParams: Promise.resolve({}) }),
    );
    expect(myScenesMarkup).toContain("Sunrise Clock");

    cookieJar.clear();
    const anonymousMarkup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({}) }),
    );
    expect(anonymousMarkup).not.toContain("My scenes");
  });

  it("requires the store:publish scope and a structurally valid zip", async () => {
    const { accessToken: unscoped } = await linkClient(["backend:link"]);
    const denied = await publish(unscoped);
    expect(denied.status).toBe(403);

    const { accessToken } = await linkClient(publishScopes);

    const junk = await publish(accessToken, {
      content_base64: Buffer.from("not a zip").toString("base64"),
    });
    expect(junk.status).toBe(400);
    expect((await readJson(junk)).error).toBe("invalid_zip");

    const noScenes = await publish(accessToken, {
      content_base64: Buffer.from(
        zipSync({ "Foo/template.json": strToU8("{}") }),
      ).toString("base64"),
    });
    expect(noScenes.status).toBe(400);
    expect((await readJson(noScenes)).error).toBe("missing_scenes");

    const emptyScenes = await publish(accessToken, {
      content_base64: templateZip({ scenes: [] }).toString("base64"),
    });
    expect(emptyScenes.status).toBe(400);
  });

  it("rejects previews and image uploads proven fully transparent", async () => {
    const { accessToken } = await linkClient(publishScopes);

    // Publish-time: the zip's image.jpg is a fully transparent PNG.
    const rejected = await publish(accessToken, {
      content_base64: templateZip({
        imageBytes: transparentPng(),
      }).toString("base64"),
    });
    expect(rejected.status).toBe(400);
    expect((await readJson(rejected)).error).toBe(
      "preview_image_fully_transparent",
    );

    // Upload route: same detector on the direct image upload path.
    const scene = (await readJson(await publish(accessToken))).scene as Record<
      string,
      unknown
    >;
    const sceneId = scene.id as string;
    const [before] = await db.select({ count: sql<number>`count(*)::int` }).from(storeImages);
    const added = await addGalleryImage(
      request(`/api/account/scenes/${sceneId}/images`, "POST", {
        body: { content_base64: transparentPng().toString("base64") },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(added.status).toBe(400);
    expect((await readJson(added)).error).toBe(
      "preview_image_fully_transparent",
    );
    const [after] = await db.select({ count: sql<number>`count(*)::int` }).from(storeImages);
    expect(after?.count).toBe(before?.count);
  });
  it("makes the image set part of the version: every change to it is a new version, and old versions keep theirs", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;
    const [cover] = await imageShas(sceneId);
    expect(cover).toMatch(/^[0-9a-f]{64}$/);

    // CSRF and sessions apply to the version route like any owner write.
    const missingOrigin = await editSceneContent(
      request(`/api/account/scenes/${sceneId}/content`, "POST", { body: { images: [] } }),
      ctx(sceneId),
    );
    expect(missingOrigin.status).toBe(403);

    // Dropping the cover publishes v2 without an image; v1 is untouched.
    const removed = await saveVersion(sceneId, { images: [] });
    expect(removed.status).toBe(200);
    expect(((await readJson(removed)).scene as Record<string, unknown>).version).toBe(2);
    expect(await imageShas(sceneId)).toEqual([]);
    expect(await imageShas(sceneId, 1)).toEqual([cover]);

    const image = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image`, "GET"),
      ctx(sceneId),
    );
    expect(image.status).toBe(404);
    const oldCover = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image?version=1`, "GET"),
      ctx(sceneId),
    );
    expect(oldCover.status).toBe(200);

    const withoutImage = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(withoutImage.headers.get("x-scene-version")).toBe("2");
    const { unzipSync } = await import("fflate");
    const filesWithoutImage = unzipSync(
      new Uint8Array(await withoutImage.clone().arrayBuffer()),
    );
    expect(
      Object.keys(filesWithoutImage).some((name) => name.endsWith("image.jpg")),
    ).toBe(false);
    const manifestPath = Object.keys(filesWithoutImage).find((name) =>
      name.endsWith("template.json"),
    )!;
    expect(
      JSON.parse(
        Buffer.from(filesWithoutImage[manifestPath]!).toString("utf8"),
      ),
    ).not.toMatchObject({ image: expect.anything() });

    // Version 1 remains the immutable original, including its old preview.
    const original = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download?version=1`, "GET"),
      ctx(sceneId),
    );
    expect(original.headers.get("x-scene-version")).toBe("1");
    expect(await zipImage(original)).toBeTruthy();

    // A registered upload binds nothing by itself: the set changes only
    // when a version is published with it. Its PNG bytes are kept intact
    // even though FrameOS uses the conventional image.jpg path.
    const firstBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1,
    ]);
    const first = await registerImage(sceneId, firstBytes);
    expect(await imageShas(sceneId)).toEqual([]);
    const bound = await saveVersion(sceneId, { images: [first], message: "Cover" });
    expect(((await readJson(bound)).scene as Record<string, unknown>).version).toBe(3);
    expect(await imageShas(sceneId)).toEqual([first]);

    const withFirst = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(withFirst.headers.get("x-scene-version")).toBe("3");
    const firstFiles = unzipSync(new Uint8Array(await withFirst.arrayBuffer()));
    const firstImagePath = Object.keys(firstFiles).find((name) =>
      name.endsWith("image.jpg"),
    )!;
    expect(Buffer.from(firstFiles[firstImagePath]!)).toEqual(firstBytes);
    const firstManifestPath = Object.keys(firstFiles).find((name) =>
      name.endsWith("template.json"),
    )!;
    expect(
      JSON.parse(Buffer.from(firstFiles[firstManifestPath]!).toString("utf8")),
    ).toMatchObject({ image: "./image.jpg" });
    expect(
      JSON.parse(Buffer.from(firstFiles[firstManifestPath]!).toString("utf8")),
    ).not.toMatchObject({ imageHeight: expect.anything() });

    // Reordering is a version too: position 0 is the cover, so the zip's
    // image follows it. The previous version still leads with the old one.
    const secondBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xdb, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const second = await registerImage(sceneId, secondBytes);
    expect((await saveVersion(sceneId, { images: [first, second] })).status).toBe(200);
    const reordered = await saveVersion(sceneId, { images: [second, first] });
    expect(((await readJson(reordered)).scene as Record<string, unknown>).version).toBe(5);
    expect(await imageShas(sceneId)).toEqual([second, first]);
    expect(await imageShas(sceneId, 4)).toEqual([first, second]);
    expect(
      await zipImage(
        await downloadScene(request(`/api/store/scenes/${sceneId}/download`, "GET"), ctx(sceneId)),
      ),
    ).toEqual(secondBytes);
    expect(
      await zipImage(
        await downloadScene(
          request(`/api/store/scenes/${sceneId}/download?version=4`, "GET"),
          ctx(sceneId),
        ),
      ),
    ).toEqual(firstBytes);

    // Removing one keeps the other; removing all leaves no image.
    expect(((await readJson(await saveVersion(sceneId, { images: [second] }))).scene as Record<string, unknown>).version).toBe(6);
    expect(await imageShas(sceneId)).toEqual([second]);
    expect(((await readJson(await saveVersion(sceneId, { images: [] }))).scene as Record<string, unknown>).version).toBe(7);
    expect(
      await zipImage(
        await downloadScene(request(`/api/store/scenes/${sceneId}/download`, "GET"), ctx(sceneId)),
      ),
    ).toBeUndefined();

    // A malformed set is refused before anything is written: repeats, junk,
    // an image nobody registered.
    for (const images of [[first, first], ["not-a-digest"], [first, "a".repeat(64)]]) {
      const rejected = await saveVersion(sceneId, { images });
      expect([400, 404]).toContain(rejected.status);
    }
    expect(await imageShas(sceneId)).toEqual([]);
    expect((await readJson(await saveVersion(sceneId, {}))).error).toBe("nothing_to_update");

    cookieJar.clear();
    const anonymous = await saveVersion(sceneId, { images: [first] });
    expect(anonymous.status).toBe(401);
  });
  it("serves an unbound draft image to its owner only, until Save binds it", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;
    const draftBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 1, 4, 1,
    ]);
    const sha = await registerImage(sceneId, draftBytes);
    const imageCtx = { params: Promise.resolve({ imageId: sha, sceneId }) };

    // The editor shows the thumbnail the moment the upload registers: the
    // owner's session reads the digest before any version links it — served
    // privately, never through the public CDN redirect.
    const draft = await getGalleryImage(
      request(`/api/store/scenes/${sceneId}/images/${sha}`, "GET"),
      imageCtx,
    );
    expect(draft.status).toBe(200);
    expect(Buffer.from(await draft.arrayBuffer())).toEqual(draftBytes);
    expect(draft.headers.get("cache-control")).toContain("private");

    // The binding requirement stays the public capability boundary: nobody
    // else reads an unbound digest through the scene's URL.
    const ownerSession = cookieJar.get(sessionCookieName)!;
    cookieJar.clear();
    const anonymous = await getGalleryImage(
      request(`/api/store/scenes/${sceneId}/images/${sha}`, "GET"),
      imageCtx,
    );
    expect(anonymous.status).toBe(404);

    // Save publishes a version with the image; now the read is public.
    cookieJar.set(sessionCookieName, ownerSession);
    expect((await saveVersion(sceneId, { images: [sha] })).status).toBe(200);
    cookieJar.clear();
    const published = await getGalleryImage(
      request(`/api/store/scenes/${sceneId}/images/${sha}`, "GET"),
      imageCtx,
    );
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toContain("public");
  });
  it("inherits the image set when a republished ZIP has no cover, and leads with the cover when it has one", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;
    const [cover] = await imageShas(sceneId);
    const galleryBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6,
    ]);
    const gallery = await registerImage(sceneId, galleryBytes);
    expect((await saveVersion(sceneId, { images: [cover!, gallery] })).status).toBe(200);

    // No image.jpg in the push: the set carries over, the zip gets the cover.
    const republished = await publish(accessToken, {
      content_base64: templateZip({ image: false }).toString("base64"),
    });
    expect(republished.status).toBe(200);
    expect(
      ((await readJson(republished)).scene as Record<string, unknown>).version,
    ).toBe(3);
    expect(await imageShas(sceneId)).toEqual([cover, gallery]);
    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(await zipImage(download)).toBeTruthy();

    // A push with its own image.jpg leads with it; the rest follow.
    const newCoverBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 4, 4, 4, 4, 4, 4, 4, 4]);
    const withCover = await publish(accessToken, {
      content_base64: templateZip({ imageBytes: newCoverBytes }).toString("base64"),
    });
    expect(withCover.status).toBe(200);
    const shas = await imageShas(sceneId);
    expect(shas).toHaveLength(3);
    expect(shas.slice(1)).toEqual([cover, gallery]);
    expect(
      await zipImage(
        await downloadScene(request(`/api/store/scenes/${sceneId}/download`, "GET"), ctx(sceneId)),
      ),
    ).toEqual(newCoverBytes);
  });
  it("uses the version's cover in shared-scene social metadata", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (await readJson(await publish(accessToken))).scene as Record<
      string,
      unknown
    >;
    const sceneId = scene.id as string;
    const slug = scene.slug as string;

    const gallery = await registerImage(sceneId, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5, 5]));
    expect((await saveVersion(sceneId, { images: [gallery] })).status).toBe(200);
    const [storedScene] = await db
      .select({ shareToken: storeScenes.shareToken })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId));
    const share = storedScene!.shareToken;

    const metadata = (await generateSceneMetadata({
      params: Promise.resolve({ slug }),
      searchParams: Promise.resolve({ share }),
    })) as {
      openGraph?: { images?: Array<{ url: string }>; url?: string };
      twitter?: { card?: string; images?: string[] };
    };
    const expectedImageUrl = `${baseUrl}/api/store/scenes/${sceneId}/image?share=${share}`;
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: expectedImageUrl }),
    ]);
    expect(metadata.openGraph?.url).toBe(`${baseUrl}/s/${slug}?share=${share}`);
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      images: [expectedImageUrl],
    });
  });
  it("flattens markdown into the social description and names the publisher when there is none", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const described = (
      await readJson(
        await publish(accessToken, {
          description:
            "# Monthly\n\nA **monthly** calendar with [ics](https://example.com) support.\n\n- light\n- dark",
          visibility: "public",
        }),
      )
    ).scene as Record<string, unknown>;
    const describedMetadata = (await generateSceneMetadata({
      params: Promise.resolve({ slug: described.slug as string }),
      searchParams: Promise.resolve({}),
    })) as { description?: string; openGraph?: { description?: string } };
    expect(describedMetadata.description).toBe(
      "Monthly A monthly calendar with ics support. light dark",
    );
    expect(describedMetadata.openGraph?.description).toBe(
      describedMetadata.description,
    );

    // The zip's manifest always carries a description; scenes without one
    // exist (older uploads, cleared in the editor), so blank it directly.
    const blank = (
      await readJson(
        await publish(accessToken, {
          content_base64: templateZip({ name: "Blank Card" }).toString("base64"),
          name: "Blank Card",
          visibility: "public",
        }),
      )
    ).scene as Record<string, unknown>;
    await db
      .update(storeScenes)
      .set({ description: null })
      .where(eq(storeScenes.id, blank.id as string));
    const blankMetadata = (await generateSceneMetadata({
      params: Promise.resolve({ slug: blank.slug as string }),
      searchParams: Promise.resolve({}),
    })) as { description?: string };
    expect(blankMetadata.description).toMatch(
      /^A FrameOS scene by Store Tester \d+\. Preview it in your browser/,
    );
  });

  it("shows the version's cover as the store tile, and nothing when the version has no images", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    expect((await saveVersion(sceneId, { images: [] })).status).toBe(200);

    // Nothing to show: the tiles say so and the image route is a 404.
    expect(
      renderToStaticMarkup(
        await HomePage({ searchParams: Promise.resolve({}) }),
      ),
    ).toContain("No preview");
    expect(
      renderToStaticMarkup(
        await MyScenesPage({ searchParams: Promise.resolve({}) }),
      ),
    ).toContain("No preview");
    expect(
      (
        await getSceneImage(
          request(`/api/store/scenes/${sceneId}/image`, "GET"),
          ctx(sceneId),
        )
      ).status,
    ).toBe(404);

    // A screenshot added later (live preview → "Save to images", then Save)
    // leads.
    const galleryBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);
    const gallery = await registerImage(sceneId, galleryBytes);
    expect((await saveVersion(sceneId, { images: [gallery] })).status).toBe(200);

    const markup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({}) }),
    );
    expect(markup).not.toContain("No preview");
    expect(markup).toContain(`/api/store/scenes/${sceneId}/image`);
    // The owner's own listing selects from store_scenes alone (no publisher
    // join), which is where a subquery once resolved against the wrong table.
    const ownMarkup = renderToStaticMarkup(
      await MyScenesPage({ searchParams: Promise.resolve({}) }),
    );
    expect(ownMarkup).not.toContain("No preview");
    expect(ownMarkup).toContain(`/api/store/scenes/${sceneId}/image`);

    const image = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image`, "GET"),
      ctx(sceneId),
    );
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(galleryBytes);
    expect(image.headers.get("content-type")).toBe("image/png");

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    const template = (repo.templates as Array<Record<string, unknown>>).find(
      (entry) => entry.sceneId === sceneId || entry.id === scene.slug,
    );
    expect(template?.image).toContain(`/scenes/${sceneId}/image`);
  });
  it("keeps private scenes private until the owner flips them", async () => {
    const { accessToken, accountId } = await linkClient(publishScopes);

    const published = await publish(accessToken);
    const scene = (await readJson(published)).scene as Record<string, unknown>;
    expect(scene.visibility).toBe("private");
    const sceneId = scene.id as string;

    // Not in the public index, not downloadable anonymously…
    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    expect(repo.templates).toHaveLength(0);

    const ownerDownload = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(ownerDownload.status).toBe(200); // owner session still set

    cookieJar.clear();
    const anonDownload = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(anonDownload.status).toBe(404);

    // …and another account cannot manage it.
    await signIn();
    const foreignPatch = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { visibility: "public" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(foreignPatch.status).toBe(404);

    // The owner makes it public via the web route.
    const ownerToken = await createSession(db, {
      accountId,
      providerIssuer: issuer,
      providerSubject: "store-owner-relogin",
    });
    cookieJar.set(sessionCookieName, ownerToken);
    const ownerPatch = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { visibility: "public" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(ownerPatch.status).toBe(200);

    const publicRepo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    expect(publicRepo.templates).toHaveLength(1);
  });

  it("shares private scenes through their share token", async () => {
    const { accessToken } = await linkClient(publishScopes);

    const published = await publish(accessToken);
    const scene = (await readJson(published)).scene as Record<string, unknown>;
    expect(scene.visibility).toBe("private");
    const sceneId = scene.id as string;

    const [row] = await db
      .select({ shareToken: storeScenes.shareToken })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId));
    const shareToken = row?.shareToken as string;
    expect(shareToken).toBeTruthy();

    cookieJar.clear(); // everything below is anonymous

    // The right token opens the zip, scenes.json and the preview image…
    const download = await downloadScene(
      request(
        `/api/store/scenes/${sceneId}/download?share=${shareToken}`,
        "GET",
      ),
      ctx(sceneId),
    );
    expect(download.status).toBe(200);

    const scenesJson = await getScenesJson(
      request(
        `/api/store/scenes/${sceneId}/scenes.json?share=${shareToken}`,
        "GET",
      ),
      ctx(sceneId),
    );
    expect(scenesJson.status).toBe(200);
    // Private content is never cacheable by shared caches.
    expect(scenesJson.headers.get("cache-control")).toBe("no-store");

    const image = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image?share=${shareToken}`, "GET"),
      ctx(sceneId),
    );
    expect(image.status).toBe(200);

    // …a wrong or missing token stays a 404 — and, now that /api/store/ is
    // exempt from the blanket no-store header, that refusal states its own
    // policy: a private scene's 404 must never sit at the edge for the next
    // anonymous request (storeRoute's default).
    for (const suffix of ["", "?share=", "?share=not-the-token"]) {
      const denied = await downloadScene(
        request(`/api/store/scenes/${sceneId}/download${suffix}`, "GET"),
        ctx(sceneId),
      );
      expect(denied.status).toBe(404);
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    const deniedImage = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image?share=not-the-token`, "GET"),
      ctx(sceneId),
    );
    expect(deniedImage.status).toBe(404);
    expect(deniedImage.headers.get("cache-control")).toBe("no-store");

    // A pulled scene is dead even with the token (moderation kill switch).
    await db
      .update(storeScenes)
      .set({ status: "pulled" })
      .where(eq(storeScenes.id, sceneId));
    const pulled = await downloadScene(
      request(
        `/api/store/scenes/${sceneId}/download?share=${shareToken}`,
        "GET",
      ),
      ctx(sceneId),
    );
    expect(pulled.status).toBe(410);
  });

  it("pull is a kill switch: hidden, 410, and republish blocked", async () => {
    const { accessToken, accountId } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    // A non-admin cannot moderate.
    const nonAdmin = await adminPatchScene(
      request(`/api/admin/scenes/${sceneId}`, "PATCH", {
        body: { status: "pulled" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(nonAdmin.status).toBe(403);

    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, accountId));

    const pulled = await adminPatchScene(
      request(`/api/admin/scenes/${sceneId}`, "PATCH", {
        body: { pulled_reason: "malware report", status: "pulled" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(pulled.status).toBe(200);

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    expect(repo.templates).toHaveLength(0);

    // The owner's (here also a moderator's) own session still gets the
    // scene's reads — the page they can open has to render — while every
    // other path stays a 410.
    const ownerDownload = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(ownerDownload.status).toBe(200);
    const ownerScenesJson = await getScenesJson(
      request(`/api/store/scenes/${sceneId}/scenes.json`, "GET"),
      ctx(sceneId),
    );
    expect(ownerScenesJson.status).toBe(200);

    cookieJar.clear();
    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(download.status).toBe(410);
    const scenesJson = await getScenesJson(
      request(`/api/store/scenes/${sceneId}/scenes.json`, "GET"),
      ctx(sceneId),
    );
    expect(scenesJson.status).toBe(410);
    // Nor does the owner's linked frameos backend: frames never install a
    // pulled scene.
    const linkedDownload = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      ctx(sceneId),
    );
    expect(linkedDownload.status).toBe(410);

    const republish = await publish(accessToken);
    expect(republish.status).toBe(403);
    expect((await readJson(republish)).error).toBe("scene_pulled");
  });

  it("features scenes and orders them first in the repository", async () => {
    const { accessToken, accountId } = await linkClient(publishScopes);
    await publish(accessToken, { name: "Plain", visibility: "public" });
    const featuredScene = (
      await readJson(
        await publish(accessToken, { name: "Shiny", visibility: "public" }),
      )
    ).scene as Record<string, unknown>;

    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, accountId));
    const featured = await adminPatchScene(
      request(`/api/admin/scenes/${featuredScene.id}`, "PATCH", {
        body: { featured: true },
        headers: { origin: baseUrl },
      }),
      ctx(featuredScene.id as string),
    );
    expect(featured.status).toBe(200);

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    const templates = repo.templates as Array<Record<string, unknown>>;
    expect(templates.map((template) => template.name)).toEqual([
      "Shiny",
      "Plain",
    ]);
  });

  it("yanks versions crates-style and refuses to yank the last one", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;
    await publish(accessToken); // v2

    // Yank v2 → latest served becomes v1; explicit v2 still downloadable.
    const yank = await patchVersion(
      request(`/api/account/scenes/${sceneId}/versions/2`, "PATCH", {
        body: { yanked: true },
        headers: { origin: baseUrl },
      }),
      { params: Promise.resolve({ sceneId, version: "2" }) },
    );
    expect(yank.status).toBe(200);

    const latest = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(latest.headers.get("x-scene-version")).toBe("1");

    const explicit = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download?version=2`, "GET"),
      ctx(sceneId),
    );
    expect(explicit.status).toBe(200);
    expect(explicit.headers.get("x-scene-version")).toBe("2");

    const lastYank = await patchVersion(
      request(`/api/account/scenes/${sceneId}/versions/1`, "PATCH", {
        body: { yanked: true },
        headers: { origin: baseUrl },
      }),
      { params: Promise.resolve({ sceneId, version: "1" }) },
    );
    expect(lastYank.status).toBe(400);
    expect((await readJson(lastYank)).error).toBe("cannot_yank_last_version");
  });

  it("lets the owner delete a scene outright", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    const missingOrigin = await deleteScene(
      request(`/api/account/scenes/${sceneId}`, "DELETE"),
      ctx(sceneId),
    );
    expect(missingOrigin.status).toBe(403);

    const deleted = await deleteScene(
      request(`/api/account/scenes/${sceneId}`, "DELETE", {
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(deleted.status).toBe(200);

    const rows = await db.select().from(storeScenes);
    expect(rows).toHaveLength(0);
  });

  it("stores the frameos version from the manifest and exposes it", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const published = await publish(accessToken, {
      content_base64: templateZip({ frameosVersion: "2026.7.3" }).toString(
        "base64",
      ),
      visibility: "public",
    });
    expect(published.status).toBe(200);
    const scene = (await readJson(published)).scene as Record<string, unknown>;
    expect(scene.frameos_version).toBe("2026.7.3");

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    const templates = repo.templates as Array<Record<string, unknown>>;
    expect(templates[0]?.frameosVersion).toBe("2026.7.3");

    // A junk value in the manifest is dropped rather than displayed.
    const junk = await publish(accessToken, {
      content_base64: templateZip({
        frameosVersion: "<script>alert(1)</script>",
        name: "Other Scene",
      }).toString("base64"),
      name: "Other Scene",
    });
    expect(junk.status).toBe(200);
    const junkScene = (await readJson(junk)).scene as Record<string, unknown>;
    expect(junkScene.frameos_version).toBeNull();
  });

  it("lets the owner publish a minimum FrameOS version as part of a version", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    const invalid = await saveVersion(sceneId, { listing: { frameosVersion: "not a version!" } });
    expect(invalid.status).toBe(400);
    expect((await readJson(invalid)).error).toBe("invalid_frameos_version");

    const tagged = await saveVersion(sceneId, { listing: { frameosVersion: "2026.7.5" } });
    expect(tagged.status).toBe(200);
    expect(
      (await readJson(tagged)).scene as Record<string, unknown>,
    ).toMatchObject({ frameos_version: "2026.7.5", latest_version: 2 });

    const versions = await db
      .select({
        frameosVersion: storeSceneVersions.frameosVersion,
        version: storeSceneVersions.version,
      })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, sceneId))
      .orderBy(storeSceneVersions.version);
    expect(versions).toEqual([
      { frameosVersion: null, version: 1 },
      { frameosVersion: "2026.7.5", version: 2 },
    ]);

    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const manifestPath = Object.keys(files).find((name) =>
      name.endsWith("template.json"),
    )!;
    expect(
      JSON.parse(Buffer.from(files[manifestPath]!).toString("utf8")),
    ).toMatchObject({ frameosVersion: "2026.7.5" });

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    const templates = repo.templates as Array<Record<string, unknown>>;
    expect(templates[0]?.frameosVersion).toBe("2026.7.5");

    // The old PATCH surface only flips visibility now.
    const patched = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { frameosVersion: "2026.8.1" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(patched.status).toBe(400);
    expect((await readJson(patched)).error).toBe("nothing_to_update");
  });
  it("serves scenes.json for the live preview with download access rules", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scenes = [
      {
        fields: [],
        id: "scene-1",
        nodes: [{ data: { keyword: "render/color" } }],
      },
    ];
    const scene = (
      await readJson(
        await publish(accessToken, {
          content_base64: templateZip({ scenes }).toString("base64"),
          visibility: "public",
        }),
      )
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    // Public scene: anonymous fetch returns the scenes array.
    cookieJar.clear();
    const publicResponse = await getScenesJson(
      request(`/api/store/scenes/${sceneId}/scenes.json`, "GET"),
      ctx(sceneId),
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toEqual(stamped(scenes, sceneId, 1));

    // Private scene: anonymous 404, owner bearer token works.
    const privateScene = (
      await readJson(
        await publish(accessToken, {
          content_base64: templateZip({ name: "Secret", scenes }).toString(
            "base64",
          ),
          name: "Secret",
        }),
      )
    ).scene as Record<string, unknown>;
    const privateId = privateScene.id as string;

    const anonymous = await getScenesJson(
      request(`/api/store/scenes/${privateId}/scenes.json`, "GET"),
      ctx(privateId),
    );
    expect(anonymous.status).toBe(404);

    const owner = await getScenesJson(
      request(`/api/store/scenes/${privateId}/scenes.json`, "GET", {
        headers: bearer(accessToken),
      }),
      ctx(privateId),
    );
    expect(owner.status).toBe(200);
  });

  it("serves a requested scenes.json version, yanked or not, defaulting to the newest live one", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scenesV1 = [
      { fields: [], id: "scene-1", nodes: [{ data: { keyword: "v1" } }] },
    ];
    const scenesV2 = [
      { fields: [], id: "scene-1", nodes: [{ data: { keyword: "v2" } }] },
    ];
    const scene = (
      await readJson(
        await publish(accessToken, {
          content_base64: templateZip({ scenes: scenesV1 }).toString("base64"),
          visibility: "public",
        }),
      )
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;
    await publish(accessToken, {
      content_base64: templateZip({ scenes: scenesV2 }).toString("base64"),
    }); // v2

    const get = (query = "") =>
      getScenesJson(
        request(`/api/store/scenes/${sceneId}/scenes.json${query}`, "GET"),
        ctx(sceneId),
      );

    // Newest by default; an explicit version picks that one.
    const latest = await get();
    expect(latest.headers.get("x-scene-version")).toBe("2");
    expect(latest.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await latest.json()).toEqual(stamped(scenesV2, sceneId, 2));
    const first = await get("?version=1");
    expect(first.headers.get("x-scene-version")).toBe("1");
    expect(await first.json()).toEqual(stamped(scenesV1, sceneId, 1));

    // Yank v2: the default falls back to v1, ?version=2 still serves it.
    const yank = await patchVersion(
      request(`/api/account/scenes/${sceneId}/versions/2`, "PATCH", {
        body: { yanked: true },
        headers: { origin: baseUrl },
      }),
      { params: Promise.resolve({ sceneId, version: "2" }) },
    );
    expect(yank.status).toBe(200);
    cookieJar.clear();
    const fallback = await get();
    expect(fallback.headers.get("x-scene-version")).toBe("1");
    expect(await fallback.json()).toEqual(stamped(scenesV1, sceneId, 1));
    const yanked = await get("?version=2");
    expect(yanked.status).toBe(200);
    expect(yanked.headers.get("x-scene-version")).toBe("2");
    expect(await yanked.json()).toEqual(stamped(scenesV2, sceneId, 2));

    expect((await get("?version=9")).status).toBe(404);
    expect((await get("?version=abc")).status).toBe(400);
    expect((await get("?version=0")).status).toBe(400);
  });

  it("lets owners edit scene contents as a new version, and tag scenes", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    // Edit the scenes JSON from the web: new immutable version, risk flags
    // recomputed (the edit adds a shell-running code node).
    const editedScenes = [
      { id: "scene-1", nodes: [{ data: { code: 'execShellCmd("reboot")' } }] },
    ];
    const edited = await editSceneContent(
      request(`/api/account/scenes/${sceneId}/content`, "POST", {
        // The save dialog's "what changed" note, stored with the version it
        // publishes (normalized to one trimmed line).
        body: { message: "  Added a\n  reboot node  ", scenes: editedScenes },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(edited.status).toBe(200);
    const editedPayload = await readJson(edited);
    const editedScene = editedPayload.scene as Record<string, unknown>;
    expect(editedScene.version).toBe(2);
    expect(editedScene.risk_flags).toEqual(["shell"]);
    expect(editedScene.message).toBe("Added a reboot node");
    const versionMessages = await db
      .select({
        message: storeSceneVersions.message,
        version: storeSceneVersions.version,
      })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, sceneId))
      .orderBy(storeSceneVersions.version);
    // The published-from-a-zip v1 has none; only the editor asks.
    expect(versionMessages).toEqual([
      { message: null, version: 1 },
      { message: "Added a reboot node", version: 2 },
    ]);

    // The new version's zip round-trips the edited scenes; the manifest and
    // preview image carried over.
    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-scene-version")).toBe("2");
    const { unzipSync } = await import("fflate");
    const zipBytes = await download.arrayBuffer();
    const files = unzipSync(new Uint8Array(zipBytes));
    const scenesPath = Object.keys(files).find((name) =>
      name.endsWith("scenes.json"),
    )!;
    // The served zip's scenes carry the download's own origin stamp; the
    // digest header describes those served bytes.
    expect(
      JSON.parse(Buffer.from(files[scenesPath]!).toString("utf8")),
    ).toEqual(stamped(editedScenes, sceneId, 2));
    expect(download.headers.get("x-scene-sha256")).toBe(
      createHash("sha256").update(new Uint8Array(zipBytes)).digest("hex"),
    );
    expect(
      Object.keys(files).some((name) => name.endsWith("template.json")),
    ).toBe(true);
    expect(Object.keys(files).some((name) => name.endsWith("image.jpg"))).toBe(
      true,
    );

    // Junk scenes and anonymous callers are rejected.
    const junk = await editSceneContent(
      request(`/api/account/scenes/${sceneId}/content`, "POST", {
        body: { scenes: [] },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(junk.status).toBe(400);
    cookieJar.clear();
    const anonymous = await editSceneContent(
      request(`/api/account/scenes/${sceneId}/content`, "POST", {
        body: { scenes: editedScenes },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(anonymous.status).toBe(401);
  });

  it("allows 100 editor saves in one experimentation session", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    for (let save = 1; save <= 100; save += 1) {
      const response = await editSceneContent(
        request(`/api/account/scenes/${sceneId}/content`, "POST", {
          body: { scenes: [{ id: "scene-1", nodes: [], save }] },
          headers: { origin: baseUrl },
        }),
        ctx(sceneId),
      );
      expect(response.status, `save ${save}`).toBe(200);
    }

    const [stored] = await db
      .select({ latestVersion: storeScenes.latestVersion })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId));
    expect(stored?.latestVersion).toBe(101);

    // Every version is kept. The 20-version prune existed only because the
    // zips were Postgres blobs (STORE-TODO decision 2); they are objects now,
    // keyed by digest, so 100 saves of a scene that barely changes cost about
    // as much as one. Immutable versions are the whole point of the model.
    const retainedVersions = await db
      .select({
        objectKey: storeSceneVersions.objectKey,
        version: storeSceneVersions.version,
      })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, sceneId));
    expect(retainedVersions).toHaveLength(101);
    expect(retainedVersions.every((row) => row.objectKey)).toBe(true);
    // Version 1 is still downloadable, which is what the prune used to break.
    const oldest = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download?version=1`, "GET"),
      ctx(sceneId),
    );
    expect(oldest.status).toBe(200);
  });

  it("serves an image's real type, not the one the row claims", async () => {
    // Rows from before the type was sniffed hold PNG bytes with `image/jpeg`
    // in the column. The column is only as good as whatever wrote it; the
    // bytes cannot be wrong about themselves.
    const { accessToken } = await linkClient(publishScopes);
    // PNG bytes behind the zip's conventional image.jpg name — which is how
    // the mislabelled rows came about in the first place.
    const scene = (
      await readJson(
        await publish(accessToken, {
          content_base64: templateZip({ imageBytes: opaquePng() }).toString(
            "base64",
          ),
          visibility: "public",
        }),
      )
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    // Publishing sniffs, so make the stored column lie the way the old rows do.
    const [cover] = await imageShas(sceneId);
    await db
      .update(storeImages)
      .set({ contentType: "image/jpeg" })
      .where(eq(storeImages.sha256, cover!));

    const image = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image`, "GET"),
      ctx(sceneId),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
  });
  it("stores validated tags with the version and exposes them in the repository index", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    const tagged = await saveVersion(sceneId, { listing: { tags: ["Clock", "e-ink", "clock"] } });
    expect(tagged.status).toBe(200);
    expect(
      ((await readJson(tagged)).scene as Record<string, unknown>).tags,
    ).toEqual(["clock", "e-ink"]);

    const invalid = await saveVersion(sceneId, { listing: { tags: ["no spaces allowed"] } });
    expect(invalid.status).toBe(400);
    expect((await readJson(invalid)).error).toBe("invalid_tags");

    // The version records them, and the zip's manifest carries them.
    const [version] = await db
      .select({ tags: storeSceneVersions.tags })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, sceneId))
      .orderBy(sql`version desc`)
      .limit(1);
    expect(version?.tags).toEqual(["clock", "e-ink"]);
    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const manifestPath = Object.keys(files).find((name) => name.endsWith("template.json"))!;
    expect(JSON.parse(Buffer.from(files[manifestPath]!).toString("utf8"))).toMatchObject({
      tags: ["clock", "e-ink"],
    });

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    const templates = repo.templates as Array<Record<string, unknown>>;
    expect(templates[0]?.tags).toEqual(["clock", "e-ink"]);
  });
  it("guards the live-preview proxy against SSRF and junk", async () => {
    // The preview worker's XHR: same-origin, JSON. Anything else — a
    // cross-site form post, say — must be turned away before the fetch.
    const proxied = (body: Record<string, unknown>) =>
      previewProxy(
        request("/api/store/preview-proxy", "POST", {
          body,
          headers: { origin: baseUrl },
        }),
      );
    const noOrigin = await previewProxy(
      request("/api/store/preview-proxy", "POST", {
        body: { url: "https://example.com/" },
      }),
    );
    expect(noOrigin.status).toBe(403);
    expect((await readJson(noOrigin)).error).toBe("missing_origin");
    const formPost = await previewProxy(
      new NextRequest(new URL("/api/store/preview-proxy", baseUrl), {
        body: JSON.stringify({ url: "https://example.com/" }),
        headers: { "content-type": "text/plain", origin: baseUrl },
        method: "POST",
      }),
    );
    expect(formPost.status).toBe(415);

    // Loopback, private ranges, and IPv6 loopback are refused.
    for (const url of [
      "http://127.0.0.1:5432/",
      "http://10.0.0.8/admin",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:6379/",
      "http://localhost:3000/",
    ]) {
      const response = await proxied({ url });
      expect(response.status, url).toBe(403);
      expect((await readJson(response)).error).toBe("host_not_allowed");
    }

    expect((await proxied({ url: "ftp://example.com/x" })).status).toBe(400);
    expect((await proxied({ url: "not a url" })).status).toBe(400);
    expect(
      (await proxied({ method: "DELETE", url: "https://example.com/" })).status,
    ).toBe(400);

    // Upstream success is mirrored: bytes, status, content type.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("upstream-bytes", {
            headers: { "content-type": "text/x-upstream" },
            status: 201,
          }),
      ),
    );
    try {
      const response = await proxied({
        headers: { "x-api-key": "k", cookie: "never-forwarded" },
        url: "https://example.com/data",
      });
      expect(response.status).toBe(201);
      // The upstream type is reported, never served: whatever the bytes are,
      // a browser must not render them on this origin.
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("x-upstream-content-type")).toBe(
        "text/x-upstream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(await response.text()).toBe("upstream-bytes");
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
      const sentHeaders = new Headers(init.headers);
      expect(sentHeaders.get("x-api-key")).toBe("k");
      expect(sentHeaders.get("cookie")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
