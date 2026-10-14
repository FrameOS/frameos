// Every photo upload is scanned before a byte of it is stored, by every
// scanner that is configured, in this order (docs/photos.md "Scanning"):
//
//   1. hash_list  the SHA-256 against photo_blocked_hashes. Always on.
//   2. photodna   Microsoft's PhotoDNA Match API, when
//                 PHOTODNA_SUBSCRIPTION_KEY is set.
//
// Not OpenAI moderation: omni-moderation scores `sexual/minors` on text only,
// so an image-only request can never flag it.
//
// A configured scanner that errors or cannot be reached FAILS CLOSED: the
// caller answers 503 and stores nothing. A match stops at the first scanner
// that matched. This module only decides; recording the hit, suspending the
// account and notifying admins is the caller's (library.ts recordScanMatch).

export type PhotoScanner = "hash_list" | "photodna";

export const defaultPhotoDnaEndpoint =
  "https://api.microsoftmoderator.com/photodna/v1.0/Match";

const photoDnaTimeoutMs = 20_000;
// PhotoDNA's "OK" status code. Anything else (an image it could not read, a
// size it refuses, a quota) is not an answer, so it fails closed.
const photoDnaOkCode = 3000;

type Env = Record<string, string | undefined>;

function configured(env: Env, name: string) {
  return Boolean(env[name]?.trim());
}

/** The scanners every upload passes right now, in the order they run. */
export function activePhotoScanners(env: Env = process.env): PhotoScanner[] {
  const scanners: PhotoScanner[] = ["hash_list"];
  if (configured(env, "PHOTODNA_SUBSCRIPTION_KEY")) {
    scanners.push("photodna");
  }
  return scanners;
}

export type PhotoScanResult =
  | { outcome: "clean"; scanners: PhotoScanner[] }
  | { details: Record<string, unknown>; outcome: "match"; scanner: PhotoScanner }
  | { error: string; outcome: "unavailable"; scanner: PhotoScanner };

export type PhotoScanInput = {
  /** The image: bytes, or the path of a finished upload on disk. */
  source: Buffer | string;
  contentType: string;
  sha256: string;
};

export type PhotoScanDeps = {
  env?: Env;
  fetchImpl?: typeof fetch;
  /** The hash list lookup: the row when the digest is listed. */
  blockedHash: (sha256: string) => Promise<{ reason: string | null } | undefined>;
  /**
   * What PhotoDNA is sent: a small JPEG copy (thumbnail.ts photoScanCopy),
   * since the Match API takes a few MB and not every format. Null when the
   * image cannot be read, which fails closed.
   */
  scanCopy?: (source: Buffer | string, contentType: string) => Promise<Buffer | null>;
};

export async function scanPhoto(
  input: PhotoScanInput,
  deps: PhotoScanDeps,
): Promise<PhotoScanResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const scanners = activePhotoScanners(env);

  let listed: { reason: string | null } | undefined;
  try {
    listed = await deps.blockedHash(input.sha256);
  } catch (error) {
    return { error: errorText(error), outcome: "unavailable", scanner: "hash_list" };
  }
  if (listed !== undefined) {
    return {
      details: { reason: listed.reason },
      outcome: "match",
      scanner: "hash_list",
    };
  }

  if (scanners.includes("photodna")) {
    const makeCopy = deps.scanCopy ?? defaultScanCopy;
    let copy: Buffer | null;
    try {
      copy = await makeCopy(input.source, input.contentType);
    } catch (error) {
      return { error: errorText(error), outcome: "unavailable", scanner: "photodna" };
    }
    if (!copy) {
      return { error: "unreadable_image", outcome: "unavailable", scanner: "photodna" };
    }
    const result = await photoDnaMatch(copy, env, fetchImpl);
    if (result.outcome !== "clean") {
      return result;
    }
  }

  return { outcome: "clean", scanners };
}

async function defaultScanCopy(source: Buffer | string) {
  const { photoScanCopy } = await import("./thumbnail");
  return photoScanCopy(source);
}

type PhotoDnaResponse = {
  IsMatch?: unknown;
  MatchDetails?: unknown;
  Status?: { Code?: unknown; Description?: unknown };
  TrackingId?: unknown;
};

/**
 * One call to PhotoDNA's Match API.
 *
 * Written against Microsoft's published API description (POST
 * <endpoint>?enhance=false, `Ocp-Apim-Subscription-Key`, an inline base64
 * image, an answer with `Status.Code` 3000 for OK, `IsMatch` and
 * `TrackingId`). It has NOT yet been exercised against the live service: the
 * first real key should be tried with a known-clean image before the
 * deployment relies on it. Anything that does not look like that answer is
 * treated as "unavailable", which refuses the upload.
 */
export async function photoDnaMatch(
  bytes: Buffer,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<PhotoScanResult> {
  const key = env.PHOTODNA_SUBSCRIPTION_KEY?.trim() ?? "";
  const endpoint = env.PHOTODNA_ENDPOINT?.trim() || defaultPhotoDnaEndpoint;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: "invalid_endpoint", outcome: "unavailable", scanner: "photodna" };
  }
  url.searchParams.set("enhance", "false");

  let lastError = "unreachable";
  // One retry, like the store moderation: a blip should not bounce an
  // upload, a hard outage must still refuse it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let payload: PhotoDnaResponse;
    try {
      const response = await fetchImpl(url.toString(), {
        body: JSON.stringify({
          DataRepresentation: "inline",
          Value: bytes.toString("base64"),
        }),
        headers: {
          "content-type": "application/json",
          "ocp-apim-subscription-key": key,
        },
        method: "POST",
        signal: AbortSignal.timeout(photoDnaTimeoutMs),
      });
      if (!response.ok) {
        lastError = `http_${response.status}`;
        if (response.status === 401 || response.status === 403) {
          // A refused key will not be accepted a second time.
          break;
        }
        continue;
      }
      payload = (await response.json()) as PhotoDnaResponse;
    } catch (error) {
      lastError = errorText(error);
      continue;
    }
    if (!payload || typeof payload !== "object") {
      lastError = "invalid_response";
      continue;
    }
    const code = payload.Status?.Code;
    if (code !== photoDnaOkCode) {
      // The service answered, but not with a verdict. Retrying will not
      // change an image it refuses; fail closed straight away.
      return {
        error: `status_${typeof code === "number" ? code : "missing"}`,
        outcome: "unavailable",
        scanner: "photodna",
      };
    }
    if (payload.IsMatch === true) {
      return {
        details: {
          match_details: payload.MatchDetails ?? null,
          status: payload.Status?.Description ?? null,
          tracking_id: typeof payload.TrackingId === "string" ? payload.TrackingId : null,
        },
        outcome: "match",
        scanner: "photodna",
      };
    }
    if (payload.IsMatch === false) {
      return { outcome: "clean", scanners: ["photodna"] };
    }
    return { error: "invalid_response", outcome: "unavailable", scanner: "photodna" };
  }
  return { error: lastError, outcome: "unavailable", scanner: "photodna" };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}
