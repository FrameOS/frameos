import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobNamespaces,
  blobObjectKey,
  blobSha256,
  deleteBlobIfUnreferenced,
  frameCacheNamespace,
  publicBlobUrl,
  readBlob,
  storeBlob,
} from "./blobs";
import {
  isValidObjectKey,
  objectStore,
  resetObjectStoreForTests,
} from "./object-store";

let root: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "frameos-object-store-"));
  process.env.FRAMEOS_OBJECT_STORE_DIR = root;
  delete process.env.R2_CLOUD_ENDPOINT;
  delete process.env.R2_CLOUD_ACCESS_KEY_ID;
  delete process.env.R2_CLOUD_SECRET_ACCESS_KEY;
  delete process.env.R2_CLOUD_PUBLIC_BASE_URL;
  resetObjectStoreForTests();
});

afterEach(async () => {
  process.env = { ...savedEnv };
  resetObjectStoreForTests();
  await rm(root, { force: true, recursive: true });
});

describe("object keys", () => {
  it("accepts the namespaced shapes the store writes", () => {
    expect(isValidObjectKey("store/scene-versions/abc123.zip")).toBe(true);
    expect(
      isValidObjectKey(
        "frames/0f3a6d2c-1111-4222-8333-444455556666/cache/deadbeef",
      ),
    ).toBe(true);
  });

  it("refuses anything that could escape the fs driver's root", () => {
    expect(isValidObjectKey("../secrets")).toBe(false);
    expect(isValidObjectKey("store/../../etc/passwd")).toBe(false);
    expect(isValidObjectKey("/absolute")).toBe(false);
    expect(isValidObjectKey("store//double")).toBe(false);
    expect(isValidObjectKey("")).toBe(false);
    expect(isValidObjectKey("a".repeat(1024))).toBe(false);
  });

  it("refuses a frame id that is not a uuid", () => {
    // The namespace is built from a path segment, so this is the one place a
    // caller-supplied string reaches a key.
    expect(() => frameCacheNamespace("../../etc")).toThrow();
    expect(frameCacheNamespace("0f3a6d2c-1111-4222-8333-444455556666")).toBe(
      "frames/0f3a6d2c-1111-4222-8333-444455556666/cache",
    );
  });
});

describe("filesystem driver", () => {
  it("is what an unconfigured deployment gets", () => {
    expect(objectStore().driver).toBe("fs");
  });

  it("round-trips bytes, reports size, and forgets on delete", async () => {
    const store = objectStore();
    const key = "store/scene-images/abc";
    expect(await store.get(key)).toBeUndefined();
    expect(await store.head(key)).toBeUndefined();

    await store.put(key, Buffer.from("hello"), "text/plain");
    expect((await store.get(key))?.toString()).toBe("hello");
    expect(await store.head(key)).toBe(5);
    expect(await readFile(join(root, key), "utf8")).toBe("hello");

    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    // Deleting something absent is not an error.
    await store.delete(key);
  });

  it("has no public URL: a dev directory is not reachable from a browser", () => {
    expect(objectStore().publicUrl("store/scene-images/abc")).toBeUndefined();
  });

  it("leaves no temp files behind", async () => {
    await objectStore().put(
      "store/scene-images/tmp-check",
      Buffer.from("x"),
      "text/plain",
    );
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(root, "store/scene-images"));
    expect(entries).toEqual(["tmp-check"]);
  });
});

