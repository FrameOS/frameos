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

// Account-level publisher moderation: the publish ban (the account keeps
// working — sign-in, backups, existing scenes — but every new store publish
// is rejected until the ban is lifted; existing scenes are moderated
// separately, pull them per scene if needed) and the verified-publisher
// trust mark (consumed by the AI chat's store-catalog tool).
export async function PATCH(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "admin:publishers", {
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
  const hasBan = typeof body.store_banned === "boolean";
  const hasVerified = typeof body.verified_publisher === "boolean";
  if (!hasBan && !hasVerified) {
    return jsonError("invalid_ban", 400);
  }

  const [account] = await db
    .select({
      displayName: accounts.displayName,
      id: accounts.id,
      storeBannedAt: accounts.storeBannedAt,
      verifiedPublisherAt: accounts.verifiedPublisherAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    return jsonError("account_not_found", 404);
  }

  if (hasBan) {
    const banned = body.store_banned === true;
    const reason = parseOptionalString(body.reason)?.slice(0, 500) ?? null;
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

  const verified = body.verified_publisher === true;
  await db
    .update(accounts)
    .set({ verifiedPublisherAt: verified ? new Date() : null })
    .where(eq(accounts.id, account.id));
  if (verified !== Boolean(account.verifiedPublisherAt)) {
    await recordAuditEvent(db, {
      accountId: account.id,
      actor: { accountId: admin.accountId, role: "superadmin" },
      eventType: verified
        ? "store.publisher_verified"
        : "store.publisher_unverified",
      metadata: {},
      target: { accountId: account.id },
    });
  }
  return NextResponse.json({
    status: verified ? "verified" : "unverified",
  });
}
