// What every /api/photos route does before its own work: the CSRF origin
// check on mutations (which also stops read-only API tokens), a per-address
// rate limit, the session (cookie or API token), the database, and the 503
// for a library that is not ready. Plus the error and byte-serving helpers
// the routes share.

import type { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../csrf";
import { jsonError, requireDatabase } from "../device-flow";
import { getPublicOrigin } from "../env";
import { rateLimitResponse } from "../rate-limit";
import { readSession } from "../session";
import {
  assertPhotosAvailable,
  PhotoError,
  resolvePhotoShare,
  type ResolvedPhotoShare,
  type SharedPhoto,
} from "./library";

const fifteenMinutes = 15 * 60 * 1000;

// Per address. Generous for reads: one library page asks for a thumbnail per
// photo. Uploads count chunks (a 250 MiB file is 63): room for a few
// hundred full-size files in a window.
export const photoRateLimits = {
  read: { limit: 6000, windowMs: fifteenMinutes },
  upload: { limit: 20000, windowMs: fifteenMinutes },
  write: { limit: 600, windowMs: fifteenMinutes },
  // What frames call: two requests per render (the pick, then the file),
  // every 5 s at the fastest, a few frames behind one address.
  shared: { limit: 3600, windowMs: 60 * 60 * 1000 },
} as const;

export type PhotoOwnerContext =
  | {
      accountId: string;
      db: ReturnType<typeof createDb>;
      email: string | undefined;
      providerSubject: string | undefined;
      response?: undefined;
    }
  | { response: NextResponse };

export async function photoOwnerContext(
  request: NextRequest,
  options: {
    // The status route answers while the library is suspended.
    allowUnavailable?: boolean;
    kind: "read" | "upload" | "write";
  },
): Promise<PhotoOwnerContext> {
  if (options.kind !== "read") {
    const csrf = csrfResponse(request);
    if (csrf) {
      return { response: csrf };
    }
  }
  const limited = await rateLimitResponse(
    request,
    `photos:${options.kind}`,
    photoRateLimits[options.kind],
  );
  if (limited) {
    return { response: limited };
  }
  const session = await readSession();
  if (!session?.accountId) {
    return { response: jsonError("login_required", 401) };
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return { response };
  }
  if (!options.allowUnavailable) {
    try {
      await assertPhotosAvailable(db, session.accountId);
    } catch (error) {
      return { response: photoErrorResponse(error) };
    }
  }
  return {
    accountId: session.accountId,
    db,
    email: session.email,
    providerSubject: session.providerSubject,
  };
}

export type SharedPhotoContext =
  | {
      db: ReturnType<typeof createDb>;
      origin: string;
      response?: undefined;
      share: ResolvedPhotoShare;
    }
  | { response: NextResponse };

/**
 * The share routes (what frames call): no login, the token is the
 * credential, rate limited per address. An unknown token, a deleted folder
 * and a suspended account are all the same 404.
 */
export async function sharedPhotoContext(
  request: NextRequest,
  token: string,
): Promise<SharedPhotoContext> {
  const limited = await rateLimitResponse(request, "photos:shared", photoRateLimits.shared);
  if (limited) {
    return { response: limited };
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return { response };
  }
  const share = await resolvePhotoShare(db, token);
  if (!share) {
    return { response: jsonError("not_found", 404) };
  }
  return { db, origin: getPublicOrigin(request), share };
}

/** The address a frame fetches one shared file from (absolute). */
export function sharedPhotoFileUrl(origin: string, token: string, relative: string) {
  return `${origin}/api/photos/shared/${token}/file?path=${encodeURIComponent(relative)}`;
}

/**
 * One file as the share routes send it (the listing's `files` and the
 * `photo` of /photo), color profile included: the frame grades the photo
 * with it (docs/photos.md "Colors").
 */
export function sharedPhotoJson(origin: string, token: string, photo: SharedPhoto) {
  return {
    colors: photo.colors,
    content_type: photo.contentType,
    height: photo.height,
    mtime: photo.mtime,
    name: photo.name,
    path: photo.path,
    size: photo.size,
    url: sharedPhotoFileUrl(origin, token, photo.path),
    width: photo.width,
  };
}

/** A PhotoError as its JSON answer; anything else is rethrown (a real 500). */
export function photoErrorResponse(error: unknown): NextResponse {
  if (error instanceof PhotoError) {
    return jsonError(error.code, error.status, error.extra);
  }
  throw error;
}

/** Run a route body, answering PhotoErrors with their status. */
export async function withPhotoErrors(
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await run();
  } catch (error) {
    return photoErrorResponse(error);
  }
}

// RFC 6266 with an ASCII fallback for old clients and the real name for
// everyone else (RFC 5987 encoding: encodeURIComponent leaves ' ( ) *
// alone, which attr-char does not allow).
export function contentDisposition(kind: "attachment" | "inline", filename: string) {
  const fallback = filename.replace(/[^\w. ()-]/g, "_").slice(0, 200) || "photo";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Bytes with inert headers: only an image type renders, nothing sniffs. */
export function photoBytesResponse(
  bytes: Buffer,
  options: {
    cacheControl: string;
    contentType: string | null;
    disposition?: string;
  },
) {
  const isImage = Boolean(options.contentType?.startsWith("image/"));
  const headers: Record<string, string> = {
    "cache-control": options.cacheControl,
    "content-length": String(bytes.length),
    "content-security-policy": "sandbox",
    "content-type": isImage ? (options.contentType as string) : "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (options.disposition) {
    headers["content-disposition"] = options.disposition;
  }
  return new NextResponse(new Uint8Array(bytes), { headers });
}
