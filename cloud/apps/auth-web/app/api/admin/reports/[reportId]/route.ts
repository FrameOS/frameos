import { eq } from "drizzle-orm";
import {
  storeSceneReports,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ reportId: string }> };

// Resolve a scene report from the superadmin queue. Resolving is just
// closing the report — pulling the scene or banning the publisher are
// separate, deliberate actions.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "admin:reports", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return jsonError(
      admin.kind === "forbidden" ? "forbidden" : "unauthenticated",
      admin.kind === "forbidden" ? 403 : 401,
    );
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { reportId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
    return jsonError("report_not_found", 404);
  }

  const body = await readJsonObject(request);
  if (parseOptionalString(body.status) !== "resolved") {
    return jsonError("invalid_status", 400);
  }

  const [report] = await db
    .select({
      id: storeSceneReports.id,
      sceneId: storeSceneReports.sceneId,
      status: storeSceneReports.status,
    })
    .from(storeSceneReports)
    .where(eq(storeSceneReports.id, reportId))
    .limit(1);
  if (!report) {
    return jsonError("report_not_found", 404);
  }
  if (report.status === "resolved") {
    return NextResponse.json({ status: "resolved" });
  }

  await db
    .update(storeSceneReports)
    .set({
      resolvedAt: new Date(),
      resolvedByAccountId: admin.accountId,
      status: "resolved",
    })
    .where(eq(storeSceneReports.id, report.id));

  const [scene] = await db
    .select({ accountId: storeScenes.accountId, name: storeScenes.name })
    .from(storeScenes)
    .where(eq(storeScenes.id, report.sceneId))
    .limit(1);

  await recordAuditEvent(db, {
    accountId: scene?.accountId,
    actor: { accountId: admin.accountId, role: "superadmin" },
    eventType: "store.report_resolved",
    metadata: { name: scene?.name },
    target: { reportId: report.id, sceneId: report.sceneId },
  });

  return NextResponse.json({ status: "resolved" });
}
