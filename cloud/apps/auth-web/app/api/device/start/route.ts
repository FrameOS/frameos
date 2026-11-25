import { deviceAuthorizationRequests } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  deviceVerificationUrls,
  generateUniqueUserCode,
  maskUserCode,
  metadataFromBody,
  parseClientKind,
  parseScopes,
  parseString,
  readBoundedJsonObject,
  requireDatabase,
  safeLocalOrigin,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createSecretToken, hashSecret, hashUserCode } from "../../../../src/lib/secrets";

// Device-flow metadata: a few strings and a scope list.
const maxDeviceStartBodyBytes = 64 * 1024;

export const runtime = "nodejs";

const expiresInSeconds = 10 * 60;
const intervalSeconds = 5;

// A frame that asks to be managed from the cloud (its frame page's Link to
// cloud: frame:link + frame:managed) gets what a claim-token enrollment is
// granted with it (enroll/route.ts claimTokenGrantedScopes): the account's
// service API keys, and its logs and metrics shipped. Without them a store
// scene that used the account's OpenAI key showed "add a key" after its
// install, and the frame sent no logs (2026-11-25). The approval screen lists
// them like any other scope, and the owner's per-frame switches take them
// back. Added here, not asked by the firmware, so frames already shipped get
// them too.
const managedFrameScopes = ["settings:services", "telemetry:logs", "telemetry:metrics"];

function withManagedFrameScopes(scopes: string[], clientKind: "backend" | "frame"): string[] {
  if (clientKind !== "frame" || !scopes.includes("frame:managed")) {
    return scopes;
  }
  return [...scopes, ...managedFrameScopes.filter((scope) => !scopes.includes(scope))];
}

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "device:start", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const parsed = await readBoundedJsonObject(request, maxDeviceStartBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body;
  const userCode = await generateUniqueUserCode(db);
  const deviceCode = createSecretToken("fc_device", 40);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const localOrigin = safeLocalOrigin(body.local_origin);
  const clientKind = parseClientKind(body.client_kind, parseScopes(body.scopes));
  const requestedScopes = withManagedFrameScopes(parseScopes(body.scopes, clientKind), clientKind);
  const publicDisplayName = parseString(
    body.public_display_name ?? body.display_name,
    clientKind === "frame" ? "FrameOS frame" : "FrameOS backend",
  ).slice(0, 120);

  await db.insert(deviceAuthorizationRequests).values({
    backendMetadata: metadataFromBody(body),
    clientKind,
    deviceCodeHash: hashSecret(deviceCode),
    expiresAt,
    intervalSeconds,
    localOrigin,
    publicDisplayName,
    requestedScopes,
    userCodeDisplay: maskUserCode(userCode),
    userCodeHash: hashUserCode(userCode.replace("-", "")),
  });

  return NextResponse.json({
    device_code: deviceCode,
    expires_in: expiresInSeconds,
    interval: intervalSeconds,
    user_code: userCode,
    ...deviceVerificationUrls(userCode),
  });
}
