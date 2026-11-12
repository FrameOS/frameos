// Can this process store a picture? frameos-cloud-update asks the release it
// is about to ship (`node dist/index.cjs check-object-store`) before anything
// is switched: the same bundle and the same R2 keys the hub will run with.
// From 2026-11-07 to 11-09 a hub was live that could not upload a new picture,
// and the first anyone heard of it was a customer.
import { randomBytes } from "node:crypto";
import { objectStore } from "../../auth-web/src/lib/object-store";
import { errorField, logError, logInfo } from "./log";

const probeKey = "health/frame-hub-probe";
// The size of a small rendered picture: a tiny body proves less about uploads.
const probeBytes = 256 * 1024;

export interface ObjectStoreCheckOptions {
  attempts?: number;
  attemptTimeoutMs?: number;
  retryDelayMs?: number;
}

// What storeBlob does with a new picture, then the way back out.
async function probeOnce() {
  const store = objectStore();
  const body = randomBytes(probeBytes);
  await store.head(probeKey);
  await store.put(probeKey, body, "application/octet-stream");
  const read = await store.get(probeKey);
  await store.delete(probeKey);
  if (!read?.equals(body)) {
    throw new Error(read ? "read back different bytes" : "read back nothing");
  }
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** True once a probe object has been written, read back and deleted. */
export async function checkObjectStore({
  attempts = 3,
  attemptTimeoutMs = 20_000,
  retryDelayMs = 5_000,
}: ObjectStoreCheckOptions = {}): Promise<boolean> {
  const driver = objectStore().driver;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await withTimeout(probeOnce(), attemptTimeoutMs);
      logInfo("frame_hub.object_store_check", { attempt, driver, ok: true });
      return true;
    } catch (error) {
      logError("frame_hub.object_store_check", { attempt, driver, error: errorField(error), ok: false });
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}
