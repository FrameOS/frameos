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
  readJsonObject,
  requireDatabase,
  safeLocalOrigin,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createSecretToken, hashSecret, hashUserCode } from "../../../../src/lib/secrets";

export const runtime = "nodejs";

const expiresInSeconds = 10 * 60;
const intervalSeconds = 5;

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request, "device:start", {
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

  const body = await readJsonObject(request);
  const userCode = await generateUniqueUserCode(db);
  const deviceCode = createSecretToken("fc_device", 40);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const localOrigin = safeLocalOrigin(body.local_origin);
  const requestedScopes = parseScopes(body.scopes);
  const clientKind = parseClientKind(body.client_kind, requestedScopes);
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
