import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext, isUuid, superadminRefusal } from "../../../../../../../src/lib/admin";
import { recordAuditEvent } from "../../../../../../../src/lib/audit";
import { isAccountUuid } from "../../../../../../../src/lib/billing-admin";
import { csrfResponse } from "../../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../../src/lib/session";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ accountId: string }> };

// The operator's side of the AI switch (cloud/docs/accounting-todo.md §5.1,
// built for §9.3). The same `accounts.ai_disabled_at` the account flips for
// itself on /account/ai — one flag, two hands on it — and the terminal step
// of dunning (§3.2): an account that has not paid stops accruing before it
// stops being a customer.
//
// A reason is required, like every hand-posted journal entry. "Why is AI
// off for me" is a support question, and the answer has to be findable in
// the audit trail rather than in somebody's memory. The account's own
// switch has no reason field because the account is the reason.
export async function PUT(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-customer-ai", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const admin = await getSuperadminContext({ mutation: true });
  if (admin.kind !== "ok") {
    return superadminRefusal(admin);
  }
  const { accountId } = await context.params;
  if (!isUuid(accountId)) {
    return jsonError("not_found", 404);
  }
  if (!isAccountUuid(accountId)) {
    return jsonError("not_found", 404);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  if (typeof body.enabled !== "boolean") {
    return jsonError("invalid_request", 400, {
      detail: "enabled must be true or false",
    });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return jsonError("reason_required", 400, {
      detail: "Say why — it is what the account will be told if they ask.",
    });
  }

  const enabled = body.enabled;
  const [updated] = await db
    .update(accounts)
    .set({ aiDisabledAt: enabled ? null : new Date(), updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning({ aiDisabledAt: accounts.aiDisabledAt, id: accounts.id });
  if (!updated) {
    return jsonError("not_found", 404);
  }

  const session = await readSession();
  await recordAuditEvent(db, {
    accountId,
    actor: {
      accountId: admin.accountId,
      kind: "superadmin",
      providerSubject: session?.providerSubject,
    },
    eventType: enabled ? "admin.ai_enabled" : "admin.ai_disabled",
    metadata: { reason },
    target: { accountId, kind: "account" },
  });

  return NextResponse.json(
    { ai_disabled_at: updated.aiDisabledAt?.toISOString() ?? null, enabled },
    { headers: { "cache-control": "no-store" } },
  );
}
