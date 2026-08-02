import { NextRequest } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import {
  maxPublishesPerHour,
  maxSceneZipBytes,
} from "../../../../../src/lib/store";
import { publishStoreScene } from "../../../../../src/lib/store-publish";

export const runtime = "nodejs";

const maxMultipartOverheadBytes = 128 * 1024;

// Signed-in account upload of a FrameOS template ZIP. The scene name and
// description come from template.json; uploads are private by default, and
// uploading the same name again creates a new immutable version.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "account:scene-upload", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }

  const accountLimited = identityRateLimitResponse(
    session.accountId,
    "store:publish",
    { limit: maxPublishesPerHour, windowMs: 60 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxSceneZipBytes + maxMultipartOverheadBytes
  ) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("invalid_upload", 400);
  }
  const upload = form.get("file");
  if (
    !upload ||
    typeof upload === "string" ||
    typeof upload.arrayBuffer !== "function"
  ) {
    return jsonError("invalid_upload", 400);
  }

  const content = Buffer.from(await upload.arrayBuffer());
  if (content.length > maxSceneZipBytes) {
    return jsonError("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  return publishStoreScene(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    content,
  });
}
