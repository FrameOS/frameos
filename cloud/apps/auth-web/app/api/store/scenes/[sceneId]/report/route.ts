import { and, eq } from "drizzle-orm";
import { storeSceneReports, storeScenes } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { notifyDiscord } from "../../../../../../src/lib/discord";
import {
  getAccountBaseUrl,
  getScenesBaseUrl,
} from "../../../../../../src/lib/env";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import {
  maxReportReasonLength,
  maxReportsPerDay,
} from "../../../../../../src/lib/store";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Report a public scene. Reports need a signed-in
// account (raises the cost of report-spam) and land in the superadmin queue
// at /admin/reports. One open report per (scene, reporter) — enforced by a
// partial unique index — so re-reporting is a no-op.
export async function POST(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "store:report", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }

  const identityLimited = identityRateLimitResponse(
    session.accountId,
    "store:report",
    { limit: maxReportsPerDay, windowMs: 24 * 60 * 60 * 1000 },
  );
  if (identityLimited) {
    return identityLimited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { sceneId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return jsonError("scene_not_found", 404);
  }

  const [scene] = await db
    .select({
      accountId: storeScenes.accountId,
      id: storeScenes.id,
      name: storeScenes.name,
      slug: storeScenes.slug,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.id, sceneId),
        eq(storeScenes.visibility, "public"),
        eq(storeScenes.status, "active"),
      ),
    )
    .limit(1);
  if (!scene) {
    return jsonError("scene_not_found", 404);
  }

  const body = await readJsonObject(request);
  const reason = parseOptionalString(body.reason)?.slice(
    0,
    maxReportReasonLength,
  );
  if (!reason) {
    return jsonError("invalid_reason", 400);
  }

  const [created] = await db
    .insert(storeSceneReports)
    .values({
      reason,
      reporterAccountId: session.accountId,
      sceneId: scene.id,
    })
    .onConflictDoNothing()
    .returning({ id: storeSceneReports.id });

  if (!created) {
    return NextResponse.json({ status: "already_reported" });
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "store.scene_reported",
    metadata: { name: scene.name },
    target: { sceneId: scene.id },
  });

  // Heads-up to the moderation channel; the report itself already succeeded.
  const sceneUrl = new URL(`/s/${scene.slug}`, getScenesBaseUrl()).toString();
  const reportsUrl = new URL("/admin/reports", getAccountBaseUrl()).toString();
  await notifyDiscord(
    [
      `🚩 **Scene reported**: ${scene.name}`,
      `Scene: <${sceneUrl}>`,
      `Reporter: ${session.email ?? session.accountId}`,
      `Reason: ${reason.slice(0, 500)}`,
      `Review: <${reportsUrl}>`,
    ].join("\n"),
  );

  return NextResponse.json({ status: "reported" });
}
