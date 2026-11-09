import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetObjectStoreForTests } from "../../auth-web/src/lib/object-store";
import { checkObjectStore } from "./object-store-check";

let root: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "frameos-hub-store-check-"));
  process.env.FRAMEOS_OBJECT_STORE_DIR = root;
  delete process.env.R2_CLOUD_ENDPOINT;
  delete process.env.R2_CLOUD_ACCESS_KEY_ID;
  delete process.env.R2_CLOUD_SECRET_ACCESS_KEY;
  resetObjectStoreForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  resetObjectStoreForTests();
  await rm(root, { force: true, recursive: true });
});

describe("the object store check", () => {
  it("passes on a store that works, and leaves nothing behind", async () => {
    await expect(checkObjectStore({ attempts: 1 })).resolves.toBe(true);
    expect(await readdir(join(root, "health"))).toEqual([]);
  });

  it("fails on a store it cannot reach, and says why", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Nothing listens on port 1.
    process.env.R2_CLOUD_ENDPOINT = "http://127.0.0.1:1";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();

    await expect(checkObjectStore({ attempts: 2, retryDelayMs: 0 })).resolves.toBe(false);
    expect(errors).toHaveBeenCalledTimes(2);
    const line = JSON.parse(errors.mock.calls[0]![0] as string) as { error: string; event: string };
    expect(line.event).toBe("frame_hub.object_store_check");
    expect(line.error).toContain("fetch failed: ");
  });

  it("gives up on a store that never answers", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.R2_CLOUD_ENDPOINT = "http://127.0.0.1:1";
    process.env.R2_CLOUD_ACCESS_KEY_ID = "key";
    process.env.R2_CLOUD_SECRET_ACCESS_KEY = "secret";
    resetObjectStoreForTests();
    vi.stubGlobal("fetch", () => new Promise(() => undefined));

    await expect(checkObjectStore({ attempts: 1, attemptTimeoutMs: 10 })).resolves.toBe(false);
    expect(errors.mock.calls[0]![0]).toContain("no answer within 10 ms");
    vi.unstubAllGlobals();
  });
});
