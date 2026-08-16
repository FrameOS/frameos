import { strToU8, zipSync, zlibSync } from "fflate";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import {
  accounts,
  createDb,
  storeSceneImages,
  storeSceneVersions,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readBlob } from "../../lib/blobs";
import HomePage from "../../../app/page";
import { PATCH as adminPatchScene } from "../../../app/api/admin/scenes/[sceneId]/route";
import { generateMetadata as generateSceneMetadata } from "../../../app/s/[slug]/page";
import {
  DELETE as deleteScene,
  PATCH as patchScene,
} from "../../../app/api/account/scenes/[sceneId]/route";
import { PATCH as patchVersion } from "../../../app/api/account/scenes/[sceneId]/versions/[version]/route";
import { DELETE as deletePrimaryImage } from "../../../app/api/account/scenes/[sceneId]/image/route";
import { POST as addGalleryImage } from "../../../app/api/account/scenes/[sceneId]/images/route";
import { DELETE as deleteGalleryImage } from "../../../app/api/account/scenes/[sceneId]/images/[imageId]/route";
import { POST as forkScene } from "../../../app/api/account/scenes/[sceneId]/fork/route";
import { POST as uploadScene } from "../../../app/api/account/scenes/upload/route";
import { POST as publishScene } from "../../../app/api/store/publish/route";
import { GET as getRepositoryJson } from "../../../app/api/store/repository.json/route";
import { GET as downloadScene } from "../../../app/api/store/scenes/[sceneId]/download/route";
import { GET as getSceneImage } from "../../../app/api/store/scenes/[sceneId]/image/route";
import { GET as getScenesJson } from "../../../app/api/store/scenes/[sceneId]/scenes.json/route";
import { POST as previewProxy } from "../../../app/api/store/preview-proxy/route";
import { POST as editSceneContent } from "../../../app/api/account/scenes/[sceneId]/content/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

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

