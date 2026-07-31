import { NextRequest } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
} from "../../../../src/lib/backend-auth";
import { decodeBackupContent } from "../../../../src/lib/backups";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import {
  maxPublishesPerHour,
  sceneVisibilities,
  storePublishScope,
} from "../../../../src/lib/store";
import { publishStoreScene } from "../../../../src/lib/store-publish";

export const runtime = "nodejs";

// Publish a scene (template zip) to the store. Re-publishing a name the
// account already owns appends an immutable version to that scene; a new
// name creates a new scene with a globally unique slug. Private by default.
export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request, "store:publish", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }
  if (!linkedClientHasScope(linkedClient, storePublishScope)) {
    return jsonError("insufficient_scope", 403);
  }

  const accountLimited = identityRateLimitResponse(
    linkedClient.accountId,
    "store:publish",
    { limit: maxPublishesPerHour, windowMs: 60 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  const body = await readJsonObject(request);
  const name = parseOptionalString(body.name)?.slice(0, 128);
  if (!name) {
    return jsonError("invalid_name", 400);
  }

  const requestedVisibility = parseOptionalString(body.visibility);
  if (requestedVisibility && !sceneVisibilities.has(requestedVisibility)) {
    return jsonError("invalid_visibility", 400);
  }

  const content = decodeBackupContent(body.content_base64);
  if (!content) {
    return jsonError("invalid_content", 400);
  }

  return publishStoreScene(db, {
    accountId: linkedClient.accountId,
    actor: { linkedClientId: linkedClient.id },
    content,
    description: parseOptionalString(body.description)?.slice(0, 2000),
    linkedClientId: linkedClient.id,
    name,
    visibility: requestedVisibility,
  });
}