describe("content-addressed blobs", () => {
  it("keys by digest, so identical bytes are stored once", async () => {
    const content = Buffer.from("the same preview png, a thousand times");
    const first = await storeBlob(blobNamespaces.scenePreview, content, "image/png");
    const second = await storeBlob(blobNamespaces.scenePreview, content, "image/png");

    expect(first.objectKey).toBe(second.objectKey);
    expect(first.sha256).toBe(blobSha256(content));
    expect(first.sizeBytes).toBe(content.length);
    expect(first.objectKey).toBe(
      blobObjectKey(blobNamespaces.scenePreview, blobSha256(content)),
    );
  });

  it("re-uploads when an existing object is the wrong size", async () => {
    const content = Buffer.from("full content");
    const key = blobObjectKey(blobNamespaces.sceneImage, blobSha256(content));
    // A truncated earlier write: the key says these are the right bytes and
    // they are not, so a content-addressed store must not trust it.
    await objectStore().put(key, Buffer.from("trunc"), "image/png");

    await storeBlob(blobNamespaces.sceneImage, content, "image/png");

    expect((await objectStore().get(key))?.toString()).toBe("full content");
  });

  it("reads a row's bytes from wherever they are", async () => {
    const stored = await storeBlob(
      blobNamespaces.sceneVersion,
      Buffer.from("zip bytes"),
      "application/zip",
      { extension: "zip" },
    );

    // A row written since the move.
    expect(
      (await readBlob({ content: null, objectKey: stored.objectKey }))?.toString(),
    ).toBe("zip bytes");
    // A legacy row that still carries its bytes in Postgres.
    expect(
      (await readBlob({ content: Buffer.from("legacy"), objectKey: null }))?.toString(),
    ).toBe("legacy");
    // Neither: a preview that was never uploaded.
    expect(await readBlob({ content: null, objectKey: null })).toBeUndefined();
    expect(await readBlob(undefined)).toBeUndefined();
    // A key whose object has gone missing reads as "no image", not a throw.
    expect(
      await readBlob({ content: null, objectKey: "store/scene-images/absent" }),
    ).toBeUndefined();
  });

  it("only deletes an object nothing else points at", async () => {
    const stored = await storeBlob(
      blobNamespaces.sceneImage,
      Buffer.from("shared bytes"),
      "image/png",
    );

    await deleteBlobIfUnreferenced(stored.objectKey, async () => true);
    expect(await objectStore().head(stored.objectKey)).toBe(12);

    await deleteBlobIfUnreferenced(stored.objectKey, async () => false);
    expect(await objectStore().head(stored.objectKey)).toBeUndefined();

    // A row that never had an object key asks nothing of the store.
    let asked = false;
    await deleteBlobIfUnreferenced(null, async () => {
      asked = true;
      return false;
    });
    expect(asked).toBe(false);
  });
});

describe("public URLs", () => {
  it("point at the CDN alias when one is configured", () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    process.env.R2_CLOUD_PUBLIC_BASE_URL = "https://cloud-cdn.frameos.net";
    resetObjectStoreForTests();

    expect(objectStore().driver).toBe("s3");
    expect(publicBlobUrl("store/scene-previews/abc")).toBe(
      "https://cloud-cdn.frameos.net/store/scene-previews/abc",
    );
    expect(publicBlobUrl(null)).toBeUndefined();
  });

  it("are absent without a public alias, so routes proxy instead", () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();

    expect(objectStore().driver).toBe("s3");
    expect(publicBlobUrl("store/scene-previews/abc")).toBeUndefined();
  });

  it("stay on the fs driver when only half the credentials are present", () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    resetObjectStoreForTests();

    expect(objectStore().driver).toBe("fs");
  });
});

describe("the S3 driver's requests", () => {
  it("signs with SigV4 against the bucket URL", async () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    process.env.R2_CLOUD_BUCKET = "frameos-cloud";
    resetObjectStoreForTests();

    const requests: { url: string; method: string; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({
        auth: request.headers.get("authorization"),
        method: request.method,
        url: request.url,
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await objectStore().put(
        "store/scene-previews/abc",
        Buffer.from("bytes"),
        "image/png",
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toBe(
      "https://accountid.r2.cloudflarestorage.com/frameos-cloud/store/scene-previews/abc",
    );
    // region=auto is what R2 documents for the S3 API; getting it wrong is a
    // 403 that only shows up against the real bucket.
    expect(requests[0]!.auth).toContain("AWS4-HMAC-SHA256");
    expect(requests[0]!.auth).toContain("/auto/s3/aws4_request");
  });

  it("reports a missing object as undefined and a failure as a throw", async () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();

    const realFetch = globalThis.fetch;
    let status = 404;
    globalThis.fetch = (async () =>
      new Response(status === 404 ? null : "boom", { status })) as typeof fetch;
    try {
      expect(await objectStore().get("store/scene-images/x")).toBeUndefined();
      // A 404 on delete is "already gone", not a failure.
      await objectStore().delete("store/scene-images/x");
      status = 500;
      await expect(objectStore().get("store/scene-images/x")).rejects.toThrow(
        /Object store GET/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the directory default", () => {
  it("is used verbatim when FRAMEOS_OBJECT_STORE_DIR names one", async () => {
    // Guards the one thing a wrong default would silently break: two
    // processes (Next, the hub, the backfill script) disagreeing about where
    // objects live, which reads as "the image vanished".
    await writeFile(join(root, "marker"), "here");
    await objectStore().put("store/scene-images/k", Buffer.from("v"), "image/png");
    expect(await readFile(join(root, "store/scene-images/k"), "utf8")).toBe("v");
  });
});
