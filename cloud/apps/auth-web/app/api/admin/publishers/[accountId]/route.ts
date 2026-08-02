import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
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

type RouteContext = { params: Promise<{ accountId: string }> };

// Account-level publish ban. The account keeps working
// — sign-in, backups, existing scenes — but every new store publish is
// rejected until the ban is lifted. Existing scenes are moderated separately
// (pull them per scene if needed).
export async function PATCH(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "admin:publishers", {
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

  const { accountId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    return jsonError("account_not_found", 404);
  }

  const body = await readJsonObject(request);
  if (typeof body.store_banned !== "boolean") {
    return jsonError("invalid_ban", 400);
  }
  const banned = body.store_banned;
  const reason = parseOptionalString(body.reason)?.slice(0, 500) ?? null;

  const [account] = await db
    .select({
      displayName: accounts.displayName,
      id: accounts.id,
      storeBannedAt: accounts.storeBannedAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    return jsonError("account_not_found", 404);
  }

  await db
    .update(accounts)
    .set(
      banned
        ? { storeBanReason: reason, storeBannedAt: new Date() }
        : { storeBanReason: null, storeBannedAt: null },
    )
    .where(eq(accounts.id, account.id));

  if (banned !== Boolean(account.storeBannedAt)) {
    await recordAuditEvent(db, {
      accountId: account.id,
      actor: { accountId: admin.accountId, role: "superadmin" },
      eventType: banned
        ? "store.publisher_banned"
        : "store.publisher_unbanned",
      metadata: banned ? { reason } : {},
      target: { accountId: account.id },
    });
  }

  return NextResponse.json({
    status: banned ? "banned" : "unbanned",
  });
}
