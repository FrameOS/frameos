import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { decodeBackupContent } from "../../../../../../src/lib/backups";
import { jsonError, readBoundedJsonObject } from "../../../../../../src/lib/device-flow";
import { moderateStoreContent } from "../../../../../../src/lib/moderation";
import {
  detectImageContentType,
  isProvablyFullyTransparentImage,
  maxPreviewImageBytes,
} from "../../../../../../src/lib/store";
import { registerStoreImage } from "../../../../../../src/lib/store-images";
import { loadOwnedScene } from "../../../../../../src/lib/store-owner";
import {
  accountLimits,
  privateSceneBytesForAccount,
} from "../../../../../../src/lib/usage";

// One base64 image plus a little JSON around it.
const maxImageBodyBytes = Math.ceil((maxPreviewImageBytes * 4) / 3) + 64 * 1024;

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Owner upload of an image for a scene. This registers the bytes — sniffed
// for a real image signature, refused when provably transparent, moderated
// like the publish-time cover — and answers with their digest. It binds
// nothing: which images a scene shows, and in what order, is part of a
// version, so the digest goes into the editor's draft and the next Save
// publishes it (POST …/content with `images`). An upload that never gets
// bound is what the object-store sweep removes.
export async function POST(request: NextRequest, context: RouteContext) {
  const { db, errorResponse, scene, session } = await loadOwnedScene(
    request,
    context,
  );
  if (!scene || !db || !session) {
    return errorResponse;
  }
  if (scene.status === "pulled") {
    return jsonError("scene_pulled", 403);
  }

  const parsed = await readBoundedJsonObject(request, maxImageBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body;
  const content = decodeBackupContent(body.content_base64);
  if (!content || content.length === 0) {
    return jsonError("invalid_content", 400);
  }
  if (content.length > maxPreviewImageBytes) {
    return jsonError("image_too_large", 413, {
      max_bytes: maxPreviewImageBytes,
    });
  }

  const contentType = detectImageContentType(content);
  if (!contentType) {
    return jsonError("unsupported_image", 400);
  }
  // A provably all-transparent image is a broken live-preview screenshot
  // (captured before the first frame painted) and would show as a blank tile.
  if (isProvablyFullyTransparentImage(content)) {
    return jsonError("preview_image_fully_transparent", 400);
  }

  // The bytes will count against the private-scene quota once a version
  // links them; refusing here rather than at Save keeps the draft honest.
  // Public scenes are free (usage.ts).
  if (scene.visibility !== "public") {
    const [privateBytes, { privateSceneBytes: maxBytes }] = await Promise.all([
      privateSceneBytesForAccount(db, session.accountId!),
      accountLimits(db, session.accountId!),
    ]);
    if (privateBytes + content.length > maxBytes) {
      return jsonError("storage_quota_exceeded", 403, {
        max_bytes: maxBytes,
        private_bytes: Math.round(privateBytes),
      });
    }
  }

  const moderation = await moderateStoreContent({
    image: { content, contentType },
    texts: [],
  });
  if (!moderation.ok) {
    if (moderation.error === "content_rejected") {
      await recordAuditEvent(db, {
        accountId: session.accountId,
        actor: {
          accountId: session.accountId,
          providerSubject: session.providerSubject,
        },
        eventType: "store.image_rejected",
        metadata: { categories: moderation.categories },
        target: { sceneId: scene.id },
      });
      return jsonError("content_rejected", 422, {
        categories: moderation.categories,
      });
    }
    return jsonError("moderation_unavailable", 503);
  }

  const image = await registerStoreImage(db, content, contentType);

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.image_added",
    metadata: { sha256: image.sha256, sizeBytes: content.length },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    image: {
      content_type: image.contentType,
      height: image.height,
      sha256: image.sha256,
      size_bytes: image.sizeBytes,
      url: `/api/store/scenes/${scene.id}/images/${image.sha256}`,
      width: image.width,
    },
    status: "registered",
  });
}
