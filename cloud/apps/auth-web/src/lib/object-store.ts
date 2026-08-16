// Object storage for the bytes that used to live in Postgres `bytea` columns:
// store scene zips, scene previews and gallery images, and the per-frame
// device-snapshot cache.
//
// Two drivers behind one interface, chosen from the environment, because the
// two environments genuinely differ:
//
//   * **s3** — Cloudflare R2 (bucket `frameos-cloud`, public alias
//     `cloud-cdn.frameos.net`) in production. Picked when R2_CLOUD_ENDPOINT
//     and both R2_CLOUD_* credentials are set.
//   * **fs** — a directory on disk, default `<repo>/db/object-storage` (that
//     path is already gitignored). Used by `pnpm dev`, tests and CI, so a
//     developer needs no bucket, no credentials and no extra daemon. This is
//     deliberately not a fake S3 server: the interface below is four verbs
//     wide, and a directory implements all four honestly.
//
// Keys are content-addressed by the caller (see blobs.ts) and namespaced by
// what they hold, because this bucket is expected to carry more than the
// store over time:
//
//   store/scene-versions/<sha256>.zip
//   store/scene-previews/<sha256>
//   store/scene-images/<sha256>
//   frames/<frameId>/cache/<sha256>
//
// Nothing here knows about the database; nothing here decides what a key
// means. It moves bytes.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";

export type ObjectStoreDriver = "fs" | "s3";

export type ObjectStore = {
  driver: ObjectStoreDriver;
  /** Write bytes at `key`. Overwriting with identical bytes is a no-op-ish. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Bytes at `key`, or undefined when the object is not there. */
  get(key: string): Promise<Buffer | undefined>;
  /** Size in bytes, or undefined when the object is not there. */
  head(key: string): Promise<number | undefined>;
  /** Remove `key`. Removing something absent is not an error. */
  delete(key: string): Promise<void>;
  /**
   * A URL a browser can fetch directly, for objects that are public by
   * construction. undefined when the deployment has no public alias — the
   * caller then proxies the bytes itself, which is also what every private
   * object gets regardless.
   */
  publicUrl(key: string): string | undefined;
};

