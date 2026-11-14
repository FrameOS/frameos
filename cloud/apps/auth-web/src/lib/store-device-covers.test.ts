import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetObjectStoreForTests } from "./object-store";
import {
  deviceCoverKey,
  deviceCoverMaxSide,
  deviceCoverUrls,
  forgetDeviceCoversForTests,
} from "./store-device-covers";

// The copy of a store cover that frames get (store-device-covers.ts), against
// a fake R2 bucket with a public alias: made once from the cover, a JPEG no
// wider than the thumbnailer's side, named after the cover, and handed out
// as the alias's URL.

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
let objects: Map<string, Buffer>;
let puts: string[];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "frameos-device-covers-"));
  process.env.FRAMEOS_OBJECT_STORE_DIR = root;
  process.env.R2_CLOUD_ENDPOINT = "https://accountid.r2.cloudflarestorage.com";
  process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
  process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
  process.env.R2_CLOUD_PUBLIC_BASE_URL = "https://cdn.example";
  resetObjectStoreForTests();
  forgetDeviceCoversForTests();
  objects = new Map();
  puts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/frameos-cloud\//, ""));
    if (request.method === "PUT") {
      objects.set(key, Buffer.from(await request.arrayBuffer()));
      puts.push(key);
      return new Response(null, { status: 200 });
    }
    const bytes = objects.get(key);
    if (!bytes) {
      return new Response(null, { status: 404 });
    }
    return request.method === "HEAD"
      ? new Response(null, { headers: { "content-length": String(bytes.length) } })
      : new Response(new Uint8Array(bytes));
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
  resetObjectStoreForTests();
  forgetDeviceCoversForTests();
  await rm(root, { force: true, recursive: true });
});

async function cover(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { background: { alpha: 1, b: 200, g: 120, r: 40 }, channels: 4, height, width } })
    .png()
    .toBuffer();
}

describe("a store cover's copy for frames", () => {
  it("is a JPEG of at most the thumbnail side, made once, at the cover's key plus a suffix", async () => {
    const coverKey = "store/scene-images/abc123";
    objects.set(coverKey, await cover(1600, 1200));

    const [url] = await deviceCoverUrls([coverKey]);
    const copyKey = deviceCoverKey(coverKey);
    expect(copyKey).toBe("store/scene-images/abc123.device.jpg");
    expect(url).toBe(`https://cdn.example/${copyKey}`);
    const copy = objects.get(copyKey)!;
    const meta = await sharp(copy).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(deviceCoverMaxSide);
    expect(meta.height).toBe(384);
    expect(puts).toEqual([copyKey]);

    // Known now: asked again, nothing is read or written.
    expect(await deviceCoverUrls([coverKey])).toEqual([url]);
    expect(puts).toEqual([copyKey]);
  });

  it("takes a copy another process made, and never enlarges a small cover", async () => {
    const coverKey = "store/scene-images/small";
    objects.set(coverKey, await cover(320, 240));
    const [first] = await deviceCoverUrls([coverKey]);
    expect((await sharp(objects.get(deviceCoverKey(coverKey))!).metadata()).width).toBe(320);

    forgetDeviceCoversForTests();
    expect(await deviceCoverUrls([coverKey])).toEqual([first]);
    expect(puts).toEqual([deviceCoverKey(coverKey)]);
  });

  it("is null without a cover, for a cover it cannot read, and without a public alias", async () => {
    objects.set("store/scene-images/broken", Buffer.from("not an image"));
    expect(await deviceCoverUrls([null, "store/scene-images/missing", "store/scene-images/broken"])).toEqual([
      null,
      null,
      null,
    ]);

    delete process.env.R2_CLOUD_PUBLIC_BASE_URL;
    resetObjectStoreForTests();
    objects.set("store/scene-images/fine", await cover(800, 600));
    expect(await deviceCoverUrls(["store/scene-images/fine"])).toEqual([null]);
  });

  it("answers in the order asked when more covers are asked than are made at once", async () => {
    const keys = await Promise.all(
      Array.from({ length: 9 }, async (_, index) => {
        const key = `store/scene-images/page-${index}`;
        objects.set(key, await cover(400 + index * 10, 300));
        return key;
      }),
    );
    const urls = await deviceCoverUrls([null, ...keys]);
    expect(urls).toEqual([null, ...keys.map((key) => `https://cdn.example/${deviceCoverKey(key)}`)]);
  });
});
