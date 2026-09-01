import {
  billingSettingKeys,
  LedgerError,
  writeBillingSetting,
  type BillingSettingKey,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
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

// The billing knobs: margin, overdraft, and whether metering posts at all.
// Superadmin only and audited, because each one changes what the next turn
// costs somebody — and `ai_metering_mode` in particular is the switch that
// turns measurement into money.
//
// Changing a setting never rewrites the past: the margin is snapshotted into
// every usage record it priced and every entry that record posted, and the
// mode is stamped on the record itself. So this only ever decides what
// happens next, which is what makes it safe to change at all.
const writableKeys = new Set<string>(Object.values(billingSettingKeys));

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-settings", {
    limit: 30,
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

  const body = await readJsonObject(request);
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return jsonError("invalid_settings", 400, {
      detail: 'Send {"settings": {"ai_margin_percent": 30, ...}}',
    });
  }

  const entries = Object.entries(settings as Record<string, unknown>);
  const unknown = entries.filter(([key]) => !writableKeys.has(key));
  if (unknown.length > 0) {
    return jsonError("unknown_setting", 400, {
      detail: `Not a billing setting: ${unknown.map(([key]) => key).join(", ")}`,
    });
  }

  const session = await readSession();
  const written: string[] = [];
  try {
    for (const [key, value] of entries) {
      await writeBillingSetting(
        db,
        key as BillingSettingKey,
        value,
        admin.accountId,
      );
      written.push(key);
    }
  } catch (error) {
    if (error instanceof LedgerError) {
      // A typo'd setting fails here, where a human can see it, rather than
      // silently falling back to the default on every read for a month.
      return jsonError(error.code, 400, { detail: error.message });
    }
    throw error;
  }

  await recordAuditEvent(db, {
    actor: {
      accountId: admin.accountId,
      kind: "superadmin",
      providerSubject: session?.providerSubject,
    },
    eventType: "billing.settings_updated",
    metadata: { settings },
    target: { keys: written },
  });

  return NextResponse.json({ ok: true, updated: written });
}