// Anchored, no dots, no leading slash: the fs driver joins these onto a root
// directory, and a key is never derived from user input without passing
// through here first.
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export function isValidObjectKey(key: string): boolean {
  if (!keyPattern.test(key)) {
    return false;
  }
  return !key.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function assertValidKey(key: string) {
  if (!isValidObjectKey(key)) {
    throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
  }
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Where the filesystem driver keeps its objects. Defaults to `db/object-storage`
 * at the repo root — `/db/` is gitignored, so a dev machine accumulates blobs
 * without ever staging them.
 */
export function objectStoreDirectory(): string {
  const configured = optionalEnv("FRAMEOS_OBJECT_STORE_DIR");
  if (configured) {
    return resolve(configured);
  }
  // cloud/apps/auth-web/src/lib -> repo root is five levels up. Resolved from
  // cwd rather than import.meta.url so the hub, the Next server and the
  // backfill script all land on the same directory when run from the repo.
  return resolve(process.cwd(), findRepoRootRelativeDbPath());
}

function findRepoRootRelativeDbPath(): string {
  // The three known working directories: repo root, cloud/, cloud/apps/*.
  const cwd = process.cwd();
  const parts = cwd.split(sep);
  const appsIndex = parts.lastIndexOf("apps");
  if (appsIndex > 0 && parts[appsIndex - 1] === "cloud") {
    return "../../../db/object-storage";
  }
  if (parts[parts.length - 1] === "cloud") {
    return "../db/object-storage";
  }
  return "db/object-storage";
}

function createFsStore(root: string): ObjectStore {
  const pathFor = (key: string) => {
    assertValidKey(key);
    return join(root, key);
  };
  return {
    driver: "fs",
    async put(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a reader must never see a half-written object, and
      // two concurrent publishes of identical bytes must not interleave.
      const temporary = `${path}.${createHash("sha256")
        .update(`${process.pid}:${Date.now()}:${Math.random()}`)
        .digest("hex")
        .slice(0, 12)}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, path);
    },
    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async head(key) {
      try {
        return (await stat(pathFor(key))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    publicUrl() {
      // A directory on a dev machine is not reachable from a browser; the
      // routes proxy the bytes, exactly as they do for private objects in
      // production.
      return undefined;
    },
  };
}

function createS3Store(config: {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  publicBaseUrl?: string;
  secretAccessKey: string;
}): ObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    // aws4fetch retries 5xx/429 ten times by default, with exponential
    // backoff — on a request path a browser is waiting on, that is minutes of
    // held connection for an outage it cannot fix. Two retries covers a blip;
    // anything worse should surface as an error the caller can log.
    initRetryMs: 50,
    // R2 ignores the region but SigV4 does not: "auto" is what Cloudflare
    // documents for the S3 API.
    region: "auto",
    retries: 2,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
  const base = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`;
  const urlFor = (key: string) => {
    assertValidKey(key);
    return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  };

  return {
    driver: "s3",
    async put(key, body, contentType) {
      const response = await client.fetch(urlFor(key), {
        body: new Uint8Array(body),
        headers: {
          "content-length": String(body.length),
          "content-type": contentType || "application/octet-stream",
        },
        method: "PUT",
      });
      if (!response.ok) {
        throw new Error(
          `Object store PUT ${key} failed: ${response.status} ${await safeText(response)}`,
        );
      }
    },
    async get(key) {
      const response = await client.fetch(urlFor(key), { method: "GET" });
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(
          `Object store GET ${key} failed: ${response.status} ${await safeText(response)}`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async head(key) {
      const response = await client.fetch(urlFor(key), { method: "HEAD" });
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Object store HEAD ${key} failed: ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      return Number.isFinite(length) ? length : 0;
    },
    async delete(key) {
      const response = await client.fetch(urlFor(key), { method: "DELETE" });
      // S3 answers 204 for a delete of something absent; anything else that is
      // not 404 is a real failure.
      if (!response.ok && response.status !== 404) {
        throw new Error(
          `Object store DELETE ${key} failed: ${response.status} ${await safeText(response)}`,
        );
      }
    },
    publicUrl(key) {
      if (!config.publicBaseUrl) {
        return undefined;
      }
      assertValidKey(key);
      return `${config.publicBaseUrl.replace(/\/+$/, "")}/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

let cached: { key: string; store: ObjectStore } | undefined;

function configKey() {
  return [
    process.env.R2_CLOUD_ENDPOINT ?? "",
    process.env.R2_CLOUD_BUCKET ?? "",
    process.env.R2_CLOUD_ACCESS_KEY_ID ?? "",
    process.env.R2_CLOUD_PUBLIC_BASE_URL ?? "",
    process.env.FRAMEOS_OBJECT_STORE_DIR ?? "",
  ].join("|");
}

/**
 * The store this process should use. Cached per configuration, so tests can
 * point FRAMEOS_OBJECT_STORE_DIR somewhere else and get a fresh store without
 * a reset hook.
 */
export function objectStore(): ObjectStore {
  const key = configKey();
  if (cached?.key === key) {
    return cached.store;
  }
  const endpoint = optionalEnv("R2_CLOUD_ENDPOINT");
  const accessKeyId = optionalEnv("R2_CLOUD_ACCESS_KEY_ID");
  const secretAccessKey = optionalEnv("R2_CLOUD_SECRET_ACCESS_KEY");
  const publicBaseUrl = optionalEnv("R2_CLOUD_PUBLIC_BASE_URL");
  const store =
    endpoint && accessKeyId && secretAccessKey
      ? createS3Store({
          accessKeyId,
          bucket: optionalEnv("R2_CLOUD_BUCKET") ?? "frameos-cloud",
          endpoint,
          secretAccessKey,
          ...(publicBaseUrl ? { publicBaseUrl } : {}),
        })
      : createFsStore(objectStoreDirectory());
  cached = { key, store };
  return store;
}

/** Test seam: forget the memoised store. */
export function resetObjectStoreForTests() {
  cached = undefined;
}
