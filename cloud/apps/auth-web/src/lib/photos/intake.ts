// The gate every upload passes before the object store sees it: scan, and
// on a match record the hit and suspend the account; on a scanner that
// cannot answer, refuse. (A thumbnail is made from bytes that passed.)

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../device-flow";
import type { FramesDatabase } from "../frames";
import { logWarn } from "../log";
import { clientIpFromHeaders } from "../rate-limit";
import { blockedPhotoHash, recordPhotoScanMatch } from "./library";
import { scanPhoto } from "./scan";

export function photoSha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The digest of a file on disk, streamed. */
export async function photoFileSha256(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function scanIncomingPhoto(
  db: FramesDatabase,
  request: NextRequest,
  owner: { accountId: string; email: string | undefined },
  source: Buffer | string,
  contentType: string,
): Promise<{ response: NextResponse; sha256?: undefined } | { response?: undefined; sha256: string }> {
  const sha256 = Buffer.isBuffer(source) ? photoSha256(source) : await photoFileSha256(source);
  const result = await scanPhoto(
    { source, contentType, sha256 },
    { blockedHash: (digest) => blockedPhotoHash(db, digest) },
  );
  if (result.outcome === "unavailable") {
    logWarn("photos.scan_unavailable", { error: result.error, scanner: result.scanner });
    return {
      response: jsonError("scan_unavailable", 503, {
        message: "Photos cannot be checked right now. Try again later.",
        scanner: result.scanner,
      }),
    };
  }
  if (result.outcome === "match") {
    await recordPhotoScanMatch(db, {
      accountId: owner.accountId,
      clientIp: clientIpFromHeaders(request.headers),
      details: result.details,
      email: owner.email,
      scanner: result.scanner,
      sha256,
    });
    return { response: jsonError("rejected", 422) };
  }
  return { sha256 };
}
