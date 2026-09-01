import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { maxApiTokensPerAccount } from "../../../../src/lib/api-tokens";
import {
  maxAccountSettingValueLength,
  maxAccountSshKeys,
} from "../../../../src/lib/account-settings";
import { maxChatsPerAccount, maxMessagesPerChat } from "../../../../src/lib/ai/chat-store";
import { maxBackupBytes, maxBackupsPerAccount } from "../../../../src/lib/backups";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { maxScenesPerFrame } from "../../../../src/lib/frame-scenes";
import {
  claimTokenTtlMs,
  maxClaimTokensPerAccount,
  maxLogsPerFrame,
  maxMetricsPerFrame,
  maxScheduleEvents,
  maxScenesPayloadBytes,
} from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import {
  maxImagesPerScene,
  maxNewScenesPerDay,
  maxPreviewImageBytes,
  maxPublishesPerHour,
  maxSceneEditsPerHour,
  maxScenesPerAccount,
  maxSceneZipBytes,
  maxTagsPerScene,
} from "../../../../src/lib/store";
import { accountUsage } from "../../../../src/lib/usage";

export const runtime = "nodejs";

// The account, its usage against every quota, and the fixed caps the rest
// of the API enforces — one payload so a script or an agent can answer "can
// I still add a frame / save a scene / upload this file" before trying.
// `usage` is the same accountUsage() the account page and the backend grant
// endpoint render; `limits` collects the constants that otherwise only show
// up as the `max_*` field of a refusal.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:usage", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const [[account], usage] = await Promise.all([
      db
        .select({
          createdAt: accounts.createdAt,
          displayName: accounts.displayName,
          id: accounts.id,
          isSuperadmin: accounts.isSuperadmin,
          primaryEmail: accounts.primaryEmail,
          storeBannedAt: accounts.storeBannedAt,
          verifiedPublisherAt: accounts.verifiedPublisherAt,
        })
        .from(accounts)
        .where(eq(accounts.id, session.accountId))
        .limit(1),
      accountUsage(db, session.accountId),
    ]);
  if (!account) {
    return jsonError("login_required", 401);
  }

  return NextResponse.json(
    {
      account: {
        created_at: account.createdAt.toISOString(),
        email: account.primaryEmail,
        id: account.id,
        is_superadmin: account.isSuperadmin,
        name: account.displayName,
        store_banned: account.storeBannedAt !== null,
        verified_publisher: account.verifiedPublisherAt !== null,
      },
      auth: session.apiToken
        ? {
            kind: "api_token",
            token_access: session.apiToken.access,
            token_id: session.apiToken.id,
            token_name: session.apiToken.name,
          }
        : { kind: "session" },
      limits: {
        account: {
          max_api_tokens: maxApiTokensPerAccount,
          max_setting_value_length: maxAccountSettingValueLength,
          max_ssh_keys: maxAccountSshKeys,
        },
        ai: {
          max_chats: maxChatsPerAccount,
          max_messages_per_chat: maxMessagesPerChat,
        },
        backups: {
          max_backup_bytes: maxBackupBytes,
          max_backups: maxBackupsPerAccount,
        },
        frames: {
          claim_token_ttl_hours: Math.round(claimTokenTtlMs / (60 * 60 * 1000)),
          max_claim_tokens: maxClaimTokensPerAccount,
          max_log_lines_per_frame: maxLogsPerFrame,
          max_metrics_samples_per_frame: maxMetricsPerFrame,
          max_scene_payload_bytes: maxScenesPayloadBytes,
          max_scenes_per_frame: maxScenesPerFrame,
          max_schedule_events: maxScheduleEvents,
        },
        scenes: {
          max_edits_per_hour: maxSceneEditsPerHour,
          max_images_per_scene: maxImagesPerScene,
          max_new_scenes_per_day: maxNewScenesPerDay,
          max_preview_image_bytes: maxPreviewImageBytes,
          max_publishes_per_hour: maxPublishesPerHour,
          max_scene_zip_bytes: maxSceneZipBytes,
          max_scenes: maxScenesPerAccount,
          max_tags_per_scene: maxTagsPerScene,
        },
      },
      usage,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
