import { eq } from "drizzle-orm";
import { accountSettings, type createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { linkedClientHasScope } from "../../../../../src/lib/backend-auth";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../src/lib/frame-device-auth";
import {
  buildServiceSettingsPayload,
  serviceSettingsResponseBody,
} from "../../../../../src/lib/frame-service-settings";
import {
  computeAndStoreServiceSettingGroups,
  frameServiceSettingsScope,
  readServiceSettingGroups,
} from "../../../../../src/lib/frames";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";
import { reportError } from "../../../../../src/lib/log";

export const runtime = "nodejs";

// Service API keys for a cloud-managed frame (docs/cloud-frames.md, "Service
// settings"). Called by the DEVICE — its enrollment access token as
// `Authorization: Bearer …`, not a browser session:
//
//   GET /api/frames/{id}/service-settings
//   -> 200 {"settings": {group: {field: value}}, "groups": [group, …]}
//   -> 304 when the device's If-None-Match still matches
//
// A PULL, never a push. Keys must not enter the durable command queue:
// `frame_commands` rows are never deleted, so a pushed secret would live in
// Postgres and every backup forever; the payload would pass through the hub
// (whose log redaction matches token/secret/password/… and would NOT match
// `apiKey`/`accessKey`); and at-least-once redelivery could hand a device a
// key the owner had already deleted. The socket carries only the zero-payload
// `refresh_service_settings` nudge, which says "re-pull" and nothing else.
//
// `Cache-Control: no-store` is mandatory here — unlike the self-hosted
// backend, the cloud sits behind nginx and may sit behind a CDN, and this
// body is the account's credentials. The ETag is over the canonical body
// (src/lib/frame-service-settings.ts) so an unchanged answer costs a 304
// instead of re-shipping the keys.
//
// Never log the body. Failures log `{frameId, status}` and nothing else.

// The account's stored service settings, narrowed to {group: {field: string}}.
// buildServiceSettingsPayload filters again against the deliverable list; this
// only makes the jsonb safe to hand it.
async function storedServiceSettings(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<Record<string, Record<string, string>>> {
  const rows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const stored: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    const value = row.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const fields: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof fieldValue === "string") {
        fields[field] = fieldValue;
      }
    }
    stored[row.key] = fields;
  }
  return stored;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  // A device polls this on connect and after a nudge; the ETag makes repeats
  // cheap. IP budget first (it is all an unauthenticated caller can spend),
  // then a per-frame identity budget below, which an attacker cycling IPs
  // cannot dodge.
  const limited = await rateLimitResponse(request, "frames:service-settings", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const auth = await authenticateFrameDevice(
    db,
    request.headers.get("authorization"),
  );
  if ("response" in auth) {
    return auth.response;
  }
  const { frameId } = await params;
  // The token IS the identity; the path segment must agree with it.
  if (auth.frame.id !== frameId) {
    return jsonError("frame_mismatch", 403);
  }
  // A pending frame has not been confirmed by its owner and a revoked one is
  // already gone: neither gets the account's keys.
  if (auth.frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }
  // The real boundary. The owner grants `settings:services` per frame and can
  // take it back at any time; the device's own scope bookkeeping is additive
  // (it unions what `ready` reports into its local list and never removes),
  // so this 403 — not the device's opinion — is what a revocation means.
  if (!linkedClientHasScope(auth.linkedClient, frameServiceSettingsScope)) {
    return jsonError("insufficient_scope", 403);
  }
  const identityLimited = await identityRateLimitResponse(
    auth.frame.id,
    "frames:service-settings",
    { limit: 120, windowMs: 15 * 60 * 1000 },
  );
  if (identityLimited) {
    return identityLimited;
  }

  // Which groups this frame's scenes declare. Denormalized on the frame row
  // because recomputing means unzipping every assigned scene (32 MiB each at
  // the store's cap) — far too much for a per-poll route. NULL means "never
  // computed" (a frame assigned scenes before this column existed), so
  // compute once here and backfill.
  let groups = readServiceSettingGroups(auth.frame.serviceSettingGroups);
  if (!groups) {
    try {
      groups = await computeAndStoreServiceSettingGroups(db, auth.frame.id);
    } catch (error) {
      reportError("frames.service_settings_backfill_failed", error, {
        frameId: auth.frame.id,
      });
      groups = [];
    }
  }

  const payload = buildServiceSettingsPayload(
    groups,
    await storedServiceSettings(db, auth.frame.accountId),
  );
  const { body, etag } = serviceSettingsResponseBody(payload);

  // A device that already has these bytes should not have them re-sent.
  // Exact match only: no weak comparison, no `*`, since the answer is a
  // credential set and "close enough" is not a thing here.
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      headers: { "cache-control": "no-store", etag },
      status: 304,
    });
  }

  return new NextResponse(body, {
    headers: {
      // Mandatory: nginx or a CDN in front of the cloud must never hold a
      // copy of an account's API keys, let alone serve one to another frame.
      "cache-control": "no-store",
      "content-type": "application/json",
      etag,
    },
    status: 200,
  });
}
