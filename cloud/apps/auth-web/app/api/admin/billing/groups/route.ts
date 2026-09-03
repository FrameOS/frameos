import {
  createAccountGroup,
  LedgerError,
  setAccountGroup,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext, superadminRefusal } from "../../../../../src/lib/admin";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Reporting groups: the mutable half of §1.3. Creating one, or re-pointing
// an account at a different one, re-buckets every report instantly and
// touches no posting — "AI revenue should show under Platform, not Labs" is
// this, and it costs nothing to change your mind about.
//
// The other half — an amount that is in the wrong *account* — is a
// reclassification entry, and lives at /api/admin/billing/journal. The
// distinction is the whole reason both exist: one changes how the books are
// presented, the other changes what they say.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-groups", {
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
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const session = await readSession();
  const body = await readJsonObject(request);
  const actor = {
    accountId: admin.accountId,
    kind: "superadmin",
    providerSubject: session?.providerSubject,
  };

  try {
    if (body.action === "create") {
      const group = await createAccountGroup(db, {
        code: String(body.code ?? ""),
        name: String(body.name ?? ""),
        ...(typeof body.sortOrder === "number" ? { sortOrder: body.sortOrder } : {}),
      });
      await recordAuditEvent(db, {
        actor,
        eventType: "billing.group_created",
        metadata: { code: group.code, name: group.name },
        target: { groupId: group.id },
      });
      return NextResponse.json({ group, ok: true });
    }

    if (body.action === "assign") {
      const ledgerAccountId =
        typeof body.ledgerAccountId === "string" ? body.ledgerAccountId : "";
      if (!ledgerAccountId) {
        return jsonError("invalid_account", 400, {
          detail: "Which ledger account is moving group?",
        });
      }
      const groupId = typeof body.groupId === "string" && body.groupId ? body.groupId : null;
      await setAccountGroup(db, ledgerAccountId, groupId);
      await recordAuditEvent(db, {
        actor,
        eventType: "billing.group_assigned",
        metadata: { groupId },
        target: { ledgerAccountId },
      });
      return NextResponse.json({ ok: true });
    }
  } catch (error) {
    if (error instanceof LedgerError) {
      return jsonError(error.code, 400, { detail: error.message });
    }
    throw error;
  }

  return jsonError("invalid_action", 400, {
    detail: 'action must be "create" or "assign"',
  });
}
