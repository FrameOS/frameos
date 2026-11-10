import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchedFetcher } from "next/dist/server/lib/patch-fetch";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
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
  // runLiveChecks() below probes Postgres and Postmark too; unset both so a
  // developer with a database exported does not turn a unit test into a
  // network call.
  delete process.env.DATABASE_URL;
  delete process.env.POSTMARK_SERVER_TOKEN;
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

  it("copies a file from disk without reading it whole", async () => {
    const source = join(root, "upload.part");
    await writeFile(source, "from disk");
    const key = "store/scene-images/from-file";
    await objectStore().put(key, { path: source, size: 9 }, "text/plain");
    expect((await objectStore().get(key))?.toString()).toBe("from disk");
    // The source is the caller's to remove.
    expect(await readFile(source, "utf8")).toBe("from disk");
  });

  it("has no public URL: a dev directory is not reachable from a browser", () => {
    expect(objectStore().publicUrl("store/scene-images/abc")).toBeUndefined();
  });

  it("has no presigned URL either: private bytes are streamed", async () => {
    expect(await objectStore().signedUrl("photos/a/b", 600)).toBeUndefined();
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

describe("s3 driver addresses", () => {
  beforeEach(() => {
    process.env.R2_CLOUD_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "test-key-id";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_CLOUD_PUBLIC_BASE_URL = "https://cdn.example";
    resetObjectStoreForTests();
  });

  it("gives public objects an alias address and photos none", () => {
    const store = objectStore();
    expect(store.driver).toBe("s3");
    expect(store.publicUrl("store/scene-images/abc")).toBe(
      "https://cdn.example/store/scene-images/abc",
    );
    // A photo is one person's: the alias must never be handed out for one.
    expect(store.publicUrl("photos/acct/0123abcd")).toBeUndefined();
    expect(store.publicUrl("photos/acct/thumbs/0123abcd")).toBeUndefined();
  });

  it("presigns a GET on the bucket endpoint that expires", async () => {
    const url = new URL((await objectStore().signedUrl("photos/acct/0123abcd", 600))!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://account.r2.cloudflarestorage.com/frameos-cloud/photos/acct/0123abcd",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^test-key-id\//);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The secret never travels.
    expect(url.toString()).not.toContain("test-secret");
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

  it("survives a store that refuses the delete", async () => {
    // A bucket lock answers 409. The row is already gone by then, so throwing
    // would 500 a delete that succeeded; the object becomes sweep fodder
    // instead.
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<Error><Code>ObjectLockedError</Code></Error>", {
        status: 409,
      })) as typeof fetch;
    try {
      await expect(
        deleteBlobIfUnreferenced("store/scene-images/locked", async () => false),
      ).resolves.toBeUndefined();
      // The strict driver still reports it, for callers that do care.
      await expect(
        objectStore().delete("store/scene-images/locked"),
      ).rejects.toThrow(/409/);
    } finally {
      globalThis.fetch = realFetch;
    }
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

  it("retries an upload the store was too busy for, the whole file each time", async () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();
    const path = join(root, "retry.bin");
    const body = Buffer.alloc(70_000, 3);
    await writeFile(path, body);

    const statuses = [503, 429, 200];
    const sent: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push((await new Request(input, init).arrayBuffer()).byteLength);
      return new Response(null, { status: statuses.shift() ?? 500 });
    }) as typeof fetch;
    try {
      await objectStore().put("photos/x/y", { path, size: body.length }, "image/jpeg");
      expect(sent).toEqual([body.length, body.length, body.length]);

      statuses.push(503, 503, 503, 200);
      sent.length = 0;
      await expect(objectStore().put("photos/x/y", body, "image/jpeg")).rejects.toThrow(
        /Object store PUT photos\/x\/y failed: 503/,
      );
      expect(sent).toHaveLength(3);
    } finally {
      globalThis.fetch = realFetch;
    }
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

describe("the S3 driver on a real socket", () => {
  // The requests above stop at a stubbed fetch, so they cannot see what fetch
  // itself refuses. npm undici, loaded before a process's first fetch (the
  // frame hub did, through ssrf.ts), becomes the dispatcher behind the global
  // fetch, and it refused every buffer upload carrying a hand-set
  // content-length: "fetch failed", before a byte left the process. Dev and CI
  // use the filesystem driver, so only this shows it. Here fetch has already
  // run, so the dispatcher is installed by hand.
  //
  // Inside a route handler there is a second fetch in the way: Next 16's own
  // (next/dist/server/lib/patch-fetch.js), which rebuilds a Request it is
  // handed from `request.body`, a stream with no length. A buffer PUT that
  // reached it as a Request went out chunked, and R2 answered 411
  // MissingContentLength to store saves and photo uploads (2026-11-10). A work
  // store is all Next needs to take that path, so the uploads run both ways.
  type Received = { body: Buffer; contentLength: string | undefined };

  function fetchAsInsideARoute(): () => void {
    const realFetch = globalThis.fetch;
    const workStore = { page: "/api/test/route", route: "/api/test" };
    globalThis.fetch = createPatchedFetcher(realFetch, {
      workAsyncStorage: { getStore: () => workStore },
      workUnitAsyncStorage: { getStore: () => undefined },
    } as unknown as Parameters<typeof createPatchedFetcher>[1]) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  async function withBucket(
    insideARoute: boolean,
    run: (received: Received[]) => Promise<void>,
  ) {
    const dispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent());
    const restoreFetch = insideARoute ? fetchAsInsideARoute() : () => {};
    const received: Received[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ body: Buffer.concat(chunks), contentLength: request.headers["content-length"] });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.R2_CLOUD_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();
    try {
      await run(received);
    } finally {
      restoreFetch();
      setGlobalDispatcher(dispatcher);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  for (const [where, insideARoute] of [
    ["in a plain process (the frame hub)", false],
    ["inside a Next route (auth-web)", true],
  ] as const) {
    describe(where, () => {
      it("uploads a buffer, its length set by fetch", async () => {
        await withBucket(insideARoute, async (received) => {
          const body = Buffer.alloc(204_800, 7);
          await objectStore().put("frames/x/cache/abc", body, "image/png");
          expect(received).toHaveLength(1);
          expect(received[0]!.contentLength).toBe(String(body.length));
          expect(received[0]!.body.equals(body)).toBe(true);
        });
      });

      it("uploads a file from disk with its length", async () => {
        await withBucket(insideARoute, async (received) => {
          const path = join(root, "upload.bin");
          const body = Buffer.alloc(204_800, 9);
          await writeFile(path, body);
          await objectStore().put("photos/x/y", { path, size: body.length }, "image/png");
          expect(received).toHaveLength(1);
          expect(received[0]!.contentLength).toBe(String(body.length));
          expect(received[0]!.body.equals(body)).toBe(true);
        });
      });
    });
  }
});

describe("the /admin live check", () => {
  // The check exists because credentials that parse are not credentials that
  // work: a wrong endpoint, a missing bucket and a revoked key all look
  // identical to a presence check.
  it("writes, reads back and cleans up a probe object", async () => {
    const { runLiveChecks } = await import("./system-checks");
    const checks = await runLiveChecks();
    const objects = checks.find((check) => check.name === "Object storage (blobs)");

    expect(objects).toBeDefined();
    // The filesystem driver is a warning, not a pass: on a production host it
    // means blobs are landing on local disk where no backup will find them.
    expect(objects!.state).toBe("warning");
    expect(objects!.detail).toContain("Filesystem driver");
    // And it leaves nothing behind.
    expect(await objectStore().head("health/object-store-probe")).toBeUndefined();
  });

  it("checks that the public alias refuses photos", async () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    process.env.R2_CLOUD_PUBLIC_BASE_URL = "https://cdn.example";
    resetObjectStoreForTests();

    // A tiny bucket: PUT stores, a presigned GET reads, DELETE forgets; the
    // alias answers with whatever `aliasStatus` says.
    const objects = new Map<string, Buffer>();
    let aliasStatus = 200;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://cdn.example") {
        const bytes = objects.get(url.pathname.slice(1));
        return aliasStatus === 200 && bytes
          ? new Response(new Uint8Array(bytes))
          : new Response("blocked", { status: aliasStatus });
      }
      const key = url.pathname.replace(/^\/frameos-cloud\//, "");
      if (request.method === "PUT") {
        objects.set(key, Buffer.from(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const bytes = objects.get(key);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const { runLiveChecks } = await import("./system-checks");
      const open = (await runLiveChecks()).find((check) => check.name === "Photos off the public CDN");
      expect(open!.state).toBe("failing");
      expect(open!.detail).toContain("Cloudflare rule");

      aliasStatus = 403;
      const closed = (await runLiveChecks()).find((check) => check.name === "Photos off the public CDN");
      expect(closed!.state).toBe("ok");
      expect(closed!.detail).toContain("403");
      // The probes are gone either way.
      expect([...objects.keys()].filter((key) => key.startsWith("photos/"))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails loudly when the store cannot answer", async () => {
    process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("no such bucket", { status: 403 })) as typeof fetch;
    try {
      const { runLiveChecks } = await import("./system-checks");
      const checks = await runLiveChecks();
      const objects = checks.find((check) => check.name === "Object storage (blobs)");
      expect(objects!.state).toBe("failing");
      expect(objects!.detail).toContain("403");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the directory default", () => {
  it("is used verbatim when FRAMEOS_OBJECT_STORE_DIR names one", async () => {
    // Guards the one thing a wrong default would silently break: two
    // processes (Next and the hub) disagreeing about where objects live,
    // which reads as "the image vanished".
    await writeFile(join(root, "marker"), "here");
    await objectStore().put("store/scene-images/k", Buffer.from("v"), "image/png");
    expect(await readFile(join(root, "store/scene-images/k"), "utf8")).toBe("v");
  });
});