function imageCtx(sceneId: string, imageId: string) {
  return { params: Promise.resolve({ imageId, sceneId }) };
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

  it("copies every image when a scene is forked", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const source = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sourceId = source.id as string;
    const galleryImages = [
      {
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]),
        contentType: "image/png",
        position: 1,
        sceneId: sourceId,
      },
      {
        content: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 2]),
        contentType: "image/jpeg",
        position: 2,
        sceneId: sourceId,
      },
    ];
    await db.insert(storeSceneImages).values(galleryImages);

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

    const copiedImages = await db
      .select({
        content: storeSceneImages.content,
        contentType: storeSceneImages.contentType,
        objectKey: storeSceneImages.objectKey,
        position: storeSceneImages.position,
      })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, forked.id as string))
      .orderBy(storeSceneImages.position);
    expect(
      await Promise.all(
        copiedImages.map(async (image) => ({
          content: (await readBlob(image))!,
          contentType: image.contentType,
          position: image.position,
        })),
      ),
    ).toEqual(
      galleryImages.map(({ content, contentType, position }) => ({
        content,
        contentType,
        position,
      })),
    );

    const [sourcePreview, forkedPreview] = await Promise.all([
      db
        .select({ previewImage: storeScenes.previewImage })
        .from(storeScenes)
        .where(eq(storeScenes.id, sourceId))
        .then(([row]) => row),
      db
        .select({ previewImage: storeScenes.previewImage })
        .from(storeScenes)
        .where(eq(storeScenes.id, forked.id as string))
        .then(([row]) => row),
    ]);
    expect(forkedPreview?.previewImage).toEqual(sourcePreview?.previewImage);
  });

  it("puts the signed-in owner's private scenes at the top of the store", async () => {
    const { accessToken } = await linkClient(publishScopes);
    await publish(accessToken);

    const signedInMarkup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({}) }),
    );
    expect(signedInMarkup).toContain("My private scenes");
    expect(signedInMarkup).toContain("Sunrise Clock");

    cookieJar.clear();
    const anonymousMarkup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({}) }),
    );
    expect(anonymousMarkup).not.toContain("My private scenes");
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

  it("rejects previews and gallery uploads proven fully transparent", async () => {
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

    // Gallery route: same detector on the direct image upload path.
    const scene = (await readJson(await publish(accessToken))).scene as Record<
      string,
      unknown
    >;
    const sceneId = scene.id as string;
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
    const [galleryCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, sceneId));
    expect(galleryCount?.count).toBe(0);
  });

  it("versions the ZIP preview when the lead storefront image changes", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    const missingOrigin = await deletePrimaryImage(
      request(`/api/account/scenes/${sceneId}/image`, "DELETE"),
      ctx(sceneId),
    );
    expect(missingOrigin.status).toBe(403);

    const removed = await deletePrimaryImage(
      request(`/api/account/scenes/${sceneId}/image`, "DELETE", {
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(removed.status).toBe(200);

    const [row] = await db
      .select({
        latestVersion: storeScenes.latestVersion,
        previewImage: storeScenes.previewImage,
        previewImageHeight: storeScenes.previewImageHeight,
        previewImageType: storeScenes.previewImageType,
        previewImageWidth: storeScenes.previewImageWidth,
      })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId));
    expect(row).toEqual({
      latestVersion: 2,
      previewImage: null,
      previewImageHeight: null,
      previewImageType: null,
      previewImageWidth: null,
    });

    const image = await getSceneImage(
      request(`/api/store/scenes/${sceneId}/image`, "GET"),
      ctx(sceneId),
    );
    expect(image.status).toBe(404);

    const withoutImage = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    const { unzipSync } = await import("fflate");
    expect(withoutImage.headers.get("x-scene-version")).toBe("2");
    const filesWithoutImage = unzipSync(
      new Uint8Array(await withoutImage.arrayBuffer()),
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
    const originalFiles = unzipSync(
      new Uint8Array(await original.arrayBuffer()),
    );
    expect(
      Object.keys(originalFiles).some((name) => name.endsWith("image.jpg")),
    ).toBe(true);

    // The first gallery upload becomes the new ZIP preview. Its PNG bytes are
    // kept intact even though FrameOS uses the conventional image.jpg path.
    const firstBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1,
    ]);
    const firstAdded = await addGalleryImage(
      request(`/api/account/scenes/${sceneId}/images`, "POST", {
        body: { content_base64: firstBytes.toString("base64") },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(firstAdded.status).toBe(200);
    const firstPayload = await readJson(firstAdded);
    expect(firstPayload.version).toBe(3);
    const firstId = (firstPayload.image as Record<string, unknown>)
      .id as string;

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

    // Secondary images do not change the lead and therefore do not create a
    // redundant version. Removing the lead promotes the next image.
    const secondBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xdb, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const secondAdded = await addGalleryImage(
      request(`/api/account/scenes/${sceneId}/images`, "POST", {
        body: { content_base64: secondBytes.toString("base64") },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    const secondPayload = await readJson(secondAdded);
    expect(secondPayload.version).toBeUndefined();
    const secondId = (secondPayload.image as Record<string, unknown>)
      .id as string;

    const firstDeleted = await deleteGalleryImage(
      request(`/api/account/scenes/${sceneId}/images/${firstId}`, "DELETE", {
        headers: { origin: baseUrl },
      }),
      imageCtx(sceneId, firstId),
    );
    expect((await readJson(firstDeleted)).version).toBe(4);
    const withSecond = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    const secondFiles = unzipSync(
      new Uint8Array(await withSecond.arrayBuffer()),
    );
    const secondImagePath = Object.keys(secondFiles).find((name) =>
      name.endsWith("image.jpg"),
    )!;
    expect(Buffer.from(secondFiles[secondImagePath]!)).toEqual(secondBytes);

    const secondDeleted = await deleteGalleryImage(
      request(`/api/account/scenes/${sceneId}/images/${secondId}`, "DELETE", {
        headers: { origin: baseUrl },
      }),
      imageCtx(sceneId, secondId),
    );
    expect((await readJson(secondDeleted)).version).toBe(5);
    const emptyAgain = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    const emptyFiles = unzipSync(
      new Uint8Array(await emptyAgain.arrayBuffer()),
    );
    expect(
      Object.keys(emptyFiles).some((name) => name.endsWith("image.jpg")),
    ).toBe(false);

    cookieJar.clear();
    const anonymous = await deletePrimaryImage(
      request(`/api/account/scenes/${sceneId}/image`, "DELETE", {
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(anonymous.status).toBe(401);
  });

  it("keeps the gallery lead in a newly published ZIP with no primary image", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;
    const galleryBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6,
    ]);

    const added = await addGalleryImage(
      request(`/api/account/scenes/${sceneId}/images`, "POST", {
        body: { content_base64: galleryBytes.toString("base64") },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(added.status).toBe(200);
    expect((await readJson(added)).version).toBeUndefined();

    const republished = await publish(accessToken, {
      content_base64: templateZip({ image: false }).toString("base64"),
    });
    expect(republished.status).toBe(200);
    expect(
      ((await readJson(republished)).scene as Record<string, unknown>).version,
    ).toBe(2);

    const [stored] = await db
      .select({ previewImage: storeScenes.previewImage })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId));
    expect(stored?.previewImage).toBeNull();

    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const imagePath = Object.keys(files).find((name) =>
      name.endsWith("image.jpg"),
    )!;
    expect(Buffer.from(files[imagePath]!)).toEqual(galleryBytes);
  });

  it("uses the first gallery image in shared-scene social metadata", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (await readJson(await publish(accessToken))).scene as Record<
      string,
      unknown
    >;
    const sceneId = scene.id as string;
    const slug = scene.slug as string;

    const removed = await deletePrimaryImage(
      request(`/api/account/scenes/${sceneId}/image`, "DELETE", {
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(removed.status).toBe(200);

    const [galleryImage] = await db
      .insert(storeSceneImages)
      .values({
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        position: 1,
        sceneId,
      })
      .returning({ id: storeSceneImages.id });
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
    const expectedImageUrl = `${baseUrl}/api/store/scenes/${sceneId}/images/${galleryImage!.id}?share=${share}`;
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: expectedImageUrl }),
    ]);
    expect(metadata.openGraph?.url).toBe(
      `${baseUrl}/s/${slug}?share=${share}`,
    );
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      images: [expectedImageUrl],
    });
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

    // …a wrong or missing token stays a 404.
    for (const suffix of ["", "?share=", "?share=not-the-token"]) {
      const denied = await downloadScene(
        request(`/api/store/scenes/${sceneId}/download${suffix}`, "GET"),
        ctx(sceneId),
      );
      expect(denied.status).toBe(404);
    }

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

    cookieJar.clear();
    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(download.status).toBe(410);

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

  it("lets the owner publish a minimum FrameOS version into the latest ZIP", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    const invalid = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { frameosVersion: "not a version!" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(invalid.status).toBe(400);
    expect((await readJson(invalid)).error).toBe("invalid_frameos_version");

    const tagged = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { frameosVersion: "2026.7.5" },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
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
    expect(await publicResponse.json()).toEqual(scenes);

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
        body: { scenes: editedScenes },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(edited.status).toBe(200);
    const editedPayload = await readJson(edited);
    const editedScene = editedPayload.scene as Record<string, unknown>;
    expect(editedScene.version).toBe(2);
    expect(editedScene.risk_flags).toEqual(["shell"]);

    // The new version's zip round-trips the edited scenes; the manifest and
    // preview image carried over.
    const download = await downloadScene(
      request(`/api/store/scenes/${sceneId}/download`, "GET"),
      ctx(sceneId),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-scene-version")).toBe("2");
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const scenesPath = Object.keys(files).find((name) =>
      name.endsWith("scenes.json"),
    )!;
    expect(
      JSON.parse(Buffer.from(files[scenesPath]!).toString("utf8")),
    ).toEqual(editedScenes);
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
      request(`/api/store/scenes/${sceneId}/download?version=1`),
      ctx(sceneId),
    );
    expect(oldest.status).toBe(200);
  });

  it("stores validated tags and exposes them in the repository index", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const scene = (
      await readJson(await publish(accessToken, { visibility: "public" }))
    ).scene as Record<string, unknown>;
    const sceneId = scene.id as string;

    const tagged = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { tags: ["Clock", "e-ink", "clock"] },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(tagged.status).toBe(200);
    expect(
      ((await readJson(tagged)).scene as Record<string, unknown>).tags,
    ).toEqual(["clock", "e-ink"]);

    const invalid = await patchScene(
      request(`/api/account/scenes/${sceneId}`, "PATCH", {
        body: { tags: ["no spaces allowed"] },
        headers: { origin: baseUrl },
      }),
      ctx(sceneId),
    );
    expect(invalid.status).toBe(400);
    expect((await readJson(invalid)).error).toBe("invalid_tags");

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    const templates = repo.templates as Array<Record<string, unknown>>;
    expect(templates[0]?.tags).toEqual(["clock", "e-ink"]);
  });

  it("guards the live-preview proxy against SSRF and junk", async () => {
    const proxied = (body: Record<string, unknown>) =>
      previewProxy(request("/api/store/preview-proxy", "POST", { body }));

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
      expect(response.headers.get("content-type")).toBe("text/x-upstream");
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
